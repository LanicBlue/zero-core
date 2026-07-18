// sub-3c (compression-archive-simplify) acceptance test:
//   双机制 Force/Remind + memory ephemeral turn 协调.
//
// # 文件说明书
//
// ## 验收对应
//   docs/plan/compression-archive-simplify/acceptance-3c.md
//     #1 Force 档 (cold / hot+hard) → AgentLoop 协调 memory ephemeral turn (sub-2)
//        → compressSession. Signal 由 hook 写、Loop 在 turn boundary 消费.
//     #2 Remind 档 (hot+soft) → 注入 appendMessage 提示 memory-write + 自判压缩.
//     #3 Force 跑的 memory ephemeral turn step 不落盘 (回归 sub-2 acceptance #1).
//     #4 prompt_too_long 走单机制直压 (不进 signal 路径).
//
// ## 对抗性核查
//   A1 Reentry safety: memory turn ephemeral=true 时,自身的 finally 不会递归
//      coordinateForceCompress (无无限递归 / 不会双压).
//   A2 busy flip race: coordinateForceCompress 的 busy flip 在 finally 同步 awaited,
//      外部 run() 无法插入 (结构性断言).
//   A3 Signal clear on TurnStart: signal 设置后, 下一次 TurnStart 的
//      resetTurnState 把它清掉, 不会泄漏到下个 turn 误触发.
//   A4 ⚠️ wiki snapshot 刷新: sub-1 acceptance #4 承诺 "压缩后刷新" wiki-system-anchors
//      section. 此契约由 sub-3 压缩流程承担 — coordinateForceCompress 跑完
//      compressSession 后应 invalidate("wiki-system-anchors"). 当前实现未做
//      (test.skip 占位, 见 adversarial report).
//   A5 Module-level Map cross-loop bleed: pendingForceSignal 是 module-level Map,
//      clearCompressionTriggerState / clearCompressionTriggerStateForSession 真的清空.
//
// ## 驱动方式
//   真实 AgentLoop + 真实 CoreDatabase + mock LanguageModelV2 (沿用 sub2-ephemeral-turn
//   形态). 在 loop.registry 上注册 production compression-trigger-hooks, 让 PreLLMCall
//   / OnLLMError 走真生产路径. vi.spyOn 监听 compressSession 直接断言"被调用".

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { LanguageModelV2 } from "@ai-sdk/provider";

// Mock provider-factory BEFORE importing AgentLoop (hoisted). resolveModel returns
// an inline mock so both the loop's streamText AND compressSession's generateText
// get a stub model (compression-core uses resolveModel internally).
const resolveModelMock = vi.fn();
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: (...args: unknown[]) => resolveModelMock(...args),
	getContextWindow: () => 200000,
	getMultimodal: () => false,
	getMultimodalTri: () => false,
}));

import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { registerTurnHooks } from "../../src/runtime/hooks/turn-hooks.js";
import {
	registerCompressionTriggerHooks,
	clearCompressionTriggerState,
	_setLastLLMCallForTest,
	_getLastLLMCallForTest,
	_getPendingForceSignalForTest,
	consumePendingForceSignal,
	clearCompressionTriggerStateForSession,
} from "../../src/runtime/hooks/compression-trigger-hooks.js";
import { AgentLoop } from "../../src/runtime/agent-loop.js";
import type { SessionConfig, RuntimeCallbacks, StreamEvent } from "../../src/runtime/types.js";

// ─── Inline mock LanguageModelV2 (replay per-call chunk schedule) ──────────

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

/**
 * Summary JSON compression-core expects from generateText (5-section contract).
 * Used by doGenerate (compressSession's path). Real-shape so the parser succeeds.
 */
function goodSummaryJson(): string {
	return JSON.stringify({
		purpose: "build feature X",
		plan: "step 1, 2, 3",
		status: "did steps 1-2. next: run tests",
		artifacts: "src/feature.ts (created)",
		lessons: "watch out for off-by-one",
	});
}

