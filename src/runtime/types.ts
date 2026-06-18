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
import type { SessionContextBundle } from "../shared/types.js";

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
	contextUsage?: number;
	contextWindow?: number;
	estimatedTokens?: number;
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
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
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
	guidelines?: string[];
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
	/**
	 * v0.8 (P2 §11.5): this agent's delegation subagents (copied from
	 * AgentRecord.subagents at session build time). Each entry references a
	 * global agent by id; the loop turns each into a caller-only delegation
	 * tool via subagents-delegation.ts. Empty/undefined → no delegation tools.
	 */
	subagents?: Array<{ agentId: string; name?: string; description?: string }>;
	/**
	 * v0.8 (P2 §11.5): resolve a subagent target agent's identity by id, so
	 * the delegation entry can pass systemPrompt/model/toolPolicy to
	 * delegateTask. Optional — when absent, only targetAgentId is forwarded
	 * and the sub-loop inherits the caller's identity.
	 */
	resolveSubagentTarget?: (agentId: string) => {
		id: string;
		name?: string;
		systemPrompt?: string;
		model?: string;
		toolPolicy?: SessionConfig["toolPolicy"];
	} | undefined;
	getToolConfig?: () => Record<string, Record<string, any>>;
	compression?: {
		enabled?: boolean;
		keepRecentTurns?: number;
		l1Threshold?: number;
		l2Threshold?: number;
		provider?: string;
		model?: string;
	};
	memory?: {
		enabled?: boolean;
		autoExtract?: boolean;
		autoRecall?: boolean;
		recallLimit?: number;
	};
	// Multi-Agent Workflow
	agentRole?: string;                    // analyst | lead | developer | reviewer | qa
	projectContext?: {
		projectId: string;
		projectName: string;
		projectPath: string;
		activeRequirementId?: string;        // Lead/sub-agent use
	};
	/** Injected into ToolExecutionContext for workflow tools */
	wikiStore?: any;                       // ProjectWikiStore
	requirementStore?: any;                // RequirementStore
	/**
	 * v0.8 (M0): session context bundle (D-B) carried by the SessionConfig.
	 * Sub-agents built from this config inherit this bundle unless the caller
	 * overrides per-call via DelegateTaskOptions.contextOverride.
	 */
	contextBundle?: SessionContextBundle;
	/**
	 * v0.8 (P1 §10.6): the agent's free wiki anchors (copied from
	 * AgentRecord.wikiAnchors at session build time). Combined with the
	 * auto-derived memory + project anchors (from contextBundle) this forms
	 * the session's full anchor set — used by both the scope guard (visible
	 * nodeId union) and the prompt injector (system + context channels).
	 */
	wikiAnchors?: import("../shared/types.js").AgentRecord["wikiAnchors"];
	/**
	 * v0.8 (M0): ZeroAdminService handle for the zero role's management tools.
	 * Only set on zero sessions.
	 */
	zeroAdmin?: any;
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
	/**
	 * v0.8 (M0): extended delegateTask signature (RFC §2.11 / decision 16).
	 * Passes target agent full config + per-call override + caller bundle
	 * inheritance. Identity/toolPolicy/history come from the target agent.
	 *
	 * Legacy 2-arg callers (`task`, `{model, systemPrompt}`) still work —
	 * the extended fields are all optional.
	 */
	delegateTask?: (task: string, options?: import("./subagent-delegator.js").DelegateTaskOptions) => Promise<string>;
	delegateTaskBackground?: (task: string, options?: { model?: string; systemPrompt?: string }) => string;
	getTaskResult?: (taskId: string) => TaskInfo | null;
	listTasks?: (filter?: "running" | "completed") => TaskInfo[];
	stopTask?: (taskId: string) => boolean;
	suspendUntilWake?: (timeoutMs: number, taskId?: string) => Promise<string>;
	runBackground?: (command: string, timeout?: number) => string;
	readScope?: "filesystem" | "workspace";
	toolConfig?: Record<string, Record<string, any>>;
	rateLimiter?: import("./tool-rate-limiter.js").ToolRateLimiter;
	// Multi-Agent Workflow context
	wikiStore?: any;                    // ProjectWikiStore
	requirementStore?: any;             // RequirementStore
	// v0.8 (M4): PmService handle (PM sessions only) — backs the
	// CreateRequirementWithDoc tool. Gated via CONDITIONAL_TOOLS.
	pmService?: any;                    // PmService
	taskStepStore?: any;                // TaskStepStore
	projectId?: string;                 // Current project ID
	agentRole?: string;                 // Current agent role (analyst | lead | developer | reviewer | qa)
	projectPath?: string;               // Project root directory path
	activeRequirementId?: string;       // Current requirement ID for orchestration
	// v0.8 (M0): createRoleLoop removed from context. Sub-agent dispatch
	// now flows through delegateTask (extended signature carries target agent
	// full config + per-call override + caller bundle inheritance).
	/** v0.8 (M0): session context bundle (D-B) carried by this loop. */
	contextBundle?: SessionContextBundle;
	/**
	 * v0.8 (M0): ZeroAdminService handle for the zero global-management
	 * role's tools (create/update/delete project, agent, set toolPolicy,
	 * expose-as-tool). Only present on zero sessions; absent elsewhere so
	 * the tools gate themselves out via CONDITIONAL_TOOLS.
	 */
	zeroAdmin?: any;
	/**
	 * v0.8 (P2 §11.5): this caller's subagents list (mirrors SessionConfig.
	 * subagents). Surfaced so the Orchestrate engine can resolve a DSL `task`
	 * node's `agentTool` (user-facing name) → target agent id.
	 */
	subagents?: Array<{ agentId: string; name?: string; description?: string }>;
	/** v0.8 (P2 §11.5): resolve a subagent target's identity by id. */
	resolveSubagentTarget?: (agentId: string) => {
		id: string;
		name?: string;
		systemPrompt?: string;
		model?: string;
		toolPolicy?: SessionConfig["toolPolicy"];
	} | undefined;
	/**
	 * v0.8 (M3): Orchestrate plan store — persists lead-submitted DSL flows +
	 * confirm gate state. Only present on lead sessions.
	 */
	orchestratePlanStore?: any;
	/**
	 * v0.8 (M3): Orchestrate manifest store — persists per-run manifests
	 * (touched files + tests + review) for PM coverage judgement and archivist
	 * traceability.
	 */
	orchestrateManifestStore?: any;
	/**
	 * v0.8 (M3): GitIntegration — lets the Orchestrate tool commit each task
	 * step on the feature worktree with the [req-<short>] reference (decision
	 * 21 / RFC §2.15). Only present on lead sessions; best-effort (safe-fail
	 * when git is unavailable).
	 */
	gitIntegration?: any;
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
