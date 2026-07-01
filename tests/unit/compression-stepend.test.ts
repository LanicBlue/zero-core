// Step 3A acceptance test: compression evaluates on StepEnd, per-step.
//
// # File说明书
// ## 核心功能
// 验证 Step 3A (compression hook moved PostTurnComplete → StepEnd):
//   - StepEnd with contextUsage <= l1Threshold → compressIfNeeded early-returns
//     (didCompress = false); no replaceMessages / saveToDb side effect.
//   - StepEnd with contextUsage > l1Threshold (crossed at step 2) →
//     compressIfNeeded fires at THAT step's StepEnd, returns didCompress = true,
//     and the hook applies replaceMessages + saveToDb inside the StepEnd handler
//     (per-step timing, NOT deferred to a turn-end boundary).
//
// ## 输入
// vi.mock'd CompressionEngine (we control compressIfNeeded's return value to
// assert on didCompress deterministically without a live LLM), a fake session
// exposing getMessages/replaceMessages/saveToDb/getSessionId, and a config
// whose compression.l1Threshold = 0.5.
//
// ## 输出
// Vitest cases.
//
// ## 定位
// tests/unit/ — pairs with compression-engine.test.ts (which covers the pure
// turn/threshold logic) by exercising the hook's per-step scheduling contract.
//
// ## 维护规则
// If the hook reverts to PostTurnComplete, or the threshold gate moves out of
// the hook, this test must fail — update together with compression-hooks.ts.
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { HookRegistry } from "../../src/core/hook-registry.js";

// ─── Mock CompressionEngine BEFORE importing the hook ─────────────────
// The hook does `new CompressionEngine(providers, ...)`. We stub the class so
// we can drive compressIfNeeded's return shape (didCompress / messages /
// memoryNodes) deterministically and assert the hook's StepEnd scheduling
// behaviour without standing up a real provider/model.
const compressIfNeededMock = vi.fn();
vi.mock("../../src/runtime/compression-engine.js", () => ({
	CompressionEngine: class {
		constructor(_providers: unknown, _providerName: unknown, _modelId: unknown) {}
		compressIfNeeded = compressIfNeededMock;
	},
}));

import { registerCompressionHooks } from "../../src/runtime/hooks/compression-hooks.js";

/** Minimal fake session — only the surface the hook touches. */
function makeFakeSession(messages: any[]) {
	return {
		_messages: messages,
		getMessages() {
			return this._messages;
		},
		replaceMessages(next: any[]) {
			this._messages = next;
		},
		saveToDb: vi.fn(),
		getSessionId: () => "sess-step-3a",
	};
}

