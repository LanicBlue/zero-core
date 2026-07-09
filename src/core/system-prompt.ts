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
// skill-system sub-9:skill 段渲染抽到 buildSkillsSection(单一真理源)。
// buildSystemPrompt 复用它,Electron app 运行时的 AgentLoop skills section 也复用。
import { buildSkillsSection } from "./skills-section.js";

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
	 * skill-system sub-12: 原 canAuthorSkills 字段移除。写权限由 enabledSkills
	 * 是否含 "skill-creator" 决定(skill-author-gate 查),且 skill-creator 自身
	 * 的 name+description 已在 Available Skills 段触发 agent 读其正文获取引导,
	 * 不再在 prompt 里重复一份引导文案。
	 */
}

/**
 * ⚠️ skill-system sub-9 重要说明 ⚠️
 *
 * 本函数是 **CLI / headless 路径的 prompt builder**(唯一调用方:
 * `src/cli.ts:201`,headless 一次性 prompt 组装)。**Electron app 运行时
 * agent 的 system prompt 不走这里** —— app agent 的 prompt 由
 * `AgentLoop.assembleSystemPrompt`(`src/runtime/agent-loop.ts`)经各
 * `SystemPromptAssembler` section 拼装;skill 注入走那里的 `skills`
 * system section(见 `src/core/skills-section.ts` 的 `buildSkillsSection`,
 * 本函数也复用它 —— 单一真理源)。
 *
 * 勿以为改本函数会影响 app agent。app agent 的 skill 段改动请改
 * `buildSkillsSection`(两路径共用)。本函数保留是为 CLI/headless prompt,
 * 详见 docs/archive/agent-context-fields Q9(维持原样不清理,清理风险高、
 * 对 app 无收益)。
 *
 * CLI 调用方不传 skills / enabledSkills,所以这里的
 * skill 段对 CLI 实际是空跑(段不出现)—— 符合预期,CLI 不注入 skill。
 */
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

	// 4–5. Skills(Available Skills 列表)
	//
	// skill-system sub-9/sub-12:渲染抽到 `buildSkillsSection`(src/core/skills-section.ts),
	// Electron app 运行时的 AgentLoop skills section 也复用它 —— 单一真理源。
	// sub-12: 原 Authoring 引导段已移除(写权限改由 skill-creator skill 触发)。
	if (ctx.skills?.length) {
		const skillSection = buildSkillsSection({
			skills: ctx.skills ?? [],
			enabledSkills: ctx.enabledSkills,
		});
		if (skillSection) sections.push(skillSection);
	}

	return sections.join("\n\n");
}
