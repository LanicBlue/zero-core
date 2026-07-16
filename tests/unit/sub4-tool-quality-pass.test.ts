// sub-4 (tool-quality-pass) acceptance-4 — verifier-authored tests.
//
// # Authoritative spec
// docs/plan/tool-quality-pass/acceptance-4.md (14 criteria)
//
// # Scope
// Independent, adversarial verification of sub-4 (Task #1 acknowledge deletes
// the delegated_tasks DB row + Task #10 list Summary aggregation). The #1 root
// cause was: Task get → registry.delete clears memory, but the DB row stayed →
// next turn loop's restoreDelegatedTasks re-seeded the task ("get后消失，新turn
// 后又出现"). These tests assert the FIX end-to-end: acknowledgeTask真的调了
// deleteDelegatedTask AND restoreDelegatedTasks真的不再re-seed.
//
// # Harness
// Mirrors sub-3 verifier + runtime-task-restore.test.ts + n4-config-hot-sync:
//   - Real CoreDatabase on a mkdtempSync temp file (no mock; survives across
//     instances so we can rebuild loops against the same DB).
//   - Real SubagentDelegator / AgentLoop with provider-factory vi.mock'd to an
//     inline finish-model (we never drive a real LLM stream — restoreDelegatedTasks
//     + acknowledgeTask are pure DB/registry state transitions).
//   - list Summary tests go through the real task-tool execute path (action:
//     "list") with stub delegateFns.listTasks returning controlled TaskInfo[].
//
// # Not covered here (other acceptance criteria)
//   - #13 typecheck — verified by `npm run typecheck`.
//   - #14 prior task tests still green — verified by running them.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";

// Stub provider-factory BEFORE the first import that pulls agent-loop
// transitively (so the static `resolveModel` import is replaced).
const resolveModelMock = vi.fn();
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: (...args: unknown[]) => resolveModelMock(...args),
	getContextWindow: () => 128000,
	getMultimodal: () => false,
}));

import { CoreDatabase } from "../../src/server/core-database.js";
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";
import { AgentLoop } from "../../src/runtime/agent-loop.js";
import { TaskRegistry } from "../../src/runtime/task-registry.js";
import { taskTool } from "../../src/tools/task-tool.js";
import { getToolExecute, getToolFormat } from "../../src/tools/tool-factory.js";
import type {
	SessionConfig,
	RuntimeCallbacks,
	StreamEvent,
	TaskInfo,
} from "../../src/runtime/types.js";
import type { DelegatedTaskRecord } from "../../src/shared/types.js";

// ─── Inline mock language model (only used so AgentLoop's constructor resolves) ─
function createFinishModel(modelId = "sub4-mock"): LanguageModelV2 {
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId,
		supportedUrls: {},
		async doGenerate() {
			throw new Error("doGenerate not used");
		},
		async doStream() {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue([
						{ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
					]);
					controller.close();
				},
			});
			return { stream } as any;
		},
	} as unknown as LanguageModelV2;
}

// ─── harness: temp CoreDatabase ──────────────────────────────────────────────

let tmpDir: string;
let sessionDB: CoreDatabase;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub4-quality-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	resolveModelMock.mockImplementation(() => createFinishModel());
});
afterEach(() => {
	sessionDB?.close();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	resolveModelMock.mockReset();
});

// ─── helpers ──────────────────────────────────────────────────────────────

/** Build a minimal SubagentDelegator with `db` wired into config. */
function makeDelegator(db?: CoreDatabase): SubagentDelegator {
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
	});
}

/**
 * Insert + mark a delegated_tasks row terminal. `sessionId` is only set when
 * a real backing session row exists (FK session_id→sessions.id is checked at
 * INSERT/UPDATE time); pass undefined otherwise.
 */
