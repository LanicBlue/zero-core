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
import type { DelegatedTaskRecord, SessionContextBundle } from "../shared/types.js";
import type { HookWiringDeps } from "./hooks/index.js";

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

/**
 * sub-5 (Wait rewrite): control events emitted by the loop to flip the
 * session's "running" state around a Wait suspension. session_waiting = a Wait
 * tool suspended (release busy; UI shows idle; next user message routes to
 * interruptWaitForUserInput). session_running = Wait resumed (reacquire busy).
 * The server (agent-service handleRuntimeEvent) consumes these to keep
 * runStates the UI truth source; the renderer's session_waiting handler flips
 * the streaming flag back to idle. session_running is ALSO emitted by the
 * server's markRunning (pre-existing); the loop emitting it on Wait resume just
 * keeps the flag consistent. Both carry sessionId (required) + agentId.
 */
export interface SessionWaitingEvent {
	type: "session_waiting";
	agentId?: string;
	sessionId?: string;
}

/** sub-5: Wait resumed → reacquire running. Mirror of SessionWaitingEvent. */
export interface SessionRunningEvent {
	type: "session_running";
	agentId?: string;
	sessionId?: string;
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
	| SessionInitEvent
	| SessionWaitingEvent
	| SessionRunningEvent;

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
	/**
	 * v0.8 (Step 1B): which kind of loop owns this config. Used by the
	 * per-loop HookRegistry wiring (registerHooksForLoop) to pick the right
	 * handler set. Defaults to "main" when unset (legacy callers). Delegated
	 * sub-loops set this to "delegated" so the registry registers
	 * task-control-hooks and skips main-only hooks (notification /
	 * input-queue / metrics).
	 */
	loopKind?: "main" | "delegated";
	systemPrompt: string;
	guidelines?: string[];
	/**
	 * Per-agent context-block toggles (mirrors AgentRecord.contextConfig, narrowed
	 * to the only live toggle). buildContextMessage reads useDeviceContext every
	 * turn to gate the Environment section; undefined ⇒ on (default-equivalent).
	 */
	contextConfig?: { useDeviceContext?: boolean };
	modelId: string;
	providerName: string;
	thinkingLevel?: string;
	timeoutSec?: number;
	sessionId?: string;
	db?: ISessionStore;
	concurrencyManager?: import("./provider-concurrency-manager.js").ProviderConcurrencyManager;
	parentSessionId?: string;
	spawnDepth?: number;
	/**
	 * The taskId this loop was spawned under (undefined for a root main
	 * session). Stamped onto every task this loop's delegator creates as that
	 * task's parentTaskId, so the live in-memory task tree can be reconstructed
	 * by walking nested delegators (UI TaskTree + agent TaskList share one
	 * source). Undefined at the root means "direct child of the session".
	 */
	ownerTaskId?: string;
	toolPolicy: {
		autoApprove?: string[];
		blockedTools?: string[];
		tools?: Record<string, { enabled: boolean }>;
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
		readScope?: "filesystem" | "workspace";
	};
	getMcpTools?: (agentId?: string) => Promise<Record<string, any>>;
	/**
	 * v0.8 (P2 §11.5): this agent's delegation subagents (copied from
	 * AgentRecord.subagents at session build time). Each entry references a
	 * global agent by id; the `Agent` action tool resolves them live by name
	 * at delegate time. Empty/undefined → no named delegation targets.
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
	/** v0.8 (delegation refactor): live agent resolver for the Agent tool. */
	resolveAgent?: (agentId: string) => {
		id: string;
		name?: string;
		systemPrompt?: string;
		model?: string;
		toolPolicy?: SessionConfig["toolPolicy"];
		subagents?: Array<{ agentId: string; name?: string; description?: string }>;
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
	// Multi-Agent Workflow
	/** v0.8 project-work:触发该 turn 的工位 id。workflow-context-hook 据此读 work.contextPolicy。 */
	workId?: string;
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
	 * sub-7 (work-context 拆解到三通道): server-built closure that renders the
	 * Project / Requirement / Wiki Baseline text for the **system** channel
	 * (按需段,cacheBreak:false — re-read each turn but only injected when the
	 * work-context policy / activeRequirement flips). The closure captures
	 * projectStore / requirementStore / wikiStore + the per-work policy at
	 * SessionConfig build time (agent-service) so the runtime layer never
	 * imports server stores directly (mirrors wikiStore / wikiAnchors injection).
	 *
	 * Returns "" for non-work sessions → the system section is omitted
	 * (SystemPromptAssembler drops empty sections).
	 */
	workContextSystemSection?: () => string;
	/**
	 * sub-7: server-built closure rendering the **Steps Progress** text for the
	 * **workbench** channel (per-step). Same DI shape as workContextSystemSection.
	 * Returns "" when there are no steps → the workbench section is omitted.
	 */
	stepsProgressSection?: () => string;
	/**
	 * v0.8 (P3): ManagementService handle for the domain action tools
	 * (Project/Agent/Cron). Only set on zero sessions.
	 *
	 * (Renamed from `zeroAdmin` in P3 — RFC §7.3 硬原则: capability lives in
	 * tools named by function, not by agent. The legacy field name is gone.)
	 */
	management?: any;
	/**
	 * Step 1B: per-loop hook wiring deps. Carried on the config so the loop's
	 * internal SubagentDelegator can build delegated sub-loops with the same
	 * deps (sub-loops register their own hook set on their own registry). The
	 * MAIN loop's registration is performed by agent-service right after it
	 * builds the loop (it owns loopKind="main").
	 */
	hookWiringDeps?: HookWiringDeps;
}

// ---------------------------------------------------------------------------
// Subagent task info — tracked by SubagentTaskRegistry
// ---------------------------------------------------------------------------

export type TaskType = "subagent" | "bash";

/**
 * sub-5 (Wait rewrite): wake reasons for the generic session-suspend Wait.
 * The Wait tool returns one of these as `woke: <reason>`. Wake-source
 * priority when multiple fire in the same tick (deterministic): user-input >
 * task-finished > timeout.
 *
 *   - "timeout"        : the `until` absolute point or `timeout` relative
 *                        duration was reached.
 *   - "task finished"  : any background task reached a terminal state.
 *   - "user input"     : the user sent a message while the session was
 *                        suspended (the current turn ends; turn+1 starts).
 */
export type WakeReason = "timeout" | "task finished" | "user input";

/** Options passed to suspendUntilWake. Exactly one timing source should be
 *  meaningful; `until` is preferred (absolute, durable across restart). */
export interface WaitSuspendOptions {
	/** ISO 8601 absolute wake point. Preferred for durability. */
	until?: string;
	/** Relative wait in seconds. Used when `until` is omitted. Not durable
	 *  across restart (a relative timeout that spans a restart is treated as
	 *  already-elapsed on resume). */
	timeoutSec?: number;
}

/** Result of a Wait suspension: why it woke + wall-clock elapsed. */
export interface WaitWakeResult {
	reason: WakeReason;
	elapsedMs: number;
}

export interface TaskInfo {
	id: string;
	type: TaskType;
	task: string;
	status: "running" | "finishing" | "completed" | "failed" | "killed" | "interrupted";
	/**
	 * The taskId this task was spawned under (the ownerTaskId of the loop whose
	 * delegator created it). Undefined for tasks dispatched directly by a root
	 * main session. Drives the in-memory task tree (UI TaskTree + agent
	 * TaskList). Not persisted — live view only.
	 */
	parentTaskId?: string;
	step: number;
	/** Agent-loop iterations completed (one user input spans many loops). */
	turns: number;
	/** Cumulative tokens (input + output) across all loops. */
	tokens: number;
	currentTool?: string;
	result?: string;
	error?: string;
	startedAt: number;
	completedAt?: number;
	/**
	 * The agent the task was delegated to (sub-agent identity). For subagent
	 * tasks = targetAgentId; undefined for bash tasks (no agent). Used by the
	 * UI TaskTree to show the agent NAME instead of a generic "subagent" label.
	 * Not persisted — live view only (DelegatedTaskRecord.targetAgentId is the
	 * persisted mirror).
	 */
	targetAgentId?: string;
}

// ---------------------------------------------------------------------------
// Tool execution context — passed to each tool's execute function
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
	workingDir: string;
	agentId: string;
	sessionId?: string;
	turnSeq?: number;
	/**
	 * Step 2E: the tool-call id of the currently-executing tool invocation
	 * (set by buildTool's execute wrapper just before calling the tool's own
	 * execute). Lets delegation tools (Agent/Orchestrate) stamp the resulting
	 * delegated task with its parent tool-call id so the parent resume path can
	 * resolve a dangling Agent tool-call → its delegated task.
	 */
	currentToolCallId?: string;
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
	delegateTaskBackground?: (task: string, options?: import("./subagent-delegator.js").DelegateTaskOptions) => string;
	getTaskResult?: (taskId: string) => TaskInfo | null;
	listTasks?: (filter?: "running" | "completed") => TaskInfo[];
	stopTask?: (taskId: string) => boolean;
	/**
	 * sub-4 (TaskKill interrupted→abandon): mark a frozen delegated child's
	 * interrupted turn_state terminal + drop the task from the live registry.
	 * Returns false if the task isn't interrupted (or unknown). The complement
	 * to stopTask (running→kill) — this is interrupted→abandon.
	 */
	abandonTask?: (taskId: string) => boolean;
	/**
	 * Parent-agent "confirm completion": drop a FINISHED (completed/failed/
	 * killed/interrupted) task from the live registry so it leaves the UI
	 * TaskTree and the agent's TaskList. Refuses running/finishing tasks.
	 */
	acknowledgeTask?: (taskId: string) => boolean;
	/**
	 * Ask a running delegated task to finish soon (advisory). Marks the task
	 * "finishing", injects a control message into the sub-agent's next loop,
	 * and — if maxTurns is given — force-stops it after that many agent-loop
	 * iterations. Without maxTurns the request is purely advisory (never
	 * force-stops); use stopTask for unconditional hard stop.
	 */
	requestTaskFinish?: (taskId: string, options?: { message?: string; maxTurns?: number }) => boolean;
	/** List delegated-task records (persisted) for this owner, optionally scoped. */
	listDelegatedTasks?: (filter?: { rootTaskId?: string; parentTaskId?: string }) => DelegatedTaskRecord[];
	suspendUntilWake?: (opts: WaitSuspendOptions) => Promise<WaitWakeResult>;
	/**
	 * sub-5 (Wait): announce a Wait suspension starting / ending so the loop
	 * can release/reacquire the session "running" state and detect a user-input
	 * wake (→ end current turn, start turn+1). Best-effort no-ops when not wired
	 * (test stubs). The Wait tool calls beginWait before suspendUntilWake and
	 * endWait(reason) after it resolves.
	 */
	beginWait?: () => void;
	endWait?: (reason: WakeReason) => void;
	runBackground?: (command: string, timeout?: number) => string;
	/**
	 * Step 2E: annotate the recorder's current tool-call block with the
	 * delegated taskId backing it. Called by the Agent/Orchestrate tools right
	 * after the delegator mints a taskId, so the parent step's tool-call block
	 * carries the link (tool-call ↔ task). Wired to TurnRecorder by AgentLoop.
	 * Best-effort — no-op when the loop has no recorder (test stubs).
	 */
	setToolCallTaskId?: (toolCallId: string, taskId: string) => void;
	/**
	 * sub-9 (durable relative-timeout Wait): stamp the wall-clock startedAt
	 * onto the calling Wait tool's recorder block (sibling to `args`). Persisted
	 * with the step so the resume path can compute remaining `timeout` across a
	 * restart. Wired to TurnRecorder by AgentLoop. Best-effort no-op when not
	 * wired (test stubs).
	 */
	setWaitStartedAt?: (toolCallId: string, startedAt: number) => void;
	/**
	 * Step 2E: resume a delegated task by taskId from the parent session's
	 * resume path. Surfaces SubagentDelegator.resumeTask so a future parent-
	 * side dangling-tool-call scanner can re-attach without re-invoking.
	 */
	resumeTask?: (taskId: string) => Promise<string>;
	/**
	 * sub-4 (TaskResume, non-blocking): resume a frozen delegated child WITHOUT
	 * awaiting — set up the sub-loop + turn_seq guard synchronously, then detach
	 * the run. Returns the taskId. The turn_seq pre-population happens BEFORE
	 * the detached resume fires, so the child's TurnStart won't allocate
	 * turn_seq+1 (the "turn+1 bug"). Agent tasks only.
	 */
	resumeTaskBackground?: (taskId: string) => string;
	/**
	 * sub-4 (TaskGet recent-calls, design §4.2): the last N tool-call records
	 * of a running task — NAME + ARGS SUMMARY ONLY, no output/result. Dispatch
	 * by task type (agent → live sub-loop recorder; bash → command only).
	 * Pure runtime→runtime read; no DB hop, no cross-layer. Returns [] when the
	 * sub-loop is frozen/interrupted (recent calls only appear post-TaskResume).
	 */
	getTaskRecentCalls?: (taskId: string, n?: number) => Array<{ name: string; args?: string }>;
	readScope?: "filesystem" | "workspace";
	toolConfig?: Record<string, Record<string, any>>;
	rateLimiter?: import("./tool-rate-limiter.js").ToolRateLimiter;
	// Multi-Agent Workflow context
	wikiStore?: any;                    // ProjectWikiStore
	requirementStore?: any;             // RequirementStore
	// v0.8 (M4) / project-flow F3: PmService handle (PM sessions only) —
	// backs Flow.verify's compound close (submitCoverageVerdict → archivist
	// merge) + Flow.create's PM-session path. The legacy
	// CreateRequirementWithDoc tool was retired in F3 (file deleted F5).
	pmService?: any;                    // PmService
	taskStepStore?: any;                // TaskStepStore
	projectId?: string;                 // Current project ID
	/**
	 * v0.8 (读写同界 / pure anchor model): this session's resolved wiki anchor
	 * node ids (auto memory + auto project/global + free wikiAnchors). The Wiki
	 * tool uses this set as BOTH its read scope and write scope — what you can
	 * see is what you can edit. Zero/global sessions (no projectId) include
	 * WIKI_GLOBAL_ROOT_ID here → whole tree read+write. See wiki-anchor-injection.
	 */
	wikiAnchorNodeIds?: string[];
	projectPath?: string;               // Project root directory path
	activeRequirementId?: string;       // Current requirement ID for orchestration
	// v0.8 (M0): createRoleLoop removed from context. Sub-agent dispatch
	// now flows through delegateTask (extended signature carries target agent
	// full config + per-call override + caller bundle inheritance).
	/** v0.8 (M0): session context bundle (D-B) carried by this loop. */
	contextBundle?: SessionContextBundle;
	/**
	 * v0.8 (P3): ManagementService handle for the zero global-management
	 * role's action tools (Project/Work/AgentRegistry/Cron). Injected IFF the
	 * session's toolPolicy enables one of those tools (capabilityHandlesFor);
	 * absent otherwise (and the tool errors at call time if policy enabled it
	 * without the handle). (Renamed from `zeroAdmin` in P3.)
	 */
	management?: any;
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
	 * v0.8 (delegation refactor): LIVE agent-record resolver — reads from
	 * agentStore at CALL time (not loop-build time). Returns the agent's
	 * identity + its own subagents list. Used by the action-based Agent tool
	 * to (a) list the CALLER's current delegatable subagents and (b) resolve a
	 * named subagent to fresh identity, so edits to an agent (prompt/tools/
	 * subagents) take effect without restarting the running loop.
	 */
	resolveAgent?: (agentId: string) => {
		id: string;
		name?: string;
		systemPrompt?: string;
		model?: string;
		toolPolicy?: SessionConfig["toolPolicy"];
		subagents?: Array<{ agentId: string; name?: string; description?: string }>;
	} | undefined;
	/**
	 * v0.8 (M3): Orchestrate plan store — persists lead-submitted DSL flows +
	 * confirm gate state. Only present on lead sessions.
	 */
	orchestratePlanStore?: any;
	/**
	 * v0.8 (M3): Orchestrate manifest store — persists per-run manifests
	 * (touched files + tests + review) for coverage verdict and archivist
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
	/**
	 * Optional: flat list of this loop's live in-memory tasks (its delegator's
	 * TaskRegistry) plus, recursively, the same for each currently-running
	 * sub-loop. Each TaskInfo carries a parentTaskId so the caller can rebuild
	 * the tree. Present on AgentLoop; absent on stubs. Used by the UI TaskTree
	 * and the agent TaskList so they share one source.
	 */
	getRuntimeTaskTree?(): TaskInfo[];
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
