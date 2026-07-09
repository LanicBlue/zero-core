// Step 2D acceptance test: step-level resume + durable step checkpoint.
//
// # 文件说明书
//
// ## 核心功能
// Verifies the Step 2D semantics:
//   - A2: after a turn crashes mid-way (3 steps completed, step 4 not run),
//     resume() continues from the next step WITHOUT re-running the first 3.
//     Completed steps' tool-call/result pairs appear exactly once in messages;
//     the resumed step 4 runs and the turn completes.
//   - A3: the per-session step checkpoint (last_completed_step_seq) advances
//     once per StepEnd (3 steps → checkpoint=3), and a turn that ends normally
//     marks phase=completed so it is NOT recovered on next startup.
//
// ## 驱动方式
// Two-pronged drive, both isolating the resume semantics at the AgentLoop layer
// (no agent-service / IPC plumbing):
//   1. Crash scenario: run the REAL AgentLoop with a 4-step model schedule,
//      abort() the loop after the 3rd StepEnd (simulating a crash before step 4).
//      Inspect the DB: turn_state row exists, phase=pending (turn did NOT end
//      normally), last_completed_step_seq=3, and 3 assistant step rows +
//      user turn row are persisted. The model call schedule is captured so we
//      can prove steps 1-3 were each invoked once (3 doStream calls) before the
//      simulated crash.
//   2. Resume scenario: a FRESH AgentLoop+Session over the SAME SessionDB
//      (mimicking a process restart). Call loop.resume(turnSeq, checkpoint).
//      The loop reads getTurnCount (=4: user + 3 steps) so stepBaseSeq=4 and
//      the resumed step lands at seq 4 — the natural continuation. Assert:
//      only ONE new doStream call fires (step 4), its prompt already contains
//      steps 1-3's tool-calls (rebuilt from turns-table via rebuildFromTurns,
//      NOT replayed), the turn completes, and turn_state.phase=completed.
//
// ## 验收对应
// docs/design/hook-redesign/steps/2D-step-resume/accept.md (A2, A3).
// A1 (typecheck + build:lib + full vitest) verified separately.
//
// ## Design note: resume reads getTurnCount, not the checkpoint, to pick the
// next seq. lastCompletedStepSeq is informational at this layer (it tells
// recovery that mid-turn progress existed, and drives UI). This test asserts
// the OBSERVABLE invariant — no replay of completed steps — rather than the
// internal mechanism, so it stays robust to that design choice.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";

// Mock provider-factory BEFORE importing AgentLoop so the static `resolveModel`
// import inside agent-loop.ts is replaced with our inline model factory.
const resolveModelMock = vi.fn();
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: (...args: unknown[]) => resolveModelMock(...args),
	getContextWindow: () => 128000,
	getMultimodal: () => false,
}));

import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentLoop } from "../../src/runtime/agent-loop.js";
import { registerDurableHooks, setSessionTurnSeq } from "../../src/server/durable-hooks.js";
import { registerTurnHooks } from "../../src/runtime/hooks/turn-hooks.js";
import type { SessionConfig, RuntimeCallbacks, StreamEvent } from "../../src/runtime/types.js";

// ─── Inline mock language model (LanguageModelV2) ─────────────────────────
// Replays a per-call schedule of chunks. Lets us script a 4-step turn and
// capture how many times doStream was invoked (the no-replay signal).

type MockChunk =
	| { type: "text"; text: string }
	| { type: "tool-call"; toolName: string; input: object; toolCallId?: string }
	| { type: "finish"; finishReason?: "stop" | "length" | "tool-calls" | "error"; usage?: MockUsage };

interface MockUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

interface MockModelConfig {
	/** Per-call chunk schedules. Index = call number (0-based). */
	steps: MockChunk[][];
	/** If provided, each doStream call's prompt messages are pushed here. */
	capturePrompts?: Array<Array<{ role: string; content: any }>>;
}

