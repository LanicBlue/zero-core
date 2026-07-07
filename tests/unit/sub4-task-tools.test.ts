// sub-4 (subagent-recovery) acceptance unit tests for the new Task tool family.
//
// Covers acceptance-4.md cases 4–9 directly:
//   - TaskGet: running (recent calls, no output) / interrupted (waited + marker) /
//     completed (full result + acknowledge consumes the task).
//   - TaskKill: running → kill (stopTask); interrupted → abandon (abandonTask).
//   - TaskResume: bash rejected; non-interrupted rejected; turn_seq guard
//     invoked (the no-turn+1 invariant — case 9).
//   - getTaskRecentCalls (delegator): agent → live sub-loop recorder; bash →
//     command-only (no stdout leak).
//
// Tools are exercised via getToolExecute (the raw execute fn with a synthetic
// ctx), mirroring agent-delegate-tool.test.ts. The turn_seq guard is tested at
// the SubagentDelegator layer (resumeTaskBackground) against a fake db +
// tracker accessors — the tool itself just dispatches.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { taskGetTool } from "../../src/runtime/tools/task-get.js";
import { taskKillTool } from "../../src/runtime/tools/task-kill.js";
import { taskFinishTool } from "../../src/runtime/tools/task-finish.js";
import { taskResumeTool } from "../../src/runtime/tools/task-resume.js";
import { taskStartTool } from "../../src/runtime/tools/task-start.js";
import { getToolExecute } from "../../src/runtime/tools/tool-factory.js";
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";
import {
	getTurnSeq,
	setTurnSeq,
	deleteTurnSeq,
	markTurnStatePrecreated,
	isTurnStatePrecreated,
	clearTurnStatePrecreated,
} from "../../src/runtime/hooks/turn-seq-tracker.js";
import type { TaskInfo } from "../../src/runtime/types.js";

const execGet = getToolExecute(taskGetTool)!;
const execKill = getToolExecute(taskKillTool)!;
const execFinish = getToolExecute(taskFinishTool)!;
const execResume = getToolExecute(taskResumeTool)!;
const execStart = getToolExecute(taskStartTool)!;

/** Build a TaskInfo with sensible defaults; callers override fields. */
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

function ctxWith(tasks: Record<string, TaskInfo>, extra: Record<string, any> = {}) {
	return {
		agentId: "caller",
		workingDir: ".",
		getTaskResult: (id: string) => tasks[id] ?? null,
		...extra,
	} as any;
}

// ─── TaskGet (3 status branches) ─────────────────────────────────────────

describe("TaskGet — running branch (case 4)", () => {
	test("returns recent tool-call records (name+args), NO output, calls ctx.getTaskRecentCalls", async () => {
		const calls = [
			{ name: "Read", args: "/a/b.ts" },
			{ name: "Grep", args: "pattern *.ts" },
			{ name: "Edit", args: "fix" },
		];
		const ctx = ctxWith(
			{ t1: task({ status: "running", currentTool: "Edit" }) },
			{ getTaskRecentCalls: (_id: string, n?: number) => calls.slice(0, n ?? 3) },
		);
		const r = await execGet({ task_id: "t1" }, ctx);
		const parsed = JSON.parse(r);
		expect(parsed.status).toBe("running");
		expect(parsed.current_tool).toBe("Edit");
		expect(parsed.recent_calls).toHaveLength(3);
		expect(parsed.recent_calls[0]).toEqual({ name: "Read", args: "/a/b.ts" });
		// No result / output keys on running branch.
		expect(parsed.result).toBeUndefined();
	});

	test("running with no calls yet → empty recent_calls", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "running" }) },
			{ getTaskRecentCalls: () => [] },
		);
		const parsed = JSON.parse(await execGet({ task_id: "t1" }, ctx));
		expect(parsed.recent_calls).toEqual([]);
	});
});

describe("TaskGet — interrupted branch (case 6)", () => {
	test("returns waited + [interrupted by restart] marker; recent_calls empty", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "interrupted", startedAt: Date.now() - 5000, currentTool: "Grep" }) },
			{ getTaskRecentCalls: () => [] },
		);
		const parsed = JSON.parse(await execGet({ task_id: "t1" }, ctx));
		expect(parsed.status).toBe("interrupted");
		expect(parsed.marker).toBe("[interrupted by restart]");
		expect(parsed.waited_s).toBeGreaterThanOrEqual(5);
		expect(parsed.recent_calls).toEqual([]);
		// No result on interrupted branch.
		expect(parsed.result).toBeUndefined();
	});
});