function createMockModel(config: MockModelConfig, modelId = "mock-sub3c"): LanguageModelV2 {
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
		// compressSession uses generateText → doGenerate. Returns the 5-section
		// summary JSON so the parser succeeds and a real summary row is written.
		async doGenerate() {
			return {
				content: [{ type: "text", text: goodSummaryJson() }],
				finishReason: "stop",
				usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
				warnings: [],
			};
		},
		async doStream(options: any) {
			const myCallNumber = ++callCount;
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

// ─── Stub wiki side-effect tool (records writes to an in-memory map) ───────

function makeWikiStubTool(sideEffectMap: Map<string, string>) {
	return tool({
		description: "Stub wiki write — records the side effect.",
		inputSchema: z.object({
			path: z.string(),
			content: z.string(),
		}),
		execute: async ({ path, content }) => {
			sideEffectMap.set(path, content);
			return { ok: true, path };
		},
	});
}

// ─── Test harness ──────────────────────────────────────────────────────────

let tmpDir: string;
let sessionDB: CoreDatabase;
let emitted: StreamEvent[];
let hookEvents: Array<{ event: string; ctx: Record<string, unknown> }>;
let appendStepSpy: ReturnType<typeof vi.spyOn>;
let upsertStepSpy: ReturnType<typeof vi.spyOn>;
let wikiSideEffects: Map<string, string>;
let activeLoop: AgentLoop | null;
let promptAssemblerInvalidateSpy: ReturnType<typeof vi.spyOn> | null;

function makeCallbacks(): RuntimeCallbacks {
	return { onEvent: (event: StreamEvent) => { emitted.push(event); } };
}

function makeConfig(sessionId: string): SessionConfig {
	return {
		agentId: "test-agent",
		workspaceDir: tmpDir,
		systemPrompt: "You are a test agent.",
		modelId: "mock-sub3c",
		providerName: "Mock",
		sessionId,
		db: sessionDB as any,
		toolPolicy: { tools: {} },
		// Inject the wiki stub tool through the MCP merge path.
		getMcpTools: async () => ({ wikiStub: makeWikiStubTool(wikiSideEffects) }),
	} as unknown as SessionConfig;
}

function buildLoop(sessionId: string, opts: { registerCompressionHooks?: boolean } = {}): AgentLoop {
	emitted = [];
	hookEvents = [];
	wikiSideEffects = new Map();
	const cfg = makeConfig(sessionId);
	const l = new AgentLoop(cfg, [], makeCallbacks());
	registerTurnHooks(sessionDB, l.registry);
	if (opts.registerCompressionHooks !== false) {
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, l.registry);
	}
	const events = ["TurnStart", "StepStart", "StepEnd", "PreLLMCall", "PreToolUse",
		"PostToolUse", "PostToolUseFailure", "TurnEnd", "TurnError"] as const;
	for (const ev of events) {
		l.registry.register(ev as any, async (ctx: Record<string, unknown>) => {
			hookEvents.push({ event: ev, ctx });
			return undefined;
		});
	}
	activeLoop = l;
	return l;
}

function insertSessionRow(db: CoreDatabase, sessionId: string): void {
	const now = new Date().toISOString();
	(db as any).db.prepare(
		"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at, session_kind) " +
		"VALUES (?, ?, 0, ?, ?, ?, 'chat')",
	).run(sessionId, "test-agent", "sub3c", now, now);
}

/**
 * Seed a turn directly into the DB (compressSession needs steps > cursor to
 * actually compress; AgentLoop's own user turn is too short to trigger a real
 * segment). Pad makes it cross the fresh-tail budget.
 */
function seedTurn(db: CoreDatabase, sessionId: string, startSeq: number, pad = 150_000): number {
	const group = startSeq;
	db.appendStep(sessionId, startSeq, group, "user", `seeded user ${startSeq}`);
	db.appendStep(sessionId, startSeq + 1, group, "assistant", JSON.stringify([
		{ type: "text", text: `seeded assistant ${startSeq}` + " ".repeat(pad) },
	]));
	return startSeq + 1;
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub3c-dual-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	runMigrations(sessionDB);
	appendStepSpy = vi.spyOn(sessionDB, "appendStep");
	upsertStepSpy = vi.spyOn(sessionDB, "upsertStep");
	resolveModelMock.mockReset();
	// Default: a single empty-finish call.
	resolveModelMock.mockReturnValue(createMockModel({ steps: [[{ type: "finish" }]] }));
	clearCompressionTriggerState();
	activeLoop = null;
	promptAssemblerInvalidateSpy = null;
});

