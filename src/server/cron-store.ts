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
import type { CronRecord, CronRunRecord } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions — must stay in sync with db-migration.ts CRON_COLUMNS
// ---------------------------------------------------------------------------

// MUST stay in sync with db-migration.ts CRON_COLUMNS.
//
// v0.8 (P0 §3.4): `schedule` is now JSON (CronSchedule union: once|alarm|
// interval) — stored via json:true. `triggerMode` mirrors schedule.mode for
// cheap WHERE filtering; store keeps it in sync on every write.
const COLUMNS: ColumnDef[] = [
	{ key: "agentId", column: "agent_id" },
	{ key: "workingScope", column: "working_scope", json: true },
	{ key: "schedule", json: true },
	{ key: "triggerMode", column: "trigger_mode" },
	{ key: "lastRunAt", column: "last_run_at" },
	{ key: "lastStatus", column: "last_status" },
	{ key: "lastError", column: "last_error" },
	{ key: "nextRunAt", column: "next_run_at" },
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

	/**
	 * List all enabled cron entries (the cron scheduler's source of truth).
	 *
	 * v0.8 (P0 §3.4): the legacy `schedule !== "off"` check no longer applies
	 * (schedule is structured JSON now). "Off" is encoded as `enabled=false`,
	 * which is the real gate. The schedule shape itself is always valid (the
	 * migration converts any legacy "off" string to enabled=false + an inert
	 * `{mode:"interval",everyMs:0}`).
	 */
	listEnabled(): CronRecord[] {
		return this.store.list().filter((c) => c.enabled);
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
		const normalized = this.withTriggerMode(input);
		return this.store.create(normalized as any);
	}

	update(id: string, input: Partial<Omit<CronRecord, "id" | "createdAt">>): CronRecord {
		const normalized = this.withTriggerMode(input);
		return this.store.update(id, normalized as any);
	}

	/**
	 * v0.8 (P0 §3.4): keep `triggerMode` in sync with `schedule.mode` on every
	 * write. If `input.schedule` is set, derive triggerMode from it; if not,
	 * leave triggerMode untouched (store.update merges, so an omitted field
	 * preserves the existing value).
	 */
	private withTriggerMode<T extends { schedule?: CronRecord["schedule"]; triggerMode?: string }>(
		input: T,
	): T {
		if (input.schedule && typeof input.schedule === "object" && "mode" in input.schedule) {
			return { ...input, triggerMode: input.schedule.mode };
		}
		return input;
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

// ---------------------------------------------------------------------------
// CronRunStore (v0.8 P0 §3.4 / §9.3 — per-fire audit log)
// ---------------------------------------------------------------------------
//
// Persisted by the P4 scheduler after each cron fire. This phase only lands
// the store + table + types; the scheduler write trigger is P4's job (plan-P0
// boundary: "cron 三模式调度器逻辑、cron_runs 写入触发 → P4"). The store is
// wired now so P4 has the surface to write to and so sub2 can write CRUD
// tests against it.

// MUST stay in sync with db-migration.ts CRON_RUNS_COLUMNS.
const CRON_RUNS_COLUMNS: ColumnDef[] = [
	{ key: "cronId", column: "cron_id" },
	{ key: "firedAt", column: "fired_at" },
	{ key: "agentId", column: "agent_id" },
	{ key: "sessionId", column: "session_id" },
	{ key: "success", bool: true },
	{ key: "error" },
	{ key: "durationMs", column: "duration_ms" },
	{ key: "tokens" },
	{ key: "cost" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

export class CronRunStore {
	private store: SqliteStore<CronRunRecord>;

	constructor(sessionDB: SessionDB) {
		this.store = new SqliteStore<CronRunRecord>(
			sessionDB.getDb(),
			"cron_runs",
			CRON_RUNS_COLUMNS,
		);
	}

	list(): CronRunRecord[] {
		return this.store.list();
	}

	/** List all run records for one cron entry, newest-first. */
	listByCron(cronId: string): CronRunRecord[] {
		const rows = this.store.list().filter((r) => r.cronId === cronId);
		rows.sort((a, b) => b.firedAt.localeCompare(a.firedAt));
		return rows;
	}

	get(id: string): CronRunRecord | undefined {
		return this.store.get(id);
	}

	create(input: Omit<CronRunRecord, "id" | "createdAt" | "updatedAt">): CronRunRecord {
		return this.store.create(input as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}

	/** Delete all run records for one cron entry (cron row is being deleted). */
	deleteByCron(cronId: string): void {
		for (const r of this.listByCron(cronId)) {
			this.store.delete(r.id);
		}
	}
}
