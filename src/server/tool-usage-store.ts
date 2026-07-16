// Tool 配置与调用日志存储 (v0.8 P0 §7.7 #4)
//
// # 文件说明书
//
// ## 核心功能
// 两个面向 tool-call 遥测的 store:
// - ToolConfigStore:per-tool 默认参数配置(PK = tool_name)。
// - ToolUsageStore:per-call 调用日志(id PK,每次 tool 调用一行)。
//
// ## 输入
// - CoreDatabase 实例
// - ToolConfigRecord / CreateToolUsageInput
//
// ## 输出
// - ToolConfigRecord / ToolUsageRecord CRUD
//
// ## 定位
// 服务层存储,被 telemetry 消费端 (P5) / tool 执行钩子使用。
// P0 阶段只落地 store + 表 + 类型 (RFC §7.7 #4 / acceptance-P0 「新表 store 测试」)。
//
// ## 依赖
// - better-sqlite3 - SQLite 驱动
// - ./session-db - CoreDatabase (getDb())
// - ../shared/types - ToolConfigRecord / ToolUsageRecord / CreateToolUsageInput
//
// ## 维护规则
// - 表 schema 由 db-migration.ts 创建 (tool_configs / tool_usage),本文件不动 DDL。
// - tool_configs 的 PK 是 tool_name (无 id),不能用 SqliteStore 基类 (它会强制注入
//   id/createdAt/updatedAt 列),所以手写 prepared statements。
// - tool_usage 的 PK 是 id (uuid,由本 store mint),但表里没有 created_at/updated_at
//   列 (与 cron_runs 不同 — RFC §7.7 #4 显式省略,canonical 时间是 called_at)。
//   为避免 SqliteStore 自愈 ALTER 加列 (会动表结构),同样手写 prepared statements。
// - 列清单与 db-migration.ts 的 TOOL_CONFIGS_COLUMNS / TOOL_USAGE_COLUMNS 对齐。

