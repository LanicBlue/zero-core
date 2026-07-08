// skill-system sub-8 (decision 11): `[skills]/` 写权限门禁。
//
// # 文件说明书
//
// ## 核心功能
// 查"当前 agent 是否有 `[skills]/` 写权限"。从 callerCtx.agentId 出发,经
// getAgentService() 单例取 agent record 的 skillPolicy.canAuthorSkills。
//
// ## 输入
// callerCtx(Write/Edit execute 第二参)—— 读 agentId。
//
// ## 输出
// - `null` —— 放行(有权限或非 agent 调用路径下无法判定时的安全放行,见下)。
// - `string` —— 拒绝,返回值是给 agent 的权限错误文本(直接 wrap 返回)。
//
// ## 门禁语义(关键)
// canAuthorSkills 默认 false(agent-store create 填 false)。**只有显式 true 才放行**:
//   - agentId 缺失(UI/MCP 调用)→ 拒。理由:agent 自建 skill 是 agent-loop 场景,
//     无 agentId 不该写 `[skills]/`。保守拒绝。
//   - getAgentService() 缺失(早期启动/测试)→ 拒。不能判定时保守拒绝,而非放行。
//   - agent record 缺失 → 拒。
//   - skillPolicy.canAuthorSkills !== true → 拒。
//
// 读家族(Read/Glob/Grep)不经此门禁 —— 它们读始终放行(sub-2)。
//
// ## 定位
// src/tools/ —— 中立工具层共享门禁,被 Write/Edit 复用。
//
// ## 依赖
// - ./types(CallerCtx)
// - ../server/agent-service(getAgentService 单例)
//
// ## 维护规则
// - 门禁只在此处(写家族路径),不在 skill-paths.ts(那做静态路径解析,与门禁解耦)。
// - 调用方(file-write/edit)先解析 `[skills]/` 前缀,再调本门禁;非 `[skills]/`
//   路径不查门禁(workspace 沙箱照旧)。
//
import type { CallerCtx } from "./types.js";
import { getAgentService } from "../server/agent-service.js";

/**
 * 查当前 callerCtx 对应 agent 的 `[skills]/` 写权限。
 *
 * 返回 `null` = 放行;返回 `string` = 拒绝(错误文本,直接返回给 agent)。
 * 保守语义:agentId / agentService / agent record / flag 任一缺失或非 true → 拒。
 */
export function checkSkillAuthorGate(callerCtx: CallerCtx): string | null {
	const agentId = callerCtx.agentId;
	if (!agentId) {
		// 非 agent 调用(UI/MCP)不该写 `[skills]/`(agent 自建场景专属)。
		return "Error: writing under `[skills]/` requires an agent context with skill authoring permission; this caller has no agentId.";
	}
	const service = getAgentService();
	if (!service) {
		// 早期启动/无 service 的测试路径:保守拒绝(不默认放行)。
		return "Error: cannot verify skill authoring permission (agent service unavailable).";
	}
	const agent = service.getAgentRecord(agentId);
	if (!agent) {
		return `Error: cannot verify skill authoring permission (agent '${agentId}' not found).`;
	}
	const canAuthor = agent.skillPolicy?.canAuthorSkills === true;
	if (!canAuthor) {
		return `Error: this agent is not permitted to create or edit skills under \`[skills]/\` (skillPolicy.canAuthorSkills is false). Ask the user to enable 'allow this agent to create skills' in the agent editor.`;
	}
	return null;
}
