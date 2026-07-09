// 单元测试:skill-system sub-12 —— 「Authoring Skills」prompt 引导段已移除
//
// # 文件说明书
//
// ## 核心功能
// 守护 sub-12 的不变量:buildSystemPrompt 不再注入「Authoring Skills」引导段
// (原 sub-8 在 canAuthorSkills=true 时注入)。sub-12 后写权限由 enabledSkills
// 是否含 "skill-creator" 决定,而 skill-creator 的 name+description 已在 Available
// Skills 列表(sub-4)触发 agent 经 progressive disclosure 读其正文获取引导,
// 故 prompt 不再重复一份引导文案。
//
// ## 输入
// src/core/system-prompt.ts(buildSystemPrompt)、minimal config。
//
// ## 输出
// Vitest 用例:无论 skills/enabledSkills 如何组合,均不含 "Authoring Skills" 段。
//
// ## 定位
// tests/unit/ —— 单元测试,守护 sub-12 移除不变量。
//
// ## 维护规则
// 若以后重新引入 prompt 引导段(非预期),更新本文件并补 design 决策。
//
import { describe, test, expect } from "vitest";
import { buildSystemPrompt } from "../../src/core/system-prompt.js";
import type { ZeroCoreConfig } from "../../src/core/config.js";

const minimalConfig = { systemPrompt: { toolSnippets: {} } } as unknown as ZeroCoreConfig;

describe("system-prompt:sub-12 移除 Authoring Skills 引导段", () => {
	test("无 skills → 不含 'Authoring Skills' 段", () => {
		const prompt = buildSystemPrompt(minimalConfig, {
			cwd: "/x",
			activeTools: [],
			originalPrompt: "base",
		});
		expect(prompt).not.toContain("Authoring Skills");
		expect(prompt).not.toContain("genuine, repeatable reuse value");
	});

	test("有 skills + enabledSkills 命中(含 skill-creator)→ 注入 Available Skills,但仍不含 Authoring 段", () => {
		const prompt = buildSystemPrompt(minimalConfig, {
			cwd: "/x",
			activeTools: [],
			originalPrompt: "base",
			skills: [
				{ id: "skill-creator", name: "skill-creator", description: "create skills" },
				{ id: "pdf", name: "pdf", description: "pdf tool" },
			],
			enabledSkills: ["skill-creator", "pdf"],
		});
		// Available Skills 段在
		expect(prompt).toContain("Available Skills");
		expect(prompt).toContain("skill-creator");
		// Authoring 引导段不在(sub-12 移除)
		expect(prompt).not.toContain("Authoring Skills");
		expect(prompt).not.toContain("genuine, repeatable reuse value");
	});

	test("enabledSkills=[] → 段不出现(更不会有 Authoring)", () => {
		const prompt = buildSystemPrompt(minimalConfig, {
			cwd: "/x",
			activeTools: [],
			originalPrompt: "base",
			skills: [{ id: "pdf", name: "pdf", description: "pdf" }],
			enabledSkills: [],
		});
		expect(prompt).not.toContain("Available Skills");
		expect(prompt).not.toContain("Authoring Skills");
	});
});
