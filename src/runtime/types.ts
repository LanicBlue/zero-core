// Runtime 类型定义
//
// # 文件说明书
//
// ## 核心功能
// 定义运行时相关的 TypeScript 类型，包括事件、配置和状态。
//
// ## 输入
// 无 - 类型定义文件。
//
// ## 输出
// - TypeScript 类型定义
//
// ## 定位
// Runtime 模块类型定义，被整个 runtime 使用。
//
// ## 依赖
// - ai - AI SDK 类型
// - ./session-store-interface - 会话存储接口
//
// ## 维护规则
// - 新增事件类型时需更新
// - 保持与 IPC 契约一致
//
import type { ModelMessage } from "ai";
import type { ISessionStore } from "./session-store-interface.js";

// ---------------------------------------------------------------------------
// Stream events — must match the existing IPC contract
// ---------------------------------------------------------------------------

export interface TextDeltaEvent {
	type: "text_delta";
	agentId?: string;
	sessionId?: string;
	text: string;
}

export interface ThinkingDeltaEvent {
	type: "thinking_delta";
	agentId?: string;
	sessionId?: string;
	text: string;
}

export interface ToolStartEvent {
	type: "tool_start";
	agentId?: string;
	sessionId?: string;
	toolName: string;
	toolCallId?: string;
	args?: unknown;
}

export interface ToolEndEvent {
	type: "tool_end";
	agentId?: string;
	sessionId?: string;
	toolName: string;
	toolCallId?: string;
	isError: boolean;
	result?: unknown;
}

export interface MessageEndEvent {
	type: "message_end";
	agentId?: string;
	sessionId?: string;
	text: string;
}

export interface AgentEndEvent {
	type: "agent_end";
	agentId?: string;
	sessionId?: string;
}

export interface ErrorEvent {
	type: "error";
	agentId?: string;
	sessionId?: string;
	error: string;
	errorClass?: ErrorClass;
}

export interface RetryAttemptEvent {
	type: "retry_attempt";
	agentId?: string;
	sessionId?: string;
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorClass: ErrorClass;
}

export type ErrorClass = "timeout" | "rate_limit" | "server_error" | "auth" | "network" | "prompt_too_long" | "unknown";

export interface AskUserEvent {
	type: "ask_user";
	agentId?: string;
	sessionId?: string;
	requestId: string;
	questions: Array<{
		question: string;
		header?: string;
		options?: Array<{ label: string; description?: string }>;
		multiSelect?: boolean;
	}>;
}

export interface TodosUpdateEvent {
	type: "todos_update";
	agentId?: string;
	sessionId?: string;
	todos: Array<{
		content: string;
		status: "pending" | "in_progress" | "completed";
		activeForm: string;
	}>;
}

export interface SubagentDispatchedEvent {
	type: "subagent_dispatched";
	agentId?: string;
	sessionId?: string;
	taskId: string;
	task: string;
}

export interface SubagentProgressEvent {
	type: "subagent_progress";
	agentId?: string;
	sessionId?: string;
	taskId: string;
	step: number;
	toolName?: string;
}

export interface SubagentCompletedEvent {
	type: "subagent_completed";
	agentId?: string;
	sessionId?: string;
	taskId: string;
	status: "completed" | "failed";
	result?: string;
}

export interface UsageEvent {
	type: "usage";
	agentId?: string;
	sessionId?: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	};
}

export interface SessionInitMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	blocks?: Array<{
		type: "thinking" | "tool" | "text";
		text?: string;
		name?: string;
		status?: "running" | "done" | "error";
		args?: string;
		result?: string;
	}>;
	timestamp: number;
	streaming?: boolean;
}

export interface SessionInitEvent {
	type: "session_init";
	agentId?: string;
	sessionId?: string;
	messages: SessionInitMessage[];
}

export type StreamEvent =
	| TextDeltaEvent
	| ThinkingDeltaEvent
	| ToolStartEvent
	| ToolEndEvent
	| MessageEndEvent
	| AgentEndEvent
	| ErrorEvent
	| RetryAttemptEvent
	| AskUserEvent
	| TodosUpdateEvent
	| SubagentDispatchedEvent
	| SubagentProgressEvent
	| SubagentCompletedEvent
	| UsageEvent
	| SessionInitEvent;

// ---------------------------------------------------------------------------
// Provider config — mirrors existing ProviderConfig
// ---------------------------------------------------------------------------

export interface RuntimeProviderConfig {
	name: string;
	type: "openai" | "anthropic" | "gemini" | "openai-compatible" | "ollama" | "mock";
	apiKey: string;
	baseUrl: string;
	models: {
		id: string;
		name: string;
		contextWindow?: number;
		maxTokens?: number;
	}[];
	enabled: boolean;
	enableConcurrencyLimit?: boolean;
	maxConcurrency?: number;
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
	timeoutSec?: number;
	sessionId?: string;
	db?: ISessionStore;
	concurrencyManager?: import("./provider-concurrency-manager.js").ProviderConcurrencyManager;
	parentSessionId?: string;
	spawnDepth?: number;
	toolPolicy: {
		autoApprove?: string[];
		blockedTools?: string[];
		tools?: Record<string, { enabled: boolean }>;
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
			readScope?: "filesystem" | "workspace";
	};
		getMcpTools?: (agentId?: string) => Promise<Record<string, any>>;
		getRagContext?: (agentId: string, query: string) => Promise<string | undefined>;
			getAgentToolEntries?: () => Promise<{
				entries: Array<import("../shared/types.js").AgentToolEntry>;
				agents: Map<string, { id: string; name: string; systemPrompt?: string; model?: string }>;
			}>;
	getToolConfig?: () => Record<string, Record<string, any>>;
	}

// ---------------------------------------------------------------------------
// Subagent task info — tracked by SubagentTaskRegistry
// ---------------------------------------------------------------------------

export type TaskType = "subagent" | "bash";

export interface TaskInfo {
	id: string;
	type: TaskType;
	task: string;
	status: "running" | "completed" | "failed" | "killed";
	step: number;
	currentTool?: string;
	result?: string;
	error?: string;
	startedAt: number;
	completedAt?: number;
	notified?: boolean;
}

// ---------------------------------------------------------------------------
// Tool execution context — passed to each tool's execute function
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
	workingDir: string;
	agentId: string;
	sessionId?: string;
	turnSeq?: number;
	emit: (event: StreamEvent) => void;
	db?: ISessionStore;
	delegateTask?: (task: string, options?: { model?: string; systemPrompt?: string }) => Promise<string>;
	delegateTaskBackground?: (task: string, options?: { model?: string; systemPrompt?: string }) => string;
	getTaskResult?: (taskId: string) => TaskInfo | null;
	listTasks?: (filter?: "running" | "completed") => TaskInfo[];
	stopTask?: (taskId: string) => boolean;
	suspendUntilWake?: (timeoutMs: number, taskId?: string) => Promise<string>;
		runBackground?: (command: string, timeout?: number) => string;
	readScope?: "filesystem" | "workspace";
	toolConfig?: Record<string, Record<string, any>>;
	rateLimiter?: import("./tool-rate-limiter.js").ToolRateLimiter;
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