function createMockModel(config: MockModelConfig, modelId = "mock-2d"): LanguageModelV2 {
	let callCount = 0;
	const toStreamPart = (chunk: MockChunk) => {
		switch (chunk.type) {
			case "text": {
				const id = `t-${Math.random().toString(36).slice(2)}`;
				return [
					{ type: "text-start", id },
					{ type: "text-delta", id, delta: chunk.text },
					{ type: "text-end", id },
				];
			}
			case "tool-call": {
				const id = chunk.toolCallId ?? `tc-${Math.random().toString(36).slice(2)}`;
				const inputStr = JSON.stringify(chunk.input);
				return [
					{ type: "tool-input-start", id, toolName: chunk.toolName },
					{ type: "tool-input-delta", id, delta: inputStr },
					{ type: "tool-input-end", id },
					{ type: "tool-call", toolCallId: id, toolName: chunk.toolName, input: inputStr },
				];
			}
			case "finish": {
				const u = chunk.usage ?? {};
				const inputTokens = u.inputTokens ?? 10;
				const outputTokens = u.outputTokens ?? 5;
				return [{
					type: "finish",
					finishReason: chunk.finishReason ?? "stop",
					usage: { inputTokens, outputTokens, totalTokens: u.totalTokens ?? inputTokens + outputTokens },
				}];
			}
		}
	};

	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId,
		supportedUrls: {},
		async doGenerate() { throw new Error("doGenerate not used"); },
		async doStream(options: any) {
			const myCallNumber = ++callCount;
			if (config.capturePrompts) {
				const prompt = (options?.prompt ?? options?.messages ?? []) as Array<{ role: string; content: any }>;
				config.capturePrompts.push(prompt.map(m => ({ role: m.role, content: m.content })));
			}
			const idx = Math.min(myCallNumber - 1, config.steps.length - 1);
			const chunks = config.steps[idx] ?? [];
			const stream = new ReadableStream({
				async start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					for (const chunk of chunks) {
						for (const part of toStreamPart(chunk)) controller.enqueue(part);
					}
					controller.close();
				},
			});
			return { stream };
		},
	} as unknown as LanguageModelV2;
}

// ─── Test harness ─────────────────────────────────────────────────────────

let tmpDir: string;
let sessionDB: SessionDB;

function makeCallbacks(sink: StreamEvent[]): RuntimeCallbacks {
	return { onEvent: (event: StreamEvent) => { sink.push(event); } };
}

function makeConfig(sessionId: string): SessionConfig {
	return {
		agentId: "test-agent",
		workspaceDir: tmpDir,
		systemPrompt: "You are a test agent.",
		modelId: "mock-2d",
		providerName: "Mock",
		sessionId,
		db: sessionDB as any,
		toolPolicy: { tools: {} },
	} as unknown as SessionConfig;
}

/** Build a fresh AgentLoop wired with the REAL durable hooks (turn_state rows
 * + per-StepEnd checkpoint advance) and registerTurnHooks (StepEnd persists
 * step rows) over the shared SessionDB. Observer events are recorded to
 * hookSink. */