describe("TaskGet — completed branch (case 5)", () => {
	test("returns full result + acknowledge consumes the task", async () => {
		const tasks: Record<string, TaskInfo> = {
			t1: task({ status: "completed", result: "ALL DONE", completedAt: Date.now() }),
		};
		const ctx = ctxWith(tasks, {
			acknowledgeTask: (id: string) => { delete tasks[id]; return true; },
		});
		const parsed = JSON.parse(await execGet({ task_id: "t1" }, ctx));
		expect(parsed.status).toBe("completed");
		expect(parsed.result).toBe("ALL DONE");
		expect(parsed.acknowledged).toBe(true);
		// Post-acknowledge: task dropped from registry (consumed).
		expect(tasks.t1).toBeUndefined();
	});

	test("acknowledge=false surfaces a warning when task couldn't be dropped", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "completed", result: "x", completedAt: Date.now() }) },
			{ acknowledgeTask: () => false },
		);
		const parsed = JSON.parse(await execGet({ task_id: "t1" }, ctx));
		expect(parsed.acknowledged).toBe(false);
		expect(parsed.acknowledge_warning).toBeTruthy();
	});

	test("not-found task → friendly not-found string", async () => {
		const r = await execGet({ task_id: "nope" }, ctxWith({}));
		expect(r).toMatch(/not found/i);
	});
});

// ─── TaskKill (case 7) ───────────────────────────────────────────────────

describe("TaskKill", () => {
	test("running → ctx.stopTask (kill)", async () => {
		let killedId: string | null = null;
		const ctx = ctxWith(
			{ t1: task({ status: "running" }) },
			{ stopTask: (id: string) => { killedId = id; return true; } },
		);
		const r = await execKill({ task_id: "t1" }, ctx);
		expect(killedId).toBe("t1");
		expect(r).toMatch(/killed/i);
	});

	test("interrupted → ctx.abandonTask (abandon)", async () => {
		let abandonedId: string | null = null;
		const ctx = ctxWith(
			{ t1: task({ status: "interrupted" }) },
			{ abandonTask: (id: string) => { abandonedId = id; return true; } },
		);
		const r = await execKill({ task_id: "t1" }, ctx);
		expect(abandonedId).toBe("t1");
		expect(r).toMatch(/abandoned/i);
	});

	test("terminal → points at TaskGet (not killable)", async () => {
		const ctx = ctxWith({ t1: task({ status: "completed", completedAt: Date.now() }) });
		const r = await execKill({ task_id: "t1" }, ctx);
		expect(r).toMatch(/terminal/i);
		expect(r).toMatch(/TaskGet/i);
	});

	test("not-found → not found", async () => {
		const r = await execKill({ task_id: "nope" }, ctxWith({}));
		expect(r).toMatch(/not found/i);
	});
});

// ─── TaskFinish (case 8: agent only) ─────────────────────────────────────

describe("TaskFinish — agent only", () => {
	test("agent running → requestTaskFinish fires", async () => {
		let captured: any = null;
		const ctx = ctxWith(
			{ t1: task({ status: "running" }) },
			{ requestTaskFinish: (id: string, o: any) => { captured = { id, o }; return true; } },
		);
		const r = await execFinish({ task_id: "t1", maxTurns: 3 }, ctx);
		expect(captured.id).toBe("t1");
		expect(captured.o.maxTurns).toBe(3);
		expect(r).toMatch(/force-stop after 3/);
	});

	test("bash task → rejected (case 8)", async () => {
		const ctx = ctxWith({ t1: task({ type: "bash", status: "running" }) });
		const r = await execFinish({ task_id: "t1" }, ctx);
		expect(r).toMatch(/agent tasks only/i);
		expect(r).toMatch(/TaskKill/i);
	});
});

// ─── TaskResume (case 8 + case 9 turn_seq guard) ─────────────────────────

describe("TaskResume — agent only + turn_seq guard", () => {
	test("bash task → rejected (case 8)", async () => {
		const ctx = ctxWith({ t1: task({ type: "bash", status: "interrupted" }) });
		const r = await execResume({ task_id: "t1" }, ctx);
		expect(r).toMatch(/agent tasks only/i);
	});

	test("non-interrupted task → rejected", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "running" }) },
			{ resumeTaskBackground: () => "t1" },
		);
		const r = await execResume({ task_id: "t1" }, ctx);
		expect(r).toMatch(/not interrupted/i);
	});

	test("interrupted agent task → resumeTaskBackground fires, returns non-blocking message", async () => {
		let fired = false;
		const ctx = ctxWith(
			{ t1: task({ status: "interrupted" }) },
			{ resumeTaskBackground: () => { fired = true; return "t1"; } },
		);
		const r = await execResume({ task_id: "t1" }, ctx);
		expect(fired).toBe(true);
		expect(r).toMatch(/resumed/i);
		expect(r).toMatch(/non-blocking/i);
	});
});

