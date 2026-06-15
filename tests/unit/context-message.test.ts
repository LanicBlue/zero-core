// 单元测试：上下文消息构建器
//
// # 文件说明书
//
// ## 核心功能
// 测试 buildContextMessage 按 Environment → Guidelines → Recalled Memories → Knowledge Base 顺序拼装 <context> 标签包裹的上下文块；覆盖仅 workspaceDir、含 guidelines/memoryContext/ragContext 各组合
//
// ## 输入
// { workspaceDir, guidelines, memoryContext, ragContext } 入参组合
//
// ## 输出
// Vitest 测试用例：验证各 section 标题存在、顺序正确、整体被 <context> 标签包裹
//
// ## 定位
// tests/unit/ — 单元测试套件，验证 runtime 上下文拼装逻辑
//
// ## 依赖
// vitest、../../src/runtime/context-message（buildContextMessage）
//
// ## 维护规则
// section 标题（## Environment 等）文案变更需同步更新断言
// section 顺序调整需更新 envIdx/guideIdx/memIdx/ragIdx 比较测试
//
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