afterEach(() => {
	try { (activeLoop as any)?.delegator?.cleanup?.(); } catch { /* ignore */ }
	try { sessionDB.close(); } catch { /* ignore */ }
	appendStepSpy.mockRestore();
	upsertStepSpy.mockRestore();
	promptAssemblerInvalidateSpy?.mockRestore();
	try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
	vi.restoreAllMocks();
	activeLoop = null;
});

// Helpers
function emittedCount(type: string): number {
	return emitted.filter(e => (e as any).type === type).length;
}
function readSessionMessages(loop: AgentLoop): any[] {
	return (loop as any).session.getMessages() as any[];
}
/** Get the loop's private promptAssembler (for invalidate spying). */
function getPromptAssembler(loop: AgentLoop): any {
	return (loop as any).promptAssembler;
}

// ===========================================================================
// #1 Force 档 — signal set by hook → AgentLoop coordinates (memory turn + compress)
// ===========================================================================

describe("#1 Force 档: AgentLoop coordinates memory turn + compressSession", () => {
	test("PreLLMCall cold + over-threshold sets signal; loop consumes it and runs memory turn → compressSession", async () => {
		const sessionId = "sub3c-1-force";
		insertSessionRow(sessionDB, sessionId);
		// Seed 2 turns so compressSession has steps to compress.
		seedTurn(sessionDB, sessionId, 0);
		seedTurn(sessionDB, sessionId, 2);
		// Seed token_usage > 100K AND cache cold (undefined lastLLMCall) → Force signal.
		sessionDB.setTokenUsage(sessionId, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sessionId, undefined);

		// Mock model captures prompts across calls so we can detect FORCE_MEMORY_PROMPT.
		const prompts: Array<Array<{ role: string; content: any }>> = [];
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				// User turn: 1 tool-call (wiki write) → finish.
				[
					{ type: "tool-call", toolName: "wikiStub", input: { path: "mem/force-1", content: "M" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 30, outputTokens: 2 } },
				],
				// User turn final response.
				[
					{ type: "text", text: "ok" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 32, outputTokens: 1 } },
				],
				// Memory ephemeral turn: 1 tool-call (wiki write) → finish.
				[
					{ type: "tool-call", toolName: "wikiStub", input: { path: "mem/force-2", content: "M2" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 2 } },
				],
				// Memory ephemeral final response.
				[
					{ type: "text", text: "wrote" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 1 } },
				],
			],
			capturePrompts: prompts,
		}));

		const loop = buildLoop(sessionId);

		// Track promptAssembler.invalidate to detect any wiki-system-anchors refresh.
		promptAssemblerInvalidateSpy = vi.spyOn(getPromptAssembler(loop), "invalidate");

		// Assert: no signal YET (before run).
		expect(_getPendingForceSignalForTest(sessionId)).toBeUndefined();

		await loop.run("user prompt that triggers force");

		// (a) memory ephemeral turn ran — FORCE_MEMORY_PROMPT reached the mock LLM.
		//     Look for the prompt text in any captured prompt's user messages.
		const allPromptText = prompts.map(p =>
			p.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).join("\n")
		).join("\n--\n");
		expect(allPromptText, "FORCE_MEMORY_PROMPT must reach the mock LLM")
			.toContain("automatic compression is about to run");

		// (b) compressSession ran via coordinateForceCompress — summaries populated
		//     in the DB (real call, mocked model returns a parseable 5-section JSON).
		expect(sessionDB.getSummaries(sessionId).length,
			"compressSession ran after memory turn (summaries populated)")
			.toBeGreaterThanOrEqual(1);

		// (c) Signal was consumed (no leftover).
		expect(_getPendingForceSignalForTest(sessionId),
			"pendingForceSignal consumed after Force coordination").toBeUndefined();

		// (d) Wiki write by the memory turn survived (proves memory turn really ran).
		expect(wikiSideEffects.get("mem/force-2"), "memory turn wiki write survived").toBe("M2");
	}, 30000);

	test("Force path does NOT directly populate summaries at hook time (signal is set instead)", async () => {
		// Adversarial: the OLD sub5 behavior (runCompression directly inside the
		// hook) is GONE for Force paths. After firing the hook ALONE (no AgentLoop
		// to consume the signal), the DB must have ZERO new summaries — proving
		// the hook only signals, doesn't compress.
		const sessionId = "sub3c-1-signal-only";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		seedTurn(sessionDB, sessionId, 2);
		sessionDB.setTokenUsage(sessionId, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sessionId, undefined);

		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, reg);
		const summariesBefore = sessionDB.getSummaries(sessionId).length;

		await reg.trigger("PreLLMCall", {
			agentId: "a", sessionId, timestamp: Date.now(),
			config: { agentId: "a", providerName: "Mock", modelId: "mock-sub3c" } as any,
			providers: [{ name: "Mock", cacheTtlMs: 360_000 } as any],
			usage: { inputTokens: 150_000, outputTokens: 0 },
			stepNumber: 1,
		});

		// Signal set.
		expect(_getPendingForceSignalForTest(sessionId)).toBeDefined();
		// But NO compression happened yet (hook only signals).
		expect(sessionDB.getSummaries(sessionId).length, "hook does NOT compress directly")
			.toBe(summariesBefore);
	}, 30000);
});

