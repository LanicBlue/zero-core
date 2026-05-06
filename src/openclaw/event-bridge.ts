import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AttemptCallbacks } from "./types.js";

export function createEventBridge(callbacks: AttemptCallbacks) {
	return (event: AgentEvent, _signal: AbortSignal): void => {
		switch (event.type) {
			case "message_update": {
				const msg = event.message;
				if (msg && "content" in msg && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "text" && "text" in block && block.text) {
							callbacks.onPartialReply?.({ text: block.text });
						}
					}
				}
				break;
			}

			case "tool_execution_end": {
				callbacks.onToolResult?.({
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				});
				break;
			}

			case "message_end": {
				const endMsg = event.message;
				if (endMsg && "content" in endMsg && Array.isArray(endMsg.content)) {
					for (const block of endMsg.content) {
						if (block.type === "thinking" && "text" in block && typeof block.text === "string") {
							callbacks.onReasoningStream?.({ text: block.text as string });
						}
					}
				}
				break;
			}
		}

		callbacks.onAgentEvent?.(event as unknown as { type: string; [key: string]: unknown });
	};
}