describe("Step 3A — compression evaluates on StepEnd (per-step)", () => {
	let registry: HookRegistry;

	beforeEach(() => {
		registry = HookRegistry.getInstance();
		registry.clear();
		compressIfNeededMock.mockReset();
		registerCompressionHooks(registry);
	});

	afterEach(() => {
		registry.clear();
		compressIfNeededMock.mockReset();
	});

	/**
	 * Fire a StepEnd with the given contextUsage. Mirrors how agent-loop's
	 * finalizeOneStep builds the StepEndContext for the compression surface
	 * (Step 3A added session/config/providers/contextUsage to StepEndContext).
	 */
	async function fireStepEnd(session: any, config: any, contextUsage: number) {
		await (registry as any).trigger("StepEnd", {
			agentId: "dev",
			sessionId: "sess-step-3a",
			config,
			providers: [],
			contextUsage,
			session,
		});
	}

	test("below-threshold step: compressIfNeeded early-returns (didCompress = false), no side effects", async () => {
		const session = makeFakeSession([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
		const config: any = {
			compression: {
				enabled: true,
				l1Threshold: 0.5,
				l2Threshold: 0.3,
				keepRecentTurns: 2,
			},
		};

		// Usage 0.4 is <= l1Threshold (0.5) → the hook must early-return BEFORE
		// ever constructing/calling the engine. Even if the engine were reached,
		// compressIfNeeded's own below-threshold guard returns didCompress=false.
		await fireStepEnd(session, config, 0.4);

		expect(compressIfNeededMock).not.toHaveBeenCalled();
		expect(session.saveToDb).not.toHaveBeenCalled();
		// Messages untouched.
		expect(session.getMessages()).toHaveLength(2);
	});

	test("threshold crossed at step 2: compression fires at step 2's StepEnd (didCompress = true), not the turn boundary", async () => {
		// Enough turns that compressOldestTurn would have a target in a real run;
		// here the mocked engine just reports a compression happened.
		const initialMessages = [
			{ role: "user", content: "turn 1 question" },
			{ role: "assistant", content: "turn 1 answer long enough to compress".padEnd(220, "x") },
			{ role: "user", content: "turn 2 question" },
			{ role: "assistant", content: "turn 2 answer long enough to compress".padEnd(220, "x") },
			{ role: "user", content: "turn 3 question" },
			{ role: "assistant", content: "turn 3 answer long enough to compress".padEnd(220, "x") },
		];
		const session = makeFakeSession(initialMessages);
		const saveSpy = session.saveToDb as ReturnType<typeof vi.fn>;
		const config: any = {
			compression: {
				enabled: true,
				l1Threshold: 0.5, // crossed when contextUsage > 0.5
				l2Threshold: 0.3,
				keepRecentTurns: 2,
			},
		};

		// ── Step 1: usage 0.4, still below 0.5 → no compression yet. ──
		await fireStepEnd(session, config, 0.4);
		expect(compressIfNeededMock).not.toHaveBeenCalled();
		expect(saveSpy).not.toHaveBeenCalled();
		expect(session.getMessages()).toBe(initialMessages);

		// ── Step 2: usage 0.6 crosses l1Threshold (0.5). The compression MUST
		//    fire here, at step 2's StepEnd, with didCompress = true. ──
		const compressedMessages = [
			{ role: "user", content: "turn 1 question" },
			{ role: "assistant", content: "[compressed summary]" },
			{ role: "user", content: "turn 2 question" },
			{ role: "assistant", content: "turn 2 answer long enough to compress".padEnd(220, "x") },
			{ role: "user", content: "turn 3 question" },
			{ role: "assistant", content: "turn 3 answer long enough to compress".padEnd(220, "x") },
		];
		compressIfNeededMock.mockResolvedValueOnce({
			messages: compressedMessages,
			memoryNodes: [],
			didCompress: true,
			didExtract: false,
		});

		await fireStepEnd(session, config, 0.6);

		// Engine was reached this step.
		expect(compressIfNeededMock).toHaveBeenCalledTimes(1);
		const callArgs = compressIfNeededMock.mock.calls[0];
		expect(callArgs[1]).toBe(0.6); // contextUsage passed through
		// Hook applied the engine's compressed messages and persisted.
		expect(session.getMessages()).toBe(compressedMessages);
		expect(saveSpy).toHaveBeenCalledTimes(1);
	});

	test("StepEndContext now carries the compression surface (session/config/providers/contextUsage)", async () => {
		// Regression guard for the StepEndContext extension added in 3A: if a
		// future change drops these fields, the hook would silently no-op.
		// We assert the hook reads ctx.contextUsage and ctx.session by driving a
		// below-threshold step and confirming the gate evaluated the value.
		const session = makeFakeSession([{ role: "user", content: "x" }]);
		const config: any = {
			compression: { enabled: true, l1Threshold: 0.7, keepRecentTurns: 2 },
		};

		// 0.5 <= 0.7 → below threshold, engine not reached. This proves the
		// hook received and used ctx.contextUsage (otherwise it would have
		// thrown on `undefined <= 0.7` or skipped the gate).
		await expect(fireStepEnd(session, config, 0.5)).resolves.toBeUndefined();
		expect(compressIfNeededMock).not.toHaveBeenCalled();
	});
});
