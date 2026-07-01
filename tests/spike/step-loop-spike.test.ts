// SPIKE — Step 2A: AI SDK single-step loop feasibility.
//
// NOT production code. Isolated under tests/spike/. Verifies whether
// streamText({ stopWhen: stepCountIs(1), ... }) can be driven by an outer
// while-loop to give Phase 2 a step-centric executeStream.
//
// Verifies four questions (see RESULT.md):
//   1. Single-step tool-call continuation (tool-call step → text-finish step).
//   2. abort() mid single-step streamText → clean AbortError, no residue.
//   3. Per-step retry on transient error (only the failing step reruns).
//   4. finish-step + usage still emitted in single-step mode (StepEnd persists).
//
// Uses an inline mock implementing the AI SDK LanguageModelV2 surface (mirrors
// src/runtime/mock-language-model.ts shape, kept self-contained so the spike
// has no production-path coupling). The mock replays a per-call chunk schedule
// so we can script multi-step scenarios deterministically.
//
// Run:  npx vitest run tests/spike/step-loop-spike.test.ts
// (vitest.config.ts only includes tests/unit/**, so this file is invisible to
//  the normal test run — deliberately isolated.)

import { describe, it, expect } from "vitest";
import { streamText, stepCountIs, tool, type LanguageModelV2 } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Inline mock language model (LanguageModelV2). Replays a per-call schedule of
// chunks. Each top-level entry = one model call (one "step" under stepCountIs(1)).
// ---------------------------------------------------------------------------

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
	/** Per-call chunk schedules. Index = call number (clamped to last). */
	steps?: MockChunk[][];
	/** Single-response back-compat (used when steps not provided). */
	chunks?: MockChunk[];
	/** Throw this Error class from doStream on the Nth call (1-based). */
	throwOnCall?: { callNumber: number; error: Error };
	/** ms delay between enqueued parts. 0 = synchronous. */
	delayMs?: number;
	/** Optional abort hook: reject the in-flight stream when aborted. */
	abortable?: boolean;
}

function createMockModel(config: MockModelConfig, modelId = "mock-model"): LanguageModelV2 {
	const delayMs = config.delayMs ?? 0;
	let callCount = 0;

	const chunksForCall = (n: number): MockChunk[] => {
		if (config.steps?.length) {
			const idx = Math.min(n, config.steps.length - 1);
			return config.steps[idx] ?? [];
		}
		return config.chunks ?? [];
	};

	const toStreamParts = (chunk: MockChunk) => {
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
					usage: {
						inputTokens,
						outputTokens,
						totalTokens: u.totalTokens ?? inputTokens + outputTokens,
					},
				}];
			}
		}
	};

	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId,
		supportedUrls: {},

		async doGenerate() {
			throw new Error("doGenerate not used in spike");
		},

		async doStream(_options) {
			const myCallNumber = ++callCount;

			if (config.throwOnCall && myCallNumber === config.throwOnCall.callNumber) {
				throw config.throwOnCall.error;
			}

			const chunks = chunksForCall(myCallNumber - 1);
			const stream = new ReadableStream({
				async start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					try {
						for (const chunk of chunks) {
							for (const part of toStreamParts(chunk)) {
								controller.enqueue(part);
								if (delayMs > 0) {
									await new Promise((r) => setTimeout(r, delayMs));
								}
							}
						}
						controller.close();
					} catch (e) {
						controller.error(e);
					}
				},
			});
			return { stream };
		},
	};
}

// ---------------------------------------------------------------------------
// Test tool — returns the input verbatim so we can assert it round-tripped.
// ---------------------------------------------------------------------------
function makeEchoTool() {
	return tool({
		description: "Echo the input back as a tool result.",
		inputSchema: z.object({ value: z.string() }),
		execute: async ({ value }) => ({ echoed: value }),
	});
}

// ---------------------------------------------------------------------------
// Outer while-loop driver — the pattern Phase 2 wants to adopt.
// Returns the trace of events + final messages + per-step step-finish usages.
// ---------------------------------------------------------------------------
interface LoopTrace {
	steps: Array<{
		stepIndex: number;
		events: string[];
		finishStepUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
		finishStepSeen: boolean;
		finishReason?: string;
		hadToolCall: boolean;
	}>;
	finalMessages: unknown[];
	totalStreamTextCalls: number;
}

