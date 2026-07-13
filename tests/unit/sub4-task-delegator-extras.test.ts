// sub-4 (execution-entry-redesign) — salvaged SubagentDelegator-layer tests.
//
// # Why this file exists
// The legacy `sub4-task-tools.test.ts` was deleted when sub-4 merged the 6
// per-task tools into the single `Task` action tool. Most of its coverage was
// tool-level (TaskGet/Kill/Finish/Resume branches) and is now exercised by
// `sub4-task-action-tool.test.ts` (59 tests against the merged tool). Two
// describe blocks in the legacy file, however, tested the SubagentDelegator
// DIRECTLY — not via any deleted tool symbol — and are NOT covered elsewhere:
//
//   1. TaskResume turn_seq guard (case 9): `SubagentDelegator.resumeTaskBackground`
//      pre-fills the child session's turn_seq + precreate marker SYNCHRONOUSLY
//      (before the deferred resume fires) so the child's TurnStart does not
//      allocate turn_seq+1. This invariant lives at the delegator layer, not
//      the tool layer; the tool test only asserts `resumeTaskBackground` was
//      *invoked*, not what it does internally.
//
//   2. `SubagentDelegator.getTaskRecentCalls` agent-vs-bash dispatch: bash →
//      command-only (info.task, no stdout leak); agent with no live sub-loop →
//      [] (frozen child); unknown → []. Again a delegator-layer concern; the
//      tool test only forwards a mocked `getTaskRecentCalls` delegateFn.
//
// These tests import only `SubagentDelegator` + `turn-seq-tracker` (both still
// present) — no deleted tool symbols — so they are salvaged verbatim from the
// pre-deletion file. Source: `git show HEAD:tests/unit/sub4-task-tools.test.ts`.

import { describe, test, expect, beforeEach } from "vitest";
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";
import {
	getTurnSeq,
	deleteTurnSeq,
	markTurnStatePrecreated,
	isTurnStatePrecreated,
	clearTurnStatePrecreated,
} from "../../src/runtime/hooks/turn-seq-tracker.js";

// ─── Case 9: turn_seq guard at the SubagentDelegator layer ────────────────
//
// The Task {action:'resume'} tool dispatches; the GUARD lives in
// SubagentDelegator.resumeTaskBackground (pre-fills setTurnSeq +
// markTurnStatePrecreated before the detached resume). This test constructs a
// minimal delegator + fake db + fake loop factory and asserts the cursor +
// marker are set for the child session BEFORE the deferred resume fires — i.e.
// the child's TurnStart (when it eventually runs) will see them and NOT
// allocate turn_seq+1.

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