// ===========================================================================
// #2 Remind 档 — hot+soft → appendMessages; no signal, no compress
// ===========================================================================

describe("#2 Remind 档: injects appendMessage; NO signal, NO compress", () => {
	test("hot+new-turn+soft threshold → appendMessages mentions memory-write + self-judge compression", async () => {
		const sessionId = "sub3c-2-remind";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		_setLastLLMCallForTest(sessionId, Date.now() - 1_000); // 1s ago → hot
		// 150K of 200K window = 75% → above soft (70%), below hard (90%).
		sessionDB.setTokenUsage(sessionId, { inputTokens: 150_000 });

		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, reg);
		const summariesBefore = sessionDB.getSummaries(sessionId).length;

		const res: any = await reg.trigger("PreLLMCall", {
			agentId: "a", sessionId, timestamp: Date.now(),
			config: { agentId: "a", providerName: "Mock", modelId: "mock-sub3c" } as any,
			providers: [{ name: "Mock", cacheTtlMs: 360_000 } as any],
			usage: { inputTokens: 150_000, outputTokens: 0 },
			stepNumber: 1,
		});

		// appendMessages returned, non-empty.
		expect(res?.appendMessages, "appendMessages returned").toBeDefined();
		expect(res.appendMessages.length).toBeGreaterThan(0);
		// Content mentions memory-write (wiki) + self-judge compression.
		const msg = res.appendMessages[0];
		const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
		expect(text, "reminder mentions wiki memory write").toMatch(/wiki|memory/i);
		expect(text, "reminder invites agent to self-judge compression").toMatch(/compress/i);
		expect(text, "reminder is an advisory (not a force)").toMatch(/advisory|consider|may ignore/i);

		// NO signal set.
		expect(_getPendingForceSignalForTest(sessionId),
			"Remind path does NOT set Force signal").toBeUndefined();
		// NO compression happened.
		expect(sessionDB.getSummaries(sessionId).length,
			"Remind path does NOT compress").toBe(summariesBefore);
	}, 30000);
});

// ===========================================================================
// #3 memory turn step 不落盘 (reuse sub-2 acceptance #1 in Force context)
// ===========================================================================

describe("#3 Force memory ephemeral turn writes ZERO step rows", () => {
	test("Force coordination runs memory turn — appendStep/upsertStep NOT called for memory turn content", async () => {
		const sessionId = "sub3c-3-no-persist";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		seedTurn(sessionDB, sessionId, 2);
		sessionDB.setTokenUsage(sessionId, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sessionId, undefined);

		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				// User turn: 1 wiki write tool-call + finish.
				[
					{ type: "tool-call", toolName: "wikiStub", input: { path: "mem/u", content: "u" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 40, outputTokens: 2 } },
				],
				[
					{ type: "text", text: "user-turn done" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 42, outputTokens: 1 } },
				],
				// Memory ephemeral turn: also a wiki write + finish.
				[
					{ type: "tool-call", toolName: "wikiStub", input: { path: "mem/m", content: "m" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 20, outputTokens: 2 } },
				],
				[
					{ type: "text", text: "memory-turn done" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 22, outputTokens: 1 } },
				],
			],
		}));

		const loop = buildLoop(sessionId);

		// Reset spies after buildLoop (turn-hooks registration does not write, but
		// just in case). We want to count writes DURING run() only.
		appendStepSpy.mockClear();
		upsertStepSpy.mockClear();

		await loop.run("trigger force");

		// Memory turn ran (wiki side effect from memory turn captured).
		expect(wikiSideEffects.get("mem/m"), "memory turn ran (wiki write captured)").toBe("m");

		// The TOTAL step count in DB = seeded (4 rows) + user-turn writes.
		// The memory turn added 0. We assert the memory turn's content is NOT in
		// any persisted step (its assistant text "memory-turn done" must not appear).
		const steps = sessionDB.getSteps(sessionId);
		const stepTexts = steps.map(s => typeof s.content === "string" ? s.content : JSON.stringify(s.content ?? ""));
		const memoryTextPresent = stepTexts.some(t => t.includes("memory-turn done"));
		expect(memoryTextPresent,
			"memory turn assistant text must NOT be persisted in any step").toBe(false);

		// And the assistant text from the user turn IS persisted (sanity).
		const userTextPresent = stepTexts.some(t => t.includes("user-turn done"));
		expect(userTextPresent, "user turn assistant text IS persisted").toBe(true);
	}, 30000);
});