// ─── Case 9: turn_seq guard at the SubagentDelegator layer ────────────────
//
// The tool dispatches; the GUARD lives in SubagentDelegator.resumeTaskBackground
// (pre-fills setTurnSeq + markTurnStatePrecreated before the detached resume).
// This test constructs a minimal delegator + fake db + fake loop factory and
// asserts the cursor + marker are set for the child session BEFORE the deferred
// resume fires — i.e. the child's TurnStart (when it eventually runs) will see
// them and NOT allocate turn_seq+1.

describe("TaskResume turn_seq guard (case 9) — SubagentDelegator.resumeTaskBackground", () => {
	const CHILD_SESSION = "child-session-1";
	const CHILD_TURN_SEQ = 7;

	function fakeDb(over: Record<string, any> = {}) {
		return {
			getDelegatedTask: (id: string) => ({
				id,
				targetAgentId: "dev-1",
				sessionId: CHILD_SESSION,
				task: "frozen work",
				status: "interrupted",
				parentTaskId: undefined,
				rootTaskId: id,
				step: 3,
				turns: 2,
				tokens: 100,
				createdAt: new Date(Date.now() - 10000).toISOString(),
				...over,
			}),
			getIncompleteTurn: (sid: string) =>
				sid === CHILD_SESSION
					? { turnSeq: CHILD_TURN_SEQ, lastCompletedStepSeq: 5 }
					: undefined,
			updateDelegatedTask: () => {},
			abandonInterruptedTurn: () => 0,
			createDelegatedTask: () => {},
			createSession: () => ({ id: CHILD_SESSION }),
		} as any;
	}

	function makeDelegator(loopResumeSpy: () => void) {
		// Fake loop factory: the built "loop" exposes a resume() the delegator
		// awaits, plus a no-op abort/getResult. We don't fire it synchronously —
		// resumeTaskBackground defers via setImmediate, and we assert the cursor
		// is set BEFORE that fires.
		const fakeLoop: any = {
			resume: async () => { loopResumeSpy(); },
			abort: () => {},
			getResult: () => "ok",
		};
		const config: any = {
			agentId: "caller",
			sessionId: "parent-session",
			workspaceDir: ".",
			systemPrompt: "",
			modelId: "m",
			toolPolicy: {},
			db: fakeDb(),
			contextBundle: undefined,
		};
		const delegator = new SubagentDelegator({
			config,
			providers: [],
			emit: () => {},
			createSubLoop: () => fakeLoop,
			getToolConfig: () => ({}),
		});
		return { delegator, fakeLoop };
	}

	beforeEach(() => {
		// Clear any cursor / marker state from prior tests.
		deleteTurnSeq(CHILD_SESSION);
		clearTurnStatePrecreated(CHILD_SESSION);
	});

	test("cursor + precreate marker set SYNCHRONOUSLY before deferred resume (no turn+1)", () => {
		const { delegator } = makeDelegator(() => {});
		// Before: nothing set.
		expect(getTurnSeq(CHILD_SESSION)).toBeUndefined();
		expect(isTurnStatePrecreated(CHILD_SESSION)).toBe(false);

		delegator.resumeTaskBackground("task-1");

		// AFTER resumeTaskBackground returns (synchronously), BEFORE the deferred
		// resume fires — the cursor + marker MUST already be set. This is the
		// turn+1 guard: the child's TurnStart (deferred) will see these and skip
		// both the user-row write (turn-hooks) and createTurnState (durable).
		expect(getTurnSeq(CHILD_SESSION)).toBe(CHILD_TURN_SEQ);
		expect(isTurnStatePrecreated(CHILD_SESSION)).toBe(true);
	});

	test("resume still runs (deferred) and the guard stays through it", async () => {
		let resumeFired = false;
		const { delegator } = makeDelegator(() => { resumeFired = true; });
		delegator.resumeTaskBackground("task-1");
		// Guard set synchronously.
		expect(getTurnSeq(CHILD_SESSION)).toBe(CHILD_TURN_SEQ);
		// Let the deferred resume fire.
		await new Promise((r) => setImmediate(r));
		await Promise.resolve();
		expect(resumeFired).toBe(true);
	});

	test("idempotent: already-running task → returns taskId without re-resuming", () => {
		const { delegator } = makeDelegator(() => {});
		delegator.resumeTaskBackground("task-1");
		// Second call while the first is still in runningSubloops → no throw.
		const second = delegator.resumeTaskBackground("task-1");
		expect(second).toBe("task-1");
	});

	test("terminal delegated task → throws (not resumable)", () => {
		const db = fakeDb({ status: "killed", error: "dead" });
		const config: any = { agentId: "c", sessionId: "p", workspaceDir: ".", systemPrompt: "", modelId: "m", toolPolicy: {}, db, contextBundle: undefined };
		const delegator = new SubagentDelegator({ config, providers: [], emit: () => {}, createSubLoop: () => ({} as any), getToolConfig: () => ({}) });
		expect(() => delegator.resumeTaskBackground("task-1")).toThrow(/killed|dead/);
	});
});

