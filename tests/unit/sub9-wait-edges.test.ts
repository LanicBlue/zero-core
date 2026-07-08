// sub-9 (Wait edge completeness): adversarial unit tests.
//
// Independent verification of docs/plan/subagent-recovery/acceptance-9.md.
// Written by the verification agent — does NOT trust the implementer's claims.
// Each test block names the acceptance case it encodes (1-7).
//
// Two layers exercised:
//   - TurnRecorder.setToolBlockStartedAt + persistence shape (case 1).
//   - AgentSession.synthesizeDanglingToolResultsInPlace Wait branch
//     (cases 2, 3, 4 — driven via rebuild, the public surface that runs it).
//   - AgentLoop.detectAndResumePendingWait + endWaitSuspend reason plumbing
//     (cases 5, 6, 7 — driven through the loop + a real TaskRegistry, using
//      fake timers so there is NO real-setTimeout race).
//
// Mock clocks (vi.useFakeTimers) are used everywhere a wake involves time, so
// the tests are deterministic and not flaky on slow CI.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { TurnRecorder } from "../../src/runtime/turn-recorder.js";
import { AgentSession } from "../../src/runtime/session.js";
import { TaskRegistry } from "../../src/runtime/task-registry.js";

// Stub provider-factory BEFORE importing AgentLoop, so the loop constructor's
// resolveModel/getContextWindow don't hit a real provider.
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: () => ({}),
	getContextWindow: () => 128000,
}));
import { AgentLoop } from "../../src/runtime/agent-loop.js";
import type { WakeReason } from "../../src/runtime/types.js";

// ─── Shared helpers ───────────────────────────────────────────────────────

/** Minimal in-memory step store with the shape AgentSession.rebuildFromTurns
 *  touches (getSteps/appendStep/upsertStep/getTurnCount). */
function makeStepStore() {
	const steps: Array<{ seq: number; turnGroup: number; role: string; content: string | null; createdAt: string }> = [];
	return {
		steps,
		getSteps: () => steps,
		getTurnCount: () => steps.length,
		appendStep: (_sid: string, seq: number, tg: number, role: string, content: string) => {
			steps.push({ seq, turnGroup: tg, role, content, createdAt: new Date().toISOString() });
		},
		upsertStep: (_sid: string, seq: number, tg: number, role: string, content: string) => {
			const existing = steps.find(s => s.seq === seq);
			if (existing) existing.content = content;
			else steps.push({ seq, turnGroup: tg, role, content, createdAt: new Date().toISOString() });
		},
	};
}

function makeSession(store = makeStepStore()): AgentSession {
	return new AgentSession("sys", 128000, "s1", store as any);
}

/** Run rebuild (which calls synthesizeDanglingToolResultsInPlace in place) and
 *  return the LAST tool block's synthesized result text + isError flag. */
function rebuildAndGetLastWaitBlock(session: AgentSession): { result?: string; isError?: boolean; rawBlock?: any } {
	const messages = (session as any).rebuildFromTurns() as any[];
	let lastToolResult: any;
	for (const msg of messages) {
		if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type === "tool-result") lastToolResult = part;
		}
	}
	if (!lastToolResult) return {};
	const out = lastToolResult.output;
	const text = typeof out === "string"
		? out
		: out?.type === "text" ? out.value
		: out?.type === "json" ? JSON.stringify(out.value)
		: out != null ? JSON.stringify(out) : undefined;
	return { result: text, isError: lastToolResult.isError === true, rawBlock: lastToolResult };
}