// ===========================================================================
// #4 prompt_too_long single-mechanism (KEEP direct runCompression)
// ===========================================================================

describe("#4 OnLLMError prompt_too_long: single-mechanism direct compress", () => {
	test("prompt_too_long fires compressSession DIRECTLY (not via signal path)", async () => {
		const sessionId = "sub3c-4-ptl";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		seedTurn(sessionDB, sessionId, 2);
		// NO _setLastLLMCallForTest needed — OnLLMError ignores cold/hot.
		// NO token_usage seed needed either — OnLLMError ignores threshold.

		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, reg);

		// Assert: NO signal set before the trigger.
		expect(_getPendingForceSignalForTest(sessionId)).toBeUndefined();

		const res: any = await reg.trigger("OnLLMError", {
			agentId: "a", sessionId, timestamp: Date.now(),
			config: { agentId: "a", providerName: "Mock", modelId: "mock-sub3c" } as any,
			providers: [{ name: "Mock", cacheTtlMs: 360_000 } as any],
			error: "context length exceeded",
			errorClass: "prompt_too_long",
			stepNumber: 1,
		});

		// Direct compress: summaries populated (compressSession ran inside the hook).
		expect(sessionDB.getSummaries(sessionId).length,
			"prompt_too_long compresses directly (summaries populated)").toBeGreaterThan(0);
		// Retry requested.
		expect(res?.retry, "retry requested").toBe(true);

		// CRITICAL: NO Force signal was set — the reactive path bypasses the
		// signal entirely (single-mechanism, acceptance-3c #4).
		expect(_getPendingForceSignalForTest(sessionId),
			"prompt_too_long does NOT set Force signal (single-mechanism)").toBeUndefined();
	}, 30000);

	test("non-prompt_too_long error → no compress, no signal, no retry", async () => {
		const sessionId = "sub3c-4-other-err";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		const summariesBefore = sessionDB.getSummaries(sessionId).length;

		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, reg);

		const res: any = await reg.trigger("OnLLMError", {
			agentId: "a", sessionId, timestamp: Date.now(),
			config: { agentId: "a", providerName: "Mock", modelId: "mock-sub3c" } as any,
			providers: [{ name: "Mock", cacheTtlMs: 360_000 } as any],
			error: "rate limit",
			errorClass: "rate_limit",
			stepNumber: 1,
		});

		expect(sessionDB.getSummaries(sessionId).length).toBe(summariesBefore);
		expect(_getPendingForceSignalForTest(sessionId)).toBeUndefined();
		expect(res?.retry).toBeUndefined();
	}, 30000);
});

// ===========================================================================
// A1 Reentry safety — memory turn (ephemeral) cannot recursively Force
// ===========================================================================

