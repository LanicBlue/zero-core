// skill-system sub-9/sub-12:运行时 skill section 渲染器(单一真理源)
//
// # 文件说明书
//
// ## 核心功能
// 把「Available Skills」列表(sub-4)渲染抽出来,作为 **buildSystemPrompt(CLI/headless)
// 与 AgentLoop 运行时 skills section(Electron app)共用的唯一渲染入口**。
//
// ## 输入
// - skills:DiscoveredSkill[](来自 scanSkills;只读 id/name/description)
// - enabledSkills:三态过滤(undefined→全注入 legacy / []→空 / [id...]→过滤)
//
// ## 输出
// - string(空串表示该段不出现;SystemPromptAssembler / buildSystemPrompt
//   都对空串 drop)
//
// ## 定位
// src/core/ 纯函数,无 IO / 无副作用。**buildSystemPrompt 与 AgentLoop
// 必须复用本函数**(决策 4/11/12),禁止另起一份渲染逻辑。
//
// ## 依赖
// 无外部依赖;接受 minimal skill 形态以兼容 CLI 的 SystemPromptContext.skills。
//
// ## 维护规则
// 段文案 / 路径格式 / 三段式指引变更时同步更新 tests/unit/system-prompt*.test.ts。
// undefined(legacy)分支千万别删(acceptance-4 守护此不变量)。
//
// sub-12: 移除「Authoring Skills」引导段(canAuthorSkills 引导)。理由:写权限
// 改为查 enabledSkills 含 "skill-creator"(skill-creator 是 zero-core 自带 skill),
// 而该 skill 的 name+description 已在 Available Skills 列表里(sub-4 注入),
// 足够触发 agent 在合适时机读取 skill-creator 正文(经 progressive disclosure)
// 获取创建 skill 的完整引导。不再在 prompt 里重复一份引导文案。
//

/**
 * Skill 列表条目最小形态。兼容 scanSkills 的 DiscoveredSkill 与 CLI 的
 * SystemPromptContext.skills。
 */
export interface SkillSectionEntry {
	id: string;
	name: string;
	description: string;
}

export interface BuildSkillsSectionInput {
	skills: SkillSectionEntry[];
	/**
	 * 三态(对齐 design 决策 5):
	 *   - undefined → legacy 模式,注入全部 name+desc(存量 agent 兼容)
	 *   - []        → 过滤后为空,整段不出现(新 agent 默认,全不开)
	 *   - [id,...]  → 仅注入命中 id 的条目
	 */
	enabledSkills?: string[];
}

/**
 * 渲染「Available Skills」system prompt 段。
 *
 * **单一真理源**:`buildSystemPrompt`(CLI/headless 路径)与 AgentLoop 的
 * `skills` system section(Electron app 运行时)都必须调用本函数,禁止复制
 * 渲染逻辑。段为空时返回空串(调用方对空串 drop)。
 *
 * body 不进 prompt(按需 Read,见指引)。
 *
 * sub-12: 原可选「Authoring Skills」引导段已移除 —— 写权限由 skill-creator
 * skill 自身的 name+description 触发(经 progressive disclosure 读其正文)。
 */
export function buildSkillsSection(input: BuildSkillsSectionInput): string {
	const { skills, enabledSkills } = input;
	const parts: string[] = [];

	// ── Available Skills(sub-4,决策 5 三态语义)──────────────────────────
	//
	// enabledSkills === undefined → legacy 模式(注入全部 name+desc)。存量
	// agent 没有 skillPolicy.enabledSkills 字段;保留兼容,该分支不动。
	// enabledSkills === [] (显式空数组,新 agent 默认)→ 过滤后为空,
	//   "Available Skills" 段不出现(全不开,对齐决策 5)。
	// enabledSkills = [id,...] → 仅注入命中 id 的条目。
	// 每条目带 `[skills]/<id>/SKILL.md` 路径(agent 据此寻址 Read,id=目录名;
	// display name ≠ id 时光给 name agent 构造不出路径);段尾三段式指引
	// (加载/资源/脚本)。body 不进 prompt(按需 Read,见指引)。
	if (skills?.length) {
		const filtered = enabledSkills
			? skills.filter((s) => enabledSkills.includes(s.id))
			: skills;
		if (filtered.length) {
			const skillList = filtered
				.map((s) => `- **${s.name}**: ${s.description} (read \`[skills]/${s.id}/SKILL.md\` to load)`)
				.join("\n");
			parts.push(
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

	return parts.join("\n\n");
}
