// Step 2C acceptance test: externalized step loop + OnLLMError + per-step retry.
//
// # 文件说明书
//
// ## 核心功能
// Verifies the externalized step loop in AgentLoop.executeStream (Step 2C):
//   - A2: multi-step tool-use drives the outer while-loop (3 streamText calls,
//     StepEnd ×3, messages accumulate with tool-call/result pairs), and
//     PreLLMCall appendMessages injects into the NEXT step's outgoing messages.
//   - A3: a transient error on step 2 retries ONLY that step (step 1's
//     tool-call/result appear once in messages), OnLLMError fires once with
//     errorClass="rate_limit".
//   - A4: a fatal (auth) error is NOT retried → TurnError hook fires → loop
//     emits a terminal error event.
//   - A5: abort() at a step boundary stops the loop before the next step;
//     step 1 is already persisted.
//
// ## 驱动方式
// Drives the REAL AgentLoop end-to-end (run() → executeStream → outer while).
// provider-factory.resolveModel is mocked with an inline LanguageModelV2 model
// (self-contained, mirrors tests/spike/step-loop-spike.test.ts shape) so we can
// script per-call behavior (multi-step, throwOnCall). A throwaway SessionDB +
// runMigrations isolates persistence; registerTurnHooks wires StepEnd so step
// rows land in DB (lets A5 assert step 1 is persisted).
//
// ## 验收对应
// docs/design/hook-redesign/steps/2C-step-loop-externalize/accept.md (A2-A5).
// A1 (typecheck + build:lib + full vitest incl. m3) is verified separately.

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
import { HookRegistry } from "../../src/core/hook-registry.js";
import { registerTurnHooks } from "../../src/runtime/hooks/turn-hooks.js";
import { AgentLoop } from "../../src/runtime/agent-loop.js";
import type { SessionConfig, RuntimeCallbacks, StreamEvent } from "../../src/runtime/types.js";

// ─── Inline mock language model (LanguageModelV2) ─────────────────────────
// Replays a per-call schedule of chunks. Supports throwOnCall (transient/fatal
// error on the Nth call) so A3/A4 can script failure mid-loop.

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
	/** Throw this Error from doStream on the Nth call (1-based). */
	throwOnCall?: { callNumber: number; error: Error };
	/** If provided, each doStream call's prompt messages are pushed here. */
	capturePrompts?: Array<Array<{ role: string; content: any }>>;
}