function buildLoop(
	sessionId: string,
	hookSink: Array<{ event: string; ctx: Record<string, unknown> }>,
	eventSink: StreamEvent[] = [],
): AgentLoop {
	const l = new AgentLoop(makeConfig(sessionId), [], makeCallbacks(eventSink));
	const registry = (l as any).registry;
	// Wire the REAL durable hooks (TurnStart→createTurnState, StepEnd→
	// advanceStepCheckpoint, TurnEnd→completeTurnState). This is exactly what
	// agent-service does at startup.
	registerDurableHooks(sessionDB, registry);
	// turn-hooks: StepEnd → appendStep (writes assistant step rows to turns table)
	registerTurnHooks(sessionDB, registry);
	// Observer: record every event we assert on (registered AFTER the real
	// hooks so we capture the post-hook state).
	for (const ev of ["StepStart", "StepEnd", "TurnStart", "TurnEnd", "TurnError"] as const) {
		registry.register(ev as any, async (ctx: Record<string, unknown>) => {
			hookSink.push({ event: ev, ctx });
			return undefined;
		});
	}
	return l;
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-2d-step-resume-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	resolveModelMock.mockReset();
	resolveModelMock.mockReturnValue(createMockModel({ steps: [[{ type: "finish" }]] }));
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function hookCount(hooks: Array<{ event: string }>, event: string): number {
	return hooks.filter(h => h.event === event).length;
}

/** Count assistant tool-call parts for a toolName in a captured prompt. */
function toolCallCount(prompt: Array<{ role: string; content: any }>, toolName: string): number {
	return prompt
		.filter(m => m.role === "assistant")
		.flatMap(m => Array.isArray(m.content) ? m.content : [])
		.filter((part: any) => part.type === "tool-call" && part.toolName === toolName)
		.length;
}

// ─── A2: step-level resume does NOT replay completed steps ───────────────

describe("Step 2D · A2: resume continues from the next step without replay", () => {
	test("3 steps complete then crash → resume runs only step 4; steps 1-3 tool-calls appear once; turn completes", async () => {
		const sessionId = "2d-a2-resume";
		const prompts: Array<Array<{ role: string; content: any }>> = [];
		const crashHooks: Array<{ event: string; ctx: Record<string, unknown> }> = [];
		const crashEvents: StreamEvent[] = [];

		// 4-step schedule: 3 tool-calls, then a final text on step 4.
		// "noopTool" is not in the loop's tool set, so the AI SDK does not
		// auto-execute it; the tool-call still flows through fullStream and
		// response.messages carries the assistant tool-call, hadToolCall=true
		// → the outer while continues. Step 4 (text) ends the turn.
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[{ type: "tool-call", toolName: "noopTool", input: { n: 1 } }, { type: "finish", finishReason: "tool-calls" }],
				[{ type: "tool-call", toolName: "noopTool", input: { n: 2 } }, { type: "finish", finishReason: "tool-calls" }],
				[{ type: "tool-call", toolName: "noopTool", input: { n: 3 } }, { type: "finish", finishReason: "tool-calls" }],
				[{ type: "text", text: "done after resume" }, { type: "finish", finishReason: "stop" }],
			],
			capturePrompts: prompts,
		}));

		const loop = buildLoop(sessionId, crashHooks, crashEvents);

		// Simulate a crash AFTER the 3rd StepEnd fires: abort the loop so step 4
		// never starts. This leaves the DB in the exact mid-turn state a real
		// crash would: turn_state.phase=pending (TurnEnd never fired),
		// last_completed_step_seq=3, and 3 assistant step rows persisted.
		let stepEndSeen = 0;
		(loop as any).registry.register("StepEnd", async () => {
			stepEndSeen++;
			if (stepEndSeen === 3) {
				// 3rd step just finalized → simulate crash by aborting before
				// step 4's StepStart.
				loop.abort();
			}
			return undefined;
		});

		await loop.run("go");

		// ── Phase 1: crash state ──────────────────────────────────────────
		// Exactly 3 model calls fired (steps 1-3); step 4 never started.
		expect(prompts.length, "crash: 3 doStream calls before abort").toBe(3);
		expect(hookCount(crashHooks, "StepEnd"), "crash: 3 StepEnd fired").toBe(3);

		// Simulate the crash leaving the turn UNFINISHED. loop.abort() still
		// runs the finally block (TurnEnd → completeTurnState → phase=completed),
		// but a real crash would die before that. Reset phase back to pending
		// so the row shows up in getIncompleteTurns (the recovery set), exactly
		// as a crashed process would leave it. The step checkpoint
		// (last_completed_step_seq=3) is preserved.
		(sessionDB as any).db
			.prepare("UPDATE turn_state SET phase = 'pending' WHERE session_id = ?")
			.run(sessionId);

		// turn_state row exists with phase=pending (turn did NOT end normally)
		// and last_completed_step_seq=3 (the step-level checkpoint).
		const turnState = sessionDB.getIncompleteTurns().find(t => t.sessionId === sessionId);
		expect(turnState, "turn_state row exists for the interrupted turn").toBeDefined();
		expect(turnState!.phase, "phase is pending (turn not completed)").toBe("pending");
		expect(turnState!.lastCompletedStepSeq, "step checkpoint advanced to 3").toBe(3);

		// DB has the user turn + 3 assistant step rows persisted (StepEnd).
		const steps = sessionDB.getSteps(sessionId);
		const assistantSteps = steps.filter(s => s.role === "assistant");
		expect(assistantSteps.length, "3 assistant step rows persisted").toBe(3);
		expect(steps.filter(s => s.role === "user").length, "user turn row persisted").toBe(1);

		// ── Phase 2: resume (fresh loop over same DB = process restart) ───
		const resumeHooks: Array<{ event: string; ctx: Record<string, unknown> }> = [];
		const resumeEvents: StreamEvent[] = [];
		const resumedLoop = buildLoop(sessionId, resumeHooks, resumeEvents);

		// Pre-populate the turn seq so TurnStart skips creating a duplicate
		// turn_state row — mirrors what doRecoverIncompleteSessions does via
		// setSessionTurnSeq before calling resume().
		setSessionTurnSeq(sessionId, turnState!.turnSeq);

		// resume() with the step checkpoint (informational at this layer).
		await resumedLoop.resume(turnState!.turnSeq, turnState!.lastCompletedStepSeq ?? undefined);

		// CORE no-replay invariant: steps 1-3's tool-calls appear EXACTLY ONCE
		// across the WHOLE turn (crash + resume). The resumed step 4's prompt
		// carries all 3 prior tool-calls (rebuilt from turns-table, NOT replayed
		// by re-invoking the model for them). So total doStream calls = 4
		// (3 crash + 1 resume), and the resume prompt has 3 prior tool-calls.
		expect(prompts.length, "resume: exactly 1 new doStream call (step 4)").toBe(4);
		expect(toolCallCount(prompts[3], "noopTool"), "resume prompt carries steps 1-3 tool-calls once (no replay)").toBe(3);

		// The resumed step 4 ran (StepEnd fired once during resume) and the turn
		// completed normally (TurnEnd fired; phase→completed).
		expect(hookCount(resumeHooks, "StepEnd"), "resume: step 4 finalized").toBe(1);
		expect(hookCount(resumeHooks, "TurnEnd"), "resume: turn completed").toBe(1);
		expect(hookCount(resumeHooks, "TurnError"), "resume: no TurnError").toBe(0);

		// Final assistant step row (step 4) persisted — 4 total now.
		const finalSteps = sessionDB.getSteps(sessionId).filter(s => s.role === "assistant");
		expect(finalSteps.length, "4 assistant step rows after resume (no duplicate re-runs)").toBe(4);

		// turn_state now marked completed → would NOT be recovered on next start.
		const remaining = sessionDB.getIncompleteTurns().filter(t => t.sessionId === sessionId);
		expect(remaining.length, "turn_state marked completed → not recovered next start").toBe(0);

		// Final result text from the resumed step 4.
		const msgEnd = resumeEvents.find(e => (e as any).type === "message_end") as any;
		expect(msgEnd?.text).toBe("done after resume");
	}, 30000);
});

