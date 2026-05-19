import type { ModelMessage } from "ai";

// ---------------------------------------------------------------------------
// Stream events — must match the existing IPC contract
// ---------------------------------------------------------------------------

export interface TextDeltaEvent {
	type: "text_delta";
	agentId?: string;
	text: string;
}

export interface ThinkingDeltaEvent {
	type: "thinking_delta";
	agentId?: string;
	text: string;
}

export interface ToolStartEvent {
	type: "tool_start";
	agentId?: string;
	toolName: string;
	args?: unknown;
}

export interface ToolEndEvent {
	type: "tool_end";
	agentId?: string;
	toolName: string;
	isError: boolean;
	result?: unknown;
}

export interface MessageEndEvent {
	type: "message_end";
	agentId?: string;
	text: string;
}

export interface AgentEndEvent {
	type: "agent_end";
	agentId?: string;
}

export interface ErrorEvent {
	type: "error";
	agentId?: string;
	error: string;
}

export type StreamEvent =
	| TextDeltaEvent
	| ThinkingDeltaEvent
	| ToolStartEvent
	| ToolEndEvent
	| MessageEndEvent
	| AgentEndEvent
	| ErrorEvent;

// ---------------------------------------------------------------------------
// Provider config — mirrors existing ProviderConfig
// ---------------------------------------------------------------------------

export interface RuntimeProviderConfig {
	name: string;
	type: "openai" | "anthropic" | "gemini" | "openai-compatible" | "ollama";
	apiKey: string;
	baseUrl: string;
	models: {
		id: string;
		name: string;
		contextWindow?: number;
		maxTokens?: number;
	}[];
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// Session config — derived from AgentRecord
// ---------------------------------------------------------------------------

export interface SessionConfig {
	agentId: string;
	workspaceDir: string;
	systemPrompt: string;
	modelId: string;
	providerName: string;
	thinkingLevel?: string;
	maxSteps: number;
	sessionId?: string;
	toolPolicy: {
		autoApprove?: string[];
		blockedTools?: string[];
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
			readScope?: "filesystem" | "workspace";
	};
		getMcpTools?: (agentId?: string) => Promise<Record<string, any>>;
		getRagContext?: (agentId: string, query: string) => Promise<string | undefined>;
		getBuiltInTools?: () => Record<string, any>;
	}

// ---------------------------------------------------------------------------
// Tool execution context — passed to each tool's execute function
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
	workingDir: string;
	agentId: string;
	emit: (event: StreamEvent) => void;
	delegateTask?: (task: string, options?: { model?: string; systemPrompt?: string }) => Promise<string>;
		readScope?: "filesystem" | "workspace";
}

// ---------------------------------------------------------------------------
// Runtime callbacks — how AgentLoop communicates back to AgentService
// ---------------------------------------------------------------------------

export interface RuntimeCallbacks {
	onEvent: (event: StreamEvent) => void;
}

// ---------------------------------------------------------------------------
// The runtime interface
// ---------------------------------------------------------------------------

export interface AgentRuntime {
	run(userMessage: string): Promise<void>;
	abort(): void;
	getState(): RuntimeState;
	resetSession(): void;
	getResult(): string;
}

export interface RuntimeState {
	isBusy: boolean;
	streamingText: string;
	toolCalls: { name: string; status: "running" | "done" | "error" }[];
}

// ---------------------------------------------------------------------------
// Re-export ModelMessage for convenience
// ---------------------------------------------------------------------------

export type { ModelMessage };
