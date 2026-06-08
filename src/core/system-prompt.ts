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
	if (ctx.skills?.length) {
		const enabled = ctx.enabledSkills;
		const filtered = enabled
			? ctx.skills.filter((s) => enabled.includes(s.id))
			: ctx.skills;
		if (filtered.length) {
			const skillList = filtered.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
			sections.push("## Available Skills\n\n" + skillList);
		}
	}

	return sections.join("\n\n");
}
