// archive-no-residual sub-1 — adversarial verification of acceptance-1.md.
//
// # File 说明书
//
// ## 核心功能
// 独立验证 acceptance-1.md 的 11 个条目(由独立的 adversarial verifier 写,
// 非实施者)。Harness 镜像 task-cleanup-db.test.ts:real CoreDatabase on temp file +
// real SubagentDelegator(db 接进 config)。fireOnTaskTerminal 是 private,通过
// `(delegator as any).fireOnTaskTerminal(...)` 反射调用——同 harness 已用反射
// 访问 `(delegator.taskRegistry as any).tasks.get(...)` 的既定风格。
//
//   #1   completed → 行立即删 + 子 session archived=1。
//   #2   failed → 同上。
//   #3   killed 不走此路径(stopTask 不 fire onTaskTerminal;行不删,mark 不打)。
//   #4   无子 session 早退:row.sessionId 为空 → 不抛、不 mark、不删。
//   #5   memory 按接线:(a) onTaskTerminal 已接 → 被调一次含 5 参;
//        (b) 未接(db-only)→ 不抛、行仍删、mark 仍打。
//   #6   archiveDelegatedSession 不再回读行(spy on db.getDelegatedTask =0)。
//   #7   mark 幂等:fireOnTaskTerminal 后再调 markArchivedTransient 不报错。
//   #8   fire-and-forget 不抛穿:onTaskTerminal reject/throw → fireOnTaskTerminal
//        不抛、① 已完成(行已删、mark 已打)。
//   #9   源码:archiveDelegatedSession / SessionConfig.archiveDelegatedSession /
//        SubagentDelegatorDeps.onTaskTerminal 含 childAgentId? / childModelId?。
//   #10  源码:fireOnTaskTerminal 内 markArchivedTransient + deleteDelegatedTask
//        在 onTaskTerminal 调用之前(顺序断言)。
//   #11  源码:archiveDelegatedSession 不再 getDelegatedTask 回读。
//
// ## 对抗性核查
//   - 行删除 + mark 打的顺序:mark BEFORE delete(注释明示;不假设幂等就乱序)。
//   - 回调不回读行:#6 spy + #11 grep 双重锁死(行为 + 源码)。
//   - ① 无条件:#5(b) 显式构造无 onTaskTerminal delegator,断言 mark+delete 仍跑。
//   - fire-and-forget 不抛穿:#8 同步 throw + 异步 reject 两态。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里(自己开,自己关,
//   不碰 backend 占用的 DB)。
// - 不 git commit;不修改 src/(verifier 只写测试)。
// - Windows better-sqlite3 崩溃规避:本文件单跑,不进全量套件。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreDatabase } from "../../src/server/core-database.js";
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";
import { log } from "../../src/core/logger.js";
import type { SessionConfig } from "../../src/runtime/types.js";

