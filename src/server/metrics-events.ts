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
					break;
				}
				case "error": {
					const errMsg = (event as any).error ?? "unknown";
					toolsInFlight.delete(sessionId);
					sm.trackSessionError(sessionId, String(errMsg));
					break;
				}
			}
		},
	};
}

const toolStartTimes: Map<string, number> = new Map();
