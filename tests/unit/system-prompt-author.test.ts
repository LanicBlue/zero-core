// 单元测试:skill-system sub-8 prompt 引导 + toggle 持久化(acceptance-8 用例 8/9/10)
import { describe, test, expect } from "vitest";
import { buildSystemPrompt } from "../../src/core/system-prompt.js";
import type { ZeroCoreConfig } from "../../src/core/config.js";

const minimalConfig = { systemPrompt: { toolSnippets: {} } } as unknown as ZeroCoreConfig;

describe("system-prompt:canAuthorSkills 引导(用例 8)", () => {
	test("canAuthorSkills=true → 含 'Authoring Skills' 段", () => {
		const prompt = buildSystemPrompt(minimalConfig, {
			cwd: "/x",
			activeTools: [],
			originalPrompt: "base",
			canAuthorSkills: true,
		});
		expect(prompt).toContain("Authoring Skills");
		expect(prompt).toContain("[skills]/<skill-id>/SKILL.md");
		expect(prompt).toContain("genuine, repeatable reuse value");
	});

	test("canAuthorSkills=false → 不含 'Authoring Skills' 段", () => {
		const prompt = buildSystemPrompt(minimalConfig, {
			cwd: "/x",
			activeTools: [],
			originalPrompt: "base",
			canAuthorSkills: false,
		});
		expect(prompt).not.toContain("Authoring Skills");
	});

	test("canAuthorSkills 缺省(undefined)→ 不含(默认关)", () => {
		const prompt = buildSystemPrompt(minimalConfig, {
			cwd: "/x",
			activeTools: [],
			originalPrompt: "base",
		});
		expect(prompt).not.toContain("Authoring Skills");
	});

	test("canAuthorSkills=true 时引导含 frontmatter 形态 + path-safe id 规则", () => {
		const prompt = buildSystemPrompt(minimalConfig, {
			cwd: "/x",
			activeTools: [],
			originalPrompt: "base",
			canAuthorSkills: true,
		});
		expect(prompt).toContain("name: <human-readable name>");
		expect(prompt).toContain("path-safe");
		expect(prompt).toContain("read-only");
	});
});
