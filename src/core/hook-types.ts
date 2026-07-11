// Hook event type definitions
//
// # File spec
//
// ## Core
// Defines the lifecycle hook event names + per-event context + result types.
// Step 1C (hook-redesign): the agent-execution hook surface is renamed to a
// step-centric, ownership-honest set (Session/Turn/Step/LLMCall/Tool levels).
// See docs/design/hook-redesign/hook-step-redesign.md §3–§4 for the authoritative skeleton.
//
// ## Naming (Step 1C mapping)
// Old → New (agent-execution surface only; workflow/observability events like
// SubagentStart/TaskCreated/PreCompact keep their names):
//   UserPromptSubmit          → deleted (no consumer)
//   SessionStart (per-run)    → TurnStart
//   Stop                      → TurnEnd
//   StopFailure               → TurnError
//   PostStep                  → StepEnd
//   PrepareStep               → StepStart
//   SessionEnd (empty trig)   → deleted
//   PreLLMCall                → unchanged
//   PostTurnComplete          → DELETED (Step 3B): its operations moved to
//                               StepEnd (compression/extraction/todo) and
//                               SessionClose. Event + trigger removed.
//   PreToolUse / PostToolUse / PostToolUseFailure → unchanged
//   SessionStart / SessionClose (NEW semantics, instance lifecycle) → fired
//   by agent-service at loop build / loop destroy. Distinct from the retired
//   per-run SessionStart (now TurnStart).
//
// Levels:
//   Session : SessionStart / SessionClose           (agent-service · once per loop instance)
//   Turn    : TurnStart / TurnEnd / TurnError       (AgentLoop.run() · per user input)
//   Step    : StepStart / StepEnd                   (per LLM call)
//   LLMCall : PreLLMCall / PostLLCall / OnLLMError  (per LLM call)
//   Tool    : PreToolUse / PostToolUse / PostToolUseFailure (per tool)
//
// ## Input
// none (pure type definitions)
//
// ## Output
// HookEventName union + HookCallback function type
//
// ## Position
// src/core/ — core layer; provides event-name basis for hook-registry
//
// ## Dependencies
// none external
//
// ## Maintenance rules
// Adding/removing an event requires updating all hook modules + the registry.

/** All hook event names. Agent-execution surface is step-centric (Step 1C). */
export type HookEventName =
	// ── Session level (agent-service, once per loop instance) ──────────────
	| "SessionStart" | "SessionClose"
	// ── Turn level (AgentLoop.run(), per user input) ───────────────────────
	//   TurnEndCheck (sub-6) — fires right before a turn would naturally end
	//   (the step produced no tool call). A handler can return
	//   { forceContinue: true, message } to keep the turn alive for one more
	//   step with the message injected — used by the force-Wait hook to nudge
	//   the model to Wait when background tasks are still running.
	| "TurnStart" | "TurnEnd" | "TurnError" | "TurnEndCheck"
	// ── Step level (per LLM call) ──────────────────────────────────────────
	| "StepStart" | "StepEnd"
	// ── LLMCall level (per LLM call) ───────────────────────────────────────
	| "PreLLMCall" | "PostLLCall" | "OnLLMError"
	// ── Tool level (per tool) ──────────────────────────────────────────────
	| "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
	// ── Observability / workflow events (NOT renamed in Step 1C — out of
	//    scope for the agent-execution hook redesign) ───────────────────────
	| "Notification" | "PermissionRequest" | "PermissionDenied"
	| "SubagentStart" | "SubagentStop"
	| "PreCompact" | "PostCompact"
	| "TeammateIdle" | "TaskCreated" | "TaskCompleted"
	| "Elicitation" | "ElicitationResult"
	| "ConfigChange" | "CwdChanged" | "FileChanged"
	| "WorktreeCreate" | "WorktreeRemove" | "InstructionsLoaded";

// ---------------------------------------------------------------------------
// Base context — every hook receives these fields
// ---------------------------------------------------------------------------

export interface BaseHookContext {
	agentId: string;
	sessionId?: string;
	timestamp: number;
	/**
	 * Which loop kind this event fired on ("main" | "delegated"). Auto-injected
	 * by AgentLoop.triggerLocal / agent-service fire helpers. Step 1B introduced
	 * per-loop registries so loopKind is no longer load-bearing for cross-loop
	 * isolation (handlers only fire for their own loop), but it is kept as a
	 * self-introspection field for handlers that branch on main vs delegated.
	 */
	loopKind?: "main" | "delegated";
}

// ---------------------------------------------------------------------------
// Tool level (per tool)
// ---------------------------------------------------------------------------

export interface PreToolUseContext extends BaseHookContext {
	toolName: string;
	args: Record<string, unknown>;
	toolCallId?: string;
}

export interface PostToolUseContext extends BaseHookContext {
	toolName: string;
	result: unknown;
	isError: boolean;
	toolCallId?: string;
}