let tmpDir: string;
let sessionDB: CoreDatabase;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-archive-sub1-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
});
afterEach(() => {
	sessionDB?.close();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness helpers (mirror task-cleanup-db.test.ts shape).
// ---------------------------------------------------------------------------

interface MakeDelegatorOpts {
	onTaskTerminal?: (taskId: string, status: "completed" | "failed", childSessionId: string, childAgentId?: string, childModelId?: string) => Promise<void> | void;
}

function makeDelegator(db: CoreDatabase, opts?: MakeDelegatorOpts): SubagentDelegator {
	const cfg = {
		agentId: "parent-agent",
		sessionId: "parent-session",
		workspaceDir: tmpDir,
		db: db as any,
	} as SessionConfig;
	return new SubagentDelegator({
		config: cfg,
		providers: [],
		emit: () => {},
		createSubLoop: () => ({} as any),
		getToolConfig: () => ({}),
		onTaskTerminal: opts?.onTaskTerminal,
	});
}

/** Create a real child session row so markArchivedTransient has something to update. */
function seedChildSession(db: CoreDatabase, agentId = "dev"): string {
	const created = db.createSession(agentId, "delegated child", undefined, {
		sessionKind: "delegated",
		parentSessionId: "parent-session",
		visibility: "hidden",
	});
	return created.id;
}

/** Insert a delegated_tasks row with sessionId set. Returns the seeded record. */
function seedDelegatedRow(
	db: CoreDatabase,
	taskId: string,
	childSessionId: string,
	overrides?: { targetAgentId?: string; modelId?: string; status?: any },
): void {
	db.createDelegatedTask({
		id: taskId,
		rootTaskId: taskId,
		ownerAgentId: "parent-agent",
		targetAgentId: overrides?.targetAgentId ?? "dev",
		modelId: overrides?.modelId ?? "claude-test-model",
		parentSessionId: "parent-session",
		sessionId: childSessionId,
		task: "do thing",
		status: overrides?.status ?? "running",
	});
}

/** fireOnTaskTerminal is private — invoke via reflection (same style as
 *  task-cleanup-db.test.ts reaching into taskRegistry.tasks). */
function fire(delegator: SubagentDelegator, taskId: string, status: "completed" | "failed"): void {
	(delegator as unknown as { fireOnTaskTerminal: (id: string, s: "completed" | "failed") => void })
		.fireOnTaskTerminal(taskId, status);
}

/** Read sessions.archived flag straight from the row (defensive against any
 *  future SessionRecord shape change). */
function archivedFlag(db: CoreDatabase, sessionId: string): number | undefined {
	const raw = (db as unknown as { db: import("better-sqlite3").Database }).db;
	const row = raw.prepare("SELECT archived FROM sessions WHERE id = ?").get(sessionId) as { archived: number } | undefined;
	return row?.archived;
}

// ===========================================================================
// #1: completed → row deleted + child archived=1
// ===========================================================================

describe("[#1] completed → db.getDelegatedTask(taskId) undefined + child archived=1", () => {
	test("fireOnTaskTerminal(completed) deletes the row + marks the child", () => {
		const taskId = "t-comp-1";
		const child = seedChildSession(sessionDB);
		seedDelegatedRow(sessionDB, taskId, child, { status: "running" });

		// Sanity: row + child session present, child not yet archived.
		expect(sessionDB.getDelegatedTask(taskId)).toBeDefined();
		expect(archivedFlag(sessionDB, child)).toBe(0);

		const delegator = makeDelegator(sessionDB);
		expect(() => fire(delegator, taskId, "completed")).not.toThrow();

		// Row gone.
		expect(sessionDB.getDelegatedTask(taskId)).toBeUndefined();
		// Child marked.
		expect(archivedFlag(sessionDB, child)).toBe(1);
		// Recoverable via listArchivedTransientSessions.
		expect(sessionDB.listArchivedTransientSessions().map((r) => r.id)).toContain(child);
	});
}, 30000);

// ===========================================================================
// #2: failed → same shape as #1
// ===========================================================================

describe("[#2] failed → row deleted + child archived=1", () => {
	test("fireOnTaskTerminal(failed) deletes the row + marks the child", () => {
		const taskId = "t-fail-2";
		const child = seedChildSession(sessionDB);
		seedDelegatedRow(sessionDB, taskId, child, { status: "running" });

		expect(sessionDB.getDelegatedTask(taskId)).toBeDefined();
		expect(archivedFlag(sessionDB, child)).toBe(0);

		const delegator = makeDelegator(sessionDB);
		expect(() => fire(delegator, taskId, "failed")).not.toThrow();

		expect(sessionDB.getDelegatedTask(taskId)).toBeUndefined();
		expect(archivedFlag(sessionDB, child)).toBe(1);
	});
}, 30000);

// ===========================================================================
// #3: killed doesn't go through fireOnTaskTerminal
// ===========================================================================

describe("[#3] killed (stopTask) does NOT trigger terminal bookkeeping", () => {
	test("stopTask sets status=killed but row remains + child NOT marked", () => {
		const taskId = "t-kill-3";
		const child = seedChildSession(sessionDB);
		seedDelegatedRow(sessionDB, taskId, child, { status: "running" });

		const delegator = makeDelegator(sessionDB);
		// Register in the in-memory registry so stopTask has something to kill.
		delegator.taskRegistry.create(taskId, "subagent", "work");
		expect(delegator.stopTask(taskId)).toBe(true);

		// Row still present (killed path uses abandonTask/acknowledgeTask to
		// delete — sub-1 does NOT touch killed).
		const row = sessionDB.getDelegatedTask(taskId);
		expect(row).toBeDefined();
		expect(row?.status).toBe("killed");
		// Child NOT marked (fireOnTaskTerminal never ran).
		expect(archivedFlag(sessionDB, child)).toBe(0);
		expect(sessionDB.listArchivedTransientSessions().map((r) => r.id)).not.toContain(child);
	});
}, 30000);

// ===========================================================================
// #4: no sessionId → early return, no throw, no mark, no delete
// ===========================================================================

describe("[#4] row without sessionId → early return (no throw, no mark, no delete)", () => {
	test("seed row with sessionId=null → fireOnTaskTerminal is a no-op", () => {
		const taskId = "t-noses-4";
		// Seed a row with sessionId=null (test stub without persistence).
		sessionDB.createDelegatedTask({
			id: taskId,
			rootTaskId: taskId,
			ownerAgentId: "parent-agent",
			targetAgentId: "dev",
			parentSessionId: "parent-session",
			sessionId: undefined,
			task: "do thing",
			status: "running",
		});
		// Sanity: row exists with empty sessionId (row mapper converts null → undefined).
		expect(sessionDB.getDelegatedTask(taskId)?.sessionId).toBeUndefined();

		const delegator = makeDelegator(sessionDB, {
			// Should NOT be called — early return before callback.
			onTaskTerminal: () => { throw new Error("onTaskTerminal must not fire for sessionId-less row"); },
		});

		expect(() => fire(delegator, taskId, "completed")).not.toThrow();

		// Row still there (NOT deleted).
		expect(sessionDB.getDelegatedTask(taskId)).toBeDefined();
	});
}, 30000);

// ===========================================================================
// #5: memory preservation callback wiring
// ===========================================================================

describe("[#5a] onTaskTerminal wired → fires exactly once with all 5 args", () => {
	test("callback receives (taskId, status, childSessionId, childAgentId, childModelId)", () => {
		const taskId = "t-cb-5a";
		const child = seedChildSession(sessionDB);
		seedDelegatedRow(sessionDB, taskId, child, {
			targetAgentId: "researcher",
			modelId: "claude-opus-test",
		});

		const calls: Array<{ taskId: string; status: string; childSid: string; agent?: string; model?: string }> = [];
		const delegator = makeDelegator(sessionDB, {
			onTaskTerminal: (id, status, childSid, agent, model) => {
				calls.push({ taskId: id, status, childSid, agent, model });
			},
		});

		fire(delegator, taskId, "completed");

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			taskId,
			status: "completed",
			childSid: child,
			agent: "researcher",
			model: "claude-opus-test",
		});
	});
}, 30000);