// ==========================================================================
// CASE 1 — startedAt is persisted as a block-level field on a Wait tool block
//          (relative timeout). The field must be a SIBLING of `args`, not
//          nested inside args.
// ==========================================================================
describe("sub-9 case 1 — startedAt persists on Wait tool block (sibling of args)", () => {
	test("setToolBlockStartedAt stamps a block-level startedAt; survives persist shape", () => {
		const rec = new TurnRecorder();
		rec.startTurnGroup(0);
		// A Wait tool call begins (block created with args = tool INPUT only).
		rec.addToolStart("Wait", { timeout: 30 }, "tc-wait-1");
		// The Wait tool stamps its wall-clock start BEFORE suspending.
		rec.setToolBlockStartedAt("tc-wait-1", "Wait", 1_700_000_000_000);

		// Persist the step (this is the shape that hits the DB).
		const store = makeStepStore();
		rec.persistCurrentStep(store as any, "s1", 1);

		// Read the persisted row back and assert startedAt is at block level.
		const row = store.steps.find(s => s.role === "assistant");
		expect(row, "assistant step was persisted").toBeDefined();
		const blocks = JSON.parse(row!.content);
		const waitBlock = blocks.find((b: any) => b.name === "Wait");
		expect(waitBlock, "Wait block present").toBeDefined();
		// CRITICAL: startedAt is a top-level field on the block, NOT inside args.
		expect(waitBlock.startedAt).toBe(1_700_000_000_000);
		expect(waitBlock.args).toEqual({ timeout: 30 });
		expect(waitBlock.args.startedAt).toBeUndefined();
	});

	test("setToolBlockStartedAt matches by toolCallId even when other tools ran first", () => {
		const rec = new TurnRecorder();
		rec.startTurnGroup(0);
		rec.addToolStart("TaskList", {}, "tc-1");
		rec.updateToolResult("tc-1", "TaskList", "[]", false);
		rec.sealAndAdvanceStep();
		rec.addToolStart("Wait", { timeout: 10 }, "tc-wait");
		rec.setToolBlockStartedAt("tc-wait", "Wait", 1234);

		expect(rec.blocks.find(b => b.name === "Wait")?.startedAt).toBe(1234);
		expect(rec.blocks.find(b => b.name === "TaskList")?.startedAt).toBeUndefined();
	});

	test("setToolBlockStartedAt is a best-effort no-op when the block is gone (does not throw)", () => {
		const rec = new TurnRecorder();
		rec.startTurnGroup(0);
		expect(() => rec.setToolBlockStartedAt("nope", "Wait", 1)).not.toThrow();
	});
});