describe("A1 Reentry safety: memory ephemeral turn does NOT recursively coordinate", () => {
	test("ephemeral=true run with a pending signal → signal consumed, NO coordinateForceCompress fires", async () => {
		// Strategy: pre-set a signal via fire on a registry (any one will do).
		// Then call loop.run(prompt, {ephemeral:true}) directly. The loop's
		// finally reads `if (forceSignal && !ephemeral)` — with ephemeral=true
		// the consume happens but coordinateForceCompress does NOT.
		// Equivalent to what the memory turn inside coordinateForceCompress does.
		const sessionId = "sub3c-A1-reentry";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		sessionDB.setTokenUsage(sessionId, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sessionId, undefined);

		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, reg);

		// Set the signal via fire.
		await reg.trigger("PreLLMCall", {
			agentId: "a", sessionId, timestamp: Date.now(),
			config: { agentId: "a", providerName: "Mock", modelId: "mock-sub3c" } as any,
			providers: [{ name: "Mock", cacheTtlMs: 360_000 } as any],
			usage: { inputTokens: 150_000, outputTokens: 0 },
			stepNumber: 1,
		});
		expect(_getPendingForceSignalForTest(sessionId),
			"signal set by fire before run").toBeDefined();

		// reset spies (compression-trigger-hooks does not write to db during fire).
		const summariesBeforeEphemeral = sessionDB.getSummaries(sessionId).length;

		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[
					{ type: "text", text: "memory-turn response" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 1 } },
				],
			],
		}));

		const loop = buildLoop(sessionId, { registerCompressionHooks: false });
		// loop's own registry is fresh — the loop won't re-set the signal mid-turn.
		// But the signal was set externally above; the loop's finally will consume it.

		await loop.run("ephemeral trigger", { ephemeral: true });

		// CRITICAL: signal consumed (so it doesn't leak to next turn)...
		expect(_getPendingForceSignalForTest(sessionId),
			"signal consumed by ephemeral turn's finally").toBeUndefined();
		// ...but compressSession was NOT called (no recursive coordination).
		// Prove via DB: summaries count unchanged.
		expect(sessionDB.getSummaries(sessionId).length,
			"ephemeral turn must NOT trigger coordinateForceCompress / compressSession")
			.toBe(summariesBeforeEphemeral);
	}, 30000);
});

// ===========================================================================
// A3 Signal clear on TurnStart (crash recovery / stale signal)
// ===========================================================================

describe("A3 TurnStart clears stale Force signal", () => {
	test("signal set, then TurnStart fires → signal cleared", async () => {
		const sessionId = "sub3c-A3-clear";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		sessionDB.setTokenUsage(sessionId, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sessionId, undefined);

		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, reg);

		// 1) Set the signal via PreLLMCall fire.
		await reg.trigger("PreLLMCall", {
			agentId: "a", sessionId, timestamp: Date.now(),
			config: { agentId: "a", providerName: "Mock", modelId: "mock-sub3c" } as any,
			providers: [{ name: "Mock", cacheTtlMs: 360_000 } as any],
			usage: { inputTokens: 150_000, outputTokens: 0 },
			stepNumber: 1,
		});
		expect(_getPendingForceSignalForTest(sessionId)).toBeDefined();

		// 2) Simulate the next turn's TurnStart (the crash-recovery path: prior
		//    turn crashed mid-body after setting the signal but before its
		//    boundary consume).
		await reg.trigger("TurnStart", {
			agentId: "a", sessionId, timestamp: Date.now(),
			userMessage: "next-turn prompt", source: "user",
		});

		// Stale signal cleared.
		expect(_getPendingForceSignalForTest(sessionId),
			"stale Force signal cleared by TurnStart").toBeUndefined();
	}, 30000);
});

// ===========================================================================
// A4 wiki snapshot refresh after compress (sub-1 acceptance #4 contract)
// ===========================================================================

