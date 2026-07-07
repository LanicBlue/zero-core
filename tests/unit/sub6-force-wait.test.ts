// sub-6 (force-Wait hook): unit tests for the force-Wait TurnEndCheck hook.
//
// Covers acceptance cases 1-6 from docs/plan/subagent-recovery/acceptance-6.md:
//   1. Running task present → hook returns forceContinue + nudge message
//      (AgentLoop consumes this to run one more step instead of ending).
//   2. No running task → hook returns void → turn ends normally.
//   3. Per-turn dedup: a second TurnEndCheck in the same turn does NOT nudge
//      again (anti-loop). The marker clears at TurnStart.
//   4. (Integration contract) Task completes → hasRunning() false → no nudge.
//   5. Wait-suspended turn does not spuriously nudge: a Wait means the model
//      already chose to wait; the gate is on hasRunning() (no task / task
//      done) and on TurnEndCheck only firing at a real turn-end boundary.
//   6. Implementation is a hook (registered via registerForceWaitHooks, no
//      AgentLoop inline force-Wait logic): assert the hook surface and that
//      AgentLoop exposes only the TurnEndCheck checkpoint.

import { describe, test, expect, beforeEach, vi } from "vitest";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { TaskRegistry } from "../../src/runtime/task-registry.js";
import {
	registerForceWaitHooks,
	_resetForceWaitNudgeState,
} from "../../src/runtime/hooks/force-wait-hooks.js";

// AgentLoop import for the case-6 contract test (forceContinue consumption
// is in agent-loop.ts; we verify the hook surface + that AgentLoop has the
// TurnEndCheck trigger). provider-factory is stubbed so the constructor is
// light.
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: () => ({}),
	getContextWindow: () => 128000,
}));

async function fireEndCheck(reg: HookRegistry, sessionId: string, taskRegistry: TaskRegistry) {
	return reg.trigger("TurnEndCheck", {
		agentId: "a",
		sessionId,
		taskRegistry,
	});
}
async function fireStart(reg: HookRegistry, sessionId: string) {
	return reg.trigger("TurnStart", { agentId: "a", sessionId, userMessage: "go" });
}

describe("sub-6 force-Wait hook — TurnEndCheck gating", () => {
	let reg: HookRegistry;
	let tasks: TaskRegistry;

	beforeEach(() => {
		reg = new HookRegistry();
		tasks = new TaskRegistry();
		_resetForceWaitNudgeState();
		registerForceWaitHooks(reg);
	});

	test("case 1: running task present → forceContinue + nudge message (turn continues one more step)", async () => {
		tasks.create("t1", "bash", "do work");
		const res = await fireEndCheck(reg, "s1", tasks);
		expect(res.forceContinue).toBe(true);
		expect(typeof res.message).toBe("string");
		expect((res.message as string).length).toBeGreaterThan(0);
		// The nudge must direct the model to Wait.
		expect((res.message as string).toLowerCase()).toContain("wait");
	});

	test("case 2: no running task → no forceContinue → turn ends normally", async () => {
		const res = await fireEndCheck(reg, "s2", tasks);
		expect(res.forceContinue).toBeUndefined();
		expect(res.message).toBeUndefined();
	});

	test("case 3: per-turn dedup — second TurnEndCheck in the same turn does not nudge again", async () => {
		tasks.create("t2", "bash", "work");
		const first = await fireEndCheck(reg, "s3", tasks);
		expect(first.forceContinue).toBe(true);
		// Same turn (no TurnStart between) — the model ignored the nudge and
		// tried to end again. The hook must NOT nudge a second time.
		const second = await fireEndCheck(reg, "s3", tasks);
		expect(second.forceContinue).toBeUndefined();
	});

	test("case 3b: TurnStart clears the marker → next turn CAN nudge again", async () => {
		tasks.create("t3", "bash", "work");
		await fireEndCheck(reg, "s4", tasks); // nudge #1
		await fireEndCheck(reg, "s4", tasks); // dedup'd
		// New turn:
		await fireStart(reg, "s4");
		const again = await fireEndCheck(reg, "s4", tasks);
		expect(again.forceContinue).toBe(true);
	});

	test("case 4: task completes → hasRunning false → no nudge (turn may end)", async () => {
		tasks.create("t4", "bash", "work");
		tasks.complete("t4", "done");
		// Completed tasks are NOT running.
		expect(tasks.hasRunning()).toBe(false);
		const res = await fireEndCheck(reg, "s5", tasks);
		expect(res.forceContinue).toBeUndefined();
	});

	test("case 5: a task in 'finishing' state still counts as running (forces Wait)", async () => {
		// 'finishing' is a pre-terminal state the design treats as still-active
		// (matches TaskRegistry.hasRunning). Seed it directly.
		tasks.seed({ id: "t5", type: "agent", task: "wrap up", status: "finishing", result: undefined, createdAt: Date.now() } as any);
		expect(tasks.hasRunning()).toBe(true);
		const res = await fireEndCheck(reg, "s6", tasks);
		expect(res.forceContinue).toBe(true);
	});

	test("case 5b: Wait-suspended turn does not spuriously nudge — once tasks finish, no nudge", async () => {
		// The Wait-suspended scenario: model already called Wait. When the
		// awaited task finishes and the turn resumes, if it then produces a
		// no-tool-call step, hasRunning() should be false → no extra nudge.
		tasks.create("t6", "bash", "work");
		tasks.complete("t6", "done"); // simulate the wait woke on task finish
		const res = await fireEndCheck(reg, "s7", tasks);
		expect(res.forceContinue).toBeUndefined();
	});

	test("no taskRegistry in context → no-op (stubbed tests / loops without registry)", async () => {
		// TurnEndCheck with no registry attached should not throw and should
		// not force-continue.
		const res = await reg.trigger("TurnEndCheck", { agentId: "a", sessionId: "s8" });
		expect(res.forceContinue).toBeUndefined();
	});
});