function seedDelegatedRow(
	db: CoreDatabase,
	over: Partial<DelegatedTaskRecord> & { id: string },
): DelegatedTaskRecord {
	db.createDelegatedTask({
		id: over.id,
		rootTaskId: over.rootTaskId ?? over.id,
		ownerAgentId: "parent-agent",
		targetAgentId: "dev",
		parentSessionId: over.parentSessionId ?? "parent-session",
		sessionId: over.sessionId,
		task: over.task ?? "do thing",
		status: over.status ?? (over.completedAt ? "completed" : undefined),
	});
	if (over.completedAt || over.result || over.error) {
		db.updateDelegatedTask(over.id, {
			completedAt: over.completedAt,
			result: over.result,
			error: over.error,
		} as any);
	}
	return db.getDelegatedTask(over.id)!;
}

/** Build a real AgentLoop against `db` so we can call restoreDelegatedTasks. */
function buildLoop(db: CoreDatabase, sessionId = "parent-session"): AgentLoop {
	const cfg: SessionConfig = {
		agentId: "parent-agent",
		sessionId,
		workspaceDir: tmpDir,
		systemPrompt: "You are a test agent.",
		modelId: "model-A",
		providerName: "ProviderA",
		db: db as any,
		toolPolicy: { tools: {} },
	} as unknown as SessionConfig;
	const cb: RuntimeCallbacks = {
		onEvent: (_e: StreamEvent) => {},
	};
	return new AgentLoop(cfg, [], cb);
}

/** task-tool execute + format helpers. */
const exec = getToolExecute(taskTool)!;
const fmt = getToolFormat(taskTool)!;
const run = (i: any, c: any) => exec(i, c).then(fmt);
const text = async (i: any, c: any) => {
	const r = await exec(i, c);
	return r.ok ? (r as any).data?.text : r.error;
};

/** Build a CallerCtx-shape ctx with controlled delegateFns. */
function ctxWithListFns(listTasks: (filter?: "running" | "completed") => TaskInfo[], extra: Record<string, any> = {}) {
	const delegateFns: any = { listTasks };
	const delegateKeys = new Set([
		"getTaskResult",
		"listTasks",
		"stopTask",
		"abandonTask",
		"acknowledgeTask",
		"requestTaskFinish",
		"resumeTaskBackground",
		"getTaskRecentCalls",
		"runBackground",
		"delegateTask",
		"delegateTaskBackground",
		"suspendUntilWake",
		"beginWait",
		"endWait",
		"setWaitStartedAt",
		"setToolCallTaskId",
	]);
	for (const [k, v] of Object.entries(extra)) {
		if (delegateKeys.has(k)) delegateFns[k] = v;
	}
	const ctx: any = {
		caller: "internal" as const,
		agentId: "caller",
		workingDir: ".",
		delegateFns,
	};
	for (const [k, v] of Object.entries(extra)) {
		if (!delegateKeys.has(k)) ctx[k] = v;
	}
	return ctx;
}

function task(over: Partial<TaskInfo> = {}): TaskInfo {
	return {
		id: "t1",
		type: "subagent",
		task: "do thing",
		status: "running",
		step: 0,
		turns: 0,
		tokens: 0,
		startedAt: Date.now() - 1000,
		...over,
	} as TaskInfo;
}

// ===========================================================================
// PART A — direct DB + delegator tests (acceptance #1, #2, #4, #7, #8)
// ===========================================================================

