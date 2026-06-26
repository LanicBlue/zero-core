// 项目级后台 agent 任务存储
//
// # 文件说明书
//
// ## 核心功能
// ProjectJobRecord 持久化,基于 SqliteStore 的 CRUD。一个 project_job = 一次
// on-demand 的项目级长任务(如 wiki 充实)。跨 session/重启可追踪,生命周期:
// running → completed | failed | cancelled。
//
// ## 输入
// - SessionDB 实例
// - ProjectJobRecord 数据
//
// ## 输出
// - ProjectJobRecord CRUD + 状态流转辅助 (markCompleted / markFailed / markCancelled)
//
// ## 定位
// 服务层存储,被 EnrichmentRunner / ManagementService / project IPC handler 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
// - ../shared/types - ProjectJobRecord
//
// ## 维护规则
// - 新增字段时需同步 db-migration.ts 的 PROJECT_JOBS_COLUMNS(否则 fresh DB 缺列)
//

import type { SessionDB } from "./session-db.js";
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { ProjectJobRecord, ProjectJobStatus } from "../shared/types.js";

// MUST stay in sync with db-migration.ts PROJECT_JOBS_COLUMNS.
const PROJECT_JOBS_COLUMNS: ColumnDef[] = [
	{ key: "jobType", column: "job_type" },
	{ key: "projectId", column: "project_id" },
	{ key: "agentId", column: "agent_id" },
	{ key: "sessionId", column: "session_id" },
	{ key: "status" },
	{ key: "startedAt", column: "started_at" },
	{ key: "finishedAt", column: "finished_at" },
	{ key: "error" },
	{ key: "promptSummary", column: "prompt_summary" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

export class ProjectJobStore {
	private store: SqliteStore<ProjectJobRecord>;

	constructor(sessionDB: SessionDB) {
		this.store = new SqliteStore<ProjectJobRecord>(
			sessionDB.getDb(),
			"project_jobs",
			PROJECT_JOBS_COLUMNS,
		);
	}

	list(): ProjectJobRecord[] {
		return this.store.list();
	}

	/** List all jobs for one project, newest-first. */
	listByProject(projectId: string): ProjectJobRecord[] {
		const rows = this.store.findAllByColumns({ projectId });
		rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
		return rows;
	}

	/** Jobs in a given status for one project (e.g. all running jobs → 输入锁). */
	listByProjectAndStatus(projectId: string, status: ProjectJobStatus): ProjectJobRecord[] {
		return this.listByProject(projectId).filter((r) => r.status === status);
	}

	/** Any running job for this project? (drives the chat 输入锁). */
	hasRunningForProject(projectId: string): boolean {
		return this.listByProjectAndStatus(projectId, "running").length > 0;
	}

	/** Any running job for this session? (drives the per-session 输入锁). */
	hasRunningForSession(sessionId: string): boolean {
		return this.list().some((r) => r.sessionId === sessionId && r.status === "running");
	}

	get(id: string): ProjectJobRecord | undefined {
		return this.store.get(id);
	}

	create(input: Omit<ProjectJobRecord, "id" | "createdAt" | "updatedAt">): ProjectJobRecord {
		return this.store.create(input);
	}

	update(id: string, patch: Partial<Omit<ProjectJobRecord, "id" | "createdAt">>): ProjectJobRecord {
		return this.store.update(id, patch);
	}

	/** Mark a job completed (sets finishedAt + status). */
	markCompleted(id: string): ProjectJobRecord {
		return this.store.update(id, { status: "completed", finishedAt: new Date().toISOString() });
	}

	/** Mark a job failed with an error message. */
	markFailed(id: string, error: string): ProjectJobRecord {
		return this.store.update(id, { status: "failed", finishedAt: new Date().toISOString(), error });
	}

	/** Mark a job cancelled (user-initiated abort). */
	markCancelled(id: string): ProjectJobRecord {
		return this.store.update(id, { status: "cancelled", finishedAt: new Date().toISOString() });
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}