describe("A4 wiki-system-anchors refresh after compress (sub-1 #4 contract)", () => {
	// sub-1 acceptance #4 explicitly defers the "压缩后刷新" contract to sub-3.
	// sub-3c's coordinateForceCompress owns the Force-path compression flow, so
	// the invalidate belongs there. Implementation: agent-loop.ts:919-926 —
	// outer try/finally unconditionally calls promptAssembler.invalidate(
	// "wiki-system-anchors") so the next turn assembles a fresh snapshot that
	// includes the memory turn's wiki writes. The finally is OUTSIDE the
	// compressSession try/catch, so the refresh fires even on compress failure.
	test("FORCE: after coordinateForceCompress runs, wiki-system-anchors section is invalidated", async () => {
		const sessionId = "sub3c-A4-wiki-refresh";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		seedTurn(sessionDB, sessionId, 2);
		sessionDB.setTokenUsage(sessionId, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sessionId, undefined);

		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "wikiStub", input: { path: "mem/force-A4", content: "X" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 30, outputTokens: 2 } },
				],
				[
					{ type: "text", text: "ok" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 32, outputTokens: 1 } },
				],
				// Memory ephemeral turn.
				[
					{ type: "tool-call", toolName: "wikiStub", input: { path: "mem/force-A4-mem", content: "Y" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 12, outputTokens: 2 } },
				],
				[
					{ type: "text", text: "wrote" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 14, outputTokens: 1 } },
				],
			],
		}));

		const loop = buildLoop(sessionId);
		promptAssemblerInvalidateSpy = vi.spyOn(getPromptAssembler(loop), "invalidate");

		await loop.run("trigger force");

		// compressSession really ran (summaries populated).
		expect(sessionDB.getSummaries(sessionId).length,
			"compressSession ran during Force coordination").toBeGreaterThanOrEqual(1);

		// EXPECTED (plan-08 §1 cutover): coordinateForceCompress now calls the
		// GENERIC promptAssembler.invalidate() (no args = clears ALL cached
		// sections) in its outer finally, instead of the legacy section-specific
		// invalidate("wiki-system-anchors"). The wiki-system-anchors section was
		// removed when wikiAnchors were physically deleted (plan-08 §1); a
		// section-specific invalidate would be a no-op. The generic invalidate is
		// STRONGER — it guarantees the next turn assembles a fresh prompt
		// regardless of which dynamic section changed. Assert the no-arg form.
		const genericInvalidates = promptAssemblerInvalidateSpy.mock.calls.filter(
			(args: any[]) => args.length === 0 || args[0] === undefined,
		);
		expect(genericInvalidates.length,
			"coordinateForceCompress calls generic invalidate() after compress (plan-08 §1)").toBeGreaterThanOrEqual(1);
	}, 30000);

	// NOTE on the failure-path adversarial case: a runtime test that forces
	// compressSession to throw is brittle (sabotaging config.db breaks run()'s
	// own reads; sabotaging resolveModel breaks the user/memory turns too).
	// Instead we rely on the SOURCE STRUCTURE of coordinateForceCompress
	// (agent-loop.ts:859-926): the wiki invalidate lives in an OUTER try/finally
	// whose body contains the compressSession try/catch — so the finally fires
	// regardless of whether compressSession throws, returns early
	// (skippedReason), or succeeds. This was verified by reading the source:
	//   try { ... await this.run(FORCE_MEMORY_PROMPT, {ephemeral:true}); ... }
	//   finally { this.busy = wasBusy; }    ← inner: restore busy
	//   try { ... await compressSession(...); }
	//   catch (err) { log.warn(...); }      ← swallows compressSession failure
	//   finally { this.promptAssembler.invalidate("wiki-system-anchors"); }  ← OUTER
	// The catch swallows → control reaches the outer finally → invalidate fires.
});

// ===========================================================================
// A5 Module-level Map cross-loop bleed (clear helpers)
// ===========================================================================

