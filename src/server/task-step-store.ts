// 任务步骤存储管理
//
// # 文件说明书
//
// ## 核心功能
// TaskStep 数据持久化，基于 SqliteStore 的 CRUD 操作。
//
// ## 输入
// - CoreDatabase 实例
// - TaskStep 数据
//
// ## 输出
// - TaskStepRecord CRUD
//
// ## 定位
// 服务层存储，被 requirement-router 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
//
// ## 维护规则
// - 新增字段时需更新列定义
//
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { CoreDatabase } from "./core-database.js";
import type { TaskStepRecord } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "requirementId", column: "requirement_id" },
	{ key: "stepOrder", column: "step_order" },
	{ key: "role" },
	{ key: "title" },
	{ key: "description" },
	{ key: "agentConfig", column: "agent_config" },
	{ key: "status" },
	{ key: "input" },
	{ key: "output" },
	{ key: "reviewResult", column: "review_result" },
	{ key: "reviewComment", column: "review_comment" },
	{ key: "retryCount", column: "retry_count" },
	{ key: "maxRetries", column: "max_retries" },
	{ key: "sessionId", column: "session_id" },
	{ key: "startedAt", column: "started_at" },
	{ key: "completedAt", column: "completed_at" },
	{ key: "error" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// TaskStepStore
// ---------------------------------------------------------------------------

export class TaskStepStore {
	private store: SqliteStore<TaskStepRecord>;

	constructor(sessionDB: CoreDatabase) {
		this.store = new SqliteStore<TaskStepRecord>(sessionDB.getDb(), "task_steps", COLUMNS);
	}

	list(filter?: { requirementId?: string; status?: string }): TaskStepRecord[] {
		let result = this.store.list();
		if (filter?.requirementId) {
			result = result.filter((s) => s.requirementId === filter.requirementId);
		}
		if (filter?.status) {
			result = result.filter((s) => s.status === filter.status);
		}
		return result;
	}

	get(id: string): TaskStepRecord | undefined {
		return this.store.get(id);
	}

	create(input: Omit<TaskStepRecord, "id" | "createdAt" | "updatedAt">): TaskStepRecord {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<TaskStepRecord, "id" | "createdAt">>): TaskStepRecord {
		return this.store.update(id, input as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}

	/** List steps for a requirement, ordered by step_order ASC */
	listByRequirement(requirementId: string): TaskStepRecord[] {
		return this.store.list()
			.filter((s) => s.requirementId === requirementId)
			.sort((a, b) => a.stepOrder - b.stepOrder);
	}

	/** Get the currently running step for a requirement */
	getCurrentStep(requirementId: string): TaskStepRecord | undefined {
		return this.store.list().find(
			(s) => s.requirementId === requirementId && s.status === "running",
		);
	}

	/** Get count of completed steps for a requirement */
	getCompletedCount(requirementId: string): number {
		return this.store.list().filter(
			(s) => s.requirementId === requirementId && s.status === "completed",
		).length;
	}

	/** Delete all steps for a requirement */
	deleteByRequirement(requirementId: string): void {
		const steps = this.store.list().filter((s) => s.requirementId === requirementId);
		for (const step of steps) {
			this.store.delete(step.id);
		}
	}
}
