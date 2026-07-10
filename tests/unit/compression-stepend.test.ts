// steps-overhaul sub-3: compression StepEnd hook is DISABLED (no-op).
//
// # File说明书
// ## 核心功能(当前)
// Originally this file verified that compression evaluated per-step on StepEnd
// (Step 3A: the threshold-crossing engine fired at the step that crossed
// l1Threshold, not deferred to the turn boundary). sub-3 DISABLED that trigger:
// the `messages` table was redefined to "summary + compression cursor" (no step
// content), so the old L1/L2 engine — which writes the retired messages shape
// and calls the deleted syncTurnsAfterCompression/replaceStepsFromMessages —
// would crash if it ran. sub-3 leaves the engine code as dead code and no-ops
// the StepEnd handler; sub-4 will delete the engine + the hook entirely and
// land the new Extractor A.
//
// This file now asserts the DISABLED contract:
//   - StepEnd with contextUsage <= l1Threshold → engine NOT reached (no-op).
//   - StepEnd with contextUsage > l1Threshold → engine STILL NOT reached
//     (the whole point of sub-3: the trigger is gone, regardless of usage).
//   - No saveToDb, no replaceMessages side effect, in either case.
//
// ## 定位
// tests/unit/ — regression guard for the sub-3 disable. When sub-4 replaces
// this hook with the new Extractor A trigger, this file is rewritten (or the
// module is deleted along with the engine).

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { HookRegistry } from "../../src/core/hook-registry.js";

// ─── Mock CompressionEngine (still imported by the hook module, but must NOT
// be reached now that the StepEnd handler is a no-op). We keep the mock so the
// import resolves; the assertion is that compressIfNeeded is NEVER called.
const compressIfNeededMock = vi.fn();
vi.mock("../../src/runtime/compression-engine.js", () => ({
	CompressionEngine: class {
		constructor(_providers: unknown, _providerName: unknown, _modelId: unknown) {}
		compressIfNeeded = compressIfNeededMock;
	},
}));

import { registerCompressionHooks } from "../../src/runtime/hooks/compression-hooks.js";

/** Minimal fake session — only the surface the old hook used to touch. The
 *  no-op handler doesn't read it, but we pass it so the StepEndContext shape
 *  mirrors the real one (regression guard if a future change re-enables). */
function makeFakeSession(messages: any[]) {
	return {
		_messages: messages,
		getMessages() { return this._messages; },
		replaceMessages(next: any[]) { this._messages = next; },
		saveToDb: vi.fn(),
		getSessionId: () => "sess-step-3a",
	};
}

describe("sub-3 — compression StepEnd hook is DISABLED (no-op)", () => {
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

	test("below-threshold step: no-op (engine never reached, no side effects)", async () => {
		const session = makeFakeSession([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
		const config: any = {
			compression: { enabled: true, l1Threshold: 0.5, l2Threshold: 0.3, keepRecentTurns: 2 },
		};

		await fireStepEnd(session, config, 0.4);

		expect(compressIfNeededMock).not.toHaveBeenCalled();
		expect(session.saveToDb).not.toHaveBeenCalled();
		expect(session.getMessages()).toHaveLength(2);
	});

	test("ABOVE-threshold step: STILL no-op (sub-3 disabled the trigger regardless of usage)", async () => {
		// Pre-sub-3 this crossed l1Threshold and fired compression. sub-3 makes
		// the StepEnd handler unconditionally return; the engine is dead code
		// until sub-4 lands Extractor A. This test pins that contract so a
		// regression that re-enables the old trigger fails loudly here.
		const initialMessages = [
			{ role: "user", content: "turn 1 question" },
			{ role: "assistant", content: "turn 1 answer long enough to compress".padEnd(220, "x") },
			{ role: "user", content: "turn 2 question" },
		];
		const session = makeFakeSession(initialMessages);
		const saveSpy = session.saveToDb as ReturnType<typeof vi.fn>;
		const config: any = {
			compression: { enabled: true, l1Threshold: 0.5, l2Threshold: 0.3, keepRecentTurns: 2 },
		};

		await fireStepEnd(session, config, 0.6);

		expect(compressIfNeededMock).not.toHaveBeenCalled();
		expect(saveSpy).not.toHaveBeenCalled();
		// Messages untouched — no replaceMessages, no saveToDb.
		expect(session.getMessages()).toBe(initialMessages);
	});

	test("StepEndContext carries the compression surface but the handler ignores it (no-op)", async () => {
		// Regression guard: the handler still RECEIVES ctx.contextUsage /
		// ctx.session (StepEndContext unchanged) but must not act on them. A
		// below-threshold fire proves the handler ran without throwing.
		const session = makeFakeSession([{ role: "user", content: "x" }]);
		const config: any = { compression: { enabled: true, l1Threshold: 0.7, keepRecentTurns: 2 } };

		await expect(fireStepEnd(session, config, 0.5)).resolves.toBeUndefined();
		expect(compressIfNeededMock).not.toHaveBeenCalled();
	});
});