describe("[#5b] onTaskTerminal UNWIRED (db-only delegator) → no throw, row still deleted, mark still set", () => {
	test("terminal bookkeeping ① is unconditional on callback wiring", () => {
		const taskId = "t-nocb-5b";
		const child = seedChildSession(sessionDB);
		seedDelegatedRow(sessionDB, taskId, child);

		// No onTaskTerminal passed → this.onTaskTerminal is undefined.
		const delegator = makeDelegator(sessionDB);

		expect(() => fire(delegator, taskId, "completed")).not.toThrow();

		// ① ran anyway: row deleted, child marked.
		expect(sessionDB.getDelegatedTask(taskId)).toBeUndefined();
		expect(archivedFlag(sessionDB, child)).toBe(1);
	});
}, 30000);

// ===========================================================================
// #6: archiveDelegatedSession does not re-read the (already-deleted) row
// ===========================================================================

describe("[#6] AgentService.archiveDelegatedSession does NOT call getDelegatedTask", () => {
	// Mock archive-service so the spy on db.getDelegatedTask only observes
	// archiveDelegatedSession's own calls (not any downstream pipeline reads).
	// Then assert: getDelegatedTask is never invoked from within archiveDelegatedSession.

	let testDir: string;
	let archiveDB: CoreDatabase;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-archive-sub1-noReread-"));
		archiveDB = new CoreDatabase(join(testDir, "core.db"));
	});
	afterEach(() => {
		archiveDB?.close();
		if (testDir) rmSync(testDir, { recursive: true, force: true });
	});

	function interceptArchiveService() {
		vi.doMock("../../src/server/archive-service.js", () => ({
			archiveSession: vi.fn(async () => ({
				archivePath: "/dev/null/mock.json",
				memoryTurnRan: false,
				stepsExported: 0,
				summariesExported: 0,
			})),
			archivePathFor: () => "/dev/null/mock.json",
			ARCHIVES_ROOT: "/dev/null",
			recoverInterruptedArchives: vi.fn(async () => 0),
		}));
	}

	test("archiveDelegatedSession with explicit agent/model args never re-reads the row", async () => {
		const agentId = "dev-6";
		const created = archiveDB.createSession(agentId, "child", undefined, { sessionKind: "delegated" });
		const childSid = created.id;

		interceptArchiveService();
		try {
			vi.resetModules();
			const { AgentService } = await import("../../src/server/agent-service.js");
			const svc = new AgentService(testDir, archiveDB);

			// Spy AFTER construction so we only count calls made during
			// archiveDelegatedSession itself (not any constructor/agentStore reads).
			const spy = vi.spyOn(archiveDB, "getDelegatedTask");

			// Args explicitly threaded: taskId + childSid + agent + model.
			// No row exists for taskId; archiveDelegatedSession must NOT try to
			// backfill by reading the row.
			await svc.archiveDelegatedSession("task-deleted-already", childSid, agentId, "claude-test");

			expect(spy).not.toHaveBeenCalled();
		} finally {
			vi.doUnmock("../../src/server/archive-service.js");
			vi.resetModules();
		}
	});
}, 30000);