export interface PostToolUseFailureContext extends BaseHookContext {
	toolName: string;
	error: string;
	toolCallId?: string;
}

// ---------------------------------------------------------------------------
// Turn level (per user input)
// ---------------------------------------------------------------------------

/** TurnStart: fires at the start of each turn (user input → turn-group setup). */
export interface TurnStartContext extends BaseHookContext {
	/** The user message that started this turn. "(resumed)" on a resume turn. */
	userMessage: string;
	/**
	 * platform-observability ②.1 (sub-1): the turn-source marker for this
	 * turn (user|work|cron|background). Forwarded from SessionConfig.source by
	 * agent-loop.run/resume. durable-hooks TurnStart reads it to persist on
	 * turn_state.source via createTurnState. Optional on the context for
	 * back-compat with test stubs that don't set it (durable-hooks defaults to
	 * 'background' when absent).
	 */
	source?: import("../runtime/types.js").TurnSource;
}

/** TurnEnd: fires when a turn completes normally (turn boundary closure). */
export interface TurnEndContext extends BaseHookContext {
	resultText: string;
	messageCount: number;
	/** Recorder blocks for the safety-net persist path. */
	blocks?: unknown[];
}

/**
 * TurnEndCheck (sub-6 force-Wait): fires once right before a turn would
 * naturally end (the just-completed step produced no tool call). This is the
 * LAST chance for a handler to keep the turn alive. Return
 * `{ forceContinue: true, message }` to inject `message` and run one more
 * step instead of ending the turn. The handler is responsible for de-duping
 * its own nudges across repeated TurnEndCheck fires within the same turn
 * (e.g. a per-turn "already nudged" marker) so an agent that keeps trying to
 * end doesn't get nudged into a tight loop.
 */
export interface TurnEndCheckContext extends BaseHookContext {
	/** Result text the model produced this step (empty if it only emitted a tool call that was then... n/a here — only fires when no tool call). */
	resultText?: string;
	/** The task registry attached to this loop (may be absent in stubbed tests). */
	taskRegistry?: unknown;
}

/** TurnError: fires when a turn fails after all retries. */
export interface TurnErrorContext extends BaseHookContext {
	error: string;
	errorClass?: string;
	userFriendlyMsg?: string;
	retryAttempts?: number;
	/** Recorder blocks for partial-work persistence. */
	blocks?: unknown[];
}

// ---------------------------------------------------------------------------
// Step level (per LLM call)
// ---------------------------------------------------------------------------

/**
 * StepStart: per-step setup seam. Currently empty (no consumers); added so the
 * skeleton is complete. Fires before PreLLMCall of each step once the step
 * loop is externalized (P2). Not fired in Step 1C.
 */
export interface StepStartContext extends BaseHookContext {
	/** 1-based step number within the current turn. */
	stepNumber: number;
	/** Messages already slated for this step (caller-prepared). Append-only. */
	messages: Array<{ role: string; content: string }>;
}

/** StepEnd: fires after each step completes (finish-step). Persist step + usage. */
export interface StepEndContext extends BaseHookContext {
	/** TurnRecorder instance — handlers persist completed steps from it. */
	recorder?: unknown;
	/** Base seq for the current turn group's assistant steps. */
	stepBaseSeq?: number;
	/** How many steps have been completed in the current turn group. */
	stepOffset?: number;
	/**
	 * Step 2E: 1-based step number within the current turn. Lets StepEnd
	 * handlers correlate with the matching StepStart (deferred-consume hooks
	 * key their per-step markers on this).
	 */
	stepNumber?: number;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
	// ── Step 3A: per-step operation surfaces (compression + extraction) ──
	//   PostTurnComplete used to carry these; now StepEnd fires per step and
	//   both compression (contextUsage threshold) and extraction (token-budget
	//   cursor) evaluate on every step. session/config/providers mirror the
	//   PostTurnComplete context shape so the migrated handlers can run
	//   unchanged at the step boundary. contextUsage is recomputed from the
	//   step's usage via session.getContextUsage() in finalizeOneStep.
	session?: unknown;
	config?: unknown;
	providers?: unknown;
	/** 0..1 fraction of the context window in use after this step. */
	contextUsage?: number;
}

// ---------------------------------------------------------------------------
// LLMCall level (per LLM call)
// ---------------------------------------------------------------------------

/** PreLLMCall: per-step injection point (rag / providerOptions / notifications / ...). */
export interface PreLLMCallContext extends BaseHookContext {
	session?: unknown;
	config?: unknown;
	providers?: unknown;
	taskRegistry?: unknown;
	emit?: (event: unknown) => void;
}

/**
 * PostLLCall: observation seam between the model returning and tool execution.
 * Currently empty (no consumers); not fired in Step 1C (P2 will wire it).
 */
export interface PostLLCallContext extends BaseHookContext {
	/** Step number within the current turn. */
	stepNumber?: number;
}

