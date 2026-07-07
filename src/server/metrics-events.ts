// 流式事件到指标适配器
//
// # 文件说明书
//
// ## 核心功能
// 将 runtime 流式事件（StreamEvent）转换为 SessionManager 的生命周期和指标调用
//
// ## 输入
// StreamEvent 流式事件、sessionId
//
// ## 输出
// SessionManager 生命周期状态转换和指标更新
//
// ## 定位
// src/server/ — 服务层，桥接 runtime 事件与指标系统
//
// ## 依赖
// runtime/types.ts、session-manager.ts
//
// ## 维护规则
// 新增 StreamEvent 类型需在此添加对应的指标处理
//
import type { StreamEvent } from "../runtime/types.js";
import type { SessionManager } from "./session-manager.js";

/**
 * Adapts runtime stream events into SessionManager lifecycle + metrics calls.
 * Called from AgentService.handleRuntimeEvent — zero overhead when no SessionManager is set.
 */
export interface EventMetricsAdapter {
	onEvent(event: StreamEvent, sessionId: string): void;
}

export function createEventMetricsAdapter(sm: SessionManager): EventMetricsAdapter {
	// Track in-flight tool calls per session to know when all tools are done
	const toolsInFlight = new Map<string, number>();

	return {
		onEvent(event: StreamEvent, sessionId: string): void {
			switch (event.type) {
				case "text_delta": {
					sm.recordFirstTokenLatency(sessionId);
					sm.trackSessionStreaming(sessionId);
					break;
				}
				case "thinking_delta": {
					sm.trackSessionStreaming(sessionId);
					break;
				}
				case "retry_attempt": {
					sm.recordRetry(sessionId);
					break;
				}
				case "tool_start": {
					const count = (toolsInFlight.get(sessionId) ?? 0) + 1;
					toolsInFlight.set(sessionId, count);
					toolStartTimes.set(`${sessionId}:${event.toolName}`, Date.now());
					sm.trackSessionExecutingTools(sessionId);
					break;
				}
				case "tool_end": {
					const key = `${sessionId}:${event.toolName}`;
					const startTime = toolStartTimes.get(key);
					const duration = startTime ? Date.now() - startTime : 0;
					toolStartTimes.delete(key);

					sm.recordToolCall(sessionId, event.toolName, !event.isError, duration);

					const remaining = (toolsInFlight.get(sessionId) ?? 1) - 1;
					toolsInFlight.set(sessionId, remaining);
					break;
				}
				case "message_end": {
					// All API response received — if no tools in flight, back to streaming/idle
					const inFlight = toolsInFlight.get(sessionId) ?? 0;
					if (inFlight <= 0) {
						toolsInFlight.delete(sessionId);
						sm.trackSessionStreaming(sessionId);
					}
					break;
				}
				case "agent_end": {
					toolsInFlight.delete(sessionId);
					sm.trackSessionIdle(sessionId);
					break;
				}
				case "usage": {
					sm.recordTokenUsage(sessionId, (event as any).usage);
					// sub-2: provider-layer rollup. The event carries provider/
					// model/source (stamped at agent-loop finalizeOneStep). When
					// absent (synthetic/test events), skip — session metrics
					// above already recorded. Best-effort inside recordProviderUsage.
					const u = event as any;
					if (u.provider && u.model && u.source) {
						sm.recordProviderUsage({
							provider: u.provider,
							model: u.model,
							source: u.source,
							usage: u.usage,
						});
					}
					break;
				}
				case "error": {
					const errMsg = (event as any).error ?? "unknown";
					toolsInFlight.delete(sessionId);
					sm.trackSessionError(sessionId, String(errMsg));
					// sub-2: failed step → errors +1 in provider_usage. The error
					// event carries provider/model/source (stamped at agent-loop
					// runWithRetry). calls/tokens intentionally left at 0 here —
					// a failed step's usage typically didn't land (no usage
					// event fired), and we only want to bump the error counter.
					// When the fields are absent, skip (session error above still
					// recorded).
					const e = event as any;
					if (e.provider && e.model && e.source) {
						sm.recordProviderUsage({
							provider: e.provider,
							model: e.model,
							source: e.source,
							usage: { inputTokens: 0, outputTokens: 0 },
							error: true,
						});
					}
					break;
				}
			}
		},
	};
}

const toolStartTimes: Map<string, number> = new Map();