// ==========================================================================
// CASE 2 — relative timeout with startedAt, still time left → re-suspend
//          (NOT treated as already-elapsed). Encoded at the synthesize layer:
//          the Wait block must get "resumed; re-suspended" so the resume path
//          re-suspends, AND the resume path itself must compute remaining>0.
// ==========================================================================
describe("sub-9 case 2 — relative timeout + startedAt, remaining > 0 → re-suspend (not elapsed)", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	test("synthesize: startedAt + timeout with remaining > 0 → 'resumed; re-suspended'", () => {
		vi.setSystemTime(1_000_000);
		const session = makeSession();
		// Relative timeout=60s, started 10s ago → 50s remaining.
		(session as any).db.appendStep("s1", 0, 0, "user", "go");
		(session as any).db.appendStep("s1", 1, 0, "assistant", JSON.stringify([
			{ type: "tool", name: "Wait", status: "running", args: { timeout: 60 }, startedAt: 1_000_000 - 10_000 },
		]));

		const tb = rebuildAndGetLastWaitBlock(session);
		expect(tb.result).toContain("woke: timeout");
		expect(tb.result).toContain("resumed");
		expect(tb.result).not.toBe("[interrupted]");
		expect(tb.isError).toBeFalsy();
	});

	test("resume path: remaining>0 → re-suspends with rounded-up remaining timeout (deterministic via fake clock + a real TaskRegistry)", async () => {
		// We exercise the real detectAndResumePendingWait. It uses Date.now() for
		// the remaining calc, then calls delegator.suspendUntilWake with the
		// computed opts. We capture the opts by stubbing the delegator method.
		vi.setSystemTime(1_000_000);
		const events: any[] = [];
		const loop = new AgentLoop(
			{ agentId: "a", sessionId: "s", workspaceDir: ".", systemPrompt: "sys", modelId: "m", providerName: "Mock", toolPolicy: { tools: {} } } as any,
			[],
			{ onEvent: (e) => events.push(e) },
		);
		// Seed a pending Wait step with a relative timeout + startedAt such that
		// ~50s remain. The loop scans getSteps() from its config.db.
		const startedAt = 1_000_000 - 10_000;
		const fakeDb = {
			getSteps: () =>([
				{ seq: 0, turnGroup: 0, role: "user", content: "go" },
				{ seq: 1, turnGroup: 0, role: "assistant", content: JSON.stringify([
					{ type: "tool", name: "Wait", status: "running", args: { timeout: 60 }, startedAt },
				]) },
			]),
		};
		(loop as any).config.db = fakeDb;
		(loop as any).config.sessionId = "s";

		// Capture the opts the resume path passes to suspendUntilWake AND let the
		// call resolve immediately as "timeout" so detectAndResumePendingWait returns.
		let capturedOpts: any = null;
		(loop as any).delegator.suspendUntilWake = async (opts: any) => {
			capturedOpts = opts;
			return { reason: "timeout", elapsedMs: 0 } as any;
		};

		await (loop as any).detectAndResumePendingWait();

		// It must have re-suspended (called suspendUntilWake) with a remaining
		// relative timeout ≈ 50s (rounded up to ≥1). NOT passed the original 60.
		expect(capturedOpts, "resume path re-suspended").not.toBeNull();
		expect(capturedOpts.timeoutSec).toBeGreaterThanOrEqual(49);
		expect(capturedOpts.timeoutSec).toBeLessThanOrEqual(50);
		expect(capturedOpts.until).toBeUndefined();
		// And it flipped through the waiting state correctly.
		expect(events.some(e => e.type === "session_waiting")).toBe(true);
		expect(events.some(e => e.type === "session_running")).toBe(true);
		expect(loop.isWaiting()).toBe(false);
	});

	test("resume path: future absolute until still wins over relative (priority)", async () => {
		vi.setSystemTime(1_000_000);
		const loop = new AgentLoop(
			{ agentId: "a", sessionId: "s", workspaceDir: ".", systemPrompt: "sys", modelId: "m", providerName: "Mock", toolPolicy: { tools: {} } } as any,
			[],
			{ onEvent: () => {} },
		);
		const futureIso = new Date(1_000_000 + 30_000).toISOString();
		(loop as any).config.db = {
			getSteps: () =>([
				{ seq: 0, turnGroup: 0, role: "user", content: "go" },
				{ seq: 1, turnGroup: 0, role: "assistant", content: JSON.stringify([
					{ type: "tool", name: "Wait", status: "running", args: { until: futureIso, timeout: 99 }, startedAt: 1_000_000 - 99_000 },
				]) },
			]),
		};
		(loop as any).config.sessionId = "s";
		let captured: any = null;
		(loop as any).delegator.suspendUntilWake = async (opts: any) => { captured = opts; return { reason: "timeout", elapsedMs: 0 }; };
		await (loop as any).detectAndResumePendingWait();
		expect(captured.until).toBe(futureIso);
		expect(captured.timeoutSec).toBeUndefined();
	});
});

