// Wiki 操作 prompt + agent 工具校验
//
// # 文件说明书
//
// ## 核心功能
// (阶段 0) agentHasWikiTool —— 校验 agent 是否配置了 Wiki 工具(archivist
//   绑定/enrichment 的前置校验,无 Wiki 工具则拒绝 + 提醒)。
// (阶段 1,待扩展) WIKI_OPERATIONS —— wiki 构建的多操作 prompt(doc重建/
//   git更新/wiki充实),把"操作 prompt"从角色/服务端硬编码抽到操作层。
//
// ## 背景
// v0.8 推动弃用工作流角色:archivist 率先去 role。agent 从画廊 Archivist
// 模板创建(自带 Wiki 工具配置),enrichment/cron 绑定时必须核实它有 Wiki
// 工具,否则干不了 wiki 活。无 fallback —— 不自动建 agent。
//

import type { AgentRecord } from "../shared/types.js";

/**
 * agent 是否配置了 Wiki 工具。判定:Wiki 没被 blockedTools 禁用即可用。
 * archivist 绑定/enrichment 的前置校验 —— 无 Wiki 工具直接拒绝。
 */
export function agentHasWikiTool(agent: AgentRecord): boolean {
	const blocked = agent.toolPolicy?.blockedTools;
	if (Array.isArray(blocked) && blocked.includes("Wiki")) return false;
	return true;
}

/**
 * 建议:Wiki 是否被 autoApprove(免每次审批)。archivist 写 wiki 频繁,
 * autoApprove Wiki 体验最好;未 autoApprove 时仍可用(走审批),前端给提醒。
 */
export function agentWikiToolAutoApproved(agent: AgentRecord): boolean {
	return Array.isArray(agent.toolPolicy?.autoApprove) && !!agent.toolPolicy!.autoApprove!.includes("Wiki");
}
