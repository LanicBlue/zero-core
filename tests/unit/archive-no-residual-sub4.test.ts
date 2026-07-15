// archive-no-residual sub-4 — adversarial verification of acceptance-4.md.
//
// # 文件说明书
//
// ## 核心功能
// 独立验证 acceptance-4.md 的 15 个条目(由独立的 adversarial verifier 写,
// 非实施者)。覆盖 D4(cleanup-TTL 定性为安全网)+ D5(启动 sweep 清存量孤儿)。
//
// 行为测试:
//   D4 #1   delegator.cleanup() 对已 terminal(行已删)任务 deleteDelegatedTask
//           idempotent no-op(不抛、不影响 aging)。
//   D4 #2   registry aging 仍生效(终态 task 超 maxAge 从内存清,返回值含它)。
//   D5 #4   清存量孤儿(seed N 个 is_main=0/archived=0/updated_at 15d 前/
//           排除 active)→ 全 export JSON + deleteSessionData,返回 N。
//   D5 #5   不动 main(is_main=1 的 session 即使超期 → 不被清)。
//   D5 #6   不动 active(excludeIds 里的即使 is_main=0 超期 → 不被清)。
//   D5 #7   不动近期(updated_at 在 maxAgeDays=14 内的 is_main=0 → 不被清)。
//   D5 #8   export-before-delete(JSON 落盘 archives/<agentId>/<id>.json,内容含
//           session/steps/summaries;DB 删后 JSON 仍在)。
//   D5 #9   单条失败不阻断(某 orphan export 抛 → 该条 skip log,其余继续,
//           返回不含它)。
//   D5 #10  idempotent(再跑 → 0)。
//
// 源码断言:
//   #3   cleanup() 两处(subagent-delegator + task-registry)含 safety-net 注释。
//   #11  index.ts 启动调 sweepOrphanSessions,位置在 recoverInterruptedArchives
//        之后。
//   #12  sweepOrphanSessions 导出于 archive-service;index.ts 启动调用。
//   #13  listSessions/listOrphanCandidateSessions 支持 isMain/archived/olderThan/
//        excludeIds 过滤。
//
// 回归:
//   #14  既有 task-cleanup-db / archive-no-residual-sub1/2/3 测试不回归(独立跑)。
//   #15  npm run build:lib(tsc)类型绿(独立跑)。
//
// ## 对抗性核查
//   - 不信 implementer 自述"改了":git diff + 源码 indexOf 双锁(源码断言块)。
//   - 不信"调了 sweepOrphanSessions":真实副作用(行消失 / JSON 落盘)双重。
//   - 不信"不动 active/main/近期":各自显式 seed 反例,断言不被清。
//   - 不信"单条失败不阻断":mock archive-service export 抛 + 真实 sweep loop 观测。
//   - export-before-delete 的"原子性"由真实 writeArchiveJsonAtomic 落实;我们
//     断言:DB 行删后 JSON 仍在(JSON 写在 DELETE 之前,与生产管线一致)。
//
// ## 独立评判(交付报告里展开)
//   - activeSessionIds 空集:14d 阈值天然保护 active(updated_at 必新);但若某
//     active session updated_at 因故 >14d(长跑无更新),会被误扫 → export-before-
//     delete 兜底可接受吗?(独立判断)
//   - agent_id != '__recovered__' 过滤:是否漏扫该扫的、或多扫不该扫的?
//   - 启发式不精确:is_main=0 含合法非 main session → plan 明示保守 + export 兜底。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里。
// - ZERO_CORE_DIR 重定向 + vi.resetModules 让 config.ts 重读(ARCHIVES_ROOT 落 tmp)。
// - 不 git commit;不修改 src/(verifier 只写测试)。
// - Windows better-sqlite3 崩溃规避:本文件单跑,不进全量套件。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Module-level placeholders — populated in beforeEach after ZERO_CORE_DIR redirect.
let SessionDBCtor: typeof import("../../src/server/session-db.js").SessionDB;
let archiveMod: typeof import("../../src/server/archive-service.js");
let DelegatorCtor: typeof import("../../src/runtime/subagent-delegator.js").SubagentDelegator;
let TaskRegistryCtor: typeof import("../../src/runtime/task-registry.js").TaskRegistry;