describe("[sub-4 #1] deleteDelegatedTask / acknowledgeTask / abandonTask delete DB rows", () => {
	test("#1: session-db.deleteDelegatedTask(id) → getDelegatedTask returns undefined", () => {
		seedDelegatedRow(sessionDB, { id: "t-del", status: "completed" });
		expect(sessionDB.getDelegatedTask("t-del")).toBeDefined();
		sessionDB.deleteDelegatedTask("t-del");
		expect(sessionDB.getDelegatedTask("t-del")).toBeUndefined();
		// Idempotent: second call is a no-op, no throw.
		expect(() => sessionDB.deleteDelegatedTask("t-del")).not.toThrow();
	});

	test("#2 (CORE): delegator.acknowledgeTask on completed task → DB row undefined (not just registry)", () => {
		const delegator = makeDelegator(sessionDB);
		seedDelegatedRow(sessionDB, { id: "t-ack", status: "completed", result: "ok" });
		// Mirror what the loop does at restore time: seed registry from DB row.
		delegator.taskRegistry.seed({
			id: "t-ack",
			type: "subagent",
			task: "do thing",
			status: "completed",
			step: 0,
			turns: 1,
			tokens: 10,
			startedAt: Date.now() - 1000,
			completedAt: Date.now(),
		});
		// Sanity: row exists pre-ack.
		expect(sessionDB.getDelegatedTask("t-ack")).toBeDefined();
		expect(delegator.taskRegistry.get("t-ack")?.status).toBe("completed");

		// ack drop the registry entry AND delete the DB row.
		const ok = delegator.acknowledgeTask("t-ack");
		expect(ok).toBe(true);

		// CORE END-TO-END ASSERTION: row truly deleted, not just memory cleared.
		const rowAfter = sessionDB.getDelegatedTask("t-ack");
		expect(rowAfter).toBeUndefined();
		// And registry is also empty.
		expect(delegator.taskRegistry.get("t-ack")).toBeUndefined();
	});

	test("#2b: acknowledgeTask returns false on unknown / non-terminal — DB row untouched", () => {
		const delegator = makeDelegator(sessionDB);
		seedDelegatedRow(sessionDB, { id: "t-run", status: "running" });
		delegator.taskRegistry.seed({
			id: "t-run",
			type: "subagent",
			task: "x",
			status: "running",
			step: 0,
			turns: 0,
			tokens: 0,
			startedAt: Date.now(),
		});
		// running task → registry.acknowledge refuses (not terminal).
		const ok = delegator.acknowledgeTask("t-run");
		expect(ok).toBe(false);
		// Row NOT deleted (we only delete on successful ack).
		expect(sessionDB.getDelegatedTask("t-run")).toBeDefined();

		// Unknown id → false, no throw, no DB access.
		expect(() => delegator.acknowledgeTask("does-not-exist")).not.toThrow();
	});

	test("#4: delegator.abandonTask on interrupted task → DB row undefined", () => {
		const delegator = makeDelegator(sessionDB);
		// Create a real backing child session so abandonTask can resolve the
		// sessionId and exercise the abandonInterruptedTurn branch (it returns
		// 0 because the session has no interrupted turn_state — fine).
		const child = sessionDB.createSession("dev", "delegated", undefined, {
			sessionKind: "delegated",
			parentSessionId: "parent-session",
			parentTaskId: "t-abd",
			visibility: "hidden",
		});
		seedDelegatedRow(sessionDB, { id: "t-abd", status: "interrupted", sessionId: child.id });
		delegator.taskRegistry.seed({
			id: "t-abd",
			type: "subagent",
			task: "frozen",
			status: "interrupted",
			step: 2,
			turns: 1,
			tokens: 5,
			startedAt: Date.now() - 5000,
		});
		expect(sessionDB.getDelegatedTask("t-abd")).toBeDefined();

		const ok = delegator.abandonTask("t-abd");
		expect(ok).toBe(true);
		// DB row hard-deleted (the fix), not just left at "killed".
		expect(sessionDB.getDelegatedTask("t-abd")).toBeUndefined();
		// And registry cleared.
		expect(delegator.taskRegistry.get("t-abd")).toBeUndefined();
	});

	test("#8: acknowledgeTask without db (config.db undefined) is fault-tolerant", () => {
		// No db wired — stub config.
		const delegator = makeDelegator(undefined);
		delegator.taskRegistry.seed({
			id: "t-nodb",
			type: "subagent",
			task: "x",
			status: "completed",
			step: 0,
			turns: 0,
			tokens: 0,
			startedAt: Date.now() - 100,
			completedAt: Date.now(),
		});
		// Must not throw (?.  short-circuit on db).
		expect(() => delegator.acknowledgeTask("t-nodb")).not.toThrow();
		// registry.acknowledge still effective.
		expect(delegator.taskRegistry.get("t-nodb")).toBeUndefined();
	});

	test("#8b: abandonTask without db is fault-tolerant too", () => {
		const delegator = makeDelegator(undefined);
		delegator.taskRegistry.seed({
			id: "t-nodb-abd",
			type: "subagent",
			task: "x",
			status: "interrupted",
			step: 0,
			turns: 0,
			tokens: 0,
			startedAt: Date.now(),
		});
		expect(() => delegator.abandonTask("t-nodb-abd")).not.toThrow();
		expect(delegator.taskRegistry.get("t-nodb-abd")).toBeUndefined();
	});

	test("#7: archive deleteSessionData on session_id is a safe no-op after deleteDelegatedTask", () => {
		// Create a delegated session + task row, hard-delete the task row, then
		// run the archive pipeline's deleteSessionData (which itself executes
		// `DELETE FROM delegated_tasks WHERE session_id=?`). That DELETE runs
		// against a table that no longer has the row — must be a no-op, not a
		// throw. (archive is async fire-and-forget; a throw there would be
		// swallowed but is still a defect.)
		const child = sessionDB.createSession("dev", "delegated", undefined, {
			sessionKind: "delegated",
			parentSessionId: "parent-session",
			parentTaskId: "t-arch",
			visibility: "hidden",
		});
		seedDelegatedRow(sessionDB, { id: "t-arch", status: "completed", sessionId: child.id });
		expect(sessionDB.getDelegatedTask("t-arch")).toBeDefined();

		// acknowledge path deletes the task row first.
		sessionDB.deleteDelegatedTask("t-arch");
		expect(sessionDB.getDelegatedTask("t-arch")).toBeUndefined();

		// Archive cascade runs DELETE FROM delegated_tasks WHERE session_id=?,
		// matching zero rows. Must not throw.
		expect(() => sessionDB.deleteSessionData(child.id)).not.toThrow();

		// And the inverse ordering still works: archive (deleteSessionData)
		// BEFORE acknowledge removes the row via the session_id cascade.
		const child2 = sessionDB.createSession("dev", "delegated-2", undefined, {
			sessionKind: "delegated",
			parentSessionId: "parent-session",
			parentTaskId: "t-arch2",
			visibility: "hidden",
		});
		seedDelegatedRow(sessionDB, { id: "t-arch2", status: "completed", sessionId: child2.id });
		expect(() => sessionDB.deleteSessionData(child2.id)).not.toThrow();
		// Row removed by the cascade.
		expect(sessionDB.getDelegatedTask("t-arch2")).toBeUndefined();
	});
});

