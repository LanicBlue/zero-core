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
import type { AttachmentMeta, DelegatedTaskRecord, DelegatedTaskStatus, SessionContextBundle } from "../shared/types.js";

/**
 * Optional usage counters carried by step rows. Shared between the step write
 * API and {@link StepInput}.
 */
export interface StepUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

/**
 * Input shape for the step-level write API (appendStep / upsertStep /
 * replaceStepsFromMessages). `content` stays a plain string (design principle
 * A — multimodal-input sub-2): attachment metadata flows separately via
 * `attachments` and is persisted to the `turns.attachments` column as JSON.
 * `attachments` is optional for back-compat with pre-multimodal callers.
 */
export interface StepInput {
	seq: number;
	turnGroup: number;
	role: string;
	content: string | null;
	usage?: StepUsage;
	/** multimodal-input sub-2: attachment metadata persisted as JSON. */
	attachments?: AttachmentMeta[];
}

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
	/**
	 * multimodal-input sub-2: attachment metadata for the step, parsed back from
	 * the `turns.attachments` JSON column. `undefined` for rows written before
	 * the column existed / rows with no attachments (back-compat).
	 */
	attachments?: AttachmentMeta[];
}

/**
 * Interface for session/message persistence.
 * Runtime layer uses this instead of depending on server/SessionDB.
 */
export interface ISessionStore {
	getMessages(sessionId: string): any[];
	saveTurn(sessionId: string, messages: any[]): void;
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
	deleteTurn(sessionId: string, seq: number): void;
	clearTurns(sessionId: string): void;
	getKVStore(): IKVStore;

	// ── Delegated task persistence (optional — runtime null-checks) ──
	createDelegatedTask?(input: {
		id: string;
		parentTaskId?: string;
		rootTaskId: string;
		ownerAgentId: string;
		targetAgentId: string;
		modelId?: string;
		parentSessionId?: string;
		sessionId?: string;
		task: string;
		status?: DelegatedTaskStatus;
		depth?: number;
		parentToolCallId?: string;
	}): DelegatedTaskRecord;
	updateDelegatedTask?(id: string, patch: Partial<Pick<DelegatedTaskRecord, "status" | "step" | "turns" | "tokens" | "currentTool" | "result" | "error" | "controlMessage" | "finishRequestedAt" | "completedAt" | "sessionId" | "parentToolCallId">>): DelegatedTaskRecord | undefined;
	getDelegatedTask?(id: string): DelegatedTaskRecord | undefined;
	listDelegatedTasks?(filter?: { ownerAgentId?: string; rootTaskId?: string; parentTaskId?: string; parentSessionId?: string; status?: DelegatedTaskStatus }): DelegatedTaskRecord[];
	/** Mark still-running/finishing delegated tasks as interrupted (startup recovery). Returns the count marked. */
	markRunningDelegatedTasksInterrupted?(): number;
	/**
	 * sub-4 (TaskResume turn_seq guard): the interrupted turn for a session, if
	 * any. Returns { turnSeq, lastCompletedStepSeq? } so the runtime resumeTask
	 * path can pre-populate the turn_seq cursor + turn_state-precreate marker
	 * BEFORE loop.resume() — otherwise TurnStart allocates turn_seq+1 (the
	 * "turn+1 bug" acceptance case 9 checks). Mirrors what the server-side
	 * doRecoverIncompleteSessions does for chat-session recovery. Narrow single-
	 * session read so the runtime doesn't need the full getIncompleteTurns list.
	 * Returns undefined when the session has no interrupted turn.
	 */
	getIncompleteTurn?(sessionId: string): { turnSeq: number; lastCompletedStepSeq?: number | null } | undefined;
	/**
	 * sub-8 (lazy rebuild + interrupted seed): distinct session ids that have
	 * at least one non-terminal turn_state row. Single batched query (no N+1).
	 * Used by restoreAllSessions (only incomplete sessions get a startup loop)
	 * and restoreDelegatedTasks (authoritative frozen/interrupted seed signal).
	 * Empty set when nothing is incomplete.
	 */
	getIncompleteTurnSessionIds?(): Set<string>;
	/**
	 * sub-4 (TaskKill interrupted→abandon): mark a session's interrupted
	 * turn_state row terminal (failed) so it stops appearing as "needs resume"
	 * on next startup. Used by the parent's TaskKill(interrupted) branch — the
	 * parent is choosing NOT to resume a frozen child, so its interrupted turn
	 * must be closed out. Returns the count of rows marked (0 if none/unknown).
	 */
	abandonInterruptedTurn?(sessionId: string, reason?: string): number;
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

	// Step-level storage methods (Step 4A: step-only — turn_group is mandatory,
	// legacy turn API has been retired; step methods are the only turns-table API).
	getSteps(sessionId: string): StepRow[];
	getStepGroup(sessionId: string, turnGroup: number): StepRow[];
	/** multimodal-input sub-2: `attachments` (optional) is persisted to the
	 *  `turns.attachments` column as JSON; omitted on pre-multimodal callers. */
	appendStep(sessionId: string, seq: number, turnGroup: number, role: string, content: string | null, usage?: StepUsage, attachments?: AttachmentMeta[]): void;
	upsertStep(sessionId: string, seq: number, turnGroup: number, role: string, content: string | null, usage?: StepUsage, attachments?: AttachmentMeta[]): void;
	updateStepContent(sessionId: string, seq: number, content: string, usage?: StepUsage): void;
	deleteStepGroup(sessionId: string, turnGroup: number): void;
	getTurnGroupCount(sessionId: string): number;
	/** multimodal-input sub-2: each step's optional `attachments` is persisted
	 *  to the `turns.attachments` column as JSON. */
	replaceStepsFromMessages(sessionId: string, steps: StepInput[]): void;
}
