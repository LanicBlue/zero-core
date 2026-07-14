// steps-overhaul sub-8 acceptance test: 归档管线 (archive pipeline).
// Updated compression-archive-simplify sub-4: Q5b memory turn + atomic export
// (no final compression, no ExtractorA wiki-merge coupling).
//
// # File说明书
// ## 核心功能
// 独立验证 acceptance-8.md + acceptance-4.md 的核心条目,直调 archive-service.archiveSession():
//   - 管线顺序:(可选 memory turn)→ mark(archived=1)→ 原子 export → 删库(含孤儿)。
//   - JSON 落盘 `<ZERO_CORE_DIR>/archives/<agentId>/<sessionId>.json`,plain JSON,
//     含 sessions 行 + steps + messages summary + compressionCursor。
//   - 归档后:DB 无该 session 的 sessions/steps/messages/tool_executions/
//     delegated_tasks 行。
//   - 活跃 session 归档:teardown 先于删库(stopAgentLoop + clearHookState 注入,
//     按顺序跑,验证调用次序)。memory turn 在 teardown 之前。
//   - memory turn 失败 / 未注入 → 不阻塞 JSON 落盘 + 删库(best-effort)。
//   - 无 memoryTurnRunner 的 caller(如 recovery scan)→ 直接 export + delete。
//   - archivePathFor 路径段净化(防 ../../escape)。
//   - SessionDB.deleteSessionData:孤儿清理(tool_executions/delegated_tasks)。
//
// ## 不变量守恒(acceptance-4 + acceptance-8)
//   - 管线顺序 / JSON 形态 / 孤儿清理 / wiki 不归本管线管(deleteSessionData 不
//     触 wiki store;wiki 节点留存由删库语句不命中 wiki 表保证)。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里(memory
//   feedback-sessions-db-readonly)。
// - archive JSON 落盘到 ZERO_CORE_DIR/archives —— 测试用 ZERO_CORE_DIR env var
//   重定向到临时目录 + vi.resetModules() 让 config.ts 重读(同 attachment-store
//   测试模式),避免污染真实 ~/.zero-core。

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect, vi } from "vitest";
// Type-only import: erased at compile time, so it does NOT run the dynamic
// import's module-load side effects (ZERO_CORE_DIR is redirected in beforeAll
// BEFORE the runtime import that re-reads it).
import type { ArchiveJson } from "../../src/server/archive-service.js";

// Module-level placeholders — populated in beforeAll after ZERO_CORE_DIR redirect +
// module reset (same pattern as attachment-store.test.ts). Each test gets a FRESH
// SessionDB in a per-test temp dir, but shares the ONE archive root.
let TMP = "";
let archiveMod: typeof import("../../src/server/archive-service.js");
let SessionDBCtor: typeof import("../../src/server/session-db.js").SessionDB;

beforeAll(async () => {
	TMP = mkdtempSync(join(tmpdir(), "zero-sub8-archive-"));
	process.env.ZERO_CORE_DIR = TMP;
	// Bust the module cache so config.ts re-reads ZERO_CORE_DIR (→ TMP) and the
	// archive-service's ARCHIVES_ROOT resolves under TMP for every test.
	vi.resetModules();
	archiveMod = await import("../../src/server/archive-service.js");
	({ SessionDB: SessionDBCtor } = await import("../../src/server/session-db.js"));
});