const DELEGATOR_SRC = join(__dirname, "..", "..", "src", "runtime", "subagent-delegator.ts");
const TASK_REGISTRY_SRC = join(__dirname, "..", "..", "src", "runtime", "task-registry.ts");
const ARCHIVE_SVC_SRC = join(__dirname, "..", "..", "src", "server", "archive-service.ts");
const SESSION_DB_SRC = join(__dirname, "..", "..", "src", "server", "session-db.ts");
const INDEX_SRC = join(__dirname, "..", "..", "src", "server", "index.ts");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Cast SessionDB to expose the private better-sqlite3 handle. */
function rawDb(db: InstanceType<typeof SessionDBCtor>): import("better-sqlite3").Database {
	return (db as unknown as { db: import("better-sqlite3").Database }).db;
}

/** True when the session row is gone. */
function sessionRowGone(db: InstanceType<typeof SessionDBCtor>, sessionId: string): boolean {
	return rawDb(db).prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) === undefined;
}

/** Force a session's updated_at back in time (for "old orphan" seeding). */
function setUpdatedAt(db: InstanceType<typeof SessionDBCtor>, sessionId: string, iso: string): void {
	rawDb(db).prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(iso, sessionId);
}

/** ISO string for N days ago. */
function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86_400_000).toISOString();
}

// ===========================================================================
// #3, #11, #12, #13 — source-level invariants (read at module load).
// ===========================================================================

