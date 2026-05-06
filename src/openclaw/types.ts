export interface AttemptCallbacks {
	onPartialReply?: (payload: { text: string; mediaUrls?: string[] }) => Promise<void> | void;
	onToolResult?: (payload: { toolName: string; result: unknown; isError: boolean }) => Promise<void> | void;
	onAgentEvent?: (event: { type: string; [key: string]: unknown }) => Promise<void> | void;
	onReasoningStream?: (payload: { text: string }) => Promise<void> | void;
}