// ===========================================================================
// #7: mark idempotent — re-marking after fireOnTaskTerminal is a no-op
// ===========================================================================

describe("[#7] markArchivedTransient is idempotent (post-fire re-mark is a no-op)", () => {
	test("fireOnTaskTerminal then markArchivedTransient(child) again does not throw + archived stays 1", () => {
		const taskId = "t-idem-7";
		const child = seedChildSession(sessionDB);
		seedDelegatedRow(sessionDB, taskId, child);

		const delegator = makeDelegator(sessionDB);
		fire(delegator, taskId, "completed");
		expect(archivedFlag(sessionDB, child)).toBe(1);

		// Re-mark directly — must not throw (the archive pipeline ② also calls
		// markArchivedTransient; idempotency is the design contract).
		expect(() => sessionDB.markArchivedTransient(child)).not.toThrow();
		expect(archivedFlag(sessionDB, child)).toBe(1);
		// Row still gone (re-marking does NOT resurrect the deleted row).
		expect(sessionDB.getDelegatedTask(taskId)).toBeUndefined();
	});
}, 30000);

// ===========================================================================
// #8: fire-and-forget — onTaskTerminal reject/throw does not propagate
// ===========================================================================

describe("[#8] onTaskTerminal reject/throw does not propagate; ① already complete", () => {
	test("(a) callback THROWS synchronously → fireOnTaskTerminal swallows + ① done", async () => {
		const taskId = "t-throw-8a";
		const child = seedChildSession(sessionDB);
		seedDelegatedRow(sessionDB, taskId, child);

		// Suppress the warn log so the throw doesn't noise up the test output.
		// log is imported statically at file top — same singleton the runtime
		// captures in its closure (subagent-delegator imports the same module).
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			const delegator = makeDelegator(sessionDB, {
				onTaskTerminal: () => { throw new Error("sync boom"); },
			});
			expect(() => fire(delegator, taskId, "completed")).not.toThrow();

			// ① still ran BEFORE ② threw: row deleted + child marked.
			expect(sessionDB.getDelegatedTask(taskId)).toBeUndefined();
			expect(archivedFlag(sessionDB, child)).toBe(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("(b) callback returns a REJECTED promise → fireOnTaskTerminal swallows + ① done", async () => {
		const taskId = "t-reject-8b";
		const child = seedChildSession(sessionDB);
		seedDelegatedRow(sessionDB, taskId, child);

		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			const delegator = makeDelegator(sessionDB, {
				onTaskTerminal: () => Promise.reject(new Error("async boom")),
			});
			expect(() => fire(delegator, taskId, "completed")).not.toThrow();

			// ① done synchronously.
			expect(sessionDB.getDelegatedTask(taskId)).toBeUndefined();
			expect(archivedFlag(sessionDB, child)).toBe(1);

			// Let the rejected promise's .catch handler (which the runtime
			// attaches as fire-and-forget) drain before assertions on log.
			await vi.waitFor(() => { expect(warnSpy).toHaveBeenCalled(); }, { timeout: 2000 });
		} finally {
			warnSpy.mockRestore();
		}
	});
}, 30000);

// ===========================================================================
// #9 + #10 + #11: source-level invariants
// ===========================================================================

describe("[#9 + #10 + #11] source-level invariants (archive-no-residual sub-1)", () => {
	const DELEGATOR_SRC = join(__dirname, "..", "..", "src", "runtime", "subagent-delegator.ts");
	const TYPES_SRC = join(__dirname, "..", "..", "src", "runtime", "types.ts");
	const AGENT_SVC_SRC = join(__dirname, "..", "..", "src", "server", "agent-service.ts");

	test("#9a: SubagentDelegatorDeps.onTaskTerminal signature carries childAgentId? + childModelId?", () => {
		const src = readFileSync(DELEGATOR_SRC, "utf8");
		// Slice around the onTaskTerminal declaration so the assertion is scoped
		// (avoids matching an unrelated call site).
		const idx = src.indexOf("onTaskTerminal?:");
		expect(idx).toBeGreaterThan(-1);
		const decl = src.slice(idx, idx + 400);
		expect(decl).toMatch(/childAgentId\?:\s*string/);
		expect(decl).toMatch(/childModelId\?:\s*string/);
	});

	test("#9b: SessionConfig.archiveDelegatedSession signature carries childAgentId? + childModelId?", () => {
		const src = readFileSync(TYPES_SRC, "utf8");
		const idx = src.indexOf("archiveDelegatedSession?:");
		expect(idx).toBeGreaterThan(-1);
		const decl = src.slice(idx, idx + 400);
		expect(decl).toMatch(/childAgentId\?:\s*string/);
		expect(decl).toMatch(/childModelId\?:\s*string/);
	});

	test("#9c: AgentService.archiveDelegatedSession method body declares childAgentId? + childModelId? params", () => {
		const src = readFileSync(AGENT_SVC_SRC, "utf8");
		const start = src.indexOf("async archiveDelegatedSession(");
		expect(start).toBeGreaterThan(-1);
		const sig = src.slice(start, start + 400);
		expect(sig).toMatch(/childAgentId\?:\s*string/);
		expect(sig).toMatch(/childModelId\?:\s*string/);
	});

	test("#10: fireOnTaskTerminal runs markArchivedTransient + deleteDelegatedTask BEFORE onTaskTerminal", () => {
		const src = readFileSync(DELEGATOR_SRC, "utf8");
		const start = src.indexOf("private fireOnTaskTerminal(");
		expect(start).toBeGreaterThan(-1);
		// Slice to the NEXT method declaration on the class — not the first `\t}`
		// (which is a nested if-early-return brace, not the method close).
		const nextMethodIdx = src.indexOf("private buildSubEventHandler(", start);
		expect(nextMethodIdx, "next method boundary must be findable").toBeGreaterThan(start);
		const body = src.slice(start, nextMethodIdx);
		expect(body.length).toBeGreaterThan(0);

		const markIdx = body.indexOf("markArchivedTransient");
		const deleteIdx = body.indexOf("deleteDelegatedTask");
		const callIdx = body.indexOf("this.onTaskTerminal(");

		expect(markIdx, "markArchivedTransient must be referenced").toBeGreaterThan(-1);
		expect(deleteIdx, "deleteDelegatedTask must be referenced").toBeGreaterThan(-1);
		expect(callIdx, "this.onTaskTerminal(...) call must be present").toBeGreaterThan(-1);

		// Strict ordering: mark BEFORE delete BEFORE onTaskTerminal call.
		expect(markIdx).toBeLessThan(deleteIdx);
		expect(deleteIdx).toBeLessThan(callIdx);
	});

	test("#11: archiveDelegatedSession body no longer references getDelegatedTask (uses caller args)", () => {
		const src = readFileSync(AGENT_SVC_SRC, "utf8");
		const start = src.indexOf("async archiveDelegatedSession(");
		expect(start).toBeGreaterThan(-1);
		// Slice to the next method.
		const end = src.indexOf("\tasync ", start + 1);
		const body = src.slice(start, end);
		expect(body.length).toBeGreaterThan(0);

		// getDelegatedTask must NOT appear anywhere in the method body.
		expect(body, "archiveDelegatedSession must not re-read delegated_tasks row").not.toMatch(/getDelegatedTask/);
		// And it must use the threaded args.
		expect(body).toMatch(/childAgentId/);
		expect(body).toMatch(/childModelId/);
	});
});