describe("[#3, #11, #12, #13] source-level invariants (archive-no-residual sub-4)", () => {
	test("#3a: subagent-delegator.cleanup() body carries D4 safety-net comment", () => {
		const src = readFileSync(DELEGATOR_SRC, "utf8");
		// cleanup() is the LAST method in the class — slice from the method
		// signature to end-of-class (`^}` on column 1).
		const start = src.indexOf("\tcleanup(): void {");
		expect(start, "delegator cleanup() must exist").toBeGreaterThan(-1);
		const end = src.indexOf("\n}", start + 1);
		expect(end, "end of cleanup() must be findable").toBeGreaterThan(start);
		const body = src.slice(start, end);
		// Adversarial: the comment must mention BOTH the safety-net framing
		// AND the primary delete location (sub-1 terminal).
		expect(body).toMatch(/safety[\s-]?net/i);
		expect(body).toMatch(/fireOnTaskTerminal|sub-1|terminal/i);
		expect(body).toMatch(/idempotent/i);
	});

	test("#3b: task-registry.cleanup() body carries D4 safety-net / memory-hygiene comment", () => {
		const src = readFileSync(TASK_REGISTRY_SRC, "utf8");
		// task-registry's cleanup carries a maxAgeMs parameter.
		const start = src.indexOf("\tcleanup(maxAgeMs");
		expect(start, "task-registry cleanup() must exist").toBeGreaterThan(-1);
		// Slice to the next tab-indented top-level declaration.
		const end = src.indexOf("\n}", start + 1);
		expect(end, "end of cleanup() must be findable").toBeGreaterThan(start);
		const body = src.slice(start, end);
		expect(body).toMatch(/safety[\s-]?net|memory/i);
		expect(body).toMatch(/idempotent/i);
	});

	test("#12a: sweepOrphanSessions is exported from archive-service.ts", () => {
		const src = readFileSync(ARCHIVE_SVC_SRC, "utf8");
		// Exported function declaration (top-level `export async function`).
		expect(src, "must contain `export async function sweepOrphanSessions`").toMatch(/export\s+async\s+function\s+sweepOrphanSessions\s*\(/);
	});

	test("#12b + #11: index.ts startup imports + invokes sweepOrphanSessions AFTER recoverInterruptedArchives", () => {
		const src = readFileSync(INDEX_SRC, "utf8");
		// Both names appear in the same fire-and-forget block.
		expect(src, "index.ts must reference sweepOrphanSessions").toMatch(/sweepOrphanSessions/);
		expect(src, "index.ts must reference recoverInterruptedArchives").toMatch(/recoverInterruptedArchives/);
		// Ordering: recover BEFORE sweep in source.
		const recIdx = src.indexOf("recoverInterruptedArchives(sessionDB)");
		const sweepIdx = src.indexOf("sweepOrphanSessions(sessionDB");
		expect(recIdx, "must find recover call site").toBeGreaterThan(-1);
		expect(sweepIdx, "must find sweep call site").toBeGreaterThan(-1);
		expect(sweepIdx, "sweep MUST appear AFTER recover in index.ts source").toBeGreaterThan(recIdx);
	});

	test("#13: SessionDB exposes listOrphanCandidateSessions with the {olderThan, excludeIds} filter (isMain=false, archived=false are SQL constants)", () => {
		const src = readFileSync(SESSION_DB_SRC, "utf8");
		const start = src.indexOf("listOrphanCandidateSessions(");
		expect(start, "listOrphanCandidateSessions must exist").toBeGreaterThan(-1);
		// Slice a generous window — the method body is the largest span we
		// need to inspect. 4000 chars is well past the method's two SQL queries.
		const body = src.slice(start, start + 4000);
		// SQL filter constants baked in (is_main=0 + archived=0 are in the WHERE).
		expect(body).toMatch(/is_main\s*=\s*0/);
		expect(body).toMatch(/archived\s*=\s*0/);
		// Parameterized olderThan (caller-supplied cutoff).
		expect(body).toMatch(/updated_at\s*<\s*\?/);
		// excludeIds via NOT IN (...) when set is non-empty.
		expect(body).toMatch(/NOT\s+IN/i);
		expect(body).toMatch(/excludeIds/);
		// __recovered__ pseudo-agent exclusion baked in (data-safety: these
		// rows are FK bookkeeping for orphaned steps, not real sessions).
		expect(body).toMatch(/__recovered__/);
	});
});

// ===========================================================================
// D4 behavioral tests (#1, #2)
// ===========================================================================

describe("[D4 #1, #2] cleanup-TTL safety-net behavior", () => {
	let tmp: string;
	let db: InstanceType<typeof SessionDBCtor>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "zero-archive-sub4-d4-"));
		process.env.ZERO_CORE_DIR = tmp;
		vi.resetModules();
	});
	afterEach(async () => {
		vi.resetModules();
		delete process.env.ZERO_CORE_DIR;
		try { db?.close(); } catch { /* ignore */ }
		if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	async function freshImports(): Promise<void> {
		({ SessionDB: SessionDBCtor } = await import("../../src/server/session-db.js"));
		({ SubagentDelegator: DelegatorCtor } = await import("../../src/runtime/subagent-delegator.js"));
		({ TaskRegistry: TaskRegistryCtor } = await import("../../src/runtime/task-registry.js"));
		archiveMod = await import("../../src/server/archive-service.js");
	}

	function makeDelegator(dbArg: InstanceType<typeof SessionDBCtor>): InstanceType<typeof DelegatorCtor> {
		const cfg = {
			agentId: "parent-agent",
			sessionId: "parent-session",
			workspaceDir: tmp,
			db: dbArg as any,
		} as any;
		return new DelegatorCtor({
			config: cfg,
			providers: [],
			emit: () => {},
			createSubLoop: () => ({} as any),
			getToolConfig: () => ({}),
		});
	}

	test("#1: cleanup() on a task whose DB row is ALREADY deleted → idempotent no-op, no throw, registry aging still runs", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));

		// Seed a delegated_tasks row + register it in-memory, then DELETE the
		// row (mimicking sub-1 terminal having already fired). The row is gone
		// BEFORE cleanup runs — exactly the "primary delete already happened"
		// case D4 describes.
		db.createDelegatedTask({
			id: "t-already-gone",
			rootTaskId: "t-already-gone",
			ownerAgentId: "parent-agent",
			targetAgentId: "dev",
			parentSessionId: "parent-session",
			sessionId: undefined,
			task: "do thing",
			status: "completed",
		});
		db.deleteDelegatedTask("t-already-gone");
		expect(db.getDelegatedTask("t-already-gone")).toBeUndefined();

		const delegator = makeDelegator(db);
		delegator.taskRegistry.create("t-already-gone", "subagent", "work");
		delegator.taskRegistry.complete("t-already-gone", "done");
		// Force completedAt into the past so cleanup's aging sees it as expired.
		(delegator.taskRegistry as any).tasks.get("t-already-gone").completedAt = Date.now() - 7200_000;

		// cleanup() must NOT throw even though the DB row is already gone.
		expect(() => delegator.cleanup()).not.toThrow();

		// Adversarial: aging STILL ran — registry memory was cleared regardless
		// of DB state (memory hygiene is the primary point post-sub-1).
		expect(delegator.taskRegistry.get("t-already-gone")).toBeUndefined();
		// DB row is still gone (deleteDelegatedTask is idempotent — no resurrection).
		expect(db.getDelegatedTask("t-already-gone")).toBeUndefined();
	});

	test("#2: TaskRegistry.cleanup() still ages out terminal tasks (returns the removed ids + clears memory)", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));

		const reg = new TaskRegistryCtor();
		reg.create("t-aged-2", "subagent", "work");
		reg.create("t-fresh-2", "subagent", "work");
		reg.complete("t-aged-2", "done");
		reg.complete("t-fresh-2", "done");
		// aged: 2h old. fresh: now.
		(reg as any).tasks.get("t-aged-2").completedAt = Date.now() - 7200_000;

		const removed = reg.cleanup(); // default maxAge 1h
		expect(removed).toEqual(["t-aged-2"]);
		expect(reg.get("t-aged-2")).toBeUndefined();
		expect(reg.get("t-fresh-2")).toBeDefined();

		// Adversarial: a SECOND cleanup() is idempotent on the already-cleared
		// registry (returns []).
		const removed2 = reg.cleanup();
		expect(removed2).toEqual([]);
	});
});