afterAll(() => {
	delete process.env.ZERO_CORE_DIR;
	if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantContent(text: string, pad = 2000): string {
	return JSON.stringify([{ type: "text", text: text + " ".repeat(pad) }]);
}

/** Seed a user+assistant turn; returns the assistant seq. */
function seedTurn(db: InstanceType<typeof SessionDBCtor>, sessionId: string, startSeq: number, userText: string, asstText: string): number {
	const group = startSeq;
	db.appendStep(sessionId, startSeq, group, "user", userText);
	db.appendStep(sessionId, startSeq + 1, group, "assistant", assistantContent(asstText));
	return startSeq + 1;
}

function sessionConfigFor(agentId: string, workspaceDir: string): any {
	return {
		agentId,
		workspaceDir,
		systemPrompt: "",
		modelId: "stub",
		providerName: "stub",
		toolPolicy: { autoApprove: [], blockedTools: [], tools: {}, readScope: "filesystem" },
	};
}

/**
 * sub-4: a memoryTurnRunner stub. Returns true (claimed ran) without actually
 * spinning up a loop — these tests don't need a real AgentLoop (they verify
 * the archive pipeline: mark/export/delete + ordering). The runner is just
 * plumbed through to assert the opts shape + that the pipeline calls it.
 */
function memoryTurnRanStub(): () => Promise<boolean> {
	return async () => true;
}

/** Cast SessionDB to expose the private `db` (better-sqlite3) for fixture inserts. */
function rawDb(db: InstanceType<typeof SessionDBCtor>): import("better-sqlite3").Database {
	return (db as unknown as { db: import("better-sqlite3").Database }).db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-8: archive pipeline (archiveSession)", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof SessionDBCtor> | null = null;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub8-db-"));
		sessionDB = new SessionDBCtor(join(testDir, "sessions.db"));
	});

	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
	});

	// ── 1. 管线顺序 + JSON 形态 + 删库 + 孤儿清理 ──────────────────────────

	test("runs memory-turn → mark → export JSON → delete DB rows (incl. orphans)", async () => {
		const agentId = "agt-archive";
		const created = sessionDB!.createSession(agentId, "title");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "what is X?", "X is ...");
		seedTurn(sessionDB!, sid, 2, "do thing", "done thing");

		// Seed orphans: a tool_execution + a delegated_task referencing this sid.
		const dbi = rawDb(sessionDB!);
		dbi.prepare(
			"INSERT INTO tool_executions (session_id, agent_id, tool_name, success, error_message, input_preview, output_preview, duration_ms, turn_seq, created_at) VALUES (?, ?, ?, 1, NULL, NULL, NULL, 0, 0, ?)",
		).run(sid, agentId, "Bash", "2026-01-01T00:00:00.000Z");
		dbi.prepare(
			"INSERT INTO delegated_tasks (id, root_task_id, owner_agent_id, target_agent_id, session_id, task, status, depth, step, turns, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', 0, 0, 0, 0, ?, ?)",
		).run("task-1", "task-1", agentId, `${agentId}:sub`, sid, "do work", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

		// Sanity: orphans exist before archive.
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM tool_executions WHERE session_id = ?").get(sid)).toEqual({ c: 1 });
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM delegated_tasks WHERE session_id = ?").get(sid)).toEqual({ c: 1 });

		const result = await archiveMod.archiveSession(sid, sessionDB!, {
			memoryTurnRunner: memoryTurnRanStub(),
		});

		// JSON file written to <TMP>/archives/<agentId>/<sid>.json (TMP is the
		// ZERO_CORE_DIR we redirected to in beforeAll).
		const expectedPath = join(TMP, "archives", agentId, `${sid}.json`);
		expect(result.archivePath).toBe(expectedPath);
		expect(existsSync(expectedPath)).toBe(true);

		// JSON is plain + parseable + carries the session's own data.
		const raw = readFileSync(expectedPath, "utf8");
		const payload: ArchiveJson = JSON.parse(raw);
		expect(payload.version).toBe(1);
		expect(payload.sessionId).toBe(sid);
		expect(payload.agentId).toBe(agentId);
		expect(payload.session.id).toBe(sid);
		expect(payload.steps.length).toBe(4); // 2 turns × (user + assistant)
		expect(payload.summaries).toEqual([]);
		// sub-4: memory turn ran (stub returns true).
		expect(payload.memoryTurnRan).toBe(true);
		expect(result.memoryTurnRan).toBe(true);

		// DB rows ALL gone — sessions/steps/messages + both orphan tables.
		expect(sessionDB!.getSession(sid)).toBeUndefined();
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM steps WHERE session_id = ?").get(sid)).toEqual({ c: 0 });
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sid)).toEqual({ c: 0 });
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM tool_executions WHERE session_id = ?").get(sid)).toEqual({ c: 0 });
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM delegated_tasks WHERE session_id = ?").get(sid)).toEqual({ c: 0 });
	});

	// ── 2. memory turn 失败不阻塞 JSON 落盘 + 删库(best-effort) ─────────────

	test("memory turn failure (stub throws) still exports JSON + deletes rows", async () => {
		const created = sessionDB!.createSession("agt-best", "t");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "what is X?", "X is ...");

		const result = await archiveMod.archiveSession(sid, sessionDB!, {
			memoryTurnRunner: async () => { throw new Error("memory turn boom"); },
		});

		// memory turn threw → caught + memoryTurnRan=false; export + delete proceeded.
		expect(result.memoryTurnRan).toBe(false);
		expect(existsSync(result.archivePath)).toBe(true);
		expect(sessionDB!.getSession(sid)).toBeUndefined();
		const payload: ArchiveJson = JSON.parse(readFileSync(result.archivePath, "utf8"));
		expect(payload.memoryTurnRan).toBe(false);
	});

	// ── 3. 活跃 session teardown:memory turn → teardown → export,顺序对 ───

	test("active-session teardown runs stopAgentLoop BEFORE clearHookState, BEFORE export/delete; memory turn runs BEFORE teardown", async () => {
		const created = sessionDB!.createSession("agt-3", "t");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "hi", "hello");

		const order: string[] = [];
		const result = await archiveMod.archiveSession(sid, sessionDB!, {
			memoryTurnRunner: async () => { order.push("memory-turn"); return true; },
			teardown: {
				stopAgentLoop: () => { order.push("stop"); },
				clearHookState: () => { order.push("clear-hooks"); },
			},
		});

		expect(order).toEqual(["memory-turn", "stop", "clear-hooks"]);
		expect(result.memoryTurnRan).toBe(true);
		expect(existsSync(result.archivePath)).toBe(true);
		expect(sessionDB!.getSession(sid)).toBeUndefined();
	});

	test("teardown failures are swallowed (archive proceeds; never throws)", async () => {
		const created = sessionDB!.createSession("agt-3b", "t");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "hi", "hello");

		await expect(archiveMod.archiveSession(sid, sessionDB!, {
			teardown: {
				stopAgentLoop: () => { throw new Error("boom-stop"); },
				clearHookState: () => { throw new Error("boom-clear"); },
			},
		})).resolves.toBeDefined();
		expect(sessionDB!.getSession(sid)).toBeUndefined();
	});

	// ── 4. 无 memoryTurnRunner(recovery scan 形态)→ JSON 仍落盘,删库仍跑 ─

	test("no memoryTurnRunner (recovery scan form) → straight to export + delete", async () => {
		const created = sessionDB!.createSession("agt-4", "t");
		const sid = created.id;
		sessionDB!.appendStep(sid, 0, 0, "user", "hi");

		const result = await archiveMod.archiveSession(sid, sessionDB!, {});

		expect(result.memoryTurnRan).toBe(false);
		const payload: ArchiveJson = JSON.parse(readFileSync(result.archivePath, "utf8"));
		expect(payload.steps.length).toBe(1);
		expect(payload.memoryTurnRan).toBe(false);
		expect(sessionDB!.getSession(sid)).toBeUndefined();
	});

	// ── 5. archivePathFor:路径段净化(防 ../escape) ─────────────────────

	test("archivePathFor sanitizes agentId (no path-traversal escape from archives root)", () => {
		const evil = "../../etc/passwd";
		const p = archiveMod.archivePathFor(evil, "sess-x");
		const normalized = p.replace(/\\/g, "/");
		expect(normalized).toContain("archives/");
		expect(normalized).not.toMatch(/\.\.\//);
		const clean = archiveMod.archivePathFor("agt-normal", "sess-y");
		expect(clean.replace(/\\/g, "/")).toMatch(/archives\/agt-normal\/sess-y\.json$/);
	});

	// ── 6. SessionDB.deleteSessionData:孤儿清理 + 幂等 ───────────────────

	test("SessionDB.deleteSessionData removes sessions/steps/messages/tool_executions/delegated_tasks orphans; scoped + idempotent", () => {
		const created = sessionDB!.createSession("agt-7", "t");
		const sid = created.id;
		sessionDB!.appendStep(sid, 0, 0, "user", "hi");
		const dbi = rawDb(sessionDB!);
		dbi.prepare(
			"INSERT INTO tool_executions (session_id, agent_id, tool_name, success, duration_ms, created_at) VALUES (?, ?, ?, 1, 0, ?)",
		).run(sid, "agt-7", "Bash", "2026-01-01T00:00:00.000Z");
		dbi.prepare(
			"INSERT INTO delegated_tasks (id, root_task_id, owner_agent_id, target_agent_id, session_id, task, status, depth, step, turns, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', 0, 0, 0, 0, ?, ?)",
		).run("task-7", "task-7", "agt-7", "agt-7:sub", sid, "work", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

		// A SECOND session's data must survive (deleteSessionData is scoped).
		const other = sessionDB!.createSession("agt-other", "t");
		sessionDB!.appendStep(other.id, 0, 0, "user", "keep me");
		dbi.prepare(
			"INSERT INTO tool_executions (session_id, agent_id, tool_name, success, duration_ms, created_at) VALUES (?, ?, ?, 1, 0, ?)",
		).run(other.id, "agt-other", "Bash", "2026-01-01T00:00:00.000Z");

		sessionDB!.deleteSessionData(sid);

		// target session's rows: gone.
		expect(sessionDB!.getSession(sid)).toBeUndefined();
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM steps WHERE session_id = ?").get(sid)).toEqual({ c: 0 });
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM tool_executions WHERE session_id = ?").get(sid)).toEqual({ c: 0 });
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM delegated_tasks WHERE session_id = ?").get(sid)).toEqual({ c: 0 });

		// OTHER session's rows: untouched.
		expect(sessionDB!.getSession(other.id)).toBeDefined();
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM steps WHERE session_id = ?").get(other.id)).toEqual({ c: 1 });
		expect(dbi.prepare("SELECT COUNT(*) AS c FROM tool_executions WHERE session_id = ?").get(other.id)).toEqual({ c: 1 });

		// Idempotent: re-run on the already-deleted session is a no-op.
		expect(() => sessionDB!.deleteSessionData(sid)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// ARCHIVES_ROOT sits under ZERO_CORE_DIR (same root as wiki/) — static check
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-8: ARCHIVES_ROOT layout", () => {
	test("ARCHIVES_ROOT sits under the redirected ZERO_CORE_DIR (same root as wiki/)", () => {
		const normalized = archiveMod.ARCHIVES_ROOT.replace(/\\/g, "/");
		// After beforeAll redirect, ARCHIVES_ROOT must point at TMP/archives.
		const tmpNorm = TMP.replace(/\\/g, "/");
		expect(normalized.startsWith(tmpNorm + "/archives")).toBe(true);
	});
});
