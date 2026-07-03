// Terminal-event session attribution helper
//
// # 文件说明书
//
// ## 核心功能
// 决定一个"终态事件"(agent_end / error)应该清掉哪个 session 的 streaming 状态。
// 规则:只认事件显式携带的 sessionId。若事件没有 sessionId,返回 null —— 绝不
// 回退到 activeSessionId,否则一个后台/并发 run 的终态事件会把用户正在看的
// session 的 Stop 按钮误清成 Send(真实 bug:agent-service 的 error 直发曾不带
// sessionId,renderer 用 activeSessionId 兜底 → 串清)。
//
// ## 输入
// 事件对象(可能带 sessionId)、当前 activeSessionId
//
// ## 输出
// 该终态事件应作用的 sessionId,或 null(无法安全归属 → 不清)
//
// ## 定位
// src/renderer/store/ — 被 AppLayout 的 agent_end / error 分发逻辑复用
//
// ## 依赖
// 无
//
// ## 维护规则
// 终态事件类型新增需同步 AppLayout 分发器与本 helper 的语义
//

/**
 * Resolve which session a terminal event (agent_end / error) targets for the
 * purpose of clearing streaming state. Returns the event's explicit sessionId,
 * or null if it lacks one — the caller must NOT fall back to the active
 * session, because a terminal event from a background/concurrent run would
 * otherwise clobber the session the user is currently viewing.
 */
export function terminalTargetSession(
	event: { sessionId?: string },
	_activeSessionId: string | null,
): string | null {
	const sid = event.sessionId;
	if (typeof sid === "string" && sid.length > 0) return sid;
	return null;
}
