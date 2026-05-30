// ---------------------------------------------------------------------------
// Hook event definitions — 27 events covering the full agent lifecycle
// Inspired by Claude Code's hook architecture (27 event points)
// ---------------------------------------------------------------------------

/** All 27 hook event names */
export type HookEventName =
	| "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
	| "SessionStart" | "SessionEnd" | "Stop" | "StopFailure" | "Setup"
	| "UserPromptSubmit" | "Notification" | "PermissionRequest" | "PermissionDenied"
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
}

// ---------------------------------------------------------------------------
// Per-event context types (events with extra payload)
// ---------------------------------------------------------------------------

export interface PreToolUseContext extends BaseHookContext {
	toolName: string;
	args: Record<string, unknown>;
}

export interface PostToolUseContext extends BaseHookContext {
	toolName: string;
	result: unknown;
	isError: boolean;
}

export interface PostToolUseFailureContext extends BaseHookContext {
	toolName: string;
	error: string;
}

export interface StopContext extends BaseHookContext {
	resultText: string;
	messageCount: number;
}

export interface StopFailureContext extends BaseHookContext {
	error: string;
	errorClass?: string;
}

export interface UserPromptSubmitContext extends BaseHookContext {
	message: string;
}

export interface SessionStartContext extends BaseHookContext {
	userMessage: string;
}

export interface SessionEndContext extends BaseHookContext {
	resultText: string;
}

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

/** Return to block the current operation (e.g. PreToolUse blocking a tool call) */
export interface HookBlockResult {
	blocked: true;
	reason: string;
}

/** Return to force the agent loop to continue instead of stopping */
export interface HookContinueResult {
	forceContinue: true;
	message: string;
}

/** Union of all possible hook return values. void = no action */
export type HookResult = void | HookBlockResult | HookContinueResult;

/** Handler function signature */
export type HookHandler = (ctx: BaseHookContext & Record<string, unknown>) => HookResult | Promise<HookResult>;
