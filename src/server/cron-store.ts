// Cron 记录存储 (v0.8 M1)
//
// # 文件说明书
//
// ## 核心功能
// CronRecord 持久化，基于 SqliteStore 的 CRUD 操作。CronRecord 是 v0.8 的
// 一等公民实体：一条 cron = 一个全局 agent + 一个 workingScope + 一个调度。
// 同一个 agent 可以有多条 cron (各带不同 scope)，决策 6/41/42。
//
// ## 输入
// - SessionDB 实例
// - CronRecord 数据
//
// ## 输出
// - CronRecord CRUD
//
// ## 定位
// 服务层存储，被 CronAnalysisManager (调度消费端)、ZeroAdminService、
// cron IPC handler 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
// - ../shared/types - CronRecord
//
// ## 维护规则
// - 新增字段时需同步 db-migration.ts 的 CRON_COLUMNS
// - workingScope 作为 JSON 整列存储 (含 projectId?/workspaceDir/wikiRootNodeId)
// - 删 cron 不级联删它引用的 agent (解绑而非级联)
//

import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { CronRecord } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions — must stay in sync with db-migration.ts CRON_COLUMNS
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "agentId", column: "agent_id" },
	{ key: "workingScope", column: "working_scope", json: true },
	{ key: "schedule" },
	{ key: "prompt" },
	{ key: "enabled", bool: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// CronStore
// ---------------------------------------------------------------------------

export class CronStore {
	private store: SqliteStore<CronRecord>;
	private db: import("better-sqlite3").Database;

	constructor(sessionDB: SessionDB) {
		this.db = sessionDB.getDb();
		this.store = new SqliteStore<CronRecord>(this.db, "crons", COLUMNS);
	}

	list(): CronRecord[] {
		return this.store.list();
	}

	/** List all cron entries for one agent (one agent can carry N cron). */
	listByAgent(agentId: string): CronRecord[] {
		return this.store.list().filter((c) => c.agentId === agentId);
	}

	/** List all enabled cron entries (the cron scheduler's source of truth). */
	listEnabled(): CronRecord[] {
		return this.store.list().filter((c) => c.enabled && c.schedule !== "off");
	}

	get(id: string): CronRecord | undefined {
		return this.store.get(id);
	}

	create(input: Omit<CronRecord, "id" | "createdAt" | "updatedAt">): CronRecord {
		// workingScope must carry the session-context bundle fields.
		const ws = input.workingScope;
		if (!ws || !ws.workspaceDir || !ws.wikiRootNodeId) {
			throw new Error(
				"CronRecord.workingScope requires workspaceDir and wikiRootNodeId",
			);
		}
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<CronRecord, "id" | "createdAt">>): CronRecord {
		return this.store.update(id, input as any);
	}

	/**
	 * Delete a cron entry. This is a *unbind*, NOT a cascade — the global agent
	 * it references stays intact (acceptance-M1: "删 cron 不删它引用的全局 agent").
	 */
	delete(id: string): void {
		this.store.delete(id);
	}

	/**
	 * Delete all cron entries referencing a given agent. Called when a global
	 * agent is deleted to avoid dangling cron references (the inverse direction
	 * — agent deletion cascades its own cron, but cron deletion never touches
	 * the agent).
	 */
	deleteByAgent(agentId: string): void {
		for (const c of this.listByAgent(agentId)) {
			this.store.delete(c.id);
		}
	}
}
