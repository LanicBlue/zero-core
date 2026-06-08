import { describe, test, expect } from "vitest";
import { CompressionEngine, TurnBoundary } from "../../src/runtime/compression-engine.js";

// We only test the synchronous parts (turn identification, shouldCompress)
// The L1/L2 compression requires an LLM call, so those are integration tests.

function makeMessages(roles: Array<"user" | "assistant" | "tool">): any[] {
	return roles.map((role, i) => ({
		role,
		content: role === "tool" ? `[Tool result ${i}]` : `Message ${i} (${role})`,
	}));
}

describe("CompressionEngine", () => {
	// We pass dummy provider/model — only used for LLM calls which we don't test here
	const engine = new CompressionEngine([], "test", "test");

	describe("identifyTurns", () => {
		test("empty messages → no turns", () => {
			expect(engine.identifyTurns([])).toEqual([]);
		});

		test("single user message → one turn", () => {
			const msgs = makeMessages(["user"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([{ start: 0, end: 1 }]);
		});

		test("user + assistant → one turn", () => {
			const msgs = makeMessages(["user", "assistant"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([{ start: 0, end: 2 }]);
		});

		test("two turns with tool calls", () => {
			// Turn 1: user → assistant → tool → assistant
			// Turn 2: user → assistant
			const msgs = makeMessages(["user", "assistant", "tool", "assistant", "user", "assistant"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([
				{ start: 0, end: 4 },
				{ start: 4, end: 6 },
			]);
		});

		test("three turns", () => {
			const msgs = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([
				{ start: 0, end: 2 },
				{ start: 2, end: 4 },
				{ start: 4, end: 6 },
			]);
		});

		test("consecutive user messages → each starts a new turn", () => {
			const msgs = makeMessages(["user", "user", "user"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([
				{ start: 0, end: 1 },
				{ start: 1, end: 2 },
				{ start: 2, end: 3 },
			]);
		});
	});

	describe("shouldCompress", () => {
		test("returns true when usage > threshold", () => {
			expect(engine.shouldCompress(0.8, 0.7)).toBe(true);
		});

		test("returns false when usage <= threshold", () => {
			expect(engine.shouldCompress(0.6, 0.7)).toBe(false);
		});

		test("returns false when usage equals threshold", () => {
			expect(engine.shouldCompress(0.7, 0.7)).toBe(false);
		});
	});
});
