// 会话存储抽象接口
//
// # 文件说明书
//
// ## 核心功能
// 定义会话和消息持久化的最小接口，解耦运行时层与具体数据库实现
//
// ## 输入
// 会话 ID、消息数据
//
// ## 输出
// ISessionStore 接口，提供消息读写和轮次管理
//
// ## 定位
// src/runtime/ — 运行时层接口定义，由 server/SessionDB 实现
//
// ## 依赖
// core/kv-store-interface.ts
//
// ## 维护规则
// 接口变更需确保 SessionDB 实现方同步更新
//
import type { IKVStore } from "../core/kv-store-interface.js";
import type { DelegatedTaskRecord, DelegatedTaskStatus, SessionContextBundle } from "../shared/types.js";

/** Step-level row from the turns table. */
export interface StepRow {
	seq: number;
	turnGroup: number;
	role: string;
	content: string | null;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	createdAt: string;
}

/**
 * Interface for session/message persistence.
 * Runtime layer uses this instead of depending on server/SessionDB.
 */
export interface ISessionStore {
	getMessages(sessionId: string): any[];
	saveTurn(sessionId: string, messages: any[]): void;
	getTurns(sessionId: string): Array<{ seq: number; role: string; content: string | null; createdAt: string }>;
	appendTurn(sessionId: string, seq: number, role: string, content: string | null): void;
	getTurnCount(sessionId: string): number;
	getMainSession(agentId: string): { id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string } | undefined;
	createSession(
		agentId: string,
		title?: string,
		context?: SessionContextBundle,
		options?: { sessionKind?: "chat" | "delegated"; parentSessionId?: string; parentTaskId?: string; visibility?: "normal" | "hidden" | "debug" },
	): { id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string; sessionKind?: "chat" | "delegated"; parentSessionId?: string; parentTaskId?: string; visibility?: "normal" | "hidden" | "debug" };
	setMainSession(agentId: string, sessionId: string): void;
	listSessions(agentId: string): Array<{ id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string }>;
	listAllSessions(): Array<{ id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string }>;
	deleteSession(sessionId: string): void;
	updateTurnContent(sessionId: string, seq: number, content: string): void;
	upsertAssistantTurn(sessionId: string, seq: number, content: string): void;
	deleteTurn(sessionId: string, seq: number): void;
	clearTurns(sessionId: string): void;
	getKVStore(): IKVStore;
	getMemoryNodeStore(): any;

	// ── Delegated task persistence (optional — runtime null-checks) ──
	createDelegatedTask?(input: {
		id: string;
		parentTaskId?: string;
		rootTaskId: string;
		ownerAgentId: string;
		targetAgentId: string;
		parentSessionId?: string;
		sessionId?: string;
		task: string;
		status?: DelegatedTaskStatus;
		depth?: number;
	}): DelegatedTaskRecord;
	updateDelegatedTask?(id: string, patch: Partial<Pick<DelegatedTaskRecord, "status" | "step" | "turns" | "tokens" | "currentTool" | "result" | "error" | "controlMessage" | "finishRequestedAt" | "completedAt" | "sessionId">>): DelegatedTaskRecord | undefined;
	getDelegatedTask?(id: string): DelegatedTaskRecord | undefined;
	listDelegatedTasks?(filter?: { ownerAgentId?: string; rootTaskId?: string; parentTaskId?: string; parentSessionId?: string; status?: DelegatedTaskStatus }): DelegatedTaskRecord[];
	/** Mark still-running/finishing delegated tasks as interrupted (startup recovery). Returns the count marked. */
	markRunningDelegatedTasksInterrupted?(): number;
	recordToolExecution(exec: {
		sessionId: string;
		agentId: string;
		toolName: string;
		success: boolean;
		errorMessage?: string;
		inputPreview?: string;
		outputPreview?: string;
		durationMs: number;
		turnSeq?: number;
	}): void;

	// Step-level storage methods (new)
	hasStepSchema(): boolean;
	getSteps(sessionId: string): StepRow[];
	getStepGroup(sessionId: string, turnGroup: number): StepRow[];
	appendStep(sessionId: string, seq: number, turnGroup: number, role: string, content: string | null, usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void;
	upsertStep(sessionId: string, seq: number, turnGroup: number, role: string, content: string | null, usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void;
	updateStepContent(sessionId: string, seq: number, content: string, usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void;
	deleteStepGroup(sessionId: string, turnGroup: number): void;
	getTurnGroupCount(sessionId: string): number;
	replaceStepsFromMessages(sessionId: string, steps: Array<{ seq: number; turnGroup: number; role: string; content: string | null; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }>): void;
}
