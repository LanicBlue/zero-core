// 系统提示词构建
//
// # 文件说明书
//
// ## 核心功能
// 构建系统提示词，整合各种上下文信息（设备、工具等）。
//
// ## 输入
// - SystemPromptContext - 上下文信息
// - ZeroCoreConfig - 配置
//
// ## 输出
// - 完整的系统提示词字符串
//
// ## 定位
// 提示词构建模块，被 agent-loop 调用。
//
// ## 依赖
// - ./config - 配置类型
//
// ## 维护规则
// - 提示词格式变更时需更新
// - 保持提示词质量
//
import type { ZeroCoreConfig } from "./config.js";

export interface SystemPromptContext {
	cwd: string;
	activeTools: string[];
	originalPrompt: string;
	// ─── Global content ─────────────────────────
	deviceContext?: string;
	skills?: Array<{ id: string; name: string; description: string }>;
	toolSnippets?: Record<string, string>;
	// ─── Section toggles (default true, false to disable) ──
	useDeviceContext?: boolean;
	useMemoryContext?: boolean;
	enabledSkills?: string[];
	/**
	 * skill-system sub-8 (decision 11): when true, inject a brief "you may
	 * create skills" guidance into the prompt.文案克制,防 agent 滥建低质 skill。
	 */
	canAuthorSkills?: boolean;
}

export function buildSystemPrompt(config: ZeroCoreConfig, ctx: SystemPromptContext): string {
	const sections: string[] = [];

	// 1. Device Context
	if (ctx.useDeviceContext !== false && ctx.deviceContext) {
		sections.push(ctx.deviceContext);
	}

	// 2. Base Prompt (always included)
	sections.push(ctx.originalPrompt);

	// 3. Tool Reference
	const snippets = { ...ctx.toolSnippets, ...config.systemPrompt?.toolSnippets };
	if (Object.keys(snippets).length > 0) {
		const activeSnippets = ctx.activeTools
			.filter((t) => snippets[t])
			.map((t) => `### ${t}\n${snippets[t]}`)
			.join("\n\n");
		if (activeSnippets) {
			sections.push("## Tool Reference\n\n" + activeSnippets);
		}
	}

	// 4. Skills
	//
	// sub-4 (skill-system): progressive disclosure 注入。
	// 二元语义(对齐 design 决策 5,千万别混):
	//   - enabledSkills === undefined → legacy 模式(注入全部 name+desc)。存量
	//     agent 没有 skillPolicy.enabledSkills 字段;保留兼容,该分支不动。
	//   - enabledSkills === [] (显式空数组,新 agent 默认)→ 过滤后为空,"Available
	//     Skills" 段不出现(全不开,对齐决策 5)。
	//   - enabledSkills = [id,...] → 仅注入命中 id 的条目。
	// 每条目带 `[skills]/<id>/SKILL.md` 路径(agent 据此寻址 Read,id=目录名;display
	// name ≠ id 时光给 name agent 构造不出路径);段尾三段式指引(加载/资源/脚本)。
	// body 不进 prompt(按需 Read,见指引)。
	if (ctx.skills?.length) {
		const enabled = ctx.enabledSkills;
		const filtered = enabled
			? ctx.skills.filter((s) => enabled.includes(s.id))
			: ctx.skills;
		if (filtered.length) {
			const skillList = filtered
				.map((s) => `- **${s.name}**: ${s.description} (read \`[skills]/${s.id}/SKILL.md\` to load)`)
				.join("\n");
			sections.push(
				"## Available Skills\n\n" +
					skillList +
					"\n\n" +
					"Skill usage:\n" +
					"- **Load**: when a task matches a skill above, read its `[skills]/<id>/SKILL.md` for the full procedure.\n" +
					"- **Resources**: skills may bundle sibling files; read/glob/grep them via `[skills]/<id>/<file>`. (`${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` in skill bodies already resolve to `[skills]/<id>`.)\n" +
					"- **Scripts**: skills may bundle scripts; run them with Shell as `[skills]/<id>/scripts/...`.",
			);
		}
	}

	// 5. Skill authoring guidance (sub-8, decision 11)
	//
	// 仅当 canAuthorSkills === true 时注入。文案克制:强调"确有复用价值"再写,
	// 防滥建低质 skill(风险段)。给出 frontmatter 形态 + 路径,agent 据此自建。
	if (ctx.canAuthorSkills === true) {
		sections.push(
			"## Authoring Skills\n\n" +
				"You are permitted to create and edit skills for reuse. A skill is a folder under `[skills]/<id>/` containing a `SKILL.md`.\n\n" +
				"Write a new skill only when a procedure has **genuine, repeatable reuse value** across tasks — not for one-off work. Premature or low-quality skills add noise.\n\n" +
				"To author a skill, use the `Write` tool with a virtual path `[skills]/<skill-id>/SKILL.md`:\n" +
				"```\n" +
				"---\n" +
				"name: <human-readable name>\n" +
				"description: <one-line description; when this skill applies>\n" +
				"---\n" +
				"\n" +
				"<body: when to use, the procedure, examples>\n" +
				"```\n\n" +
				"Rules:\n" +
				"- `<skill-id>` must be path-safe (letters, digits, `.`, `_`, `-`; 1–64 chars), unique, and stable.\n" +
				"- New skills land under the app skills root; external skills (`~/.claude`, `~/.agents`) are read-only.\n" +
				"- You may also edit existing app skills via `Write`/`Edit` on `[skills]/<id>/<file>`; `..` escapes are blocked.\n" +
				"- Resources/scripts go in sibling files (e.g. `[skills]/<id>/reference.md`) and are reachable via Read/Glob/Grep/Shell using the same virtual path.",
		);
	}

	return sections.join("\n\n");
}
