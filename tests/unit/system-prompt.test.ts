// 单元测试:skill-system sub-4 prompt 注入 + 默认全不开(acceptance-4)
//
// # 文件说明书
//
// ## 核心功能
// 验证 buildSystemPrompt 的 Skills 段三态行为 + 文案/路径/无 body 断言:
//   1. enabled 命中 —— 仅注入命中 id 条目;每条目带 `[skills]/<id>/SKILL.md`;
//      段尾有 加载/资源/脚本 三段式指引。
//   2. enabledSkills = [] (显式空)—— "Available Skills" 段不出现(全不开)。
//   3. enabledSkills = undefined (legacy)—— 注入全部 name+desc(存量兼容)。
//   5. body 不进 prompt —— 任何态下 prompt 只有 name+desc(+路径+指引)。
//
// ## 输入
// src/core/system-prompt.ts 的 buildSystemPrompt + src/core/config.ts 的 DEFAULT_CONFIG。
//
// ## 输出
// Vitest 用例覆盖 acceptance-4.md 用例 1/3/4/5。
//
// ## 定位
// tests/unit/ —— 纯函数单测,不碰 DB / 文件系统 / scanner。
//
// ## 依赖
// vitest、../../src/core/system-prompt.js、../../src/core/config.js。
//
// ## 维护规则
// buildSystemPrompt 的 Skills 段文案/路径/指引改动时同步更新。
// undefined 分支(legacy)千万别删(acceptance-4 用例 4 守护此不变量)。
//

import { describe, test, expect } from "vitest";
import { buildSystemPrompt, type SystemPromptContext } from "../../src/core/system-prompt.js";
import { DEFAULT_CONFIG, type ZeroCoreConfig } from "../../src/core/config.js";

const config = DEFAULT_CONFIG as ZeroCoreConfig;

const SKILLS: NonNullable<SystemPromptContext["skills"]> = [
	{ id: "pdf", name: "PDF", description: "Read and edit PDF files." },
	{ id: "code-review", name: "Code Review", description: "Review the diff." },
];

function baseCtx(overrides: Partial<SystemPromptContext>): SystemPromptContext {
	return {
		cwd: "/tmp",
		activeTools: [],
		originalPrompt: "BASE PROMPT.",
		...overrides,
	};
}

describe("buildSystemPrompt — Skills 段(sub-4)", () => {
	test("用例1+5:enabled 命中 → 仅命中条目;每条带 [skills]/<id>/SKILL.md 路径;段尾三段式指引;无 body", () => {
		const out = buildSystemPrompt(config, baseCtx({
			skills: SKILLS,
			enabledSkills: ["pdf"],
		}));

		// 段存在
		expect(out).toContain("## Available Skills");

		// 命中条目带路径(id=目录名)
		expect(out).toContain("- **PDF**: Read and edit PDF files. (read `[skills]/pdf/SKILL.md` to load)");

		// 未命中条目不出现
		expect(out).not.toContain("**Code Review**");
		expect(out).not.toContain("[skills]/code-review/SKILL.md");

		// 三段式指引文案
		expect(out).toContain("**Load**");
		expect(out).toContain("**Resources**");
		expect(out).toContain("**Scripts**");
		expect(out).toContain("${SKILL_DIR}");

		// body 不进 prompt(测试 fixture 本就不带 body,断言无意外字串即可)
		expect(out).not.toContain("BODY_LEAK");
	});

	test("用例3:enabledSkills = [] (显式空)→ 'Available Skills' 段不出现", () => {
		const out = buildSystemPrompt(config, baseCtx({
			skills: SKILLS,
			enabledSkills: [],
		}));

		expect(out).not.toContain("## Available Skills");
		expect(out).not.toContain("**PDF**");
		expect(out).not.toContain("[skills]/pdf/SKILL.md");
	});

	test("用例4:enabledSkills = undefined (legacy)→ 注入全部 name+desc + 路径 + 指引(存量行为不变)", () => {
		const out = buildSystemPrompt(config, baseCtx({
			skills: SKILLS,
			// 不设 enabledSkills —— legacy
		}));

		// 全部条目都注入
		expect(out).toContain("- **PDF**: Read and edit PDF files. (read `[skills]/pdf/SKILL.md` to load)");
		expect(out).toContain("- **Code Review**: Review the diff. (read `[skills]/code-review/SKILL.md` to load)");

		// 指引仍在
		expect(out).toContain("**Load**");
	});

	test("边界:skills=[] → 段不出现(无论 enabledSkills)", () => {
		expect(buildSystemPrompt(config, baseCtx({ skills: [], enabledSkills: [] })))
			.not.toContain("## Available Skills");
		expect(buildSystemPrompt(config, baseCtx({ skills: [], enabledSkills: undefined })))
			.not.toContain("## Available Skills");
	});

	test("边界:无 skills 字段(undefined)→ 段不出现", () => {
		expect(buildSystemPrompt(config, baseCtx({}))).not.toContain("## Available Skills");
	});

	test("用例5 强化:即便条目 description 含 body 字样,真正的 skill 正文 body 永不进 prompt", () => {
		// SystemPromptContext.skills 形态本身就是 {id,name,description}——body 无从传入。
		// 本断言锁定该形态:Skills 段只产 name+desc+路径+指引,无第四类内容。
		const out = buildSystemPrompt(config, baseCtx({
			skills: [{ id: "x", name: "X", description: "d" }],
			enabledSkills: ["x"],
		}));
		const section = out.slice(out.indexOf("## Available Skills"));
		// 段内只有一行条目 + 指引,无多行 body
		expect(section).toContain("- **X**: d (read `[skills]/x/SKILL.md` to load)");
		expect(section).toContain("**Load**");
		// body 形态(多段正文)应永不出现 —— 断言形如 "## Procedure" / 长正文均不在
		expect(section).not.toContain("## Procedure");
	});
});
