// Hook 事件类型定义
//
// # 文件说明书
//
// ## 核心功能
// 定义 30 个 Hook 事件名称和回调函数类型，覆盖 agent 完整生命周期
//
// ## 输入
// 无（纯类型定义）
//
// ## 输出
// HookEventName 联合类型、HookCallback 函数类型
//
// ## 定位
// src/core/ — 核心层，为 hook-registry 提供事件类型基础
//
// ## 依赖
// 无外部依赖
//
// ## 维护规则
// 新增或删除事件时需确保不破坏已有 hook 注册
//
// ---------------------------------------------------------------------------
// Hook event definitions — 30 events covering the full agent lifecycle
// Inspired by Claude Code's hook architecture (27 event points)
// ---------------------------------------------------------------------------

/** All 30 hook event names */
export type HookEventName =
	| "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
	| "SessionStart" | "SessionEnd" | "Stop" | "StopFailure" | "Setup"
	| "UserPromptSubmit" | "Notification" | "PermissionRequest" | "PermissionDenied"
	| "SubagentStart" | "SubagentStop"
	| "PreCompact" | "PostCompact"
	| "PreLLMCall" | "PostStep" | "PostTurnComplete"
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

export interface PostStepContext extends BaseHookContext {
	stepOffset: number;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
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