/**
 * OnLLMError: fires when an LLM call fails. Handlers can request a retry of
 * just the failed step + an aggressive prune for prompt_too_long. Not fired in
 * Step 1C (P2 will wire it once the step loop is externalized).
 */
export interface OnLLMErrorContext extends BaseHookContext {
	error: string;
	errorClass?: string;
	/**
	 * Session / config / providers — same shape as StepEnd/PreLLMCall. Auto-fire
	 * from AgentLoop.triggerLocal includes them so reactive handlers (e.g.
	 * compression-trigger's prompt_too_long path) can resolve the provider/model
	 * + drive compressSession without a separate lookup. Optional for back-compat
	 * with stub test contexts.
	 */
	session?: unknown;
	config?: unknown;
	providers?: unknown;
	/** Set by a handler to request a retry of the failed step. */
	retry?: boolean;
	/** Delay (ms) before the requested retry. */
	delayMs?: number;
}

// ---------------------------------------------------------------------------
// Session level (agent-service, once per loop instance)
// ---------------------------------------------------------------------------

/**
 * SessionStart: fires from agent-service when a loop instance is BUILT (new
 * session created or restored into runtime). Distinct from the retired
 * per-run SessionStart (now TurnStart). Carries the loop kind (main/delegated).
 */
export interface SessionStartContext extends BaseHookContext {
	/** "main" for primary chat loops, "delegated" for sub-agent loops. */
	loopKind: "main" | "delegated";
}

/**
 * SessionClose: fires from agent-service when a loop instance is DESTROYED
 * (abort / agent delete / session delete / shutdown). Distinct from the
 * retired empty SessionEnd trigger that used to fire per-run.
 */
export interface SessionCloseContext extends BaseHookContext {
	/** "main" for primary chat loops, "delegated" for sub-agent loops. */
	loopKind: "main" | "delegated";
}

// ---------------------------------------------------------------------------
// Observability / workflow event context types (NOT renamed in Step 1C)
// ---------------------------------------------------------------------------

export interface SubagentStartContext extends BaseHookContext {
	taskId: string;
	task: string;
}

export interface SubagentStopContext extends BaseHookContext {
	taskId: string;
	status: "completed" | "failed";
	result?: string;
}

export interface CompactContext extends BaseHookContext {
	messageCount: number;
	estimatedTokens: number;
	contextWindow: number;
}

export interface ElicitationContext extends BaseHookContext {
	questions: unknown;
}

export interface ElicitationResultContext extends BaseHookContext {
	response: unknown;
}

export interface NotificationContext extends BaseHookContext {
	notifications: Array<{ taskId: string; status: string; result?: string }>;
}

// ---------------------------------------------------------------------------
// Hook result types
// ---------------------------------------------------------------------------

/** Return to block the current operation (e.g. PreToolUse blocking a tool call). */
export interface HookBlockResult {
	blocked: true;
	reason: string;
}

/** Return to force the agent loop to continue instead of stopping. */
export interface HookContinueResult {
	forceContinue: true;
	message: string;
}

// --- Per-event data-modification results ---

/** PreToolUse: can block or modify tool arguments. */
export interface PreToolUseResult {
	blocked?: boolean;
	reason?: string;
	modifiedArgs?: Record<string, unknown>;
}

/** PostToolUse: can modify tool output. */
export interface PostToolUseResult {
	modifiedResult?: unknown;
	modifiedIsError?: boolean;
}

/** PostToolUseFailure: can modify error message. */
export interface PostToolUseFailureResult {
	modifiedError?: string;
}

/** PreLLMCall: can inject context strings and provider options. */
export interface PreLLMCallResult {
	memoryContext?: string;
	providerOptions?: Record<string, Record<string, unknown>>;
	/**
	 * Extra messages to append for this step (same transport as
	 * StepStartResult.appendMessages). AgentLoop merges these into the outgoing
	 * step messages; compression-trigger's hot-path 提醒 uses this to nudge the
	 * model when the context crosses the soft threshold.
	 */
	appendMessages?: Array<{ role: string; content: string }>;
}

/** StepEnd: can trigger token calibration. */
export interface StepEndResult {
	inputTokens?: number;
}

/** StepStart: can append messages to be sent to the model for this step. */
export interface StepStartResult {
	/** Extra messages to append for this step (after the prepared messages). */
	appendMessages?: Array<{ role: string; content: string }>;
}

/** Union of all possible hook return values. void = no action. */
export type HookResult =
	| void
	| HookBlockResult
	| HookContinueResult
	| PreToolUseResult
	| PostToolUseResult
	| PostToolUseFailureResult
	| PreLLMCallResult
	| StepEndResult
	| StepStartResult;

/** Handler function signature. */
export type HookHandler = (ctx: BaseHookContext & Record<string, unknown>) => HookResult | Promise<HookResult>;