// ===========================================================================
// PART B — E2E re-seed behavior via real AgentLoop.restoreDelegatedTasks
// ===========================================================================

describe("[sub-4 #1] re-seed behavior via AgentLoop.restoreDelegatedTasks (E2E)", () => {
	test("#3 (CORE): acknowledged completed task does NOT re-seed into a fresh loop", () => {
		// Setup: completed row in DB.
		seedDelegatedRow(sessionDB, { id: "t-resurrect", status: "completed", result: "done" });

		// Build loop1 + restore the row → registry has the task.
		const loop1 = buildLoop(sessionDB);
		const records1 = sessionDB.listDelegatedTasks({ parentSessionId: "parent-session" });
		expect(records1.map((r) => r.id)).toContain("t-resurrect");
		loop1.restoreDelegatedTasks(records1);
		const tree1 = (loop1 as any).delegator.taskRegistry.list() as TaskInfo[];
		expect(tree1.map((t) => t.id)).toContain("t-resurrect");

		// Acknowledge via the production delegator (Task get path).
		const ok = (loop1 as any).delegator.acknowledgeTask("t-resurrect");
		expect(ok).toBe(true);

		// CORE END-TO-END ASSERTION #1: DB row is gone (so listDelegatedTasks
		// would no longer return it).
		expect(sessionDB.getDelegatedTask("t-resurrect")).toBeUndefined();
		const recordsAfter = sessionDB.listDelegatedTasks({ parentSessionId: "parent-session" });
		expect(recordsAfter.map((r) => r.id)).not.toContain("t-resurrect");

		// CORE END-TO-END ASSERTION #2: simulate "next turn / loop rebuild" —
		// a fresh AgentLoop's restoreDelegatedTasks called with the now-empty
		// DB list does NOT re-seed the task.
		const loop2 = buildLoop(sessionDB);
		loop2.restoreDelegatedTasks(sessionDB.listDelegatedTasks({ parentSessionId: "parent-session" }));
		const tree2 = (loop2 as any).delegator.taskRegistry.list() as TaskInfo[];
		expect(tree2.map((t) => t.id)).not.toContain("t-resurrect");
		expect(tree2).toEqual([]);
	});

	test("#3b: the SAME effect via the Task `get` action tool path (real user surface)", async () => {
		// Cover that the user-facing path (Task action=get → acknowledgeTask →
		// deleteDelegatedTask) also deletes the row — defense against future
		// refactors that sever the wiring inside acknowledgeTask.
		seedDelegatedRow(sessionDB, { id: "t-toolget", status: "completed", result: "done" });
		const loop = buildLoop(sessionDB);
		// Seed registry (production: restoreDelegatedTasks would do this).
		(loop as any).delegator.taskRegistry.seed({
			id: "t-toolget",
			type: "subagent",
			task: "x",
			status: "completed",
			step: 1,
			turns: 1,
			tokens: 5,
			startedAt: Date.now() - 1000,
			completedAt: Date.now(),
			result: "done",
		});
		// Wire the real delegator's methods onto ctx.delegateFns.
		const ctx: any = {
			caller: "internal" as const,
			agentId: "parent-agent",
			sessionId: "parent-session",
			workingDir: tmpDir,
			delegateFns: {
				getTaskResult: (id: string) => (loop as any).delegator.getTaskResult(id),
				getTaskRecentCalls: (id: string, n?: number) => (loop as any).delegator.getTaskRecentCalls(id, n),
				acknowledgeTask: (id: string) => (loop as any).delegator.acknowledgeTask(id),
			},
		};
		// Pre-condition.
		expect(sessionDB.getDelegatedTask("t-toolget")).toBeDefined();

		const out = await text({ action: "get", task_id: "t-toolget" }, ctx);
		expect(out).toContain("t-toolget");

		// CORE: row really deleted via the user path.
		expect(sessionDB.getDelegatedTask("t-toolget")).toBeUndefined();
	});

	test("#5: completed task NOT acknowledged still re-seeds (no false negative)", () => {
		seedDelegatedRow(sessionDB, { id: "t-keep", status: "completed", result: "ok" });

		const loop1 = buildLoop(sessionDB);
		// restore from DB → registry has it.
		loop1.restoreDelegatedTasks(sessionDB.listDelegatedTasks({ parentSessionId: "parent-session" }));
		let tree = (loop1 as any).delegator.taskRegistry.list() as TaskInfo[];
		expect(tree.map((t) => t.id)).toContain("t-keep");

		// Simulate session restart: a NEW loop reads the same DB and re-seeds.
		const loop2 = buildLoop(sessionDB);
		loop2.restoreDelegatedTasks(sessionDB.listDelegatedTasks({ parentSessionId: "parent-session" }));
		tree = (loop2 as any).delegator.taskRegistry.list() as TaskInfo[];
		expect(tree.map((t) => t.id)).toContain("t-keep");
		expect(tree.find((t) => t.id === "t-keep")?.status).toBe("completed");
	});

	test("#6: interrupted task NOT abandoned still re-seeds as interrupted (no sub-8 regression)", () => {
		seedDelegatedRow(sessionDB, { id: "t-frozen", status: "interrupted" });

		// Note: seedStatus resolution in restoreDelegatedTasks checks
		// getIncompleteTurn for child session — for an interrupted row without
		// a backing child session / incomplete turn_state row, the persisted
		// "interrupted" status is kept (the "else" branch). Assert that.
		const loop = buildLoop(sessionDB);
		loop.restoreDelegatedTasks(sessionDB.listDelegatedTasks({ parentSessionId: "parent-session" }));
		const tree = (loop as any).delegator.taskRegistry.list() as TaskInfo[];
		const t = tree.find((x) => x.id === "t-frozen");
		expect(t).toBeDefined();
		expect(t?.status).toBe("interrupted");
	});

	test("#6b: abandoned interrupted task does NOT re-seed into a fresh loop", () => {
		// Mirror of #3 for the abandon path — once abandon hard-deletes the
		// row, restart must not bring it back as interrupted.
		seedDelegatedRow(sessionDB, { id: "t-abandon-resurrect", status: "interrupted" });
		const loop1 = buildLoop(sessionDB);
		loop1.restoreDelegatedTasks(sessionDB.listDelegatedTasks({ parentSessionId: "parent-session" }));
		expect((loop1 as any).delegator.taskRegistry.list().map((t: TaskInfo) => t.id)).toContain("t-abandon-resurrect");

		// Abandon (TaskKill interrupted path) → row deleted.
		const ok = (loop1 as any).delegator.abandonTask("t-abandon-resurrect");
		expect(ok).toBe(true);
		expect(sessionDB.getDelegatedTask("t-abandon-resurrect")).toBeUndefined();

		// Fresh loop rebuild → empty.
		const loop2 = buildLoop(sessionDB);
		loop2.restoreDelegatedTasks(sessionDB.listDelegatedTasks({ parentSessionId: "parent-session" }));
		const tree2 = (loop2 as any).delegator.taskRegistry.list() as TaskInfo[];
		expect(tree2.map((t) => t.id)).not.toContain("t-abandon-resurrect");
	});
});

