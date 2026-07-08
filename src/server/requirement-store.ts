// 需求存储管理
//
// # 文件说明书
//
// ## 核心功能
// Requirement 数据持久化，包含需求、状态历史、消息三个 Store。
//
// ## 输入
// - SessionDB 实例
// - Requirement 数据
//
// ## 输出
// - RequirementRecord CRUD + 状态流转 + 消息
//
// ## 定位
// 服务层存储，被 requirement-router 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
// - ./requirement-state-machine - 状态校验
//
// ## 维护规则
// - 新增字段时需更新列定义
//
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type {
	RequirementRecord,
	RequirementStatus,
	RequirementStatusHistory,
	RequirementMessage,
	RequirementMessageSender,
	RequirementMessageType,
} from "../shared/types.js";
import { isValidTransition } from "./requirement-state-machine.js";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const REQUIREMENT_COLUMNS: ColumnDef[] = [
	{ key: "projectId", column: "project_id" },
	{ key: "title" },
	{ key: "description" },
	{ key: "status" },
	{ key: "source" },
	{ key: "priority" },
	{ key: "impactScope", column: "impact_scope" },
	{ key: "context" },
	{ key: "assignedLeadSessionId", column: "assigned_lead_session_id" },
	{ key: "discussionSessionId", column: "discussion_session_id" },
	{ key: "reviewer" },
	{ key: "closedAt", column: "closed_at" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
	// v0.8 (M4): discuss-as-document fields (RFC §4.5 / decision 12/14/34).
	{ key: "docPath", column: "doc_path" },
	{ key: "createdByAgentId", column: "created_by_agent_id" },
	{ key: "assignedAgentId", column: "assigned_agent_id" },
	{ key: "reviewerAgentId", column: "reviewer_agent_id" },
];

const STATUS_HISTORY_COLUMNS: ColumnDef[] = [
	{ key: "requirementId", column: "requirement_id" },
	{ key: "fromStatus", column: "from_status" },
	{ key: "toStatus", column: "to_status" },
	{ key: "triggeredBy", column: "triggered_by" },
	{ key: "comment" },
	{ key: "createdAt", column: "created_at" },
];

const MESSAGES_COLUMNS: ColumnDef[] = [
	{ key: "requirementId", column: "requirement_id" },
	{ key: "sender" },
	{ key: "content" },
	{ key: "messageType", column: "message_type" },
	{ key: "metadata" },
	{ key: "createdAt", column: "created_at" },
];

// ---------------------------------------------------------------------------
// RequirementStore
// ---------------------------------------------------------------------------

// tool-decoupling(决策 1):process-wide 单例 getter/setter。启动时注册;
// 工具(Flow / requirement 相关)import { getRequirementStore } 直读。
// headless 无则 undefined。
let _requirementStore: RequirementStore | undefined;
export function getRequirementStore(): RequirementStore | undefined {
	return _requirementStore;
}
export function setRequirementStore(s: RequirementStore | undefined): void {
	_requirementStore = s;
}

export class RequirementStore {
	private reqStore: SqliteStore<RequirementRecord>;
	private historyStore: SqliteStore<any>;
	private messageStore: SqliteStore<any>;

	constructor(sessionDB: SessionDB) {
		const db = sessionDB.getDb();
		this.reqStore = new SqliteStore<RequirementRecord>(db, "requirements", REQUIREMENT_COLUMNS);
		this.historyStore = new SqliteStore<any>(db, "requirement_status_history", STATUS_HISTORY_COLUMNS);
		this.messageStore = new SqliteStore<any>(db, "requirement_messages", MESSAGES_COLUMNS);
	}

	// ─── Basic CRUD ──────────────────────────────────────────────

	list(filter?: { projectId?: string; status?: string; priority?: string }): RequirementRecord[] {
		let result = this.reqStore.list();
		if (filter?.projectId) {
			result = result.filter((r) => r.projectId === filter.projectId);
		}
		if (filter?.status) {
			result = result.filter((r) => r.status === filter.status);
		}
		if (filter?.priority) {
			result = result.filter((r) => r.priority === filter.priority);
		}
		return result;
	}

	get(id: string): RequirementRecord | undefined {
		return this.reqStore.get(id);
	}

	create(input: Omit<RequirementRecord, "id" | "createdAt" | "updatedAt">): RequirementRecord {
		const req = this.reqStore.create(input as any);

		// Auto-create initial status history entry
		this.historyStore.create({
			requirementId: req.id,
			fromStatus: undefined,
			toStatus: req.status,
			triggeredBy: input.source === "user" ? "user" : "agent",
		});

		// Auto-create status_change message
		this.messageStore.create({
			requirementId: req.id,
			sender: input.source === "user" ? "user" : "agent",
			content: `Requirement created with status: ${req.status}`,
			messageType: "status_change",
		});

		return req;
	}

	update(id: string, input: Partial<Omit<RequirementRecord, "id" | "createdAt">>): RequirementRecord {
		return this.reqStore.update(id, input as any);
	}

	/** Delete requirement and cascade to history + messages */
	delete(id: string): void {
		// Delete status history
		const history = this.historyStore.list().filter((h: any) => h.requirementId === id);
		for (const h of history) {
			this.historyStore.delete(h.id);
		}

		// Delete messages
		const messages = this.messageStore.list().filter((m: any) => m.requirementId === id);
		for (const m of messages) {
			this.messageStore.delete(m.id);
		}

		// Delete requirement itself
		this.reqStore.delete(id);
	}

	// ─── Domain queries ──────────────────────────────────────────

	listByProject(projectId: string): RequirementRecord[] {
		return this.reqStore.list().filter((r) => r.projectId === projectId);
	}

	listByStatus(status: RequirementStatus): RequirementRecord[] {
		return this.reqStore.list().filter((r) => r.status === status);
	}

	/** Find requirements that are 'ready' and have no assigned lead */
	findReady(): RequirementRecord[] {
		return this.reqStore.list().filter(
			(r) => r.status === "ready" && !r.assignedLeadSessionId,
		);
	}

	// ─── Status machine ──────────────────────────────────────────

	/**
	 * Transition requirement status with state machine validation.
	 * Updates the requirement status and creates a history entry + message.
	 */
	transitionStatus(
		id: string,
		toStatus: RequirementStatus,
		triggeredBy: string,
		comment?: string,
	): { requirement: RequirementRecord; historyEntry: RequirementStatusHistory } {
		const req = this.reqStore.get(id);
		if (!req) {
			throw new Error(`Requirement not found: ${id}`);
		}

		const validation = isValidTransition(req.status, toStatus, triggeredBy);
		if (!validation.valid) {
			const err = new Error(validation.error);
			(err as any).validTargets = validation.validTargets;
			throw err;
		}

		const now = new Date().toISOString();
		const updatedReq = this.reqStore.update(id, {
			status: toStatus,
			closedAt: (toStatus === "closed" || toStatus === "cancelled") ? now : undefined,
		} as any);

		const historyEntry = this.historyStore.create({
			requirementId: id,
			fromStatus: req.status,
			toStatus,
			triggeredBy: triggeredBy as any,
			comment,
		});

		// Auto-create status_change message
		this.messageStore.create({
			requirementId: id,
			sender: triggeredBy as RequirementMessageSender,
			content: `Status changed: ${req.status} -> ${toStatus}${comment ? ` (${comment})` : ""}`,
			messageType: "status_change",
		});

		return { requirement: updatedReq, historyEntry };
	}

	// ─── Messages ────────────────────────────────────────────────

	addMessage(
		requirementId: string,
		sender: RequirementMessageSender,
		content: string,
		messageType?: RequirementMessageType,
	): RequirementMessage {
		return this.messageStore.create({
			requirementId,
			sender,
			content,
			messageType: messageType ?? "text",
		});
	}

	getMessages(requirementId: string): RequirementMessage[] {
		return this.messageStore.list()
			.filter((m: any) => m.requirementId === requirementId)
			.sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
	}

	// ─── Status history ──────────────────────────────────────────

	getStatusHistory(requirementId: string): RequirementStatusHistory[] {
		return this.historyStore.list()
			.filter((h: any) => h.requirementId === requirementId)
			.sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
	}
}