import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type { CoreDatabase } from "./core-database.js";
import type {
	ToolConfigRecord,
	ToolUsageRecord,
	CreateToolUsageInput,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// ToolConfigStore (v0.8 P0 §7.7 #4 — per-tool default-param config)
// ---------------------------------------------------------------------------
//
// tool_configs 表 PK = tool_name (没有 id),与 SqliteStore 的"id PK + 自愈
// created_at/updated_at"假设冲突,所以直接用 prepared statements。

export class ToolConfigStore {
	private db: Database.Database;
	private _getStmt: Database.Statement;
	private _upsertStmt: Database.Statement;
	private _listStmt: Database.Statement;
	private _deleteStmt: Database.Statement;

	constructor(sessionDB: CoreDatabase) {
		this.db = sessionDB.getDb();
		this._getStmt = this.db.prepare(
			"SELECT tool_name AS toolName, config, updated_at AS updatedAt FROM tool_configs WHERE tool_name = ?",
		);
		this._upsertStmt = this.db.prepare(
			`INSERT INTO tool_configs (tool_name, config, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(tool_name) DO UPDATE SET
			   config = excluded.config,
			   updated_at = excluded.updated_at`,
		);
		this._listStmt = this.db.prepare(
			"SELECT tool_name AS toolName, config, updated_at AS updatedAt FROM tool_configs ORDER BY tool_name",
		);
		this._deleteStmt = this.db.prepare(
			"DELETE FROM tool_configs WHERE tool_name = ?",
		);
	}

	/** Read one tool's config blob, or undefined if not set. */
	get(toolName: string): ToolConfigRecord | undefined {
		const row = this._getStmt.get(toolName) as
			| { toolName: string; config: string | null; updatedAt: string | null }
			| undefined;
		if (!row) return undefined;
		return {
			toolName: row.toolName,
			config: parseJson(row.config),
			updatedAt: row.updatedAt ?? new Date().toISOString(),
		};
	}

	/** Insert-or-update one tool's config blob. */
	upsert(toolName: string, config: unknown): ToolConfigRecord {
		const now = new Date().toISOString();
		const json = config === undefined ? null : JSON.stringify(config);
		this._upsertStmt.run(toolName, json, now);
		// Read back so the caller gets the canonical record (matches SqliteStore
		// semantics where writes return the persisted row).
		return this.get(toolName)!;
	}

	/** List all tool configs, alphabetical by tool_name. */
	list(): ToolConfigRecord[] {
		const rows = this._listStmt.all() as Array<{
			toolName: string;
			config: string | null;
			updatedAt: string | null;
		}>;
		return rows.map((r) => ({
			toolName: r.toolName,
			config: parseJson(r.config),
			updatedAt: r.updatedAt ?? new Date().toISOString(),
		}));
	}

	/** Remove one tool's config (rare — used by reset / uninstall paths). */
	delete(toolName: string): void {
		this._deleteStmt.run(toolName);
	}
}

// ---------------------------------------------------------------------------
// ToolUsageStore (v0.8 P0 §7.7 #4 — per-call log)
// ---------------------------------------------------------------------------
//
// tool_usage 表 PK = id (uuid,本 store mint)。表里没有 created_at/updated_at
// (canonical 时间是 called_at),所以同样手写 prepared statements,不用 SqliteStore
// (避免它自愈 ALTER 加列,动了 P0 已定的表结构)。

// tool-decoupling(决策 1):process-wide 单例 getter/setter。启动时注册;
// tool-factory 的 recordToolUsage 当前从 ctx.toolUsageStore 读(sub-2+ 改读
// 此单例)。headless 无则 undefined → 日志 no-op(已有降级)。
let _toolUsageStore: ToolUsageStore | undefined;
export function getToolUsageStore(): ToolUsageStore | undefined {
	return _toolUsageStore;
}
export function setToolUsageStore(s: ToolUsageStore | undefined): void {
	_toolUsageStore = s;
}

export class ToolUsageStore {
	private db: Database.Database;
	private _insertStmt: Database.Statement;
	private _getStmt: Database.Statement;
	private _listByToolStmt: Database.Statement;
	private _listBySessionStmt: Database.Statement;
	private _listAllStmt: Database.Statement;
	private _deleteStmt: Database.Statement;

	constructor(sessionDB: CoreDatabase) {
		this.db = sessionDB.getDb();
		this._insertStmt = this.db.prepare(
			`INSERT INTO tool_usage
			   (id, tool_name, agent_id, session_id, called_at, params, success, duration_ms)
			 VALUES (@id, @toolName, @agentId, @sessionId, @calledAt, @params, @success, @durationMs)`,
		);
		this._getStmt = this.db.prepare(
			`SELECT id, tool_name AS toolName, agent_id AS agentId, session_id AS sessionId,
			        called_at AS calledAt, params, success, duration_ms AS durationMs
			 FROM tool_usage WHERE id = ?`,
		);
		this._listByToolStmt = this.db.prepare(
			`SELECT id, tool_name AS toolName, agent_id AS agentId, session_id AS sessionId,
			        called_at AS calledAt, params, success, duration_ms AS durationMs
			 FROM tool_usage WHERE tool_name = ?
			 ORDER BY called_at DESC`,
		);
		this._listBySessionStmt = this.db.prepare(
			`SELECT id, tool_name AS toolName, agent_id AS agentId, session_id AS sessionId,
			        called_at AS calledAt, params, success, duration_ms AS durationMs
			 FROM tool_usage WHERE session_id = ?
			 ORDER BY called_at DESC`,
		);
		this._listAllStmt = this.db.prepare(
			`SELECT id, tool_name AS toolName, agent_id AS agentId, session_id AS sessionId,
			        called_at AS calledAt, params, success, duration_ms AS durationMs
			 FROM tool_usage
			 ORDER BY called_at DESC`,
		);
		this._deleteStmt = this.db.prepare("DELETE FROM tool_usage WHERE id = ?");
	}

	/** Record one tool call. Returns the persisted record. */
	record(input: CreateToolUsageInput): ToolUsageRecord {
		const id = uuidv4();
		this._insertStmt.run({
			id,
			toolName: input.toolName,
			agentId: input.agentId ?? null,
			sessionId: input.sessionId ?? null,
			calledAt: input.calledAt,
			params: input.params === undefined ? null : JSON.stringify(input.params),
			success: input.success ? 1 : 0,
			durationMs: input.durationMs ?? null,
		});
		return this.get(id)!;
	}

	/** Read one call record by id. */
	get(id: string): ToolUsageRecord | undefined {
		const row = this._getStmt.get(id) as UsageRow | undefined;
		return row ? rowToRecord(row) : undefined;
	}

	/** List all calls for one tool, newest-first. */
	listByTool(toolName: string): ToolUsageRecord[] {
		return (this._listByToolStmt.all(toolName) as UsageRow[]).map(rowToRecord);
	}

	/** List all calls for one session, newest-first. */
	listBySession(sessionId: string): ToolUsageRecord[] {
		return (this._listBySessionStmt.all(sessionId) as UsageRow[]).map(rowToRecord);
	}

	/** List all call records, newest-first. */
	list(): ToolUsageRecord[] {
		return (this._listAllStmt.all() as UsageRow[]).map(rowToRecord);
	}

	/** Delete one call record. */
	delete(id: string): void {
		this._deleteStmt.run(id);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface UsageRow {
	id: string;
	toolName: string;
	agentId: string | null;
	sessionId: string | null;
	calledAt: string;
	params: string | null;
	success: number;
	durationMs: number | null;
}

function rowToRecord(row: UsageRow): ToolUsageRecord {
	return {
		id: row.id,
		toolName: row.toolName,
		agentId: row.agentId ?? undefined,
		sessionId: row.sessionId ?? undefined,
		calledAt: row.calledAt,
		params: parseJson(row.params),
		success: row.success === 1,
		durationMs: row.durationMs ?? undefined,
	};
}

/** Parse a TEXT column back to its JS value; null/empty → undefined. */
function parseJson(raw: string | null): unknown {
	if (raw == null || raw === "") return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
