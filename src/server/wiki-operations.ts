// Wiki 操作 prompt + agent 工具校验
//
// # 文件说明书
//
// ## 核心功能
// (阶段 0) agentHasWikiTool —— 校验 agent 是否配置了 Wiki 工具(archivist
//   绑定/enrichment 的前置校验,无 Wiki 工具则拒绝 + 提醒)。
// (阶段 1) WIKI_OPERATIONS —— wiki 构建的多操作 prompt(doc重建/
//   git更新/wiki充实),把"操作 prompt"从角色/服务端硬编码抽到操作层。
//   resolveOperationPrompt —— 自定义 prompt > 指定操作 > 默认 wiki-enrich。
//
// ## 背景
// v0.8 推动弃用工作流角色:archivist 率先去 role。"操作 prompt"(这次 wiki
// 维护具体做什么)绑在**操作**上,不绑角色身份(身份来自 agent/模板)。多操作
// 拆分:doc重建/git更新/wiki充实 各自独立 prompt,可各自按键或各自 cron/事件触发。
//

import type { AgentRecord, WikiOperationId } from "../shared/types.js";
// WikiOperationId 定义在 shared/types(供 renderer/server 共用,避免循环引用),此处 re-export。
export type { WikiOperationId };

/**
 * agent 是否配置了 Wiki 工具。判定:Wiki 没被 blockedTools 禁用即可用。
 * archivist 绑定/enrichment 的前置校验 —— 无 Wiki 工具直接拒绝。
 */
export function agentHasWikiTool(agent: AgentRecord): boolean {
	return agentHasTool(agent, "Wiki");
}

/**
 * 通用:agent 是否可用某工具(没被 blockedTools 禁用即可用)。project-work 分配
 * agent 时的前置校验 —— work.requiredTools 逐项检查,不满足则拒绝+提醒(无 fallback)。
 */
export function agentHasTool(agent: AgentRecord, tool: string): boolean {
	const blocked = agent.toolPolicy?.blockedTools;
	if (Array.isArray(blocked) && blocked.includes(tool)) return false;
	return true;
}

/**
 * 建议:Wiki 是否被 autoApprove(免每次审批)。archivist 写 wiki 频繁,
 * autoApprove Wiki 体验最好;未 autoApprove 时仍可用(走审批),前端给提醒。
 */
export function agentWikiToolAutoApproved(agent: AgentRecord): boolean {
	return Array.isArray(agent.toolPolicy?.autoApprove) && !!agent.toolPolicy!.autoApprove!.includes("Wiki");
}

// ---------------------------------------------------------------------------
// Wiki 构建操作(阶段 1)
// ---------------------------------------------------------------------------

export interface WikiOperation {
	id: WikiOperationId;
	name: string;
	description: string;
	/** prompt 模板,{projectName} 占位由 resolveOperationPrompt 替换。 */
	prompt: string;
}

/**
 * wiki 构建的三个内置操作。操作 prompt 绑在操作上(不绑角色身份),
 * 各自可独立按键/cron/事件触发。
 */
