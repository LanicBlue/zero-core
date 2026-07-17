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

export type Section = "basic" | "prompt" | "tools" | "skills" | "expose" | "permissions" | "subagents" | "wiki-access" | "wiki-context" | "anchors";

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
		// sub-12: canAuthorSkills 字段已移除 —— 写权限由 enabledSkills 是否含
		// "skill-creator" 决定(见 skill-author-gate.ts)。Form 不再归一化该字段。
		skillPolicy: {
			enabledSkills: a.skillPolicy?.enabledSkills ?? [],
		},
		// v0.8 (P2 §11.9 / §11.5 / §11.3): harness fields surfaced in the
		// agent config page. Copy through so the subagents editor round-trips
		// with the server record.
		subagents: a.subagents,
		// plan-07 §3 兑现 sub-06 defer:旧 wikiAnchors 字段**清空**(runtime
		// 不再读,form 也不再 round-trip)。save 时显式传 [] —— 这样 ipc-proxy
		// JSON.stringify([]) 存活 → AgentStore.update 把字段写为 [],旧值
		// 不残留(feedback-unique-message-keys 同款陷阱)。
		wikiAnchors: [],
		// wiki-system-redesign plan-05 §1 + plan-07 §3/§4:Wiki grants/context
		// 现在由 WikiAccessSection / WikiContextSection 编辑。round-trip 保留。
		wikiGrants: a.wikiGrants,
		wikiContext: a.wikiContext,
		wikiPolicyRevision: a.wikiPolicyRevision,
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
		// plan-07 §3:从 template seed 拷贝 wikiGrants/wikiContext(字段化 defer
		// 兑现)。Prefill 路径(AgentEditor prefillTemplate)走的就是这条 → 新建
		// agent 出生即带 template 默认 grants,与 management-service.instantiate
		// Template 路径行为一致。
		wikiGrants: t.wikiGrants,
		wikiContext: t.wikiContext,
	};
}

export function defaultForm(defaultPrompt: string): FormState {
	return { ...EMPTY_FORM, systemPrompt: defaultPrompt };
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k`;
	return `~${tokens}`;
}