// ── TaskRegistry.hasRunning (sub-6 supporting API) ───────────────────────

describe("sub-6 TaskRegistry.hasRunning", () => {
	test("empty → false", () => {
		const t = new TaskRegistry();
		expect(t.hasRunning()).toBe(false);
	});
	test("running task → true", () => {
		const t = new TaskRegistry();
		t.create("t", "bash", "x");
		expect(t.hasRunning()).toBe(true);
	});
	test("completed task → false", () => {
		const t = new TaskRegistry();
		t.create("t", "bash", "x");
		t.complete("t", "done");
		expect(t.hasRunning()).toBe(false);
	});
	test("finishing task → true", () => {
		const t = new TaskRegistry();
		t.seed({ id: "f", type: "agent", task: "x", status: "finishing", result: undefined, createdAt: Date.now() } as any);
		expect(t.hasRunning()).toBe(true);
	});
});

// ── Case 6: implementation is a hook, AgentLoop exposes only the checkpoint ─

describe("sub-6 case 6 — force-Wait is a hook, not inline AgentLoop logic", () => {
	test("AgentLoop has the TurnEndCheck trigger (the checkpoint); no inline task/Wait knowledge", () => {
		// The force-Wait logic must live in src/runtime/hooks/force-wait-hooks.ts,
		// registered via registerForceWaitHooks. AgentLoop only consumes the
		// hook result. We assert the source surface, not runtime behavior.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("fs");
		const loopSrc = fs.readFileSync(
			require("path").join(__dirname, "../../src/runtime/agent-loop.ts"),
			"utf8",
		);
		// The checkpoint exists.
		expect(loopSrc).toContain('"TurnEndCheck"');
		// AgentLoop must NOT inline task/Wait forcing — it only reads forceContinue.
		// (It references taskRegistry only to pass through ctx, which is allowed.)
		expect(loopSrc).toContain("forceContinue");
		// No direct TaskRegistry import / hasRunning call inside agent-loop.
		expect(loopSrc).not.toMatch(/hasRunning\s*\(/);
	});

	test("registerForceWaitHooks registers TurnEndCheck + TurnStart (dedup reset)", () => {
		const reg = new HookRegistry();
		_resetForceWaitNudgeState();
		registerForceWaitHooks(reg);
		expect(reg.hasHandlers("TurnEndCheck")).toBe(true);
		expect(reg.hasHandlers("TurnStart")).toBe(true);
	});
});
