import { describe, test, expect } from "vitest";
import { buildDefaultPrompt } from "../../src/core/default-prompt.js";

describe("buildDefaultPrompt", () => {
	test("embeds the agent name", () => {
		const p = buildDefaultPrompt("Foo");
		expect(p).toContain("Foo");
		expect(p.startsWith("You are Foo,")).toBe(true);
	});

	test("mentions coding assistant role", () => {
		const p = buildDefaultPrompt("Bar");
		expect(p.toLowerCase()).toContain("coding assistant");
	});

	test("different names produce different prompts", () => {
		const a = buildDefaultPrompt("Alice");
		const b = buildDefaultPrompt("Bob");
		expect(a).not.toBe(b);
		expect(a).toContain("Alice");
		expect(b).toContain("Bob");
	});

	test("empty name still produces a valid template", () => {
		const p = buildDefaultPrompt("");
		expect(p).toContain("You are ,");
		expect(p.length).toBeGreaterThan(100);
	});
});