// ==========================================================================
// CASE 3 — relative timeout with startedAt, remaining ≤ 0 → fill woke: timeout
//          (do NOT re-suspend).
// ==========================================================================
describe("sub-9 case 3 — relative timeout + startedAt, remaining ≤ 0 → 'woke: timeout' (no re-suspend)", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	test("synthesize: startedAt + timeout, already elapsed → 'woke: timeout' (no 'resumed')", () => {
		vi.setSystemTime(2_000_000);
		const session = makeSession();
		// timeout=10s, started 100s ago → elapsed.
		(session as any).db.appendStep("s1", 0, 0, "user", "go");
		(session as any).db.appendStep("s1", 1, 0, "assistant", JSON.stringify([
			{ type: "tool", name: "Wait", status: "running", args: { timeout: 10 }, startedAt: 2_000_000 - 100_000 },
		]));
		const tb = rebuildAndGetLastWaitBlock(session);
		expect(tb.result).toBe("woke: timeout");
		expect(tb.result).not.toContain("resumed");
		expect(tb.result).not.toBe("[interrupted]");
	});

	test("resume path: remaining ≤ 0 → does NOT call suspendUntilWake (synthesized result stands)", async () => {
		vi.setSystemTime(2_000_000);
		const loop = new AgentLoop(
			{ agentId: "a", sessionId: "s", workspaceDir: ".", systemPrompt: "sys", modelId: "m", providerName: "Mock", toolPolicy: { tools: {} } } as any,
			[],
			{ onEvent: () => {} },
		);
		(loop as any).config.db = {
			getSteps: () =>([
				{ seq: 0, turnGroup: 0, role: "user", content: "go" },
				{ seq: 1, turnGroup: 0, role: "assistant", content: JSON.stringify([
					{ type: "tool", name: "Wait", status: "running", args: { timeout: 10 }, startedAt: 2_000_000 - 100_000 },
				]) },
			]),
		};
		(loop as any).config.sessionId = "s";
		let called = false;
		(loop as any).delegator.suspendUntilWake = async () => { called = true; return { reason: "timeout", elapsedMs: 0 }; };
		await (loop as any).detectAndResumePendingWait();
		expect(called, "must NOT re-suspend when already elapsed").toBe(false);
	});
});

// ==========================================================================
// CASE 4 — legacy block with NO startedAt → treated as elapsed, does not crash
//          (back-compat with data persisted before sub-9).
// ==========================================================================
describe("sub-9 case 4 — legacy Wait block without startedAt → elapsed, no crash", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	test("synthesize: relative timeout, no startedAt → 'woke: timeout' (NOT [interrupted], no throw)", () => {
		vi.setSystemTime(5_000_000);
		const session = makeSession();
		(session as any).db.appendStep("s1", 0, 0, "user", "go");
		(session as any).db.appendStep("s1", 1, 0, "assistant", JSON.stringify([
			{ type: "tool", name: "Wait", status: "running", args: { timeout: 30 } },
			// no startedAt field at all
		]));
		const tb = rebuildAndGetLastWaitBlock(session);
		expect(tb.result).toBe("woke: timeout");
		expect(tb.result).not.toBe("[interrupted]");
	});

	test("synthesize: startedAt present but timeout missing/invalid → elapsed path (no throw)", () => {
		vi.setSystemTime(5_000_000);
		const session = makeSession();
		(session as any).db.appendStep("s1", 0, 0, "user", "go");
		(session as any).db.appendStep("s1", 1, 0, "assistant", JSON.stringify([
			{ type: "tool", name: "Wait", status: "running", args: {}, startedAt: 5_000_000 - 1_000 },
		]));
		const tb = rebuildAndGetLastWaitBlock(session);
		expect(tb.result).toBe("woke: timeout");
	});

	test("resume path: legacy block (no startedAt) → does NOT re-suspend, returns cleanly", async () => {
		vi.setSystemTime(5_000_000);
		const loop = new AgentLoop(
			{ agentId: "a", sessionId: "s", workspaceDir: ".", systemPrompt: "sys", modelId: "m", providerName: "Mock", toolPolicy: { tools: {} } } as any,
			[],
			{ onEvent: () => {} },
		);
		(loop as any).config.db = {
			getSteps: () =>([
				{ seq: 0, turnGroup: 0, role: "user", content: "go" },
				{ seq: 1, turnGroup: 0, role: "assistant", content: JSON.stringify([
					{ type: "tool", name: "Wait", status: "running", args: { timeout: 30 } },
				]) },
			]),
		};
		(loop as any).config.sessionId = "s";
		let called = false;
		(loop as any).delegator.suspendUntilWake = async () => { called = true; return { reason: "timeout", elapsedMs: 0 }; };
		// Must not throw and must not re-suspend.
		await expect((loop as any).detectAndResumePendingWait()).resolves.toBeUndefined();
		expect(called).toBe(false);
	});
});