function createMockModel(config: MockModelConfig, modelId = "mock-2c"): LanguageModelV2 {
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
			// Capture the prompt the loop sent to this model call (the AI SDK
			// normalizes the `messages` passed to streamText into `options.prompt`,
			// a UIMessage-style array). Used by A2 to verify per-step injection.
			if (config.capturePrompts) {
				const prompt = (options?.prompt ?? options?.messages ?? []) as Array<{ role: string; content: any }>;
				config.capturePrompts.push(prompt.map(m => ({ role: m.role, content: m.content })));
			}
			if (config.throwOnCall && myCallNumber === config.throwOnCall.callNumber) {
				throw config.throwOnCall.error;
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
let loop: AgentLoop;
let emitted: StreamEvent[];
let hookEvents: Array<{ event: string; ctx: Record<string, unknown> }>;

function makeCallbacks(): RuntimeCallbacks {
	return {
		onEvent: (event: StreamEvent) => { emitted.push(event); },
	};
}

function makeConfig(sessionId: string): SessionConfig {
	return {
		agentId: "test-agent",
		workspaceDir: tmpDir,
		systemPrompt: "You are a test agent.",
		modelId: "mock-2c",
		providerName: "Mock",
		sessionId,
		db: sessionDB as any,
		toolPolicy: { tools: {} },
	} as unknown as SessionConfig;
}

/** Build a loop with registerTurnHooks (StepEnd persists) + an observer that
 * records every hook event. Registers everything on the loop's OWN registry
 * (exposed readonly via `loop.registry`). Returns the loop + its registry. */
function buildLoop(sessionId: string): { loop: AgentLoop; registry: HookRegistry } {
	emitted = [];
	hookEvents = [];
	const cfg = makeConfig(sessionId);
	const l = new AgentLoop(cfg, [], makeCallbacks());
	// The loop owns its own HookRegistry (readonly `registry` getter). Register
	// turn-hooks (StepEnd persistence) + an observer for every event we assert
	// on, directly on it.
	registerTurnHooks(sessionDB, l.registry);
	const events = ["StepStart", "StepEnd", "PreLLMCall", "OnLLMError", "TurnStart", "TurnEnd", "TurnError", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostTurnComplete"] as const;
	for (const ev of events) {
		l.registry.register(ev as any, async (ctx: Record<string, unknown>) => {
			hookEvents.push({ event: ev, ctx });
			return undefined;
		});
	}
	loop = l;
	return { loop: l, registry: l.registry };
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-2c-step-loop-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	resolveModelMock.mockReset();
	resolveModelMock.mockReturnValue(createMockModel({ steps: [[{ type: "finish" }]] }));
});

afterEach(() => {
	try { (loop as any)?.delegator?.cleanup?.(); } catch { /* ignore */ }
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: count emitted events of a type.
function countEmitted(type: string): number {
	return emitted.filter(e => (e as any).type === type).length;
}

// Helper: count hook observer events for a name.
function hookCount(event: string): number {
	return hookEvents.filter(h => h.event === event).length;
}

// Helper: count steps persisted in DB for a session.
function persistedStepCount(sessionId: string): number {
	return sessionDB.getSteps(sessionId).filter(s => s.role === "assistant").length;
}

// ─── A2: multi-step tool-use drives the external loop ────────────────────

describe("Step 2C · A2: multi-step tool-use external loop", () => {
	test("3 streamText calls (tool→tool→text), StepEnd ×3, assistant tool-call messages accumulate across steps", async () => {
		const sessionId = "2c-a2-multi";
		const prompts: Array<Array<{ role: string; content: any }>> = [];

		// Schedule: step1 tool-call(T,x:1) → step2 tool-call(T,y:2) → step3 text.
		// "noopTool" is NOT in the loop's tool set, so the AI SDK does not auto-
		// execute it; the tool-call still flows through fullStream (recorder
		// captures it), response.messages carries the assistant tool-call, and
		// the loop's `hadToolCall` flag is true → the outer while continues.
		// This lets us assert the CORE accumulation semantic without wiring a
		// real tool: step 2's prompt must contain step 1's assistant tool-call.
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "noopTool", input: { x: 1 } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 2 } },
				],
				[
					{ type: "tool-call", toolName: "noopTool", input: { y: 2 } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 12, outputTokens: 3 } },
				],
				[
					{ type: "text", text: "all done" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 14, outputTokens: 4 } },
				],
			],
			capturePrompts: prompts,
		}));

		const { loop } = buildLoop(sessionId);

		await loop.run("go");

		// A2.1: outer while ran 3 streamText calls (one doStream per step).
		expect(prompts.length, "3 doStream calls = 3 steps").toBe(3);
		expect(hookCount("StepEnd"), "StepEnd fires once per successful step").toBe(3);
		// 3 assistant steps persisted (StepEnd → turn-hooks → appendStep).
		expect(persistedStepCount(sessionId), "3 assistant step rows persisted").toBe(3);

		// CORE accumulation semantic: step 2's prompt must carry step 1's
		// assistant tool-call; step 3's prompt must carry step 1 + step 2's
		// tool-calls. The externalized loop adopts each step's
		// response.messages into the running `messages` (executeStream line:
		// `messages = [...messages, ...step.responseMessages]`).
		const toolCallCount = (p: Array<{ role: string; content: any }>) =>
			p.filter(m => m.role === "assistant")
				.flatMap(m => Array.isArray(m.content) ? m.content : [])
				.filter((part: any) => part.type === "tool-call" && part.toolName === "noopTool")
				.length;

		expect(toolCallCount(prompts[0]), "step 1 prompt: 0 prior tool-calls").toBe(0);
		expect(toolCallCount(prompts[1]), "step 2 prompt carries step 1's tool-call").toBe(1);
		expect(toolCallCount(prompts[2]), "step 3 prompt carries step 1+2 tool-calls").toBe(2);

		// Turn completed normally (text finish on step 3).
		expect(hookCount("TurnEnd")).toBe(1);
		expect(hookCount("TurnError")).toBe(0);
		// Final result text captured from the last step.
		const msgEnd = emitted.find(e => (e as any).type === "message_end") as any;
		expect(msgEnd?.text).toBe("all done");
	}, 30000);

	test("PreLLMCall appendMessages reaches the model on step 2 only (verified at the doStream prompt)", async () => {
		const sessionId = "2c-a2-inject-prompt";
		const prompts: Array<Array<{ role: string; content: any }>> = [];

		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "noopTool", input: { a: 1 } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 1 } },
				],
				[
					{ type: "text", text: "ok" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 6, outputTokens: 1 } },
				],
			],
			capturePrompts: prompts,
		}));

		const { loop, registry } = buildLoop(sessionId);
		// PreLLMCall: inject a user message from step 2 onward.
		registry.register("PreLLMCall", async (ctx: any) => {
			if ((ctx.stepNumber as number) >= 2) {
				return { appendMessages: [{ role: "user", content: "INJECTED-FOR-STEP-2" }] };
			}
			return undefined;
		});

		await loop.run("go");

		expect(hookCount("StepEnd")).toBe(2);
		// Two model calls = two captured prompts.
		expect(prompts.length, "one prompt captured per step").toBe(2);

		// Flatten each step's prompt to a searchable string (content may be
		// string or array-of-parts).
		const promptText = (p: Array<{ role: string; content: any }>) =>
			p.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).join("\n");

		expect(promptText(prompts[0]).includes("INJECTED-FOR-STEP-2"),
			"injection must NOT reach the model on step 1").toBe(false);
		expect(promptText(prompts[1]).includes("INJECTED-FOR-STEP-2"),
			"injection must reach the model on step 2").toBe(true);
	}, 30000);
});