// ===========================================================================
// PART C — Task list Summary aggregation (acceptance #9, #10, #11, #12)
// ===========================================================================

describe("[sub-4 #10] Task list Summary aggregation", () => {
	test("#9: list output contains a Summary line", async () => {
		const now = Date.now();
		const tasks: TaskInfo[] = [
			task({ id: "ls-1", status: "running", tokens: 50, startedAt: now - 5_000 }),
		];
		const out = await text({ action: "list" }, ctxWithListFns(() => tasks));
		expect(out).toMatch(/Summary:\s+\d+\s+tasks?\s*\|\s*tokens\s+\d+/);
	});

	test("#10: Summary aggregates tokens (sum) + elapsed (sum) + max correctly", async () => {
		// 3 completed tasks, tokens 100/200/300 → total 600. Use deterministic
		// startedAt/completedAt so elapsed is predictable (no Date.now drift).
		//   t-A: starts 0, ends 10000 → 10s
		//   t-B: starts 0, ends 20000 → 20s
		//   t-C: starts 0, ends 30000 → 30s
		// → total elapsed 60s, max 30s.
		const tasks: TaskInfo[] = [
			task({
				id: "agg-a",
				status: "completed",
				tokens: 100,
				startedAt: 0,
				completedAt: 10_000,
			}),
			task({
				id: "agg-b",
				status: "completed",
				tokens: 200,
				startedAt: 0,
				completedAt: 20_000,
			}),
			task({
				id: "agg-c",
				status: "completed",
				tokens: 300,
				startedAt: 0,
				completedAt: 30_000,
			}),
		];
		const out = await text({ action: "list" }, ctxWithListFns(() => tasks));
		// tokens 600, elapsed 60s, max 30s, running 0.
		expect(out).toContain("Summary: 3 tasks");
		expect(out).toContain("tokens 600");
		expect(out).toContain("elapsed 60s");
		expect(out).toContain("running 0");
		expect(out).toContain("max 30s");
	});

	test("#10b: Summary reflects a mix of running + completed (tokens sum still all)", async () => {
		// running task contributes now-startedAt (unpredictable, just >0).
		// completed tasks contribute completedAt-startedAt (deterministic).
		// tokens still summed across ALL tasks regardless of state.
		const now = Date.now();
		const tasks: TaskInfo[] = [
			task({
				id: "mix-r",
				status: "running",
				tokens: 100,
				startedAt: now - 7_000, // ~7s running
			}),
			task({
				id: "mix-c",
				status: "completed",
				tokens: 250,
				startedAt: now - 100_000,
				completedAt: now - 80_000, // 20s completed
			}),
		];
		const out = await text({ action: "list" }, ctxWithListFns(() => tasks));
		expect(out).toContain("Summary: 2 tasks");
		expect(out).toContain("tokens 350"); // 100 + 250
		expect(out).toContain("running 1");
		// max must be at least 20s (the completed task); the running one's
		// exact value depends on Date.now at format time so we don't pin it.
		const maxMatch = out.match(/max (\d+)s/);
		expect(maxMatch).not.toBeNull();
		expect(Number(maxMatch![1])).toBeGreaterThanOrEqual(20);
	});

	test("#11: empty list does not crash (Summary not required when no tasks)", async () => {
		// listTasks returns [] → early-return "No tasks." before Summary.
		const out = await text({ action: "list" }, ctxWithListFns(() => []));
		// Must not crash. Either "No tasks." or a Summary line at 0 — both fine.
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
		// Sanity: the early-return path emits "No tasks." text.
		expect(out).toMatch(/No tasks/);
	});

	test("#11b: empty filter='running' path uses 'No running tasks.'", async () => {
		const out = await text({ action: "list", filter: "running" }, ctxWithListFns(() => []));
		expect(out).toMatch(/No running tasks/);
	});

	test("#12: list with taskIds filter still renders Summary (post-filter set)", async () => {
		const all: TaskInfo[] = [
			task({ id: "f-1", status: "completed", tokens: 100, startedAt: 0, completedAt: 5_000 }),
			task({ id: "f-2", status: "completed", tokens: 200, startedAt: 0, completedAt: 6_000 }),
			task({ id: "f-3", status: "completed", tokens: 999, startedAt: 0, completedAt: 99_000 }), // excluded
		];
		// listTasks returns all; the tool then filters to {f-1, f-2}.
		const out = await text({ action: "list", taskIds: ["f-1", "f-2"] }, ctxWithListFns(() => all));
		// Summary should reflect only the filtered set (tokens 100+200=300,
		// not 100+200+999).
		expect(out).toContain("Summary: 2 tasks");
		expect(out).toContain("tokens 300");
		expect(out).toContain("max 6s");
		// And the excluded task's lines should not appear in the body either.
		expect(out).not.toMatch(/\bf-3\b/);
	});

	test("#12b: list with filter='completed' still renders Summary", async () => {
		const now = Date.now();
		const tasks: TaskInfo[] = [
			task({ id: "fc-r", status: "running", tokens: 999, startedAt: now }),
			task({ id: "fc-c", status: "completed", tokens: 42, startedAt: 0, completedAt: 4_000 }),
		];
		// listTasks is called with filter="completed" → returns only the
		// completed task. Summary should reflect that single task.
		const out = await text(
			{ action: "list", filter: "completed" },
			ctxWithListFns((f) => (f === "completed" ? [tasks[1]] : tasks)),
		);
		expect(out).toContain("Summary: 1 tasks");
		expect(out).toContain("tokens 42");
		expect(out).toContain("max 4s");
	});
});
