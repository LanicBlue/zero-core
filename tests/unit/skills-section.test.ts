// 单元测试:skill-system sub-9 buildSkillsSection(单一真理源,运行时 + CLI 共用)
//
// # 文件说明书
//
// ## 核心功能
// 验证抽出来的 buildSkillsSection 三态 + canAuthorSkills 行为与 buildSystemPrompt
// 内联版完全一致(回归守护:抽函数后旧 acceptance-4/8 语义不变)。
//
// ## 输入
// src/core/skills-section.ts 的 buildSkillsSection。
//
// ## 输出
// Vitest 用例:三态(enabled 命中 / [] / undefined)+ canAuthorSkills 开/关 +
// 两段共存(canAuthorSkills=true 且 enabled 命中 → Available + Authoring 都在)。
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

describe("buildSkillsSection — Authoring Skills(canAuthorSkills)", () => {
	test("canAuthorSkills=true → 含 Authoring 段 + frontmatter + path-safe 规则", () => {
		// 无 skills,只测引导段
		const out = buildSkillsSection({ skills: [], canAuthorSkills: true });
		expect(out).toContain("## Authoring Skills");
		expect(out).toContain("[skills]/<skill-id>/SKILL.md");
		expect(out).toContain("genuine, repeatable reuse value");
		expect(out).toContain("name: <human-readable name>");
		expect(out).toContain("path-safe");
		expect(out).toContain("read-only");
	});

	test("canAuthorSkills=false / undefined → 不含 Authoring 段", () => {
		expect(buildSkillsSection({ skills: [], canAuthorSkills: false }))
			.not.toContain("Authoring Skills");
		expect(buildSkillsSection({ skills: [] }))
			.not.toContain("Authoring Skills");
	});
});

describe("buildSkillsSection — 两段共存", () => {
	test("canAuthorSkills=true 且 enabled 命中 → Available + Authoring 都在", () => {
		const out = buildSkillsSection({
			skills: SKILLS,
			enabledSkills: ["pdf"],
			canAuthorSkills: true,
		});
		// Available 在前,Authoring 在后(用 indexOf 顺序断言)
		const availIdx = out.indexOf("## Available Skills");
		const authIdx = out.indexOf("## Authoring Skills");
		expect(availIdx).toBeGreaterThan(-1);
		expect(authIdx).toBeGreaterThan(-1);
		expect(authIdx).toBeGreaterThan(availIdx);
		// Available 段只命中 pdf
		expect(out).toContain("[skills]/pdf/SKILL.md");
		expect(out).not.toContain("[skills]/code-review/SKILL.md");
	});
});