// ─── A3: checkpoint advances per StepEnd + completed turns are not recovered ─

describe("Step 2D · A3: step checkpoint advances + completed turns not recovered", () => {
	test("checkpoint = number of completed steps (3 steps → 3); a normally-ended turn is not recovered", async () => {
		const sessionId = "2d-a3-checkpoint";
		const hooks: Array<{ event: string; ctx: Record<string, unknown> }> = [];
		const prompts: Array<Array<{ role: string; content: any }>> = [];

		// 3-step turn that ends normally on step 3 (text finish).
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[{ type: "tool-call", toolName: "noopTool", input: { a: 1 } }, { type: "finish", finishReason: "tool-calls" }],
				[{ type: "tool-call", toolName: "noopTool", input: { a: 2 } }, { type: "finish", finishReason: "tool-calls" }],
				[{ type: "text", text: "complete" }, { type: "finish", finishReason: "stop" }],
			],
			capturePrompts: prompts,
		}));

		const loop = buildLoop(sessionId, hooks);

		// Snapshot the checkpoint after each StepEnd to prove monotonic advance.
		const checkpoints: Array<number | null> = [];
		let stepEndCount = 0;
		(loop as any).registry.register("StepEnd", async () => {
			stepEndCount++;
			checkpoints.push(sessionDB.getStepCheckpoint(sessionId));
			return undefined;
		});

		await loop.run("go");

		// 3 steps ran, 3 StepEnds fired, checkpoint advanced 1→2→3 monotonically.
		expect(stepEndCount, "3 StepEnds fired").toBe(3);
		expect(checkpoints, "checkpoint advances 1, 2, 3 per StepEnd").toEqual([1, 2, 3]);

		// Turn ended normally → phase=completed, so getIncompleteTurns excludes
		// it (would NOT be recovered on next startup).
		expect(hookCount(hooks, "TurnEnd"), "turn ended normally").toBe(1);
		const incomplete = sessionDB.getIncompleteTurns().filter(t => t.sessionId === sessionId);
		expect(incomplete.length, "completed turn not in incomplete set").toBe(0);

		// Direct read of the row confirms phase=completed.
		const direct = (sessionDB as any).db
			.prepare("SELECT phase FROM turn_state WHERE session_id = ?").get(sessionId) as { phase: string };
		expect(direct.phase, "turn_state.phase = completed").toBe("completed");
	}, 30000);
});
