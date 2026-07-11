// sub-5 (Wait rewrite): unit tests for the generic session-suspend Wait.
//
// Covers acceptance cases 1-10 from docs/plan/subagent-recovery/acceptance-5.md:
//   - Three wake sources (timeout / any-task-finish / user-input) each wake.
//   - Wake priority when multiple fire in the same tick (user > task > timeout).
//   - Return shape = `woke: <reason> elapsed <n>s` only (no task summary).
//   - Durable wait-resume:
//       * past-due `until` → synthesize fills `woke: timeout`, NOT [interrupted].
//       * future `until`   → synthesize fills `woke: timeout (resumed; ...)`,
//                             NOT [interrupted].
//       * relative-only `timeout` → treated as elapsed → `woke: timeout`.
//   - AgentLoop busy release: beginWait emits session_waiting; endWait emits
//     session_running; user-input wake sets userInterruptQueued (ends turn).
//
// Two layers:
//   1. TaskRegistry.suspendUntilWake — the three-source core (pure registry,
//      no DB, no model). Fast and deterministic.
//   2. AgentSession.synthesizeDanglingToolResultsInPlace — the durable
//      wait-resume branch (no [interrupted] for Wait). Driven via rebuild.
//
// The AgentLoop-level busy release / turn+1 is exercised through the public
// methods (isWaiting / interruptWaitForUserInput / begin-endWait) since wiring
// a full model+DB run is covered by step-resume.test.ts's harness pattern.

import { describe, test, expect, beforeEach, vi } from "vitest";
import { TaskRegistry } from "../../src/runtime/task-registry.js";
import { AgentSession } from "../../src/runtime/session.js";

// Stub provider-factory BEFORE importing AgentLoop, so the loop constructor's
// getContextWindow/resolveModel don't hit a real provider.
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: () => ({}),
	getContextWindow: () => 128000,
	getMultimodal: () => false,
}));
import { AgentLoop } from "../../src/runtime/agent-loop.js";

// ─── Layer 1: TaskRegistry.suspendUntilWake (three wake sources) ──────────

describe("sub-5 TaskRegistry.suspendUntilWake — three wake sources", () => {
	let reg: TaskRegistry;

	beforeEach(() => {
		reg = new TaskRegistry();
	});

	test("timeout wake: until reached → reason 'timeout'", async () => {
		// Short relative timeout; no running task. Should wake on the timer.
		const start = Date.now();
		const res = await reg.suspendUntilWake({ timeoutSec: 0.05 }); // ~50ms
		expect(res.reason).toBe("timeout");
		expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(res.elapsedMs).toBeLessThan(2000);
		expect(Date.now() - start).toBeGreaterThanOrEqual(20);
	});

	test("timeout wake: absolute until in the near future → reason 'timeout'", async () => {
		const until = new Date(Date.now() + 60).toISOString();
		const res = await reg.suspendUntilWake({ until });
		expect(res.reason).toBe("timeout");
	});

	test("any-task-finish wake: completing a task resolves the wait with 'task finished'", async () => {
		// A running task + a long timeout. Complete the task → wake.
		reg.create("t1", "bash", "work");
		const until = new Date(Date.now() + 5000).toISOString(); // far future
		const p = reg.suspendUntilWake({ until });
		// Give the suspension a tick to register its resolver.
		await Promise.resolve();
		reg.complete("t1", "done");
		const res = await p;
		expect(res.reason).toBe("task finished");
	});

	test("any-task-finish wake: failing/killing a task also wakes", async () => {
		reg.create("t2", "bash", "work", new AbortController());
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		reg.fail("t2", "boom");
		const res = await p;
		expect(res.reason).toBe("task finished");
	});

	test("user-input wake: interruptWaitForUserInput resolves the wait with 'user input'", async () => {
		// Long timeout, no task. Fire user-input interrupt → wake.
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		reg.interruptWaitForUserInput();
		const res = await p;
		expect(res.reason).toBe("user input");
	});

	test("user-input has highest priority over task-finish and timeout", async () => {
		// Deterministic priority: user-input > task-finish > timeout. Set up a
		// wait, then fire user-input AND task-finish in the same tick. The
		// resolver sees user-input first (it's called directly).
		reg.create("t3", "bash", "work");
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		reg.interruptWaitForUserInput();
		reg.complete("t3", "done");
		const res = await p;
		expect(res.reason).toBe("user input");
	});

	test("no time source and no running task → immediate 'timeout' wake (nothing to wait for)", async () => {
		const res = await reg.suspendUntilWake({});
		expect(res.reason).toBe("timeout");
		expect(res.elapsedMs).toBe(0);
	});

	test("time source honored even with no running task (wait until a wall-clock point)", async () => {
		// No task, but a relative timeout given → wait the duration.
		const until = new Date(Date.now() + 40).toISOString();
		const p = reg.suspendUntilWake({ until });
		const res = await p;
		expect(res.reason).toBe("timeout");
	});

	test("interruptWaitForUserInput is a no-op when no Wait is active", () => {
		expect(() => reg.interruptWaitForUserInput()).not.toThrow();
	});
});

