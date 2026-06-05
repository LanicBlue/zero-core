// 单元测试：默认提示词生成
//
// # 文件说明书
//
// ## 核心功能
// 测试 buildDefaultPrompt 函数是否正确嵌入 Agent 名称、角色描述和模板格式
//
// ## 输入
// src/core/default-prompt.js 导出的 buildDefaultPrompt 函数
//
// ## 输出
// Vitest 测试用例验证名称嵌入、角色描述、不同名称差异和空名称容错
//
// ## 定位
// tests/unit/ — 单元测试套件，验证核心提示词构建逻辑
//
// ## 依赖
// vitest、../../src/core/default-prompt
//
// ## 维护规则
// 提示词模板变更需更新断言中的期望文本
// 新增模板参数需添加对应测试
//
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
