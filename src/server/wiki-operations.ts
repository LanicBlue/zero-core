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
// ## wiki-system-redesign plan-04 §7
// prompt 已切换到新 9-action 词汇(expand/read/search/create/update/delete/
// link/unlink/move)+ 逻辑地址(memory:// / project://)+ canonical path。
// 旧 createMemory/updateMemory/docRead/docWrite/docEdit 退役。Memory 由
// `memory://` 地址 + create/update 表达;doc 操作合并到 read/update。
//
// **plan-04 不触发未注册工具**(plan-05 才正式注册 Wiki v2)。本文件的 prompt
// 在 plan-05 接线后才会真正被 agent 调用 —— 当前仅 prompt 字符串更新到位。
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
 * 通用:agent 是否**真正启用**了某工具。镜像 buildToolsSet.isEnabled / agent-service
 * toolEnabled 的判定(blocked → false;否则 tools map > autoApprove > DEFAULT_ENABLED),
 * 而非只看 blockedTools。否则像 Wiki 这种不在 DEFAULT_ENABLED 的工具,agent "没 block
 * 但也没启用"会通过分配校验,运行时(ctx.wikiStore 注入由 capabilityHandlesFor 的 on("Wiki")
 * 把关)却不附加 → agent 报 "Wiki tool isn't attached"。
 */