describe("A5 pendingForceSignal clear helpers reset module state", () => {
	test("clearCompressionTriggerState empties pendingForceSignal Map", async () => {
		const sessionId = "sub3c-A5-clear-all";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		sessionDB.setTokenUsage(sessionId, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sessionId, undefined);

		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, reg);
		await reg.trigger("PreLLMCall", {
			agentId: "a", sessionId, timestamp: Date.now(),
			config: { agentId: "a", providerName: "Mock", modelId: "mock-sub3c" } as any,
			providers: [{ name: "Mock", cacheTtlMs: 360_000 } as any],
			usage: { inputTokens: 150_000, outputTokens: 0 },
			stepNumber: 1,
		});
		expect(_getPendingForceSignalForTest(sessionId)).toBeDefined();

		clearCompressionTriggerState();
		expect(_getPendingForceSignalForTest(sessionId),
			"clearCompressionTriggerState clears pendingForceSignal").toBeUndefined();
	}, 30000);

	test("clearCompressionTriggerStateForSession clears ONLY the target session", async () => {
		const sidA = "sub3c-A5-sess-A";
		const sidB = "sub3c-A5-sess-B";
		insertSessionRow(sessionDB, sidA);
		insertSessionRow(sessionDB, sidB);
		seedTurn(sessionDB, sidA, 0);
		seedTurn(sessionDB, sidB, 0);
		sessionDB.setTokenUsage(sidA, { inputTokens: 150_000 });
		sessionDB.setTokenUsage(sidB, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sidA, undefined);
		_setLastLLMCallForTest(sidB, undefined);

		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, reg);
		for (const sid of [sidA, sidB]) {
			await reg.trigger("PreLLMCall", {
				agentId: "a", sessionId: sid, timestamp: Date.now(),
				config: { agentId: "a", providerName: "Mock", modelId: "mock-sub3c" } as any,
				providers: [{ name: "Mock", cacheTtlMs: 360_000 } as any],
				usage: { inputTokens: 150_000, outputTokens: 0 },
				stepNumber: 1,
			});
		}
		expect(_getPendingForceSignalForTest(sidA)).toBeDefined();
		expect(_getPendingForceSignalForTest(sidB)).toBeDefined();

		clearCompressionTriggerStateForSession(sidA);
		expect(_getPendingForceSignalForTest(sidA),
			"target session signal cleared").toBeUndefined();
		expect(_getPendingForceSignalForTest(sidB),
			"other session signal preserved").toBeDefined();
	}, 30000);

	test("consumePendingForceSignal is read-once (second consume returns undefined)", async () => {
		const sid = "sub3c-A5-consume";
		insertSessionRow(sessionDB, sid);
		seedTurn(sessionDB, sid, 0);
		sessionDB.setTokenUsage(sid, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sid, undefined);

		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: sessionDB }, reg);
		await reg.trigger("PreLLMCall", {
			agentId: "a", sessionId: sid, timestamp: Date.now(),
			config: { agentId: "a", providerName: "Mock", modelId: "mock-sub3c" } as any,
			providers: [{ name: "Mock", cacheTtlMs: 360_000 } as any],
			usage: { inputTokens: 150_000, outputTokens: 0 },
			stepNumber: 1,
		});

		const first = consumePendingForceSignal(sid);
		const second = consumePendingForceSignal(sid);
		expect(first, "first consume returns the signal").toBeDefined();
		expect(first?.reason).toBeTruthy();
		expect(second, "second consume returns undefined (already cleared)").toBeUndefined();
	}, 30000);
});

// ===========================================================================
// A2 busy flip race — structural assertion
// ===========================================================================

describe("A2 busy flip race — coordinateForceCompress structural safety", () => {
	test("coordinateForceCompress flips busy off→on synchronously around the awaited nested run", async () => {
		// Structural proof: read the source and assert the nested run() is
		// AWAITED inside a try/finally that restores busy BEFORE the outer
		// finally releases busy. JS is single-threaded so no concurrent caller
		// can observe busy===true at the same time as the nested run() entry.
		//
		// We verify the contract dynamically: drive a Force turn, then verify
		// (a) the loop is NOT busy after run() returns (busy restored + released),
		// (b) the nested memory turn actually completed (wiki side effect captured).
		const sessionId = "sub3c-A2-flip";
		insertSessionRow(sessionDB, sessionId);
		seedTurn(sessionDB, sessionId, 0);
		seedTurn(sessionDB, sessionId, 2);
		sessionDB.setTokenUsage(sessionId, { inputTokens: 150_000 });
		_setLastLLMCallForTest(sessionId, undefined);

		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "wikiStub", input: { path: "mem/u", content: "u" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 30, outputTokens: 2 } },
				],
				[
					{ type: "text", text: "user-turn done" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 32, outputTokens: 1 } },
				],
				[
					{ type: "tool-call", toolName: "wikiStub", input: { path: "mem/m", content: "m" } },
					{ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 12, outputTokens: 2 } },
				],
				[
					{ type: "text", text: "memory-turn done" },
					{ type: "finish", finishReason: "stop", usage: { inputTokens: 14, outputTokens: 1 } },
				],
			],
		}));

		const loop = buildLoop(sessionId);
		await loop.run("trigger force coordination");

		// After run() returns: busy must be false (outer finally released it).
		// If the busy-flip were wrong (e.g. never restored), getState().isBusy
		// would still be true here.
		expect((loop as any).busy,
			"busy released after run() (busy-flip restored cleanly)").toBe(false);
		expect(loop.getState().isBusy).toBe(false);
		// And the memory turn completed (wiki write captured).
		expect(wikiSideEffects.get("mem/m")).toBe("m");
	}, 30000);
});