// ===========================================================================
// D5 behavioral tests (#4-#10)
// ===========================================================================

describe("[D5 #4-#10] sweepOrphanSessions behavior (real archive-service)", () => {
	let tmp: string;
	let db: InstanceType<typeof SessionDBCtor>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "zero-archive-sub4-d5-"));
		process.env.ZERO_CORE_DIR = tmp;
		vi.resetModules();
	});
	afterEach(async () => {
		vi.resetModules();
		delete process.env.ZERO_CORE_DIR;
		try { db?.close(); } catch { /* ignore */ }
		if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	async function freshImports(): Promise<void> {
		({ SessionDB: SessionDBCtor } = await import("../../src/server/session-db.js"));
		archiveMod = await import("../../src/server/archive-service.js");
	}

	/** Seed an orphan candidate: non-main, non-archived, updated_at 15d ago.
	 *  Optionally add a step + summary so export content is non-empty. */
	function seedOrphan(
		agentId: string,
		opts: { ageDays?: number; withContent?: boolean; sessionKind?: "chat" | "delegated" } = {},
	): string {
		const ageDays = opts.ageDays ?? 15;
		const created = db.createSession(agentId, "orphan", undefined, {
			sessionKind: opts.sessionKind ?? "delegated",
			parentSessionId: "parent-session",
			visibility: "hidden",
		});
		if (opts.withContent) {
			db.appendStep(created.id, 0, 0, "user", `hello from ${created.id}`);
			db.appendStep(created.id, 1, 0, "assistant", `reply to ${created.id}`);
		}
		// Force updated_at back in time (appendStep resets it to now).
		setUpdatedAt(db, created.id, daysAgo(ageDays));
		return created.id;
	}

	/** Seed a session with is_main=1 (old, but main — sweep MUST NOT touch). */
	function seedMain(agentId: string, ageDays = 15): string {
		const created = db.createSession(agentId, "main session", undefined, { sessionKind: "chat" });
		db.setMainSession(agentId, created.id);
		// setMainSession updates updated_at to now; push it back.
		setUpdatedAt(db, created.id, daysAgo(ageDays));
		return created.id;
	}

	// -------------------------------------------------------------------------
	// #4: 清存量孤儿 — seed N orphans → all swept, count = N
	// -------------------------------------------------------------------------

	test("#4: seed N (3) orphans → all exported + deleted, return count = 3", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		const ids = [
			seedOrphan("agent-A", { withContent: true }),
			seedOrphan("agent-B", { withContent: true }),
			seedOrphan("agent-A", { withContent: true }),
		];
		// Sanity: all present + non-archived.
		for (const id of ids) expect(db.getSession(id)).toBeDefined();

		try {
			const n = await archiveMod.sweepOrphanSessions(db);
			expect(n).toBe(3);

			// Adversarial: each row is GONE.
			for (const id of ids) {
				expect(sessionRowGone(db, id), `${id} row must be deleted`).toBe(true);
			}

			// Adversarial: JSON landed on disk (export-before-delete). Path:
			// <ZERO_CORE_DIR>/archives/<agentId>/<id>.json
			for (const id of ids) {
				const row = db.getSession(id); // undefined now — find agentId another way
				// We seeded agent-A (x2) + agent-B (x1). Find the JSON by walking
				// archives/<agent>/<id>.json directly.
				const row0 = rawDb(db).prepare("SELECT agent_id FROM sessions WHERE id = ?").get(id) as { agent_id: string } | undefined;
				// Row gone → use a fallback: search both agents.
				const candidates = ["agent-A", "agent-B"].map((a) => join(tmp, "archives", a, `${id}.json`));
				const hit = candidates.find((p) => existsSync(p));
				expect(hit, `archive JSON for ${id} MUST exist on disk`).toBeDefined();
			}
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #5: is_main=1 不被清
	// -------------------------------------------------------------------------

	test("#5: is_main=1 session (even if 15d old) is NOT swept", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		const mainId = seedMain("agent-main", 15);
		// Sanity: it's main + old (>= 14d).
		expect(db.getMainSession("agent-main")?.id).toBe(mainId);
		const updatedMs = Date.parse(db.getSession(mainId)?.updatedAt ?? "");
		expect(Date.now() - updatedMs).toBeGreaterThan(14 * 86_400_000);

		try {
			const n = await archiveMod.sweepOrphanSessions(db);
			expect(n).toBe(0);
			// Main session still present.
			expect(sessionRowGone(db, mainId)).toBe(false);
			expect(db.getSession(mainId)?.isMain).toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #6: 在 activeSessionIds 集合里的 session 即使 is_main=0 超期 → 不被清
	// -------------------------------------------------------------------------

	test("#6: orphan in activeSessionIds is protected from sweep", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		const activeId = seedOrphan("agent-active", { ageDays: 15, withContent: true });
		const otherId = seedOrphan("agent-other", { ageDays: 15, withContent: true });

		try {
			const n = await archiveMod.sweepOrphanSessions(db, {
				activeSessionIds: new Set([activeId]),
			});
			// Only "other" swept; "active" protected.
			expect(n).toBe(1);
			expect(sessionRowGone(db, activeId), "active session MUST remain").toBe(false);
			expect(sessionRowGone(db, otherId), "other session MUST be swept").toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #7: 近期(updated_at 在 maxAgeDays=14 内)的 is_main=0 → 不被清
	// -------------------------------------------------------------------------

	test("#7a: orphan updated 5d ago (within default 14d) is NOT swept", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		const fresh = seedOrphan("agent-fresh", { ageDays: 5, withContent: true });
		const stale = seedOrphan("agent-stale", { ageDays: 15, withContent: true });

		try {
			const n = await archiveMod.sweepOrphanSessions(db); // default maxAgeDays=14
			expect(n).toBe(1);
			expect(sessionRowGone(db, fresh), "5d-old orphan MUST remain (within 14d cutoff)").toBe(false);
			expect(sessionRowGone(db, stale), "15d-old orphan MUST be swept").toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("#7b: custom maxAgeDays=30 is STRICTER than default 14 — only orphans >30d old are swept", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		// 15d orphan: swept at default maxAgeDays=14, KEPT at stricter maxAgeDays=30.
		// 40d orphan: swept at BOTH (always older than the largest reasonable cutoff).
		const mid = seedOrphan("agent-mid", { ageDays: 15, withContent: true });
		const ancient = seedOrphan("agent-ancient", { ageDays: 40, withContent: true });

		try {
			// Default (14d): both mid + ancient are >14d → both swept.
			let n = await archiveMod.sweepOrphanSessions(db);
			expect(n).toBe(2);
			expect(sessionRowGone(db, mid)).toBe(true);
			expect(sessionRowGone(db, ancient)).toBe(true);
		} finally {
			warnSpy.mockRestore();
		}

		// Re-seed fresh copies + run with maxAgeDays=30: only ancient is swept
		// (15d is within the 30d window). Asserted in a separate test below.
	});

	test("#7c: maxAgeDays=30 keeps 15d orphan, sweeps 40d orphan (stricter cutoff)", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		const mid = seedOrphan("agent-mid", { ageDays: 15, withContent: true });
		const ancient = seedOrphan("agent-ancient", { ageDays: 40, withContent: true });

		try {
			const n = await archiveMod.sweepOrphanSessions(db, { maxAgeDays: 30 });
			// 40d > 30d cutoff → swept. 15d < 30d cutoff → kept.
			expect(n).toBe(1);
			expect(sessionRowGone(db, mid), "15d orphan MUST remain (within 30d window)").toBe(false);
			expect(sessionRowGone(db, ancient), "40d orphan MUST be swept").toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #8: export-before-delete — JSON 落盘 + 内容含 session/steps/summaries;
	//     DB 删后 JSON 仍在
	// -------------------------------------------------------------------------

	test("#8: swept orphan's JSON lands at archives/<agentId>/<id>.json with session/steps/summaries; survives DB delete", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		const agentId = "agent-export-test";
		const orphanId = seedOrphan(agentId, { ageDays: 15, withContent: true });

		try {
			const n = await archiveMod.sweepOrphanSessions(db);
			expect(n).toBe(1);

			// DB row gone.
			expect(sessionRowGone(db, orphanId)).toBe(true);

			// JSON file exists at the canonical path.
			const archivePath = join(tmp, "archives", agentId, `${orphanId}.json`);
			expect(existsSync(archivePath), `JSON must exist at ${archivePath}`).toBe(true);

			// Read back + assert payload shape (version=1, session, steps, summaries).
			const payload = JSON.parse(readFileSync(archivePath, "utf8"));
			expect(payload.version).toBe(1);
			expect(payload.agentId).toBe(agentId);
			expect(payload.sessionId).toBe(orphanId);
			expect(payload.session, "session field must be present").toBeDefined();
			expect(payload.session.id).toBe(orphanId);
			expect(Array.isArray(payload.steps)).toBe(true);
			expect(payload.steps.length, "steps must contain the 2 we seeded").toBe(2);
			expect(payload.steps[0].role).toBe("user");
			expect(payload.steps[1].role).toBe("assistant");
			expect(Array.isArray(payload.summaries)).toBe(true);
			expect(payload.memoryTurnRan).toBe(false); // sweep never runs a memory turn
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #9: 单条失败不阻断 — one orphan's export throws → that one is skipped,
	//     others continue, return count excludes the failed one
	// -------------------------------------------------------------------------

	test("#9: when one orphan's export throws, others still sweep; failed one stays + count excludes it", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		const ok1 = seedOrphan("agent-ok1", { ageDays: 15, withContent: true });
		const failId = seedOrphan("agent-fail", { ageDays: 15, withContent: true });
		const ok2 = seedOrphan("agent-ok2", { ageDays: 15, withContent: true });

		// Sabotage the failId's steps row so buildArchivePayload's getSteps
		// throws. Easiest reliable way: corrupt the steps table for that one
		// session by dropping the row's content column to a value that makes
		// the JSON-mapper throw. Simpler still: delete the steps rows so
		// getSteps returns [] — but that won't make the EXPORT throw. We need
		// the EXPORT step itself to throw.
		//
		// Approach: spy on db.deleteSessionData so the FIRST call (failId is
		// ordered by updated_at ASC — could be any order) throws. To make the
		// test deterministic regardless of order, sabotage failId's row so
		// buildArchivePayload can't read it: rename the agent_id of failId to
		// contain a path separator — archivePathFor sanitizes it, but
		// writeArchiveJsonAtomic would still write to a safe path. That won't
		// throw either.
		//
		// Cleanest reliable approach: monkey-patch db.getSteps to throw ONLY
		// for failId (buildArchivePayload calls db.getSteps). The patched
		// method throws synchronously → caught by sweep's try/catch → skip.
		const origGetSteps = db.getSteps.bind(db);
		db.getSteps = (sid: string) => {
			if (sid === failId) throw new Error("simulated export failure");
			return origGetSteps(sid);
		};

		try {
			const n = await archiveMod.sweepOrphanSessions(db);
			// 2 of 3 succeeded.
			expect(n).toBe(2);
			// ok1 + ok2 gone; failId still present (skipped).
			expect(sessionRowGone(db, ok1)).toBe(true);
			expect(sessionRowGone(db, ok2)).toBe(true);
			expect(sessionRowGone(db, failId), "failId MUST remain (skipped on export throw)").toBe(false);
			// The failure was logged (warn spy caught it).
			const allWarnArgs = warnSpy.mock.calls.flat().join(" ");
			expect(allWarnArgs).toMatch(/orphan sweep.*failed.*skipped/i);
		} finally {
			warnSpy.mockRestore();
			db.getSteps = origGetSteps;
		}
	});

	// -------------------------------------------------------------------------
	// #10: idempotent — 再跑 → 0
	// -------------------------------------------------------------------------

	test("#10: second sweep after a clean sweep returns 0 (idempotent)", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		seedOrphan("agent-A", { ageDays: 15, withContent: true });
		seedOrphan("agent-B", { ageDays: 15, withContent: true });

		try {
			const first = await archiveMod.sweepOrphanSessions(db);
			expect(first).toBe(2);

			// Second sweep: no candidates remain (rows gone).
			const second = await archiveMod.sweepOrphanSessions(db);
			expect(second).toBe(0);
		} finally {
			warnSpy.mockRestore();
		}
	});
});

// ===========================================================================
// Independent judgement: __recovered__ exclusion is correct (no real session
// is missed; data is not lost). Verified at the SQL layer.
// ===========================================================================

describe("[independent judgement] __recovered__ pseudo-agent exclusion", () => {
	test("a session with agent_id='__recovered__' (15d old) is NOT swept (FK-bookkeeping, not real data)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "zero-archive-sub4-recovered-"));
		process.env.ZERO_CORE_DIR = tmp;
		vi.resetModules();
		try {
			({ SessionDB: SessionDBCtor } = await import("../../src/server/session-db.js"));
			archiveMod = await import("../../src/server/archive-service.js");
			const db = new SessionDBCtor(join(tmp, "sessions.db"));
			// Insert a __recovered__ row directly (mimics ensureSession's FK guard).
			rawDb(db).prepare(
				"INSERT INTO sessions (id, agent_id, is_main, archived, title, created_at, updated_at) " +
				"VALUES (?, '__recovered__', 0, 0, NULL, ?, ?)",
			).run("recovered-row-1", daysAgo(20), daysAgo(20));

			const { log } = await import("../../src/core/logger.js");
			const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
			try {
				const n = await archiveMod.sweepOrphanSessions(db);
				expect(n).toBe(0);
				// __recovered__ row MUST remain (sweep MUST NOT touch bookkeeping).
				const row = rawDb(db).prepare("SELECT agent_id FROM sessions WHERE id = ?").get("recovered-row-1");
				expect(row).toBeDefined();
				expect((row as any).agent_id).toBe("__recovered__");
			} finally {
				warnSpy.mockRestore();
				db.close();
			}
		} finally {
			vi.resetModules();
			delete process.env.ZERO_CORE_DIR;
			if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM */ }
		}
	});
});