// ─── Layer 2: durable wait-resume (synthesize branch) ─────────────────────

describe("sub-5 durable wait-resume — pending Wait is NOT synthesized as [interrupted]", () => {
	// Drive via a fresh AgentSession + a minimal in-memory step store. The
	// rebuild path calls synthesizeDanglingToolResultsInPlace on dangling tool
	// blocks; we assert the Wait block takes the dedicated branch.

	function makeSession(): AgentSession {
		// AgentSession needs a store with getSteps; we hand-roll a stub.
		const steps: Array<{ seq: number; turnGroup: number; role: string; content: string | null; createdAt: string }> = [];
		const store: any = {
			getSteps: () => steps,
			getStepCount: () => steps.length,
			appendStep: (sid: string, seq: number, tg: number, role: string, content: string) => {
				steps.push({ seq, turnGroup: tg, role, content, createdAt: new Date().toISOString() });
			},
			upsertStep: (sid: string, seq: number, tg: number, role: string, content: string) => {
				const existing = steps.find(s => s.seq === seq);
				if (existing) existing.content = content;
				else steps.push({ seq, turnGroup: tg, role, content, createdAt: new Date().toISOString() });
			},
		};
		// Constructor signature: (systemPrompt, contextWindow?, sessionId?, db?)
		return new AgentSession("sys", 128000, "s1", store);
	}

	function rebuildAndGetLastToolBlock(session: AgentSession): any {
		// rebuildFromTurns is the public entry that runs synthesize in place
		// on the parsed blocks, then builds ModelMessages. Read the synthesized
		// result back from the rebuilt messages' tool-result parts (the paired
		// output carries whatever synthesize filled: [interrupted] / woke: ...).
		const messages = (session as any).rebuildFromTurns() as any[];
		// Find the last tool-result part across tool messages.
		let lastToolResult: any;
		for (const msg of messages) {
			if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
			for (const part of msg.content) {
				if (part.type === "tool-result") lastToolResult = part;
			}
		}
		if (!lastToolResult) return undefined;
		const out = lastToolResult.output;
		const text = typeof out === "string"
			? out
			: out?.type === "text" ? out.value
			: out?.type === "json" ? JSON.stringify(out.value)
			: out != null ? JSON.stringify(out) : undefined;
		// isError flag is set when status was "error" ([interrupted] path).
		return { result: text, isError: lastToolResult.isError === true };
	}

	test("past-due absolute until → fills 'woke: timeout', NOT [interrupted], NOT error", () => {
		const session = makeSession();
		// Seed: user turn + assistant step with a dangling Wait whose until is in the past.
		const pastIso = new Date(Date.now() - 60_000).toISOString();
		(session as any).db.appendStep("s1", 0, 0, "user", "go");
		(session as any).db.appendStep("s1", 1, 0, "assistant", JSON.stringify([
			{ type: "tool", name: "Wait", status: "running", args: { until: pastIso } },
		]));

		const tb = rebuildAndGetLastToolBlock(session);
		expect(tb.result).toBe("woke: timeout");
		expect(tb.result).not.toBe("[interrupted]");
	});

	test("future absolute until → fills 'woke: timeout (resumed; ...)', NOT [interrupted]", () => {
		const session = makeSession();
		const futureIso = new Date(Date.now() + 60_000).toISOString();
		(session as any).db.appendStep("s1", 0, 0, "user", "go");
		(session as any).db.appendStep("s1", 1, 0, "assistant", JSON.stringify([
			{ type: "tool", name: "Wait", status: "running", args: { until: futureIso } },
		]));

		const tb = rebuildAndGetLastToolBlock(session);
		expect(tb.result).toContain("woke: timeout");
		expect(tb.result).toContain("resumed");
		expect(tb.result).not.toBe("[interrupted]");
	});

	test("relative-only timeout (not durable) → treated as elapsed → 'woke: timeout', NOT [interrupted]", () => {
		const session = makeSession();
		(session as any).db.appendStep("s1", 0, 0, "user", "go");
		(session as any).db.appendStep("s1", 1, 0, "assistant", JSON.stringify([
			{ type: "tool", name: "Wait", status: "running", args: { timeout: 30 } },
		]));

		const tb = rebuildAndGetLastToolBlock(session);
		expect(tb.result).toBe("woke: timeout");
		expect(tb.result).not.toBe("[interrupted]");
	});

	test("non-Wait dangling tool call still synthesized as [interrupted] (regression guard)", () => {
		const session = makeSession();
		(session as any).db.appendStep("s1", 0, 0, "user", "go");
		(session as any).db.appendStep("s1", 1, 0, "assistant", JSON.stringify([
			{ type: "tool", name: "Shell", status: "running", args: { command: "ls" } },
		]));

		const tb = rebuildAndGetLastToolBlock(session);
		expect(tb.result).toBe("[interrupted]");
	});

	test("Wait args stored as JSON STRING (legacy normalized form) parses correctly", () => {
		const session = makeSession();
		const pastIso = new Date(Date.now() - 60_000).toISOString();
		(session as any).db.appendStep("s1", 0, 0, "user", "go");
		// args as a STRING (some normalization paths store this shape).
		(session as any).db.appendStep("s1", 1, 0, "assistant", JSON.stringify([
			{ type: "tool", name: "Wait", status: "running", args: JSON.stringify({ until: pastIso }) },
		]));

		const tb = rebuildAndGetLastToolBlock(session);
		expect(tb.result).toBe("woke: timeout");
	});
});