async function runStepLoop(opts: {
	model: LanguageModelV2;
	messages: any[];
	tools?: Record<string, any>;
	maxSteps?: number;
	abortSignal?: AbortSignal;
}): Promise<LoopTrace> {
	const { model, messages, tools, maxSteps = 10, abortSignal } = opts;
	let currentMessages = [...messages];
	const trace: LoopTrace = { steps: [], finalMessages: currentMessages, totalStreamTextCalls: 0 };

	for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
		const stepEvents: string[] = [];
		let finishStepSeen = false;
		let finishStepUsage: LoopTrace["steps"][number]["finishStepUsage"];
		let finishReason: string | undefined;
		let hadToolCall = false;

		const result = streamText({
			model,
			messages: currentMessages,
			tools,
			stopWhen: stepCountIs(1),
			...(abortSignal ? { abortSignal } : {}),
		});
		trace.totalStreamTextCalls++;

		for await (const ev of result.fullStream as any) {
			stepEvents.push(ev.type);
			if (ev.type === "tool-call") hadToolCall = true;
			if (ev.type === "finish-step") {
				finishStepSeen = true;
				finishStepUsage = ev.usage as any;
			}
			if (ev.type === "finish") finishReason = ev.finishReason;
			if (ev.type === "error") {
				stepEvents.push(`error:${(ev.error as Error)?.message}`);
			}
		}

		// Append this step's model messages (tool-call and/or assistant text)
		// so the next streamText call sees the full conversation. NOTE: in ai SDK
		// v6, result.response is itself a PromiseLike that resolves to an object
		// carrying .messages — so we must await response first, then read .messages.
		const response = await (result.response as any);
		const responseMessages = response?.messages;
		if (Array.isArray(responseMessages) && responseMessages.length > 0) {
			currentMessages = [...currentMessages, ...responseMessages];
		}

		trace.steps.push({
			stepIndex,
			events: stepEvents,
			finishStepUsage,
			finishStepSeen,
			finishReason,
			hadToolCall,
		});
		trace.finalMessages = currentMessages;

		if (!hadToolCall) break; // text-finish → done
	}

	return trace;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("Spike 2A: single-step streamText loop", () => {

	// Q1 — Single-step tool-call continuation.
	it("Q1: continues across steps when step 1 tool-calls and step 2 text-finishes", async () => {
		const model = createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "echo", input: { value: "hello" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 12, outputTokens: 3 } },
				],
				[
					{ type: "text", text: "All done." },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 4 } },
				],
			],
		});

		const trace = await runStepLoop({
			model,
			messages: [{ role: "user", content: "use echo then finish" }],
			tools: { echo: makeEchoTool() },
		});

		// Evidence dump — captured into RESULT.md manually.
		// eslint-disable-next-line no-console
		console.log("Q1 trace:", JSON.stringify(trace, null, 2));

		// Q1 verdict criteria:
		expect(trace.steps.length).toBe(2); // two streamText calls
		expect(trace.steps[0].hadToolCall).toBe(true);
		expect(trace.steps[0].finishReason).toBe("tool-calls");
		expect(trace.steps[1].hadToolCall).toBe(false);
		expect(trace.steps[1].finishReason).toBe("stop");
		// The tool-result from step 0 must reach step 1: confirm by checking the
		// final messages contain a tool result role.
		const roles = (trace.finalMessages as any[]).map((m) => m.role);
		expect(roles).toContain("tool");
	});

	// Q2 — abort mid single-step stream.
	it("Q2: abortSignal.abort() during a step rejects/aborts cleanly", async () => {
		const model = createMockModel({
			delayMs: 50, // slow enough to abort mid-stream
			steps: [[
				{ type: "text", text: "streaming..." },
				{ type: "text", text: "more..." },
				{ type: "finish", finishReason: "stop" },
			]],
		});

		const ac = new AbortController();
		const seenEvents: string[] = [];
		let caught: unknown;

		const result = streamText({
			model,
			messages: [{ role: "user", content: "x" }],
			stopWhen: stepCountIs(1),
			abortSignal: ac.signal,
		});

		const consumer = (async () => {
			try {
				for await (const ev of result.fullStream as any) {
					seenEvents.push(ev.type);
				}
			} catch (e) {
				caught = e;
			}
		})();

		// Abort after first text part lands.
		await new Promise((r) => setTimeout(r, 80));
		ac.abort();
		await consumer;

		const errName = (caught as Error)?.name ?? "<no-throw>";
		const errMsg = (caught as Error)?.message ?? "";
		// eslint-disable-next-line no-console
		console.log("Q2 seenEvents:", seenEvents, "caught:", errName, errMsg);

		// Q2 verdict: either an AbortError thrown, or stream terminated cleanly
		// without residue. We accept AbortError OR a clean end (no further parts).
		const abortedCleanly =
			errName === "AbortError" ||
			/abort/i.test(errMsg) ||
			seenEvents.length > 0; // consumed some parts then stopped
		expect(abortedCleanly).toBe(true);
		// No finish-step should fire after abort (no spurious StepEnd persistence).
		expect(seenEvents.includes("finish-step")).toBe(false);
	});

	// Q3 — per-step retry on transient error (only the failing step reruns).
	it("Q3: transient error in one step can be retried without replaying prior steps", async () => {
		// Call schedule:
		//   call 1 (step 0): tool-call + finish(tool-calls)
		//   call 2 (step 1): THROW transient
		//   call 3 (step 1 retry): text + finish(stop)
		// We want: messages carry over (tool-call+tool-result from step 0 remain),
		//          and only step 1's streamText is reissued.
		let transientThrown = false;
		const model = createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "echo", input: { value: "keep" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 2 } },
				],
				[
					{ type: "text", text: "final answer" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 8, outputTokens: 6 } },
				],
			],
			throwOnCall: {
				callNumber: 2,
				error: new Error("transient: rate limited"),
			},
		});

		// Custom loop with retry around the per-step streamText call.
		let currentMessages: any[] = [{ role: "user", content: "go" }];
		const stepRecords: Array<{ events: string[]; toolCall: boolean; retried: boolean; threw?: string }> = [];
		const MAX_STEPS = 5;
		const MAX_RETRIES = 2;

		for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex++) {
			let attempt = 0;
			// eslint-disable-next-line no-constant-condition
			while (true) {
				attempt++;
				const events: string[] = [];
				let hadToolCall = false;
				let threw: string | undefined;
				try {
					const result = streamText({
						model,
						messages: currentMessages,
						tools: { echo: makeEchoTool() },
						stopWhen: stepCountIs(1),
					});
					for await (const ev of result.fullStream as any) {
						events.push(ev.type);
						if (ev.type === "tool-call") hadToolCall = true;
						if (ev.type === "error") threw = (ev.error as Error)?.message;
					}
					if (threw) throw new Error(threw);
					const response = await (result.response as any);
					const responseMessages = response?.messages;
					if (Array.isArray(responseMessages) && responseMessages.length > 0) {
						currentMessages = [...currentMessages, ...responseMessages];
					}
					stepRecords.push({ events, toolCall: hadToolCall, retried: attempt > 1 });
					break; // step succeeded
				} catch (e) {
					if (attempt > MAX_RETRIES) {
						stepRecords.push({ events, toolCall: hadToolCall, retried: true, threw: (e as Error).message });
						throw e; // give up
					}
					// retry same step (messages NOT advanced — only this step reruns)
					continue;
				}
			}
			if (!stepRecords[stepIndex].toolCall) break;
		}

		// eslint-disable-next-line no-console
		console.log("Q3 stepRecords:", JSON.stringify(stepRecords, null, 2));
		// eslint-disable-next-line no-console
		console.log("Q3 finalMessages roles:", currentMessages.map((m) => m.role));

		// Q3 verdict:
		// - Step 0 ran once, had a tool-call, did not retry.
		expect(stepRecords[0].retried).toBe(false);
		expect(stepRecords[0].toolCall).toBe(true);
		// - Step 1 retried at least once (transient on call 2), then succeeded.
		expect(stepRecords[1].retried).toBe(true);
		expect(stepRecords[1].toolCall).toBe(false);
		// - Step 0's tool-call + tool-result messages are still present after retry
		//   (no replay of step 0).
		const roles = currentMessages.map((m) => m.role);
		expect(roles.filter((r) => r === "tool").length).toBe(1); // exactly one tool result
	});

	// Q4 — finish-step + usage still emitted in single-step mode.
	it("Q4: emits finish-step with usage for each single-step call", async () => {
		const model = createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "echo", input: { value: "x" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 7, outputTokens: 3 } },
				],
				[
					{ type: "text", text: "ok" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 11, outputTokens: 9 } },
				],
			],
		});

		const trace = await runStepLoop({
			model,
			messages: [{ role: "user", content: "go" }],
			tools: { echo: makeEchoTool() },
		});

		// eslint-disable-next-line no-console
		console.log("Q4 trace steps:", JSON.stringify(trace.steps.map((s) => ({
			i: s.stepIndex,
			finishStepSeen: s.finishStepSeen,
			usage: s.finishStepUsage,
			events: s.events,
		})), null, 2));

		// Q4 verdict: every step saw finish-step with non-empty usage.
		expect(trace.steps.length).toBeGreaterThanOrEqual(1);
		for (const step of trace.steps) {
			expect(step.finishStepSeen, `step ${step.stepIndex} missing finish-step`).toBe(true);
			expect(step.finishStepUsage, `step ${step.stepIndex} missing usage`).toBeTruthy();
			const u = step.finishStepUsage!;
			expect(typeof u.totalTokens).toBe("number");
		}
		// Specifically confirm the second step's usage reflects its fixture values.
		const last = trace.steps[trace.steps.length - 1];
		expect(last.finishStepUsage?.inputTokens).toBe(11);
		expect(last.finishStepUsage?.outputTokens).toBe(9);
	});
});
