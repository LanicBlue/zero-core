import { describe, test, expect } from "vitest";
import { buildContextMessage } from "../../src/runtime/context-message.js";

describe("buildContextMessage", () => {
	test("returns environment block when only workspaceDir provided", () => {
		const result = buildContextMessage({ workspaceDir: "/home/user/project" });
		expect(result).not.toBeNull();
		expect(result!).toContain("<context>");
		expect(result!).toContain("</context>");
		expect(result!).toContain("## Environment");
		expect(result!).toContain("/home/user/project");
	});

	test("includes guidelines when provided", () => {
		const result = buildContextMessage({
			guidelines: ["Always write tests", "Use TypeScript"],
		});
		expect(result).toContain("## Guidelines");
		expect(result).toContain("- Always write tests");
		expect(result).toContain("- Use TypeScript");
	});

	test("includes memory context when provided", () => {
		const result = buildContextMessage({
			memoryContext: "**ProjectX** (decision): Use SQLite. [2026-06-01]",
		});
		expect(result).toContain("## Recalled Memories");
		expect(result).toContain("ProjectX");
	});

	test("includes RAG context when provided", () => {
		const result = buildContextMessage({
			ragContext: "Relevant doc: ...",
		});
		expect(result).toContain("## Knowledge Base");
		expect(result).toContain("Relevant doc: ...");
	});

	test("includes all sections when all provided", () => {
		const result = buildContextMessage({
			workspaceDir: "/home/user/project",
			guidelines: ["Rule 1"],
			memoryContext: "**X** (event): happened",
			ragContext: "Doc content",
		});
		expect(result).toContain("## Environment");
		expect(result).toContain("## Guidelines");
		expect(result).toContain("## Recalled Memories");
		expect(result).toContain("## Knowledge Base");
	});

	test("order: Environment → Guidelines → Recalled Memories → Knowledge Base", () => {
		const result = buildContextMessage({
			guidelines: ["G"],
			memoryContext: "M",
			ragContext: "R",
		});
		const envIdx = result!.indexOf("## Environment");
		const guideIdx = result!.indexOf("## Guidelines");
		const memIdx = result!.indexOf("## Recalled Memories");
		const ragIdx = result!.indexOf("## Knowledge Base");
		expect(envIdx).toBeLessThan(guideIdx);
		expect(guideIdx).toBeLessThan(memIdx);
		expect(memIdx).toBeLessThan(ragIdx);
	});

	test("wraps everything in <context> tag", () => {
		const result = buildContextMessage({ workspaceDir: "/tmp" });
		expect(result!.startsWith("<context>\n")).toBe(true);
		expect(result!.trim().endsWith("</context>")).toBe(true);
	});
});