// ==========================================================================
// CASE 5 — durable-resume re-suspend woken by user input → userInterruptQueued
//          (turn+1 path). The reason must come from the resolver (case 7 too).
// ==========================================================================
describe("sub-9 case 5 — re-suspend woken by user input → userInterruptQueued (turn+1)", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	test("detectAndResumePendingWait re-suspends; user-input wake → userInterruptQueued=true", async () => {
		vi.setSystemTime(1_000_000);
		const loop = new AgentLoop(
			{ agentId: "a", sessionId: "s", workspaceDir: ".", systemPrompt: "sys", modelId: "m", providerName: "Mock", toolPolicy: { tools: {} } } as any,
			[],
			{ onEvent: () => {} },
		);
		(loop as any).config.db = {
			getSteps: () =>([
				{ seq: 0, turnGroup: 0, role: "user", content: "go" },
				{ seq: 1, turnGroup: 0, role: "assistant", content: JSON.stringify([
					{ type: "tool", name: "Wait", status: "running", args: { timeout: 60 }, startedAt: 1_000_000 - 10_000 },
				]) },
			]),
		};
		(loop as any).config.sessionId = "s";

		// Real registry: we drive the wake via interruptWaitForUserInput to prove
		// the reason flows resolver → endWaitSuspend → userInterruptQueued.
		(loop as any).delegator.suspendUntilWake = async (_opts: any) => {
			// Resolve on next microtask via the user-input interrupt path.
			const reg: TaskRegistry = (loop as any).delegator.taskRegistry;
			const p = reg.suspendUntilWake({ timeoutSec: 5000 });
			await Promise.resolve();
			reg.interruptWaitForUserInput();
			return p;
		};

		expect((loop as any).userInterruptQueued).toBe(false);
		await (loop as any).detectAndResumePendingWait();
		expect(loop.isWaiting()).toBe(false);
		expect((loop as any).userInterruptQueued, "user-input wake must set userInterruptQueued").toBe(true);
	});
});

// ==========================================================================
// CASE 6 — re-suspend woken by task-finish or timeout → normal resume, NO
//          turn+1 (userInterruptQueued stays false).
// ==========================================================================
describe("sub-9 case 6 — re-suspend woken by task-finish/timeout → normal resume (no turn+1)", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	test("task-finish wake → userInterruptQueued stays false", async () => {
		vi.setSystemTime(1_000_000);
		const loop = new AgentLoop(
			{ agentId: "a", sessionId: "s", workspaceDir: ".", systemPrompt: "sys", modelId: "m", providerName: "Mock", toolPolicy: { tools: {} } } as any,
			[],
			{ onEvent: () => {} },
		);
		(loop as any).config.db = {
			getSteps: () =>([
				{ seq: 0, turnGroup: 0, role: "user", content: "go" },
				{ seq: 1, turnGroup: 0, role: "assistant", content: JSON.stringify([
					{ type: "tool", name: "Wait", status: "running", args: { timeout: 60 }, startedAt: 1_000_000 - 10_000 },
				]) },
			]),
		};
		(loop as any).config.sessionId = "s";

		(loop as any).delegator.suspendUntilWake = async (_opts: any) => {
			const reg: TaskRegistry = (loop as any).delegator.taskRegistry;
			reg.create("t1", "bash", "work");
			const p = reg.suspendUntilWake({ timeoutSec: 5000 });
			await Promise.resolve();
			reg.complete("t1", "done");
			return p;
		};

		await (loop as any).detectAndResumePendingWait();
		expect(loop.isWaiting()).toBe(false);
		expect((loop as any).userInterruptQueued, "task-finish wake must NOT set userInterruptQueued").toBe(false);
	});

	test("timeout wake → userInterruptQueued stays false", async () => {
		vi.setSystemTime(1_000_000);
		const loop = new AgentLoop(
			{ agentId: "a", sessionId: "s", workspaceDir: ".", systemPrompt: "sys", modelId: "m", providerName: "Mock", toolPolicy: { tools: {} } } as any,
			[],
			{ onEvent: () => {} },
		);
		(loop as any).config.db = {
			getSteps: () =>([
				{ seq: 0, turnGroup: 0, role: "user", content: "go" },
				{ seq: 1, turnGroup: 0, role: "assistant", content: JSON.stringify([
					{ type: "tool", name: "Wait", status: "running", args: { timeout: 60 }, startedAt: 1_000_000 - 10_000 },
				]) },
			]),
		};
		(loop as any).config.sessionId = "s";
		(loop as any).delegator.suspendUntilWake = async () => ({ reason: "timeout" as WakeReason, elapsedMs: 0 });

		await (loop as any).detectAndResumePendingWait();
		expect((loop as any).userInterruptQueued).toBe(false);
	});
});

