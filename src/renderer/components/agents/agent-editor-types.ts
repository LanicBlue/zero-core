// Agent 编辑器类型定义
//
// # 文件说明书
//
// ## 核心功能
// 定义 Agent 编辑器的表单状态类型、分页枚举和工具函数
//
// ## 输入
// AgentRecord、PromptTemplate 类型引用
//
// ## 输出
// FormState 类型、Section 枚举、kebab 等工具函数
//
// ## 定位
// src/renderer/components/agents/ — Agent 编辑器的共享类型层
//
// ## 依赖
// shared/types.ts
//
// ## 维护规则
// 表单字段变更需同步更新 FormState 类型
//
import type { AgentRecord, PromptTemplate } from "../../../shared/types.js";

export type FormState = Omit<AgentRecord, "id" | "createdAt" | "updatedAt">;

export type Section = "basic" | "prompt" | "tools" | "expose" | "permissions" | "subagents" | "anchors";

export const DEFAULT_ENABLED_TOOLS = new Set(["Shell", "Read", "Write", "Edit", "Grep", "Glob"]);

export const EMPTY_FORM: FormState = {
	name: "",
};

export const shorten = (p: string) =>
	p.replace(/^[A-Z]:\\Users\\[^\\]+/, "~").replace(/\\/g, "/");

export const kebab = (s: string) =>
	s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function agentToForm(a: AgentRecord): FormState {
	return {
		name: a.name,
		workspaceDir: a.workspaceDir || undefined,
		model: a.model,
		provider: a.provider,
		thinkingLevel: a.thinkingLevel,
		contextConfig: a.contextConfig,
		systemPrompt: a.systemPrompt ?? "",
		toolPolicy: a.toolPolicy,
		// sub-4 (skill-system, decision 5): new agents default enabledSkills=[].
		// Server-side agentStore.create already fills [], but the form is also
		// loaded from legacy agents whose record predates this field
		// (enabledSkills===undefined). Normalize here too so the form always has
		// an array to render/toggle (sub-5 SkillsSection), never undefined.
		skillPolicy: {
			enabledSkills: a.skillPolicy?.enabledSkills ?? [],
		},
		// v0.8 (P2 §11.9 / §11.5 / §11.3): harness fields surfaced in the
		// agent config page. Copy through so the subagents + wikiAnchors
		// editors round-trip with the server record.
		subagents: a.subagents,
		wikiAnchors: a.wikiAnchors,
	};
}

export function templateToForm(t: PromptTemplate): FormState {
	return {
		name: t.name,
		systemPrompt: t.systemPrompt,
		model: t.model,
		provider: t.provider,
		thinkingLevel: t.thinkingLevel,
		toolPolicy: t.toolPolicy,
	};
}

export function defaultForm(defaultPrompt: string): FormState {
	return { ...EMPTY_FORM, systemPrompt: defaultPrompt };
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k`;
	return `~${tokens}`;
}