export const WIKI_OPERATIONS: WikiOperation[] = [
	{
		id: "wiki-enrich",
		name: "Wiki 充实",
		description: "遍历现有骨架,给 detail 为空的节点写详 doc + 准 summary(最常用)",
		prompt: [
			`深度充实项目 "{projectName}" 的 wiki 树。`,
			"",
			"骨架扫描已经建好了结构节点(header/intent/structure)和启发式简摘。",
			"你的任务是把它们做实:",
			"",
			"1. 用 Wiki(expand) 从项目子树根开始遍历整棵骨架。",
			"2. 对每个 header 节点(代码文件):用 Read 读源文件,然后用 Wiki(docWrite/docEdit)",
			"   写一段详实的 detail —— 讲清这个文件/模块的职责、关键导出、依赖关系、",
			"   设计意图(为什么这么写),并更新 summary 成准确的一句话概括。",
			"3. 对每个 intent 节点(需求/设计/ADR 文档):读文档,写 detail 概述其内容。",
			"4. 对 structure 节点(模块/子系统):聚合子节点信息,写 detail 说明该层的组织。",
			"5. 持续直到没有 detail 为空的 header/intent 节点。provenance 标 structure/derived/confirmed。",
			"",
			"硬约束:只在本项目 wiki 子树内写、只写 header/intent/structure 类型(你已有的规则)。",
			"遇到读不到/拿不准的,留 flags 不要瞎编。完成后简述你充实了多少节点。",
		].join("\n"),
	},
	{
		id: "doc-rebuild",
		name: "Doc 重建",
		description: "全量扫描 workspace,重建 header/intent 结构节点 + 用 LLM 写准 summary(覆盖骨架启发式简摘)",
		prompt: [
			`全量重建项目 "{projectName}" 的 wiki 结构节点。`,
			"",
			"目标:覆盖骨架扫描的启发式简摘,用准确的 LLM 概括替换。",
			"",
			"1. 用 Wiki(expand) 列出项目子树所有 header/intent/structure 节点。",
			"2. 对每个 header 节点:用 Read 读对应源文件(docPointer 指向的路径),",
			"   重新写 summary(准确的一句话概括文件职责)和 detail。",
			"3. 对每个 intent 节点:读对应文档,重写 summary + detail。",
			"4. 若发现骨架遗漏的文件(无对应 header 节点),用 Wiki(docWrite) 补建 header。",
			"5. 若发现失效节点(对应文件已删),用 Wiki 删除或标记 flags:stale。",
			"6. provenance 重新标 structure/derived/confirmed。",
			"",
			"硬约束:只在本项目 wiki 子树内、只写 header/intent/structure 类型。",
			"完成后简述:重建多少节点、补建多少、标记失效多少。",
		].join("\n"),
	},
	{
		id: "git-update",
		name: "Git 增量更新",
		description: "基于 git 变更(自上次更新),只更新变化文件对应的 header 节点(增量、省 token)",
		prompt: [
			`基于 git 变更增量更新项目 "{projectName}" 的 wiki。`,
			"",
			"目标:只处理自上次更新后变化的文件,不重扫全树。",
			"",
			"1. 用 Shell(git log/git diff) 查自上次 wiki 更放后变化的文件列表",
			"   (若不知基线,取最近 N 条 commit 涉及的文件)。",
			"2. 对每个变化文件,用 Wiki 查其对应的 header 节点(docPointer 匹配):",
			"   - 文件修改/新增 → Read 新内容,重写该 header 的 summary + detail。",
			"   - 文件删除 → 标记 header flags:stale 或删除。",
			"   - 无对应 header 的新文件 → Wiki(docWrite) 补建。",
			"3. 对应的 structure 节点若有结构变化,同步聚合更新。",
			"4. provenance 标 derived(基于 commit 推断)或 confirmed。",
			"",
			"硬约束:只在本项目 wiki 子树内、只写 header/intent/structure 类型。",
			"完成后简述:更新多少文件、补建多少、标记失效多少。",
		].join("\n"),
	},
];

/**
 * 解析本次 wiki 维护的操作 prompt。优先级:
 *   customPrompt(自定义) > operationId 对应操作 > wiki-enrich(默认)。
 * projectName 用于替换 prompt 里的 {projectName} 占位。
 */
export function resolveOperationPrompt(
	operationId?: string,
	customPrompt?: string,
	projectName?: string,
): string {
	if (customPrompt && customPrompt.trim()) return customPrompt;
	const op = WIKI_OPERATIONS.find((o) => o.id === operationId) ?? WIKI_OPERATIONS.find((o) => o.id === "wiki-enrich")!;
	const prompt = op.prompt;
	return projectName ? prompt.replaceAll("{projectName}", projectName) : prompt;
}

// ---------------------------------------------------------------------------
// git-aware cron(阶段3)—— "git 变更触发"用 sentinel 标记 cron.prompt,
// cron-analysis 触发前检查 git ref 变化,无变化跳过。复用 cron 轮询,零事件机制。
// ---------------------------------------------------------------------------

/** cron.prompt 前缀 sentinel,标记该 cron 为 git-aware(变更才触发)。 */
export const GIT_AWARE_SENTINEL = "<!-- zero:git-aware:1 -->";

/** 把操作 prompt 包装成 git-aware(sentinel 前缀,LLM 会忽略 HTML 注释)。 */
export function wrapGitAwarePrompt(prompt: string): string {
	return `${GIT_AWARE_SENTINEL}\n${prompt}`;
}

/** cron.prompt 是否标记为 git-aware。 */
export function isGitAwarePrompt(prompt: string | undefined): boolean {
	return !!prompt && prompt.startsWith(GIT_AWARE_SENTINEL);
}

/** 去掉 sentinel,返回传给 LLM 的纯操作 prompt。 */
export function stripGitAwareSentinel(prompt: string): string {
	return prompt.startsWith(GIT_AWARE_SENTINEL) ? prompt.slice(GIT_AWARE_SENTINEL.length).replace(/^\n/, "") : prompt;
}