// ==========================================================================
// CASE 7 — endWaitSuspend reason comes from the resolver, not hardcoded.
//          Adversarial: we feed three different resolver reasons through the
//          SAME detectAndResumePendingWait code path and assert the side
//          effect (userInterruptQueued) differs per reason. If reason were
//          hardcoded, all three would behave identically.
// ==========================================================================
describe("sub-9 case 7 — endWaitSuspend reason comes from resolver (not hardcoded)", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	function makeLoopWithPendingWait() {
		vi.setSystemTime(1_000_000);
		const loop = new AgentLoop(
			{ agentId: "a", sessionId: "s", workspaceDir: ".", systemPrompt: "sys", modelId: "m", providerName: "Mock", toolPolicy: { tools: {} } } as any,
			[],
			{ onEvent: () => {} },
		);
		(loop as any).config.db = {
			getSteps: () =>([
				{ seq: 0, turnGroup: 0, role: "user", content: "go" },
				{ seq: 1, turnGroup: 0, role: "assistant", content: JSON.stringify([
					{ type: "tool", name: "Wait", status: "running", args: { timeout: 60 }, startedAt: 1_000_000 - 10_000 },
				]) },
			]),
		};
		(loop as any).config.sessionId = "s";
		return loop;
	}

	// Parameterized: feed each reason, assert the userInterruptQueued outcome
	// matches the runtime Wait semantics (only "user input" breaks the turn).
	const cases: Array<{ reason: WakeReason; expectInterrupt: boolean }> = [
		{ reason: "user input", expectInterrupt: true },
		{ reason: "task finished", expectInterrupt: false },
		{ reason: "timeout", expectInterrupt: false },
	];
	for (const c of cases) {
		test(`resolver reason "${c.reason}" → userInterruptQueued=${c.expectInterrupt}`, async () => {
			const loop = makeLoopWithPendingWait();
			(loop as any).delegator.suspendUntilWake = async () => ({ reason: c.reason, elapsedMs: 0 });
			await (loop as any).detectAndResumePendingWait();
			expect(
				(loop as any).userInterruptQueued,
				`reason "${c.reason}" must produce userInterruptQueued=${c.expectInterrupt}`,
			).toBe(c.expectInterrupt);
		});
	}

	test("endWaitSuspend directly: only 'user input' sets userInterruptQueued", () => {
		// Direct call to the private coordination method — same plumbing the
		// resolver-driven path uses. Proves the method is reason-driven, not
		// state-driven or hardcoded.
		const loop = makeLoopWithPendingWait();
		(loop as any).beginWaitSuspend();
		(loop as any).endWaitSuspend("task finished");
		expect((loop as any).userInterruptQueued).toBe(false);
		(loop as any).beginWaitSuspend();
		(loop as any).endWaitSuspend("user input");
		expect((loop as any).userInterruptQueued).toBe(true);
		// Reset and confirm a timeout after a user-input doesn't sticky-set.
		(loop as any).userInterruptQueued = false;
		(loop as any).beginWaitSuspend();
		(loop as any).endWaitSuspend("timeout");
		expect((loop as any).userInterruptQueued).toBe(false);
	});
});