// ─── A3: per-step retry reruns only the failing step ──────────────────────

describe("Step 2C · A3: transient error retries only the failing step", () => {
	test("step 2 call 1 rate_limit, call 2 success; step 1 not replayed; OnLLMError fires once", async () => {
		const sessionId = "2c-a3-retry";
		const prompts: Array<Array<{ role: string; content: any }>> = [];
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "noopTool", input: { keep: true } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 2 } },
				],
				[
					{ type: "text", text: "final answer" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 8, outputTokens: 3 } },
				],
			],
			throwOnCall: { callNumber: 2, error: new Error("rate limited: 429 Too Many Requests") },
			capturePrompts: prompts,
		}));

		const { loop } = buildLoop(sessionId);

		await loop.run("go");

		// OnLLMError fired exactly once, with errorClass="rate_limit".
		const onErrs = hookEvents.filter(h => h.event === "OnLLMError");
		expect(onErrs.length, "OnLLMError fires exactly once").toBe(1);
		expect(onErrs[0].ctx.errorClass).toBe("rate_limit");

		// Turn completed normally after the retry succeeded.
		expect(hookCount("TurnEnd")).toBe(1);
		expect(hookCount("TurnError")).toBe(0);

		// 3 doStream calls: step1 (success) + step2 attempt1 (rate_limit throw)
		// + step2 attempt2 (success retry). The throw happens INSIDE doStream,
		// so capturePrompts records the prompt BEFORE the throw — giving us 3
		// captured prompts total.
		expect(prompts.length, "3 doStream calls: step1 + step2-fail + step2-retry").toBe(3);

		// CORE retry semantic: step 1's tool-call appears EXACTLY ONCE in every
		// captured prompt (step1's own prompt has 0 prior; step2's failed and
		// retried attempts both carry step1's single tool-call, NOT duplicated).
		// This proves the per-step retry does NOT replay completed steps.
		const toolCallCount = (p: Array<{ role: string; content: any }>) =>
			p.filter(m => m.role === "assistant")
				.flatMap(m => Array.isArray(m.content) ? m.content : [])
				.filter((part: any) => part.type === "tool-call" && part.toolName === "noopTool")
				.length;

		expect(toolCallCount(prompts[0]), "step 1 prompt: 0 prior tool-calls").toBe(0);
		expect(toolCallCount(prompts[1]), "step 2 failed attempt: step 1's tool-call once").toBe(1);
		expect(toolCallCount(prompts[2]), "step 2 retried attempt: step 1's tool-call STILL once (no replay)").toBe(1);

		// StepEnd fired once per SUCCESSFUL step (step 1 + step 2 retry) = 2.
		// The failed step 2 attempt must NOT fire StepEnd (runOneStepWithRetry
		// only returns responseMessages on success; finalizeOneStep is called
		// once per outer-loop iteration on the successful attempt).
		expect(hookCount("StepEnd"), "StepEnd fires only for successful steps").toBe(2);

		// retry_attempt UI event fired once before the backoff.
		expect(countEmitted("retry_attempt"), "retry_attempt emitted once").toBe(1);
		// Final result text from the retried step's text finish.
		const msgEnd = emitted.find(e => (e as any).type === "message_end") as any;
		expect(msgEnd?.text).toBe("final answer");
	}, 30000);
});

