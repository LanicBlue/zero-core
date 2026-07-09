// 单元测试:skill-system sub-9/sub-12 buildSkillsSection(单一真理源,运行时 + CLI 共用)
//
// # 文件说明书
//
// ## 核心功能
// 验证抽出来的 buildSkillsSection 三态行为与 buildSystemPrompt 内联版完全一致
// (回归守护:抽函数后旧 acceptance-4 语义不变)。
//
// sub-12: 原 canAuthorSkills=true 时注入的「Authoring Skills」引导段已移除 ——
// 写权限改由 enabledSkills 含 "skill-creator" 决定,且 skill-creator 自身的
// name+description 已在 Available Skills 列表触发 agent 读其正文。本测守护
// "Authoring 段永不再出现" 不变量。
//
// ## 输入
// src/core/skills-section.ts 的 buildSkillsSection。
//
// ## 输出
// Vitest 用例:三态(enabled 命中 / [] / undefined)+ Authoring 段移除断言。
//
// ## 定位
// tests/unit/ —— 纯函数单测。
//
// ## 维护规则
// buildSkillsSection 段文案/路径/指引改动时同步更新;同时与本测对应的
// system-prompt.test.ts / system-prompt-author.test.ts 应保持一致(单一真理源)。
//

import { describe, test, expect } from "vitest";
import { buildSkillsSection } from "../../src/core/skills-section.js";

const SKILLS = [
	{ id: "pdf", name: "PDF", description: "Read and edit PDF files." },
	{ id: "code-review", name: "Code Review", description: "Review the diff." },
];

describe("buildSkillsSection — Available Skills 三态(单一真理源)", () => {
	test("enabled 命中 → 仅命中条目 + 路径 + 三段式指引;无 body", () => {
		const out = buildSkillsSection({ skills: SKILLS, enabledSkills: ["pdf"] });
		expect(out).toContain("## Available Skills");
		expect(out).toContain("- **PDF**: Read and edit PDF files. (read `[skills]/pdf/SKILL.md` to load)");
		expect(out).not.toContain("**Code Review**");
		expect(out).not.toContain("[skills]/code-review/SKILL.md");
		expect(out).toContain("**Load**");
		expect(out).toContain("**Resources**");
		expect(out).toContain("**Scripts**");
		expect(out).toContain("${SKILL_DIR}");
	});

	test("enabledSkills=[] (显式空)→ Available 段不出现", () => {
		const out = buildSkillsSection({ skills: SKILLS, enabledSkills: [] });
		expect(out).not.toContain("## Available Skills");
		expect(out).not.toContain("**PDF**");
	});

	test("enabledSkills=undefined (legacy)→ 注入全部", () => {
		const out = buildSkillsSection({ skills: SKILLS });
		expect(out).toContain("- **PDF**:");
		expect(out).toContain("- **Code Review**:");
		expect(out).toContain("**Load**");
	});

	test("skills=[] → 空串(无论 enabledSkills)", () => {
		expect(buildSkillsSection({ skills: [], enabledSkills: [] })).toBe("");
		expect(buildSkillsSection({ skills: [], enabledSkills: undefined })).toBe("");
	});
});

describe("buildSkillsSection — sub-12:Authoring 段已移除", () => {
	test("无论 skills/enabledSkills 如何组合,均不含 Authoring 段", () => {
		// skills=[] 也无 Authoring(原 canAuthorSkills=true 时会注入,sub-12 移除)
		expect(buildSkillsSection({ skills: [] })).not.toContain("Authoring Skills");
		expect(buildSkillsSection({ skills: [] })).not.toContain("genuine, repeatable reuse value");
		// 含 skill-creator 的 enabledSkills 也只产 Available,无 Authoring
		const out = buildSkillsSection({
			skills: [{ id: "skill-creator", name: "skill-creator", description: "create skills" }],
			enabledSkills: ["skill-creator"],
		});
		expect(out).toContain("Available Skills");
		expect(out).not.toContain("Authoring Skills");
		expect(out).not.toContain("genuine, repeatable reuse value");
	});
});
