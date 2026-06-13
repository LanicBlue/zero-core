// 项目存储
//
// # 文件说明书
//
// ## 核心功能
// Project 数据持久化，基于 SqliteStore 的 CRUD 操作。
//
// ## 输入
// - SessionDB 实例
// - Project 数据
//
// ## 输出
// - ProjectRecord CRUD
//
// ## 定位
// 服务层存储，被 project-router 和 project-handlers 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
//
// ## 维护规则
// - 新增字段时需更新列定义
//
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { ProjectRecord } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "path" },
	{ key: "analystCronId", column: "analyst_cron_id" },
	{ key: "analystSessionId", column: "analyst_session_id" },
	{ key: "lastAnalysisAt", column: "last_analysis_at" },
	{ key: "analysisInterval", column: "analysis_interval" },
	{ key: "status" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// ProjectStore
// ---------------------------------------------------------------------------

export class ProjectStore {
	private store: SqliteStore<ProjectRecord>;

	constructor(sessionDB: SessionDB) {
		this.store = new SqliteStore<ProjectRecord>(sessionDB.getDb(), "projects", COLUMNS);
	}

	list(filter?: { status?: string }): ProjectRecord[] {
		const all = this.store.list();
		if (filter?.status) {
			return all.filter((p) => p.status === filter.status);
		}
		return all;
	}

	get(id: string): ProjectRecord | undefined {
		return this.store.get(id);
	}

	getByPath(path: string): ProjectRecord | undefined {
		return this.store.list().find((p) => p.path === path);
	}

	listActive(): ProjectRecord[] {
		return this.store.list().filter((p) => p.status === "active");
	}

	create(input: Omit<ProjectRecord, "id" | "createdAt" | "updatedAt">): ProjectRecord {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<ProjectRecord, "id" | "createdAt">>): ProjectRecord {
		return this.store.update(id, input as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}