// ─── getTaskRecentCalls (delegator) — agent vs bash dispatch ──────────────

describe("SubagentDelegator.getTaskRecentCalls — agent vs bash dispatch", () => {
	test("bash task → returns command only (info.task), no stdout leak", () => {
		const config: any = { agentId: "c", sessionId: "p", workspaceDir: ".", systemPrompt: "", modelId: "m", toolPolicy: {}, db: {}, contextBundle: undefined };
		const delegator = new SubagentDelegator({ config, providers: [], emit: () => {}, createSubLoop: () => ({} as any), getToolConfig: () => ({}) });
		// Seed a bash task in the registry.
		delegator.taskRegistry.seed({
			id: "bg1", type: "bash", task: "npm run build", status: "running",
			step: 0, turns: 0, tokens: 0, startedAt: Date.now(),
		});
		const calls = delegator.getTaskRecentCalls("bg1", 3);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("Shell");
		expect(calls[0].args).toBe("npm run build");
	});

	test("agent task with no live sub-loop → [] (frozen child)", () => {
		const config: any = { agentId: "c", sessionId: "p", workspaceDir: ".", systemPrompt: "", modelId: "m", toolPolicy: {}, db: {}, contextBundle: undefined };
		const delegator = new SubagentDelegator({ config, providers: [], emit: () => {}, createSubLoop: () => ({} as any), getToolConfig: () => ({}) });
		delegator.taskRegistry.seed({
			id: "sub1", type: "subagent", task: "explore", status: "interrupted",
			step: 0, turns: 0, tokens: 0, startedAt: Date.now(),
		});
		// No runningSubloops entry → [] (frozen; recent calls appear only after TaskResume).
		expect(delegator.getTaskRecentCalls("sub1", 3)).toEqual([]);
	});

	test("unknown task → []", () => {
		const config: any = { agentId: "c", sessionId: "p", workspaceDir: ".", systemPrompt: "", modelId: "m", toolPolicy: {}, db: {}, contextBundle: undefined };
		const delegator = new SubagentDelegator({ config, providers: [], emit: () => {}, createSubLoop: () => ({} as any), getToolConfig: () => ({}) });
		expect(delegator.getTaskRecentCalls("ghost", 3)).toEqual([]);
	});
});

// ─── TaskStart (case 1) ──────────────────────────────────────────────────

describe("TaskStart — explicit background entry (case 1)", () => {
	test("type:shell → ctx.runBackground, returns task_id", async () => {
		const ctx = ctxWith(
			{},
			{
				runBackground: (_cmd: string, _t?: number) => "bg-1",
				getTaskResult: () => null,
			},
		);
		const r = await execStart({ type: "shell", command: "npm test" }, ctx);
		expect(r).toMatch(/task_id: bg-1/);
	});

	test("type:shell missing command → error", async () => {
		const ctx = ctxWith({}, { runBackground: () => "x" });
		const r = await execStart({ type: "shell", command: "" }, ctx);
		expect(r).toMatch(/command.*required/i);
	});

	test("type:agent → ctx.delegateTaskBackground, returns task_id", async () => {
		const ctx = ctxWith(
			{},
			{
				delegateTaskBackground: (_t: string, _o: any) => "sub-1",
				resolveAgent: () => ({ id: "c", subagents: [] }),
			},
		);
		const r = await execStart({ type: "agent", task: "explore the codebase" }, ctx);
		expect(r).toMatch(/task_id: sub-1/);
	});

	test("type:agent missing task → error", async () => {
		const ctx = ctxWith({}, { delegateTaskBackground: () => "x", resolveAgent: () => ({ id: "c", subagents: [] }) });
		const r = await execStart({ type: "agent", task: "" }, ctx);
		expect(r).toMatch(/task.*required/i);
	});

	test("type:agent named subagent not in list → error + available", async () => {
		const ctx = ctxWith(
			{},
			{
				delegateTaskBackground: () => "x",
				resolveAgent: (_id: string) => ({ id: "caller", subagents: [{ agentId: "dev-1", name: "Developer" }] }),
				agentId: "caller",
			},
		);
		// resolveAgent(dev-1) returns no target → "no longer exists" path
		const r = await execStart({ type: "agent", task: "t", subagent: "Nope" }, ctx);
		expect(r).toMatch(/no subagent named "Nope"/);
	});
});