const DEFAULT_ENABLED_TOOLS = new Set(["Shell", "Read", "Write", "Edit", "Grep", "Glob"]);
export function agentHasTool(agent: AgentRecord, tool: string): boolean {
	const policy = agent.toolPolicy;
	if (Array.isArray(policy?.blockedTools) && policy.blockedTools.includes(tool)) return false;
	if (!policy) return DEFAULT_ENABLED_TOOLS.has(tool);
	if (policy.tools) {
		if (tool in policy.tools) return policy.tools[tool]?.enabled === true;
		return DEFAULT_ENABLED_TOOLS.has(tool);
	}
	const aa = new Set(policy.autoApprove ?? []);
	if (aa.has("*")) return true;
	if (aa.size > 0) return aa.has(tool);
	return DEFAULT_ENABLED_TOOLS.has(tool);
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
 *
 * wiki-system-redesign plan-04 §7:prompt 已切换到新 9-action 词汇
 * (expand/read/search/create/update/delete/link/unlink/move)+ 逻辑地址
 * (memory:// / project://)+ canonical path。旧 createMemory/updateMemory
 * /docRead/docWrite/docEdit 退役。
 */
export const WIKI_OPERATIONS: WikiOperation[] = [
	{
		id: "wiki-enrich",
		name: "Wiki 充实",
		description: "遍历现有骨架,给 content 为空的节点写详实正文 + 准确 summary(最常用)",
		prompt: [
			`深度充实项目 "{projectName}" 的 wiki 树。`,
			"",
			"项目镜像已经建好了 source-bound 节点(每个 Git tracked 文件 / 推导目录一个)",
			"和启发式简摘。你的任务是把它们做实:",
			"",
			"执行策略(递归型任务,重点):整棵树可能很大,逐节点单线程做既慢又容易把你的上下文撑爆。",
			"**优先用 Agent 工具把不同的子树/分支委派给子 agent 并行充实** —— 独立分支用",
			"non_blocking 模式同时跑,你自己只负责拆分调度 + 汇总。下面是每个节点的充实规范,",
			"你或委派出去的子 agent 都按此执行。",
			"",
			"寻址约定:用 `project://` 前缀代表 active 项目根,例如 `project://src/server/wiki-service`。",
			"expand 返回 canonical path(`wiki-root/projects/<id>/...`),后续 read/update 可任选格式。",
			"",
			"1. 用 Wiki(action:'expand', node:'project://') 从项目根开始遍历。",
			"2. 对每个 source_file 节点(代码文件):用 Read 读源文件,然后用",
			"   Wiki(action:'update', node, expected_revision, operations:[{op:'replace_text',...}])",
			"   或 changes.content 写一段详实的 content —— 讲清这个文件/模块的职责、关键导出、",
			"   依赖关系、设计意图(为什么这么写),并 update summary 成一句话概括该节点是什么。",
			"3. 对文档节点(README / 设计 / ADR):用 Read 读文档原文,然后 update content 概述其内容",
			"   (不要复制原文;Wiki 是语义层,事实源仍是 Git 仓库)。",
			"4. 对 directory 节点(模块/子系统):聚合子节点信息,update content 说明该层的组织。",
			"5. 持续直到没有 content 为空且 summary 仍是启发式简摘的节点。",
			"",
			"硬约束:",
			"- 只在 active project wiki 子树内 update;不会跨项目。",
			"- source-bound 节点的结构性操作(create/move/delete)返回 SOURCE_MANAGED —— 结构变更",
			"  必须改文件并 commit,让 indexer 同步。语义字段(summary/content/attributes)可自由 update。",
			"- 每次 update 必须带 expected_revision(从 expand/read 拿到);冲突 → WRITE_CONFLICT,",
			"  re-read 后重试。",
			"- 遇到读不到 / 拿不准的,留 attrs.confidence=low,不要瞎编。完成后简述充实了多少节点。",
		].join("\n"),
	},
	{
		id: "doc-rebuild",
		name: "Doc 重建",
		description: "全量扫描项目镜像,重建 source-bound 节点 + 用 LLM 写准确 summary/content(覆盖启发式简摘)",
		prompt: [
			`全量重建项目 "{projectName}" 的 wiki 摘要。`,
			"",
			"目标:覆盖镜像 indexer 的启发式简摘,用准确的 LLM 概括替换。",
			"",
			"执行策略(递归型任务,重点):全量重建涉及大量节点,逐节点单线程做既慢又容易把你的上下文撑爆。",
			"**优先用 Agent 工具把不同的子树/分支委派给子 agent 并行重建** —— 独立分支用",
			"non_blocking 模式同时跑,你自己只负责拆分调度 + 汇总。下面是每个节点的重建规范,",
			"你或委派出去的子 agent 都按此执行。",
			"",
			"寻址约定:用 `project://` 前缀代表 active 项目根,例如 `project://src/tools/wiki-v2-tool.ts`。",
			"",
			"1. 用 Wiki(action:'search', target:'source', query:'<file-glob-or-keyword>', scope:'project://')",
			"   定位要重建的文件节点;或用 Wiki(action:'expand', node:'project://') 遍历整棵镜像。",
			"2. 对每个 source_file 节点:用 Read 读对应源文件,然后用",
			"   Wiki(action:'update', node, expected_revision, changes:{summary, content}) 重写。",
			"3. 若镜像遗漏文件(应已由 indexer 同步;若没有,先用 Shell 确认 Git tracked,",
			"   再让用户 commit 触发 reindex —— 不要自己 create source-bound 节点,会返 SOURCE_MANAGED)。",
			"4. 若发现失效节点(对应文件已删):由 indexer 在下次同步时归档;无需手动 delete。",
			"",
			"硬约束:",
			"- 只在 active project wiki 子树内 update。",
			"- source-bound 节点的结构性操作(create/move/delete)返回 SOURCE_MANAGED。",
			"- 每次 update 必须带 expected_revision。",
			"完成后简述:重建了多少节点、补建了多少、标记失效了多少。",
		].join("\n"),
	},
	{
		id: "git-update",
		name: "Git 增量更新",
		description: "基于 git 变更(自上次更新),只更新变化文件对应的 wiki 节点(增量、省 token)",
		prompt: [
			`基于 git 变更增量更新项目 "{projectName}" 的 wiki。`,
			"",
			"目标:只处理自上次更新后变化的文件,不重扫全树。",
			"",
			"寻址约定:用 `project://` 前缀代表 active 项目根,例如 `project://src/tools/wiki-v2-tool.ts`。",
			"",
			"1. 用 Shell(git log/git diff) 查自上次 wiki 更放后变化的文件列表",
			"   (若不知基线,取最近 N 条 commit 涉及文件)。",
			"2. 对每个变化文件,用 Wiki(action:'search', target:'source', query:'<filename>',",
			"   scope:'project://') 查对应的 source-bound 节点:",
			"   - 文件修改/新增 → Read 新内容,Wiki(action:'update', node, expected_revision,",
			"     changes:{summary, content}) 重写。",
			"   - 文件删除 → indexer 在下次 commit 后自动归档对应节点;无需手动 delete。",
			"   - 无对应 wiki 节点 → 先确认文件已 commit + indexer 已同步;若仍未同步,",
			"     不要 create(source-bound 会返 SOURCE_MANAGED)。",
			"3. 对 directory 节点:若结构有变(子目录增删),indexer 已在 commit 同步时处理;",
			"   语义层 summary/content 由你 update。",
			"",
			"硬约束:",
			"- 只在 active project wiki 子树内 update。",
			"- source-bound 节点的结构性操作(create/move/delete)返回 SOURCE_MANAGED。",
			"- 每次 update 必须带 expected_revision。",
			"完成后简述:更新了多少文件、补建了多少、标记失效了多少。",
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