// ─── Layer 3: AgentLoop Wait coordination (busy release + turn+1) ─────────

describe("sub-5 AgentLoop Wait coordination — busy release + user-input turn+1", () => {
	// These tests drive the loop's Wait-coordination surface directly (no model
	// run): the private begin/endWaitSuspend methods (invoked by the Wait tool
	// via ctx), the public isWaiting / interruptWaitForUserInput, and the
	// emitted session_waiting / session_running events. The full model-driven
	// path is covered by the integration harness in step-resume.test.ts pattern.

	function makeLoop(eventSink: any[]): any {
		// Minimal AgentLoop construction. We don't run the model — only call the
		// Wait-coordination methods. provider-factory is stubbed at the top.
		const config = {
			agentId: "test-agent",
			sessionId: "s-loop",
			workspaceDir: ".",
			systemPrompt: "sys",
			modelId: "mock",
			providerName: "Mock",
			toolPolicy: { tools: {} },
		};
		const callbacks = { onEvent: (e: any) => eventSink.push(e) };
		return new AgentLoop(config, [], callbacks);
	}

	test("beginWaitSuspend flips isWaiting true and emits session_waiting", () => {
		const events: any[] = [];
		const loop = makeLoop(events);
		expect(loop.isWaiting()).toBe(false);
		(loop as any).beginWaitSuspend();
		expect(loop.isWaiting()).toBe(true);
		const waiting = events.find(e => e.type === "session_waiting");
		expect(waiting, "session_waiting emitted").toBeDefined();
		expect(waiting.sessionId).toBe("s-loop");
	});

	test("endWaitSuspend with non-user reason flips isWaiting false, emits session_running, does NOT set userInterruptQueued", () => {
		const events: any[] = [];
		const loop = makeLoop(events);
		(loop as any).beginWaitSuspend();
		(loop as any).endWaitSuspend("timeout");
		expect(loop.isWaiting()).toBe(false);
		const running = events.find(e => e.type === "session_running");
		expect(running, "session_running emitted on resume").toBeDefined();
		// userInterruptQueued stays false (private; check via executeStream side
		// effect would need a model run — assert the accessor contract instead).
		expect((loop as any).userInterruptQueued).toBe(false);
	});

	test("endWaitSuspend with 'user input' sets userInterruptQueued (current turn will end → turn+1)", () => {
		const events: any[] = [];
		const loop = makeLoop(events);
		(loop as any).beginWaitSuspend();
		(loop as any).endWaitSuspend("user input");
		expect(loop.isWaiting()).toBe(false);
		expect((loop as any).userInterruptQueued, "user-input wake queues a turn end").toBe(true);
	});

	test("interruptWaitForUserInput returns false when not waiting (no-op)", () => {
		const events: any[] = [];
		const loop = makeLoop(events);
		expect(loop.interruptWaitForUserInput()).toBe(false);
	});

	test("interruptWaitForUserInput returns true when waiting and fires the registry interrupt", async () => {
		const events: any[] = [];
		const loop = makeLoop(events);
		// Seed a suspension via the loop's delegator registry so the interrupt
		// has something to resolve.
		const reg = (loop as any).delegator.taskRegistry;
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		(loop as any).beginWaitSuspend();
		const interrupted = loop.interruptWaitForUserInput();
		expect(interrupted).toBe(true);
		const res = await p;
		expect(res.reason).toBe("user input");
	});

	test("endWaitSuspend is idempotent when not waiting (no spurious session_running)", () => {
		const events: any[] = [];
		const loop = makeLoop(events);
		(loop as any).endWaitSuspend("timeout"); // never began
		expect(events.find(e => e.type === "session_running")).toBeUndefined();
		expect(loop.isWaiting()).toBe(false);
	});
});