// ─── A4: fatal (auth) error is not retried → TurnError ───────────────────

describe("Step 2C · A4: fatal auth error not retried", () => {
	test("auth error → OnLLMError fires → no retry → TurnError fires → terminal error emitted", async () => {
		const sessionId = "2c-a4-fatal";
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [[{ type: "finish" }]],
			throwOnCall: { callNumber: 1, error: new Error("401 Unauthorized: invalid api key") },
		}));

		const { loop } = buildLoop(sessionId);

		await loop.run("go");

		// OnLLMError fired (the per-step handler runs before the retry decision).
		const onErrs = hookEvents.filter(h => h.event === "OnLLMError");
		expect(onErrs.length, "OnLLMError fires for the fatal error").toBe(1);
		expect(onErrs[0].ctx.errorClass).toBe("auth");

		// No retry attempted (fatal = not retryable).
		expect(countEmitted("retry_attempt"), "no retry for fatal auth").toBe(0);

		// TurnError hook fired (terminal failure path in runWithRetry).
		expect(hookCount("TurnError"), "TurnError fires for unrecoverable error").toBe(1);
		const turnErr = hookEvents.find(h => h.event === "TurnError")!;
		expect(turnErr.ctx.errorClass).toBe("auth");

		// Terminal error event emitted to subscribers.
		expect(countEmitted("error"), "terminal error event emitted").toBe(1);
		const errEvt = emitted.find(e => (e as any).type === "error") as any;
		expect(errEvt?.errorClass).toBe("auth");

		// Turn still ends (finally block) but no StepEnd (the step never succeeded).
		expect(hookCount("StepEnd"), "no StepEnd for the failed step").toBe(0);
		expect(hookCount("TurnEnd"), "TurnEnd still fires in finally").toBe(1);
	}, 30000);
});

// ─── A5: abort at step boundary stops before the next step ───────────────

describe("Step 2C · A5: abort at step boundary", () => {
	test("abort before step 2 → loop breaks, step 2 not entered, step 1 already persisted", async () => {
		const sessionId = "2c-a5-abort";
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "noopTool", input: { first: true } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 2 } },
				],
				[
					{ type: "text", text: "should not run" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 6, outputTokens: 1 } },
				],
			],
		}));

		const { loop, registry } = buildLoop(sessionId);
		// Abort right after step 1's StepEnd fires (i.e. at the step-2 boundary,
		// before step 2's StepStart → streamText).
		let stepEndCount = 0;
		registry.register("StepEnd", async (ctx: any) => {
			stepEndCount++;
			if (stepEndCount === 1) {
				// Step 1 just finalized → abort now so the outer loop's next
				// iteration sees signal.aborted and breaks before step 2.
				loop.abort();
			}
			return undefined;
		});

		await loop.run("go");

		// Only ONE step ran (step 2 never started).
		expect(hookCount("StepEnd"), "only step 1 finalized").toBe(1);
		expect(hookCount("StepStart"), "step 2 StepStart never fired").toBe(1);

		// Step 1 is persisted (StepEnd → turn-hooks → appendStep).
		expect(persistedStepCount(sessionId), "step 1 assistant row persisted").toBe(1);

		// No TurnError (abort is not a failure — runWithRetry swallows AbortError).
		expect(hookCount("TurnError"), "abort is not a failure").toBe(0);
		// TurnEnd still fires (finally block).
		expect(hookCount("TurnEnd")).toBe(1);
		// No terminal error event for abort.
		expect(countEmitted("error"), "no error event for abort").toBe(0);
		// resultText empty (step 2 never produced final text).
		const msgEnd = emitted.find(e => (e as any).type === "message_end") as any;
		expect(msgEnd?.text ?? "").toBe("");
	}, 30000);
});
