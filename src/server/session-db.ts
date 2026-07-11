// 会话数据库
//
// # 文件说明书
//
// ## 核心功能
// 会话数据库管理，提供会话 CRUD、消息存储和 KV 存储。
//
// ## 输入
// - 数据库路径
// - SessionRecord 数据
//
// ## 输出
// - SessionDB 实例
// - KeyValueStore
//
// ## 定位
// 服务层数据库，被 agent-service 使用。
//
// ## 依赖
// - better-sqlite3 - SQLite 驱动
// - uuid - ID 生成
//
// ## 维护规则
// - 新增表或列时需同步更新 db-migration.ts
// - 保持向后兼容
//
import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { log } from "../core/logger.js";
import type { AttachmentMeta, DelegatedTaskRecord, DelegatedTaskStatus, SessionRecord, ToolExecutionRecord, ToolExecutionFilter, ToolExecutionStats } from "../shared/types.js";
// platform-observability ②.1 (sub-1): type-only import — no runtime cycle with
// the runtime layer (session-db is server, but types are erased at runtime).
import type { TurnSource } from "../runtime/types.js";
import { KeyValueStore } from "./key-value-store.js";
// v0.8 (M5): extractor cursor + tool telemetry stores. These back
// extractor A's incremental cursor (mechanism 2) and extractor B's
// independent telemetry writes (decision 49). Tables are created in
// their own constructors (idempotent IF NOT EXISTS), so they don't
// need entries in db-migration.ts's *_COLUMNS arrays.
import { ExtractionCursorStore } from "./extraction-cursor-store.js";
import { TelemetryStore } from "./telemetry-store.js";
import { ZERO_CORE_DIR } from "../core/config.js";
// N1 (runtime-push-ui-sync): structural session primitives (create/delete/
// archive) feed the unified data-change-hub so the sidebar list updates in
// real time. data-change-hub is a pure module (no DB / no session-db import),
// so this import does not create a cycle. High-frequency UPDATEs (updated_at,
// token counters, context bundle, setMain) deliberately do NOT emit — they
// would flood the channel; the sidebar only needs to learn about structural
// membership changes.
import { emitDataChange } from "./data-change-hub.js";

// ---------------------------------------------------------------------------
// SessionDB — SQLite-backed session & message persistence
// ---------------------------------------------------------------------------

/**
 * steps-overhaul sub-3: one summary block persisted in the `messages` table.
 * The table holds ≤3 of these FIFO (design.md: cap 3, oldest evicted). Each is
 * the product of one compression pass (future Extractor A, sub-4) and carries
 * the structured 5-section form (purpose/plan/status/artifacts/lessons) plus an
 * anchor back to the step range it summarized (for on-demand recall).
 *
 * sub-3 itself has no writer — the table starts empty; this type fixes the
 * contract ahead of the writer landing.
 */
export interface MessageSummary {
	/** Human-readable headline (e.g. "Compression of steps 12..27"). */
	title: string;
	/** Structured body — the 5 sections from design.md (purpose/plan/status/...). */
	sections: {
		purpose?: string;
		plan?: string;
		status?: string;
		artifacts?: string;
		lessons?: string;
		[k: string]: string | undefined;
	};
	/** Anchor: the step seq range this summary covers (for on-demand recall). */
	stepRange?: { from: number; to: number };
	/** ISO timestamp of the compression that produced this summary. */
	createdAt: string;
}

// tool-decoupling(决策 1):process-wide 单例 getter/setter。启动时注册;
// 工具 import { getSessionDB } 直读(db / messages / KV)。headless 无则 undefined。
let _sessionDB: SessionDB | undefined;
export function getSessionDB(): SessionDB | undefined {
	return _sessionDB;
}
export function setSessionDB(s: SessionDB | undefined): void {
	_sessionDB = s;
}

export class SessionDB {
	private db: Database.Database;
	private kvStore: KeyValueStore;
	// v0.8 (M5): extractor cursor + telemetry stores (lazy-init below).
	private extractionCursorStore: ExtractionCursorStore | null = null;
	private telemetryStore: TelemetryStore | null = null;

	constructor(dbPath?: string) {
		const dir = join(dbPath ?? ZERO_CORE_DIR, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const path = dbPath ?? join(ZERO_CORE_DIR, "sessions.db");
		this.db = new Database(path);

		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");

		this.kvStore = new KeyValueStore(this.db);

		this.initSchema();
		this.migrateMessageFiles();
	}

	/** Expose the underlying db for SqliteStore instances. */
	getDb(): Database.Database {
		return this.db;
	}

	getKVStore(): KeyValueStore {
		return this.kvStore;
	}

	// v0.8 (M5): extractor stores — lazy so existing code paths that never
	// touch M5 (e.g. compression engine unit tests) don't pay the init cost.
	getExtractionCursorStore(): ExtractionCursorStore {
		if (!this.extractionCursorStore) {
			this.extractionCursorStore = new ExtractionCursorStore(this.db);
		}
		return this.extractionCursorStore;
	}

	getTelemetryStore(): TelemetryStore {
		if (!this.telemetryStore) {
			this.telemetryStore = new TelemetryStore(this.db);
		}
		return this.telemetryStore;
	}

	// -----------------------------------------------------------------------
	// Schema — sessions/messages/steps (owned by SessionDB itself).
	//
	// steps-overhaul sub-1: the physical `turns` table was renamed to `steps`
	// (it always held step rows; the old name was a misnomer). The per-(session,
	// turn) `turn_state` table was DROPPED — its columns folded into `sessions`
	// as a 1:1 "current run state" (phase/last_completed_step_seq/source/error/
	// turn_count/step_count/token_usage). The legacy `checkpoint` JSON column
	// was deleted (zero consumers; the step-level marker is
	// last_completed_step_seq). `updateTurnPhase` (zero callers) + `cleanOldTurn-
	// State` (its GC job is absorbed by recovery scanning sessions.phase) were
	// removed. DROP statements for upgraded DBs run below (guarded); fresh DBs
	// never create the legacy tables.
	// -----------------------------------------------------------------------

	private initSchema(): void {
		// steps-overhaul sub-1: drop legacy `turns` + `turn_state` on upgraded
		// DBs (CREATE TABLE IF NOT EXISTS below will not alter an existing
		// table, and the renamed `steps` must not collide with the old `turns`).
		// Data is NOT migrated (DROP+rebuild per design.md). Guarded so fresh DBs
		// (which never had them) are unaffected. SQLite supports DROP TABLE
		// IF EXISTS since 3.7.
		this.db.exec(`DROP TABLE IF EXISTS turn_state`);
		this.db.exec(`DROP TABLE IF EXISTS turns`);

		// steps-overhaul sub-3: the `messages` table's semantic was redefined
		// from "LLM view content dumped to disk" to "summary blocks + a
		// compression cursor (last_compressed_step_seq) — NO step content".
		// The old schema (session_id/seq/role/content/msg_json) is incompatible
		// with the new one (session_id/seq/summary_json/last_compressed_step_seq),
		// so we DROP+rebuild it on every startup. CREATE TABLE IF NOT EXISTS
		// would NOT alter an existing pre-sub-3 table, so the explicit DROP is
		// load-bearing. Data is NOT migrated — confirmed with the user (the old
		// LLM-view cache is redundant once steps is the source of truth; nothing
		// references it after sub-3). Guarded so the very first run on a fresh DB
		// (which never had the old schema) is a no-op drop.
		this.db.exec(`DROP TABLE IF EXISTS messages`);

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id         TEXT PRIMARY KEY,
				agent_id   TEXT NOT NULL,
				is_main    INTEGER NOT NULL DEFAULT 0,
				title      TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);

			-- steps-overhaul sub-3: messages is redefined to "summary blocks +
			-- compression cursor". It does NOT store step content (steps is the
			-- source of truth; messages is an assemble pointer + ≤3 FIFO summary
			-- blocks for LLM view continuity). One row per summary slot, capped at
			-- MAX_MESSAGE_SUMMARIES (=3, FIFO). last_compressed_step_seq is the
			-- compression/assembly cursor — redundant across a session's ≤3 rows
			-- (kept in sync by every writer) so reads are a single SELECT. NULL
			-- means "no compression yet / cursor unset". See design.md「两张表」.
			CREATE TABLE IF NOT EXISTS messages (
				id                        INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id                TEXT NOT NULL,
				seq                       INTEGER NOT NULL,
				summary_json              TEXT NOT NULL,
				last_compressed_step_seq  INTEGER,
				created_at                TEXT NOT NULL,
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

			-- steps-overhaul sub-1: physical turns table renamed to steps.
			-- A row = one assistant step (or the user-row opening a turn_group).
			CREATE TABLE IF NOT EXISTS steps (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id  TEXT NOT NULL,
				seq         INTEGER NOT NULL,
				role        TEXT NOT NULL,
				content     TEXT,
				compressed  INTEGER NOT NULL DEFAULT 0,
				created_at  TEXT NOT NULL,
				turn_group  INTEGER NOT NULL DEFAULT -1,
				input_tokens  INTEGER DEFAULT 0,
				output_tokens INTEGER DEFAULT 0,
				total_tokens  INTEGER DEFAULT 0,
				-- multimodal-input sub-2: AttachmentMeta[] JSON (design principle
				-- A — only meta, never bytes). NULL on legacy/no-attachment rows.
				attachments TEXT,
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_steps_session_seq ON steps(session_id, seq);

			CREATE TABLE IF NOT EXISTS tool_executions (
				id             INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id     TEXT NOT NULL,
				agent_id       TEXT NOT NULL,
				tool_name      TEXT NOT NULL,
				success        INTEGER NOT NULL DEFAULT 1,
				error_message  TEXT,
				input_preview  TEXT,
				output_preview TEXT,
				duration_ms    INTEGER NOT NULL DEFAULT 0,
				turn_seq       INTEGER,
				created_at     TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_tool_exec_session ON tool_executions(session_id);
			CREATE INDEX IF NOT EXISTS idx_tool_exec_agent_tool ON tool_executions(agent_id, tool_name);
			CREATE INDEX IF NOT EXISTS idx_tool_exec_created ON tool_executions(created_at);

			CREATE TABLE IF NOT EXISTS delegated_tasks (
				id                  TEXT PRIMARY KEY,
				parent_task_id      TEXT,
				root_task_id        TEXT NOT NULL,
				owner_agent_id      TEXT NOT NULL,
				target_agent_id     TEXT NOT NULL,
				model_id            TEXT,
				parent_session_id   TEXT,
				session_id          TEXT,
				task                TEXT NOT NULL,
				status              TEXT NOT NULL,
				depth               INTEGER NOT NULL DEFAULT 0,
				step                INTEGER NOT NULL DEFAULT 0,
				turns               INTEGER NOT NULL DEFAULT 0,
				tokens              INTEGER NOT NULL DEFAULT 0,
				current_tool        TEXT,
				result              TEXT,
				error               TEXT,
				control_message     TEXT,
				finish_requested_at TEXT,
				parent_tool_call_id TEXT,
				created_at          TEXT NOT NULL,
				updated_at          TEXT NOT NULL,
				completed_at        TEXT,
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
			);
			CREATE INDEX IF NOT EXISTS idx_delegated_tasks_owner ON delegated_tasks(owner_agent_id, status);
			CREATE INDEX IF NOT EXISTS idx_delegated_tasks_parent ON delegated_tasks(parent_task_id);
			CREATE INDEX IF NOT EXISTS idx_delegated_tasks_root ON delegated_tasks(root_task_id);

			-- platform-observability ②.2 (sub-2): provider-layer usage rollup,
			-- INDEPENDENT of session metrics. One row per
			-- (provider, model, hour_bucket, source); upsert accumulates.
			-- Feeds sub-5 observation + sub-6 charts. PK is the 4-tuple key so
			-- mid-session provider switches produce separate rows (correct
			-- attribution — the whole point). hour_bucket is hour-floor ISO UTC
			-- (e.g. "2026-07-07T09:00:00.000Z"). source ∈ user|work|cron|background
			-- (sub-1 turn-source marker). Retention ≥ 30d via cleanOldProviderUsage.
			CREATE TABLE IF NOT EXISTS provider_usage (
				provider      TEXT NOT NULL,
				model         TEXT NOT NULL,
				hour_bucket   TEXT NOT NULL,
				source        TEXT NOT NULL DEFAULT 'background',
				calls         INTEGER NOT NULL DEFAULT 0,
				input_tokens  INTEGER NOT NULL DEFAULT 0,
				output_tokens INTEGER NOT NULL DEFAULT 0,
				cache_read    INTEGER NOT NULL DEFAULT 0,
				cache_write   INTEGER NOT NULL DEFAULT 0,
				errors        INTEGER NOT NULL DEFAULT 0,
				created_at    TEXT NOT NULL,
				updated_at    TEXT NOT NULL,
				PRIMARY KEY (provider, model, hour_bucket, source)
			);
			CREATE INDEX IF NOT EXISTS idx_provider_usage_hour ON provider_usage(hour_bucket);
			CREATE INDEX IF NOT EXISTS idx_provider_usage_provider ON provider_usage(provider, hour_bucket);
		`);

		// v0.8 (M0): session context bundle columns + routing index.
		// JSON-stored context + extracted context_project_id column for the
		// (agentId, projectId) find-or-create routing key (RFC §2.11).
		this.safeAddColumn("sessions", "context", "TEXT");
		this.safeAddColumn("sessions", "context_project_id", "TEXT");
		this.safeAddColumn("sessions", "context_workspace_dir", "TEXT");
		this.safeAddColumn("sessions", "context_wiki_root_node_id", "TEXT");
		// v0.8: archived flag — archived sessions are excluded from active
		// routing/listing/main lookup but kept in DB for the archive area.
		this.safeAddColumn("sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
		// Delegated-task session attribution + visibility. session_kind='delegated'
		// rows back sub-agent tasks and are excluded from all chat list queries.
		this.safeAddColumn("sessions", "session_kind", "TEXT NOT NULL DEFAULT 'chat'");
		this.safeAddColumn("sessions", "parent_session_id", "TEXT");
		this.safeAddColumn("sessions", "parent_task_id", "TEXT");
		this.safeAddColumn("sessions", "visibility", "TEXT NOT NULL DEFAULT 'normal'");
		// Routing index — must come AFTER context_project_id exists.
		this.safeAddIndex("sessions", "idx_sessions_agent_project", "agent_id, context_project_id");
		this.safeAddIndex("sessions", "idx_sessions_kind", "session_kind, visibility");

		// steps-overhaul sub-1: sessions absorbs turn_state (1:1 current run
		// state). 7 new columns. phase defaults to 'completed' so existing
		// (pre-fold) sessions rows are NOT flagged as recovery candidates
		// (recovery scans phase NOT IN ('completed','failed')). turn_count/
		// step_count default 0; appendStep(role='user') bumps turn_count.
		// token_usage is JSON (last API usage). See design.md "sessions 收状态".
		// Also added (typed) in db-migration.ts runMigrations
		// (memory feedback-fresh-db-migrations — fresh DB must not miss cols).
		this.safeAddColumn("sessions", "phase", "TEXT NOT NULL DEFAULT 'completed'");
		this.safeAddColumn("sessions", "last_completed_step_seq", "INTEGER");
		this.safeAddColumn("sessions", "source", "TEXT NOT NULL DEFAULT 'background'");
		this.safeAddColumn("sessions", "error", "TEXT");
		this.safeAddColumn("sessions", "turn_count", "INTEGER NOT NULL DEFAULT 0");
		this.safeAddColumn("sessions", "step_count", "INTEGER NOT NULL DEFAULT 0");
		this.safeAddColumn("sessions", "token_usage", "TEXT");
		// Index the recovery scan hot path: WHERE phase NOT IN (...).
		this.safeAddIndex("sessions", "idx_sessions_phase", "phase");

		// Migrate renamed tools (Bash -> Shell, etc.)
		this.migrateToolNames();

		// multimodal-input sub-2: per-step attachment metadata. The steps table
		// stores an `AttachmentMeta[]` JSON blob here; `content` stays a plain
		// string (design principle A — bytes never enter the steps table, only
		// the lightweight meta does). steps is SessionDB-owned (no *_COLUMNS
		// array), so this single safeAddColumn is the only migration sync point
		// — fresh DBs get the column from CREATE TABLE above; upgraded DBs get
		// it here. NULL on legacy rows (read back as undefined — back-compat).
		this.safeAddColumn("steps", "attachments", "TEXT");
	}

	/** Idempotently add a column to an existing table (no-op if present). */
	private safeAddColumn(table: string, column: string, def: string): void {
		try {
			const cols = (this.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(r => r.name);
			if (!cols.includes(column)) {
				this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
			}
		} catch { /* column already exists */ }
	}

	/** Idempotently create an index on an existing table (no-op if present). */
	private safeAddIndex(table: string, indexName: string, columns: string): void {
		try {
			const indexes = (this.db.pragma(`index_list(${table})`) as Array<{ name: string }>).map(r => r.name);
			if (!indexes.includes(indexName)) {
				this.db.exec(`CREATE INDEX ${indexName} ON ${table}(${columns})`);
			}
		} catch { /* index already exists */ }
	}

	private migrateToolNames(): void {
		const renames: Record<string, string> = {
			Bash: "Shell",
		};
		for (const [oldName, newName] of Object.entries(renames)) {
			const result = this.db.prepare(
				"UPDATE tool_executions SET tool_name = ? WHERE tool_name = ?"
			).run(newName, oldName);
			if (result.changes > 0) {
				log.db("migrateToolNames: " + result.changes + " rows " + oldName + " -> " + newName);
			}
		}
	}

	// Session CRUD
	// -----------------------------------------------------------------------

	createSession(
		agentId: string,
		title?: string,
		context?: SessionRecord["context"],
		options?: { sessionKind?: "chat" | "delegated"; parentSessionId?: string; parentTaskId?: string; visibility?: "normal" | "hidden" | "debug" },
	): SessionRecord {
		const now = new Date().toISOString();
		const id = uuidv4();
		const ctxJson = context ? JSON.stringify(context) : null;
		const sessionKind = options?.sessionKind ?? "chat";
		const visibility = options?.visibility ?? (sessionKind === "delegated" ? "hidden" : "normal");
		this.db.prepare(
			"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at, context, context_project_id, context_workspace_dir, context_wiki_root_node_id, session_kind, parent_session_id, parent_task_id, visibility) " +
			"VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			id, agentId, title ?? null, now, now, ctxJson,
			context?.projectId ?? null,
			context?.workspaceDir ?? null,
			context?.wikiRootNodeId ?? null,
			sessionKind,
			options?.parentSessionId ?? null,
			options?.parentTaskId ?? null,
			visibility,
		);
		const rec: SessionRecord = {
			id, agentId, isMain: false, title: title ?? null,
			sessionKind, parentSessionId: options?.parentSessionId,
			parentTaskId: options?.parentTaskId, visibility,
			createdAt: now, updatedAt: now, context,
		};
		// N1: structural primitive — emit so the sidebar list updates. The
		// record is carried so the renderer patches without a refetch.
		emitDataChange("sessions", id, "create", rec);
		return rec;
	}

	getSession(sessionId: string): SessionRecord | undefined {
		const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
		return row ? this.rowToRecord(row) : undefined;
	}

	getMainSession(agentId: string): SessionRecord | undefined {
		const row = this.db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND is_main = 1 AND archived = 0 AND session_kind = 'chat'").get(agentId) as any;
		return row ? this.rowToRecord(row) : undefined;
	}

	/**
	 * The most-recently-active session for an agent, by `updated_at`. Every
	 * turn/message/tool write refreshes `updated_at`, so this is the session the
	 * user last chatted in — what should open when they pick the agent again.
	 * Diverges from `getMainSession` (a sticky `is_main=1` flag only changed on
	 * new/switch/clear): chatting in a non-main session bumps its `updated_at`
	 * but leaves `is_main` pointing elsewhere, so re-opening the agent via the
	 * main flag shows a stale session. Excludes the `__recovered__` bookkeeping
	 * pseudo-agent. Returns undefined if the agent has no sessions yet.
	 */
	getMostRecentSession(agentId: string): SessionRecord | undefined {
		const row = this.db.prepare(
			"SELECT * FROM sessions WHERE agent_id = ? AND agent_id != '__recovered__' AND archived = 0 AND session_kind = 'chat' " +
			"ORDER BY updated_at DESC LIMIT 1",
		).get(agentId) as any;
		return row ? this.rowToRecord(row) : undefined;
	}

	setMainSession(agentId: string, sessionId: string): void {
		const tx = this.db.transaction(() => {
			this.db.prepare("UPDATE sessions SET is_main = 0 WHERE agent_id = ?").run(agentId);
			this.db.prepare("UPDATE sessions SET is_main = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
		});
		tx();
	}

	listSessions(agentId: string): SessionRecord[] {
		const rows = this.db.prepare(
			"SELECT * FROM sessions WHERE agent_id = ? AND archived = 0 AND session_kind = 'chat' ORDER BY updated_at DESC",
		).all(agentId) as any[];
		return rows.map((r) => this.rowToRecord(r));
	}

	listAllSessions(): SessionRecord[] {
		const rows = this.db.prepare(
			"SELECT * FROM sessions WHERE agent_id != '__recovered__' AND archived = 0 AND session_kind = 'chat' ORDER BY updated_at DESC",
		).all() as any[];
		return rows.map((r) => this.rowToRecord(r));
	}

	/**
	 * v0.8 (M0): find-or-create routing key for `{role(agentId), projectId} → session`.
	 * Used by discuss / notification / cron to land on a stable session per
	 * (role, project). Returns existing session if found, otherwise undefined
	 * (caller creates via createSession with the bundle).
	 *
	 * Lookup = (agentId, context.projectId). Sessions without a projectId in
	 * their context bundle do not match this query (they are global sessions).
	 */
	findSessionByAgentAndProject(agentId: string, projectId: string): SessionRecord | undefined {
		const row = this.db.prepare(
			"SELECT * FROM sessions WHERE agent_id = ? AND context_project_id = ? AND archived = 0 " +
			"ORDER BY updated_at DESC LIMIT 1",
		).get(agentId, projectId) as any;
		return row ? this.rowToRecord(row) : undefined;
	}

	/** Update a session's context bundle. */
	updateSessionContext(sessionId: string, context: SessionRecord["context"]): void {
		const now = new Date().toISOString();
		this.db.prepare(
			"UPDATE sessions SET context = ?, context_project_id = ?, context_workspace_dir = ?, " +
			"context_wiki_root_node_id = ?, updated_at = ? WHERE id = ?",
		).run(
			context ? JSON.stringify(context) : null,
			context?.projectId ?? null,
			context?.workspaceDir ?? null,
			context?.wikiRootNodeId ?? null,
			now, sessionId,
		);
	}

	/** Get a session's context bundle (D-B). */
	getSessionContext(sessionId: string): SessionRecord["context"] | undefined {
		const row = this.db.prepare(
			"SELECT context FROM sessions WHERE id = ?",
		).get(sessionId) as { context: string | null } | undefined;
		if (!row || !row.context) return undefined;
		try {
			return JSON.parse(row.context) as SessionRecord["context"];
		} catch {
			return undefined;
		}
	}
	deleteSession(sessionId: string): void {
		this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
		// N1: structural primitive — emit delete (no record).
		emitDataChange("sessions", sessionId, "delete");
	}

	/**
	 * Mark a session as archived (soft delete). Archived sessions are excluded
	 * from active routing/listing/main lookup (the WHERE archived = 0 filters
	 * above) but the row is kept in DB. The caller is responsible for creating
	 * a replacement session with the same (agentId, projectId) context.
	 */
	archiveSession(sessionId: string): void {
		this.db.prepare("UPDATE sessions SET archived = 1, updated_at = ? WHERE id = ?")
			.run(new Date().toISOString(), sessionId);
		// N1: structural primitive — emit update with archived=true so the
		// sidebar removes it from the active list. We synthesize a minimal
		// record (id + archived) rather than re-reading the row: the renderer
		// patches by id and only needs the membership flag.
		emitDataChange("sessions", sessionId, "update", { id: sessionId, archived: true });
	}

	/**
	 * steps-overhaul sub-8 (archive pipeline): hard-delete ALL of a session's
	 * OWN data — the `sessions` row + every `steps`/`messages` row + the
	 * `tool_executions`/`delegated_tasks` ORPHANS that reference this session
	 * via `session_id`. Wiki memory nodes are NOT session-owned (they live
	 * cross-session in the wiki tree) and are intentionally left untouched.
	 *
	 * This is the "delete" half of the archive pipeline (after the JSON export
	 * has been written). It is also idempotent: re-running on an already-archived
	 * session is a no-op (all DELETEs match zero rows).
	 *
	 * `delegated_tasks` carries TWO session links: `session_id` (the child
	 * session this task SPAWNED) and `parent_session_id` (the session that
	 * DISPATCHED it). We delete by `session_id` only — i.e. rows whose CHILD
	 * session is the one being archived. Rows where this session is the PARENT
	 * are NOT deleted: those belong to the parent's archive scope, and a parent
	 * being archived would itself be the `session_id` of its own
	 * `delegated_tasks` row chain (root tasks have NULL parent_session_id).
	 *
	 * Emits a `sessions` delete event so the sidebar removes the row.
	 */
	deleteSessionData(sessionId: string): void {
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
			this.db.prepare("DELETE FROM steps WHERE session_id = ?").run(sessionId);
			this.db.prepare("DELETE FROM tool_executions WHERE session_id = ?").run(sessionId);
			this.db.prepare("DELETE FROM delegated_tasks WHERE session_id = ?").run(sessionId);
			this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
		});
		tx();
		// N1: structural primitive — emit delete (no record). The renderer
		// removes the session from every list (active + archived area).
		emitDataChange("sessions", sessionId, "delete");
	}

	updateSessionUsage(sessionId: string, usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; estimatedCostUsd: number }): void {
		const now = new Date().toISOString();
		this.db.prepare(
			"UPDATE sessions SET input_tokens = ?, output_tokens = ?, total_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?, estimated_cost_usd = ?, updated_at = ? WHERE id = ?"
		).run(usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens, usage.estimatedCostUsd, now, sessionId);
	}

	// -----------------------------------------------------------------------
	// token_usage — steps-overhaul sub-5
	//
	// `sessions.token_usage` (JSON) holds the LAST API-returned usage object for
	// the session (the most recent step's input/output token counts as reported
	// by the provider, NOT a running sum — input grows within a turn). This is
	// the input the compression trigger reads to decide whether the live context
	// has crossed the absolute/relative thresholds (design.md「阈值」). The
	// cumulative input_tokens/output_tokens columns are a different thing
	// (session-wide running totals for metrics); token_usage is the per-call
	// snapshot that reflects current context size.
	// -----------------------------------------------------------------------

	/**
	 * Read the last API-returned usage snapshot for a session (the `token_usage`
	 * JSON column). Returns undefined when no step has run yet (column NULL or
	 * malformed). Used by the compression trigger to gauge current context size.
	 */
	getTokenUsage(sessionId: string): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
		try {
			const row = this.db.prepare(
				"SELECT token_usage FROM sessions WHERE id = ?",
			).get(sessionId) as { token_usage: string | null } | undefined;
			if (!row || !row.token_usage) return undefined;
			return JSON.parse(row.token_usage) as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
		} catch (err) {
			log.warn("db", `getTokenUsage failed (session=${sessionId}):`, (err as Error).message);
			return undefined;
		}
	}

	/**
	 * Overwrite the last API-returned usage snapshot. Called by the compression
	 * trigger's StepEnd handler with the step's `usage` so the next trigger
	 * evaluation reads current context size off the session row.
	 */
	setTokenUsage(sessionId: string, usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
		try {
			this.db.prepare(
				"UPDATE sessions SET token_usage = ?, updated_at = ? WHERE id = ?",
			).run(JSON.stringify(usage), new Date().toISOString(), sessionId);
		} catch (err) {
			log.warn("db", `setTokenUsage failed (session=${sessionId}):`, (err as Error).message);
		}
	}

	// -----------------------------------------------------------------------
	// Messages — steps-overhaul sub-3 redefinition
	//
	// The `messages` table NO LONGER stores LLM-view content. It now holds:
	//   - up to MAX_MESSAGE_SUMMARIES (=3) summary blocks (FIFO, one row each),
	//     produced by future compression (sub-4+); and
	//   - last_compressed_step_seq: the compression/assembly cursor that splits
	//     the LLM view into [summary] + [middle: tool stub] + [fresh tail].
	//
	// steps is the single source of truth for step content; messages is just an
	// assemble pointer. Invariant (design.md): two tables never duplicate
	// content. saveTurn's old "dump the in-memory messages array here" contract
	// is GONE — AgentSession now rebuilds its LLM view from steps on every
	// assemble (rebuildFromTurns) and never writes step content to messages.
	//
	// The old reader API names (getMessages / getMessagesWithSeq / getMessageCount
	// / deleteMessage / updateMessageContent) referenced the retired "LLM view
	// dumped here" semantics and are removed. Callers that need step content read
	// getSteps / getStepGroup; callers that need the summary blocks + cursor read
	// getSummaries / getCompressionCursor below. The two server-side REST readers
	// that still treat messages as content (agent-router GET /messages,
	// analyst-service verify) are best-effort tolerated by getSummaries so they
	// don't crash on the empty/summary-only new shape; sub-9 will repoint them at
	// steps (UI data source per design).
	// -----------------------------------------------------------------------

	/** Max FIFO summary slots in the messages table per session (design.md: ≤3). */
	static readonly MAX_MESSAGE_SUMMARIES = 3;

	/** Shape of one summary block persisted to messages.summary_json. */
	static parseSummary(raw: string): MessageSummary {
		return JSON.parse(raw) as MessageSummary;
	}

	/**
	 * Read the summary blocks for a session, oldest-first. Returns [] when no
	 * compression has written summaries yet (the common case in sub-3 — there is
	 * no compression writer until sub-4). Future compression (sub-4 Extractor A)
	 * appends here FIFO, capping at MAX_MESSAGE_SUMMARIES.
	 */
	getSummaries(sessionId: string): MessageSummary[] {
		try {
			const rows = this.db.prepare(
				"SELECT summary_json FROM messages WHERE session_id = ? ORDER BY seq",
			).all(sessionId) as { summary_json: string }[];
			return rows.map((r) => SessionDB.parseSummary(r.summary_json));
		} catch (err) {
			log.warn("db", `getSummaries failed (session=${sessionId}):`, (err as Error).message);
			return [];
		}
	}

	/**
	 * Read the compression/assembly cursor (messages.last_compressed_step_seq).
	 * NULL means "no compression yet / cursor unset" — the entire step history
	 * lives in the fresh-tail region for LLM-view assembly. This is the
	 * summary/middle vs fresh-tail boundary, INDEPENDENT of
	 * sessions.last_completed_step_seq (the resume cursor — see sub-1).
	 */
	getCompressionCursor(sessionId: string): number | null {
		try {
			const row = this.db.prepare(
				"SELECT last_compressed_step_seq AS seq FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1",
			).get(sessionId) as { seq: number | null } | undefined;
			return row?.seq ?? null;
		} catch (err) {
			log.warn("db", `getCompressionCursor failed (session=${sessionId}):`, (err as Error).message);
			return null;
		}
	}

	/**
	 * Push a new summary block + advance the compression cursor atomically.
	 * FIFO cap at MAX_MESSAGE_SUMMARIES: the oldest summary is evicted when the
	 * cap is reached. The cursor is set on EVERY summary row for the session
	 * (redundant but lets readers SELECT it from any row — the table holds ≤3
	 * rows so the duplication is trivial and read-path-cheap).
	 *
	 * Used by future compression (sub-4 Extractor A). sub-3 itself has no writer
	 * — the table starts empty; this method exists so the contract is fixed
	 * before the writer lands.
	 */
	saveSummaryAndAdvanceCursor(sessionId: string, summary: MessageSummary, compressedStepSeq: number): void {
		this.ensureSession(sessionId);
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			// Current slot count + FIFO eviction.
			const cntRow = this.db.prepare(
				"SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?",
			).get(sessionId) as { cnt: number };
			if (cntRow.cnt >= SessionDB.MAX_MESSAGE_SUMMARIES) {
				// Evict the oldest (lowest seq) and re-pack seq from 0.
				this.db.prepare(
					"DELETE FROM messages WHERE session_id = ? AND seq = (SELECT MIN(seq) FROM messages WHERE session_id = ?)",
				).run(sessionId, sessionId);
			}
			// Re-number remaining rows to a dense 0..N-1 so the new slot is N.
			const reRows = this.db.prepare(
				"SELECT id FROM messages WHERE session_id = ? ORDER BY seq",
			).all(sessionId) as { id: number }[];
			const renumber = this.db.prepare("UPDATE messages SET seq = ? WHERE id = ?");
			reRows.forEach((r, i) => renumber.run(i, r.id));
			const nextSeq = reRows.length;

			this.db.prepare(
				"INSERT INTO messages (session_id, seq, summary_json, last_compressed_step_seq, created_at) VALUES (?, ?, ?, ?, ?)",
			).run(sessionId, nextSeq, JSON.stringify(summary), compressedStepSeq, now);

			// Keep the cursor identical across all of the session's rows.
			this.db.prepare(
				"UPDATE messages SET last_compressed_step_seq = ? WHERE session_id = ?",
			).run(compressedStepSeq, sessionId);

			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	/**
	 * Clear all summaries for a session (e.g. on session reset). Does NOT touch
	 * steps. The cursor returns to NULL (no compression) implicitly.
	 */
	clearSummaries(sessionId: string): void {
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	/** Ensure a session row exists for the given ID (defensive FK guard). */
	private ensureSession(sessionId: string): void {
		const existing = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
		if (!existing) {
			this.db.prepare(
				"INSERT OR IGNORE INTO sessions (id, agent_id, is_main, title, created_at, updated_at) VALUES (?, '__recovered__', 0, NULL, ?, ?)",
			).run(sessionId, new Date().toISOString(), new Date().toISOString());
		}
	}

	// -----------------------------------------------------------------------
	// Migration from legacy message JSON files
	//
	// steps-overhaul sub-3: the old migration wrote the legacy messages array
	// into the `messages` table via saveTurn. With messages redefined to
	// summary+cursor (no step content), legacy content now lands in STEPS — the
	// source of truth. Each legacy message becomes one step row: user messages
	// open a new turn_group, assistant messages append a text block to the same
	// group. No tool blocks (legacy JSON didn't carry them).
	// -----------------------------------------------------------------------

	private migrateMessageFiles(): void {
		const msgDir = join(ZERO_CORE_DIR, "messages");
		if (!existsSync(msgDir)) return;

		const files = readdirSync(msgDir).filter((f) => f.endsWith(".json") && !f.endsWith(".migrated.bak"));
		if (files.length === 0) return;

		log.db("Migrating", files.length, "message files...");

		for (const file of files) {
			const agentId = file.replace(".json", "");
			const fp = join(msgDir, file);
			try {
				const data = JSON.parse(readFileSync(fp, "utf-8")) as any[];
				if (!Array.isArray(data) || data.length === 0) {
					renameSync(fp, fp + ".migrated.bak");
					continue;
				}

				const session = this.createSession(agentId, "Migrated");
				this.setMainSession(agentId, session.id);

				// Build step rows from legacy messages. user opens a turn_group;
				// assistant appends a text-block step in the same group.
				let seq = 0;
				let turnGroup = 0;
				for (const sm of data) {
					const role = sm.role === "assistant" ? "assistant" : "user";
					const text: string = sm.text ?? "";
					if (role === "user") {
						turnGroup = seq;
						this.appendStep(session.id, seq, turnGroup, "user", text);
						seq++;
					} else {
						const block = JSON.stringify([{ type: "text", text }]);
						this.appendStep(session.id, seq, turnGroup, "assistant", block);
						seq++;
					}
				}

				renameSync(fp, fp + ".migrated.bak");
				log.db("Migrated", data.length, "messages for agent", agentId);
			} catch (err) {
				log.error("db", "Failed to migrate", file, (err as Error).message);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Steps table — step-level storage (steps-overhaul sub-1: physical table
	// renamed from `turns`). turn_group is the grouping key. Every write path
	// goes through the step-level methods below.
	// -----------------------------------------------------------------------

	getStepCount(sessionId: string): number {
		// steps-overhaul sub-1: read sessions.step_count instead of
		// COUNT(*) FROM steps. CRITICAL: getStepCount is the SEQ ALLOCATION
		// cursor — turn-hooks TurnStart reads it for the next user-row seq,
		// AND AgentLoop.resume() reads it for stepBaseSeq (the next assistant
		// step's seq, which MUST account for all already-persisted steps). So
		// step_count tracks TOTAL step rows (user + assistant), bumped on every
		// appendStep / upsertStep-insert / replaceStepsFromMessages write.
		// (turn_count, separately, tracks true turn count = user rows; it's for
		// the future volume UI, NOT for seq allocation.)
		//
		// Pre-migration this was COUNT(*) FROM turns (all rows); step_count is
		// the equivalent column-mirror, kept in sync at every step write so the
		// read is O(1).
		const row = this.db.prepare(
			"SELECT step_count AS cnt FROM sessions WHERE id = ?",
		).get(sessionId) as { cnt: number } | undefined;
		return row?.cnt ?? 0;
	}

	clearTurns(sessionId: string): void {
		// steps-overhaul sub-1: zero the counters since every step row is gone.
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM steps WHERE session_id = ?").run(sessionId);
			this.db.prepare(
				"UPDATE sessions SET step_count = 0, turn_count = 0, updated_at = ? WHERE id = ?",
			).run(now, sessionId);
		});
		tx();
	}

	deleteTurn(sessionId: string, seq: number): void {
		// Note: does NOT decrement step_count (seq allocation is monotonic;
		// re-using a freed seq would collide with future appends). Callers that
		// need a corrected count should use deleteStepGroup (which recomputes).
		this.db.prepare("DELETE FROM steps WHERE session_id = ? AND seq = ?").run(sessionId, seq);
	}

	// -----------------------------------------------------------------------
	// Step-level storage — canonical turns-table API (Step 4A: step-only).
	// -----------------------------------------------------------------------

	/**
	 * multimodal-input sub-2: serialize a step's attachment metadata to the
	 * `steps.attachments` column value. Empty/undefined → NULL (keeps legacy
	 * rows indistinguishable from no-attachment rows; both read back as
	 * `undefined`). Design principle A: only meta is persisted, never bytes.
	 */
	private serializeAttachments(attachments?: AttachmentMeta[]): string | null {
		if (!attachments || attachments.length === 0) return null;
		return JSON.stringify(attachments);
	}

	/**
	 * multimodal-input sub-2: parse the `steps.attachments` column back into
	 * `AttachmentMeta[]`. Returns `undefined` for NULL / unparseable rows so
	 * legacy data (pre-column) is transparent — callers see no attachments.
	 */
	private deserializeAttachments(raw: unknown): AttachmentMeta[] | undefined {
		if (typeof raw !== "string" || raw.length === 0) return undefined;
		try {
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return undefined;
			return parsed as AttachmentMeta[];
		} catch {
			return undefined;
		}
	}

	getSteps(sessionId: string): Array<{
		seq: number; turnGroup: number; role: string;
		content: string | null; inputTokens: number; outputTokens: number;
		totalTokens: number; createdAt: string;
		attachments?: AttachmentMeta[];
	}> {
		const rows = this.db.prepare(
			"SELECT seq, turn_group, role, content, input_tokens, output_tokens, total_tokens, created_at, attachments " +
			"FROM steps WHERE session_id = ? ORDER BY seq",
		).all(sessionId) as any[];
		return rows.map((r) => ({
			seq: r.seq,
			turnGroup: r.turn_group,
			role: r.role,
			content: r.content,
			inputTokens: r.input_tokens ?? 0,
			outputTokens: r.output_tokens ?? 0,
			totalTokens: r.total_tokens ?? 0,
			createdAt: r.created_at,
			attachments: this.deserializeAttachments(r.attachments),
		}));
	}

	getStepGroup(sessionId: string, turnGroup: number): Array<{
		seq: number; turnGroup: number; role: string;
		content: string | null; inputTokens: number; outputTokens: number;
		totalTokens: number; createdAt: string;
		attachments?: AttachmentMeta[];
	}> {
		const rows = this.db.prepare(
			"SELECT seq, turn_group, role, content, input_tokens, output_tokens, total_tokens, created_at, attachments " +
			"FROM steps WHERE session_id = ? AND turn_group = ? ORDER BY seq",
		).all(sessionId, turnGroup) as any[];
		return rows.map((r) => ({
			seq: r.seq,
			turnGroup: r.turn_group,
			role: r.role,
			content: r.content,
			inputTokens: r.input_tokens ?? 0,
			outputTokens: r.output_tokens ?? 0,
			totalTokens: r.total_tokens ?? 0,
			createdAt: r.created_at,
			attachments: this.deserializeAttachments(r.attachments),
		}));
	}

	appendStep(
		sessionId: string, seq: number, turnGroup: number,
		role: string, content: string | null,
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
		attachments?: AttachmentMeta[],
	): void {
		this.ensureSession(sessionId);
		const now = new Date().toISOString();
		const attachmentsJson = this.serializeAttachments(attachments);
		// steps-overhaul sub-1: bump counters on every appendStep.
		// - step_count: tracks TOTAL step rows (= the old COUNT(*) FROM turns).
		//   getStepCount() reads this for seq allocation (turn-hooks' user row
		//   AND AgentLoop.resume()'s stepBaseSeq). Bumped for EVERY role since
		//   every appendStep inserts one row.
		// - turn_count: tracks TRUE turn count (user rows only). For the future
		//   volume UI. Not used for seq allocation.
		// Both set to seq+1 (the just-written row's seq + 1 = next allocation).
		// replaceStepsFromMessages (compression rebuild) sets counts in bulk
		// separately (doesn't go through appendStep).
		const isUser = role === "user";
		const tx = this.db.transaction(() => {
			this.db.prepare(
				"INSERT INTO steps (session_id, seq, turn_group, role, content, input_tokens, output_tokens, total_tokens, created_at, attachments) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				sessionId, seq, turnGroup, role, content ?? null,
				usage?.inputTokens ?? 0,
				usage?.outputTokens ?? 0,
				usage?.totalTokens ?? 0,
				now,
				attachmentsJson,
			);
			if (isUser) {
				this.db.prepare(
					"UPDATE sessions SET step_count = MAX(step_count, ?), turn_count = MAX(turn_count, ?), updated_at = ? WHERE id = ?",
				).run(seq + 1, seq + 1, now, sessionId);
			} else {
				this.db.prepare(
					"UPDATE sessions SET step_count = MAX(step_count, ?), updated_at = ? WHERE id = ?",
				).run(seq + 1, now, sessionId);
			}
		});
		tx();
	}

	upsertStep(
		sessionId: string, seq: number, turnGroup: number,
		role: string, content: string | null,
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
		attachments?: AttachmentMeta[],
	): void {
		this.ensureSession(sessionId);
		const now = new Date().toISOString();
		const attachmentsJson = this.serializeAttachments(attachments);
		const existing = this.db.prepare(
			"SELECT 1 FROM steps WHERE session_id = ? AND seq = ?",
		).get(sessionId, seq);
		const isUser = role === "user";
		if (existing) {
			this.db.prepare(
				"UPDATE steps SET turn_group = ?, content = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, attachments = ? " +
				"WHERE session_id = ? AND seq = ?",
			).run(
				turnGroup, content ?? null,
				usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage?.totalTokens ?? 0,
				attachmentsJson,
				sessionId, seq,
			);
			// UPDATE path: no new row, no counter bump (counters track row count).
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		} else {
			// INSERT path: new row → bump step_count (and turn_count if user).
			// See appendStep for the counter semantics rationale.
			const tx = this.db.transaction(() => {
				this.db.prepare(
					"INSERT INTO steps (session_id, seq, turn_group, role, content, input_tokens, output_tokens, total_tokens, created_at, attachments) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).run(
					sessionId, seq, turnGroup, role, content ?? null,
					usage?.inputTokens ?? 0,
					usage?.outputTokens ?? 0,
					usage?.totalTokens ?? 0,
					now,
					attachmentsJson,
				);
				if (isUser) {
					this.db.prepare(
						"UPDATE sessions SET step_count = MAX(step_count, ?), turn_count = MAX(turn_count, ?), updated_at = ? WHERE id = ?",
					).run(seq + 1, seq + 1, now, sessionId);
				} else {
					this.db.prepare(
						"UPDATE sessions SET step_count = MAX(step_count, ?), updated_at = ? WHERE id = ?",
					).run(seq + 1, now, sessionId);
				}
			});
			tx();
		}
	}

	updateStepContent(
		sessionId: string, seq: number, content: string,
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
	): void {
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			if (usage) {
				this.db.prepare(
					"UPDATE steps SET content = ?, input_tokens = ?, output_tokens = ?, total_tokens = ? " +
					"WHERE session_id = ? AND seq = ?",
				).run(content, usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.totalTokens ?? 0, sessionId, seq);
			} else {
				this.db.prepare(
					"UPDATE steps SET content = ? WHERE session_id = ? AND seq = ?",
				).run(content, sessionId, seq);
			}
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	deleteStepGroup(sessionId: string, turnGroup: number): void {
		// steps-overhaul sub-1: recompute counters after deleting a group
		// (compression / undo paths). step_count = remaining rows; turn_count =
		// remaining user rows.
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM steps WHERE session_id = ? AND turn_group = ?").run(sessionId, turnGroup);
			const cnt = this.db.prepare(
				"SELECT COUNT(*) AS total, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_rows FROM steps WHERE session_id = ?",
			).get(sessionId) as { total: number; user_rows: number } | undefined;
			this.db.prepare(
				"UPDATE sessions SET step_count = ?, turn_count = ?, updated_at = ? WHERE id = ?",
			).run(cnt?.total ?? 0, cnt?.user_rows ?? 0, now, sessionId);
		});
		tx();
	}

	getTurnGroupCount(sessionId: string): number {
		const row = this.db.prepare(
			"SELECT COUNT(DISTINCT turn_group) as cnt FROM steps WHERE session_id = ?",
		).get(sessionId) as any;
		return row.cnt;
	}

	// steps-overhaul sub-3: replaceStepsFromMessages is DELETED. It was the
	// destructive "DELETE+re-insert steps from compressed messages" path used
	// (steps-overhaul sub-4: old L1/L2 compression engine + compression-hooks deleted; stage-3 core (compressSession) does not touch steps.)
	// With messages redefined to summary+cursor (no step content) and steps now
	// the immutable source of truth, there is no caller and no valid use —
	// future compression (sub-4) advances the cursor + writes a summary instead
	// of touching steps.

	// -----------------------------------------------------------------------
	// Turn state (steps-overhaul sub-1: folded into sessions as 1:1 current
	// run state — phase/last_completed_step_seq/source/error/turn_count/
	// step_count/token_usage. No per-turn history; a session has at most one
	// in-flight turn. cleanOldTurnState + updateTurnPhase removed (the former's
	// GC job is absorbed by recovery scanning sessions.phase; the latter had
	// zero callers).)
	// -----------------------------------------------------------------------

	createTurnState(sessionId: string, turnSeq: number, source: TurnSource = "background"): void {
		const now = new Date().toISOString();
		try {
			// steps-overhaul sub-1: the per-turn turn_state row is gone; the
			// same logical state lives on the sessions row. phase flips to
			// 'pending' (recovery candidate), last_completed_step_seq resets to
			// NULL (turn started, no step finished yet), and source records who
			// kicked the turn. error is cleared (fresh turn).
			//
			// turn_count is NOT bumped here — see appendStep (role='user') for
			// the bump rationale (it must happen at user-row write time, not at
			// turn-state init, to avoid a TurnStart ordering hazard: if durable
			// TurnStart runs before turn-hooks TurnStart, bumping here would
			// make turn-hooks' subsequent getStepCount() read N+1 and write the
			// user row at the wrong seq).
			//
			// A recovered turn skips this (recovery pre-marks via
			// setSessionTurnSeq → markTurnStatePrecreated → durable TurnStart
			// skips createTurnState, preserving the existing phase/checkpoint).
			this.db.prepare(
				`UPDATE sessions SET phase = 'pending', last_completed_step_seq = NULL, source = ?, error = NULL, updated_at = ? WHERE id = ?`,
			).run(source, now, sessionId);
		} catch (e) {
			log.error("db", `createTurnState failed (session=${sessionId}, turn=${turnSeq}):`, (e as Error).message);
			throw e;
		}
	}

	/**
	 * steps-overhaul sub-1: advance the per-session step checkpoint (was
	 * per-(session,turn); now 1:1 on sessions). Called on every successful
	 * StepEnd with the just-completed step's seq (stepBaseSeq + stepOffset).
	 * resume() reads last_completed_step_seq and continues from +1, so
	 * completed steps are never re-run. Only moves the cursor FORWARD — a
	 * regression (older seq) is ignored to protect against out-of-order hook
	 * firing.
	 */
	advanceStepCheckpoint(sessionId: string, turnSeq: number, stepSeq: number): void {
		const now = new Date().toISOString();
		try {
			this.db.prepare(
				"UPDATE sessions SET last_completed_step_seq = ?, updated_at = ? " +
				"WHERE id = ? " +
				"AND (last_completed_step_seq IS NULL OR last_completed_step_seq < ?)",
			).run(stepSeq, now, sessionId, stepSeq);
		} catch (e) {
			log.error("db", `advanceStepCheckpoint failed (session=${sessionId}, turn=${turnSeq}, step=${stepSeq}):`, (e as Error).message);
			throw e;
		}
	}

	/** Read the per-session step checkpoint (NULL when no step has completed). */
	getStepCheckpoint(sessionId: string): number | null {
		try {
			const row = this.db.prepare(
				"SELECT last_completed_step_seq AS seq FROM sessions WHERE id = ?",
			).get(sessionId) as { seq: number | null } | undefined;
			return row?.seq ?? null;
		} catch (e) {
			log.error("db", `getStepCheckpoint failed (session=${sessionId}):`, (e as Error).message);
			return null;
		}
	}

	completeTurnState(sessionId: string, turnSeq: number): void {
		const now = new Date().toISOString();
		try {
			this.db.prepare(
				`UPDATE sessions SET phase = 'completed', updated_at = ? WHERE id = ?`,
			).run(now, sessionId);
		} catch (e) {
			log.error("db", `completeTurnState failed (session=${sessionId}, turn=${turnSeq}):`, (e as Error).message);
			throw e;
		}
	}

	failTurnState(sessionId: string, turnSeq: number, error: string): void {
		const now = new Date().toISOString();
		try {
			this.db.prepare(
				`UPDATE sessions SET phase = 'failed', error = ?, updated_at = ? WHERE id = ?`,
			).run(error, now, sessionId);
		} catch (e) {
			log.error("db", `failTurnState failed (session=${sessionId}, turn=${turnSeq}):`, (e as Error).message);
			throw e;
		}
	}

	/**
	 * steps-overhaul sub-1: all sessions whose phase is non-terminal (recovery
	 * candidates). Was a scan of turn_state; now a single SELECT on sessions.
	 * Returns turnSeq derived from sessions.turn_count (the next allocation =
	 * current turn_count, which is also the in-flight turn's seq+1 — but the
	 * in-flight turn's OWN seq is turn_count-1; recovery resumes that turn, so
	 * we report turnSeq = turn_count - 1). For sessions where turn_count is 0
	 * (edge: phase pending but no createTurnState ran), fall back to 0.
	 * `.checkpoint` field dropped (dead); callers (recovery, durable-hooks)
	 * only read `.turnSeq` / `.lastCompletedStepSeq` / `.phase` / `.source`.
	 */
	getIncompleteTurns(): Array<{ sessionId: string; turnSeq: number; phase: string; error: string | null; lastCompletedStepSeq: number | null; source: TurnSource }> {
		try {
			const rows = this.db.prepare(
				`SELECT id AS session_id, phase, error, last_completed_step_seq, source, turn_count FROM sessions WHERE phase NOT IN ('completed', 'failed')`,
			).all() as any[];
			return rows.map((r: any) => ({
				sessionId: r.session_id,
				turnSeq: Math.max(0, (r.turn_count ?? 1) - 1),
				phase: r.phase,
				error: r.error,
				lastCompletedStepSeq: r.last_completed_step_seq ?? null,
				source: (r.source ?? "background") as TurnSource,
			}));
		} catch (e) {
			log.error("db", "getIncompleteTurns failed:", (e as Error).message);
			throw e;
		}
	}

	/**
	 * sub-4 (TaskResume turn_seq guard): single-session interrupted turn read.
	 * Used by the runtime resumeTask path to pre-populate turn_seq before
	 * loop.resume() (closing the turn+1 bug on the TaskResume path — the server-
	 * side doRecoverIncompleteSessions already does this for chat sessions).
	 * steps-overhaul sub-1: now reads sessions (phase non-terminal). Returns
	 * turnSeq = turn_count - 1 (the in-flight turn's own seq). undefined if the
	 * session is terminal or missing.
	 */
	getIncompleteTurn(sessionId: string): { turnSeq: number; lastCompletedStepSeq?: number | null; source?: TurnSource } | undefined {
		try {
			const row = this.db.prepare(
				`SELECT turn_count, last_completed_step_seq, source FROM sessions WHERE id = ? AND phase NOT IN ('completed', 'failed')`,
			).get(sessionId) as any;
			if (!row) return undefined;
			return {
				turnSeq: Math.max(0, (row.turn_count ?? 1) - 1),
				lastCompletedStepSeq: row.last_completed_step_seq ?? null,
				source: (row.source ?? "background") as TurnSource,
			};
		} catch (e) {
			log.error("db", `getIncompleteTurn failed (session=${sessionId}):`, (e as Error).message);
			return undefined;
		}
	}

	/**
	 * sub-8 (lazy rebuild + interrupted seed): set of DISTINCT session ids whose
	 * phase is non-terminal. Used by:
	 *   - restoreAllSessions — only these sessions get a loop at startup; all
	 *     other chat sessions defer to activateSession (lazy build).
	 *   - restoreDelegatedTasks — authoritative seed-status signal: a delegated
	 *     child whose session is non-terminal is "frozen/interrupted" regardless
	 *     of its delegated_tasks.status row.
	 * steps-overhaul sub-1: was DISTINCT session_id FROM turn_state; now a
	 * single SELECT id FROM sessions WHERE phase NOT IN (...). Single batched
	 * query (no N+1). Empty set when nothing is incomplete.
	 */
	getIncompleteTurnSessionIds(): Set<string> {
		try {
			const rows = this.db.prepare(
				`SELECT id FROM sessions WHERE phase NOT IN ('completed', 'failed')`,
			).all() as any[];
			return new Set(rows.map((r) => r.id as string));
		} catch (e) {
			log.error("db", "getIncompleteTurnSessionIds failed:", (e as Error).message);
			return new Set();
		}
	}

	/**
	 * sub-4 (TaskKill interrupted→abandon): mark a session's interrupted state
	 * terminal (failed) so it doesn't resurface as "needs resume" on next
	 * startup. Called from the parent's TaskKill(interrupted) branch when the
	 * parent chooses NOT to resume a frozen delegated child. Returns 1 if a row
	 * was flipped, 0 otherwise (best-effort: errors log + return 0).
	 * steps-overhaul sub-1: was UPDATE turn_state ... WHERE phase NOT IN ...;
	 * now a single-row UPDATE on sessions.
	 */
	abandonInterruptedTurn(sessionId: string, reason: string = "Abandoned via TaskKill"): number {
		try {
			const now = new Date().toISOString();
			const info = this.db.prepare(
				`UPDATE sessions SET phase = 'failed', error = ?, updated_at = ? WHERE id = ? AND phase NOT IN ('completed', 'failed')`,
			).run(reason, now, sessionId);
			return info.changes ?? 0;
		} catch (e) {
			log.error("db", `abandonInterruptedTurn failed (session=${sessionId}):`, (e as Error).message);
			return 0;
		}
	}

	/**
	 * platform-observability ②.2 (sub-2): retention for the provider_usage
	 * rollup. Deletes any hour_bucket older than `maxAgeMs` ago. Called on the
	 * same startup schedule as the (now-removed) cleanOldTurnState. Cutoff is
	 * compared against hour_bucket (hour-floor ISO UTC) directly — that's a
	 * coarser comparison than updated_at, which is fine: we keep ≥30d of hourly
	 * buckets, the only risk is over-retaining the partial hour at the boundary
	 * (acceptable).
	 */
	cleanOldProviderUsage(maxAgeMs: number): void {
		const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
		try {
			const result = this.db.prepare(
				`DELETE FROM provider_usage WHERE hour_bucket < ?`,
			).run(cutoff);
			if (result.changes > 0) {
				log.db(`cleanOldProviderUsage removed ${result.changes} row(s) older than ${maxAgeMs}ms`);
			}
		} catch (e) {
			log.error("db", "cleanOldProviderUsage failed:", (e as Error).message);
			// Best-effort — don't take down startup for a retention cleanup.
		}
	}

	/**
	 * Reset a session's turn state row to terminal-completed (defensive clear).
	 * steps-overhaul sub-1: was DELETE FROM turn_state; now flips sessions.phase
	 * to 'completed' so the session stops being a recovery candidate. Kept for
	 * callers that historically cleared turn_state on session teardown.
	 */
	deleteTurnState(sessionId: string): void {
		const now = new Date().toISOString();
		this.db.prepare(
			`UPDATE sessions SET phase = 'completed', last_completed_step_seq = NULL, error = NULL, updated_at = ? WHERE id = ?`,
		).run(now, sessionId);
	}

	// -----------------------------------------------------------------------
	// Tool executions
	// -----------------------------------------------------------------------

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
	}): void {
		this.db.prepare(
			"INSERT INTO tool_executions (session_id, agent_id, tool_name, success, error_message, input_preview, output_preview, duration_ms, turn_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
		).run(
			exec.sessionId,
			exec.agentId,
			exec.toolName,
			exec.success ? 1 : 0,
			exec.errorMessage ?? null,
			exec.inputPreview ?? null,
			exec.outputPreview ?? null,
			exec.durationMs,
			exec.turnSeq ?? null,
			new Date().toISOString()
		);
	}

	queryToolExecutions(filter: ToolExecutionFilter): ToolExecutionRecord[] {
		const clauses: string[] = ["1=1"];
		const params: any[] = [];
		if (filter.agentId) { clauses.push("agent_id = ?"); params.push(filter.agentId); }
		if (filter.sessionId) { clauses.push("session_id = ?"); params.push(filter.sessionId); }
		if (filter.toolName) { clauses.push("tool_name = ?"); params.push(filter.toolName); }
		if (filter.success !== undefined) { clauses.push("success = ?"); params.push(filter.success ? 1 : 0); }
		const where = clauses.join(" AND ");
		const limit = filter.limit ?? 100;
		const offset = filter.offset ?? 0;
		const rows = this.db.prepare(
			"SELECT * FROM tool_executions WHERE " + where + " ORDER BY created_at DESC LIMIT ? OFFSET ?"
		).all(...params, limit, offset) as any[];
		return rows.map(r => this.toolExecRowToRecord(r));
	}

	getToolExecutionStats(agentId?: string): ToolExecutionStats[] {
		const params: any[] = [];
		let where = "";
		if (agentId) { where = " WHERE agent_id = ?"; params.push(agentId); }
		const rows = this.db.prepare(
			"SELECT tool_name, COUNT(*) as total_calls, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as error_count, " +
			"ROUND(AVG(duration_ms), 1) as avg_duration_ms, " +
			"MAX(CASE WHEN success = 0 THEN created_at END) as last_error_at " +
			"FROM tool_executions" + where + " GROUP BY tool_name ORDER BY error_count DESC, total_calls DESC"
		).all(...params) as any[];
		return rows.map(r => ({
			toolName: r.tool_name,
			totalCalls: r.total_calls,
			errorCount: r.error_count,
			errorRate: r.total_calls > 0 ? Math.round((r.error_count / r.total_calls) * 1000) / 1000 : 0,
			avgDurationMs: r.avg_duration_ms ?? 0,
			lastErrorAt: r.last_error_at ?? undefined,
		}));
	}

	cleanOldToolExecutions(maxAgeMs: number): number {
		const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
		const result = this.db.prepare("DELETE FROM tool_executions WHERE created_at < ?").run(cutoff);
		if (result.changes > 0) {
			log.db("cleanOldToolExecutions removed " + result.changes + " row(s) older than " + maxAgeMs + "ms");
		}
		return result.changes;
	}

	private toolExecRowToRecord(row: any): ToolExecutionRecord {
		return {
			id: row.id,
			sessionId: row.session_id,
			agentId: row.agent_id,
			toolName: row.tool_name,
			success: row.success === 1,
			errorMessage: row.error_message ?? undefined,
			inputPreview: row.input_preview ?? undefined,
			outputPreview: row.output_preview ?? undefined,
			durationMs: row.duration_ms,
			turnSeq: row.turn_seq ?? undefined,
			createdAt: row.created_at,
		};
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	close(): void {
		this.db.close();
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private rowToRecord(row: any): SessionRecord {
		let context: SessionRecord["context"] | undefined;
		if (row.context) {
			try {
				context = JSON.parse(row.context) as SessionRecord["context"];
			} catch {
				// Reconstruct from columns if JSON parse fails
				if (row.context_workspace_dir || row.context_wiki_root_node_id) {
					context = {
						projectId: row.context_project_id ?? undefined,
						workspaceDir: row.context_workspace_dir ?? "",
						wikiRootNodeId: row.context_wiki_root_node_id ?? "",
					};
				}
			}
		} else if (row.context_workspace_dir || row.context_wiki_root_node_id) {
			context = {
				projectId: row.context_project_id ?? undefined,
				workspaceDir: row.context_workspace_dir ?? "",
				wikiRootNodeId: row.context_wiki_root_node_id ?? "",
			};
		}
		return {
			id: row.id,
			agentId: row.agent_id,
			isMain: row.is_main === 1,
			title: row.title,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			inputTokens: row.input_tokens ?? 0,
			outputTokens: row.output_tokens ?? 0,
			totalTokens: row.total_tokens ?? 0,
			cacheReadTokens: row.cache_read_tokens ?? 0,
			cacheWriteTokens: row.cache_write_tokens ?? 0,
			reasoningTokens: row.reasoning_tokens ?? 0,
			estimatedCostUsd: row.estimated_cost_usd ?? 0,
			context,
			archived: row.archived === 1,
			sessionKind: (row.session_kind as "chat" | "delegated") ?? "chat",
			parentSessionId: row.parent_session_id ?? undefined,
			parentTaskId: row.parent_task_id ?? undefined,
			visibility: (row.visibility as "normal" | "hidden" | "debug") ?? "normal",
		};
	}

	// -----------------------------------------------------------------------
	// Delegated task persistence
	// -----------------------------------------------------------------------

	private delegatedTaskRowToRecord(row: any): DelegatedTaskRecord {
		return {
			id: row.id,
			parentTaskId: row.parent_task_id ?? undefined,
			rootTaskId: row.root_task_id,
			ownerAgentId: row.owner_agent_id,
			targetAgentId: row.target_agent_id,
			modelId: row.model_id ?? undefined,
			parentSessionId: row.parent_session_id ?? undefined,
			sessionId: row.session_id ?? undefined,
			task: row.task,
			status: row.status,
			depth: row.depth ?? 0,
			step: row.step ?? 0,
			turns: row.turns ?? 0,
			tokens: row.tokens ?? 0,
			currentTool: row.current_tool ?? undefined,
			result: row.result ?? undefined,
			error: row.error ?? undefined,
			controlMessage: row.control_message ?? undefined,
			finishRequestedAt: row.finish_requested_at ?? undefined,
			parentToolCallId: row.parent_tool_call_id ?? undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			completedAt: row.completed_at ?? undefined,
		};
	}

	createDelegatedTask(input: {
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
	}): DelegatedTaskRecord {
		const now = new Date().toISOString();
		const status = input.status ?? "running";
		this.db.prepare(
			"INSERT INTO delegated_tasks (id, parent_task_id, root_task_id, owner_agent_id, target_agent_id, model_id, parent_session_id, session_id, task, status, depth, step, turns, tokens, parent_tool_call_id, created_at, updated_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)",
		).run(
			input.id,
			input.parentTaskId ?? null,
			input.rootTaskId,
			input.ownerAgentId,
			input.targetAgentId,
			input.modelId ?? null,
			input.parentSessionId ?? null,
			input.sessionId ?? null,
			input.task,
			status,
			input.depth ?? 0,
			input.parentToolCallId ?? null,
			now, now,
		);
		return this.getDelegatedTask(input.id)!;
	}

	updateDelegatedTask(id: string, patch: Partial<Pick<DelegatedTaskRecord, "status" | "step" | "turns" | "tokens" | "currentTool" | "result" | "error" | "controlMessage" | "finishRequestedAt" | "completedAt" | "sessionId" | "parentToolCallId">>): DelegatedTaskRecord | undefined {
		const sets: string[] = [];
		const vals: any[] = [];
		const colMap: Record<string, string> = {
			status: "status",
			step: "step",
			turns: "turns",
			tokens: "tokens",
			currentTool: "current_tool",
			result: "result",
			error: "error",
			controlMessage: "control_message",
			finishRequestedAt: "finish_requested_at",
			completedAt: "completed_at",
			sessionId: "session_id",
			parentToolCallId: "parent_tool_call_id",
		};
		for (const [k, v] of Object.entries(patch)) {
			const col = colMap[k];
			if (!col) continue;
			sets.push(`${col} = ?`);
			vals.push(v ?? null);
		}
		if (!sets.length) return this.getDelegatedTask(id);
		sets.push("updated_at = ?");
		vals.push(new Date().toISOString());
		vals.push(id);
		this.db.prepare(`UPDATE delegated_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
		return this.getDelegatedTask(id);
	}

	getDelegatedTask(id: string): DelegatedTaskRecord | undefined {
		const row = this.db.prepare("SELECT * FROM delegated_tasks WHERE id = ?").get(id) as any;
		return row ? this.delegatedTaskRowToRecord(row) : undefined;
	}

	listDelegatedTasks(filter?: { ownerAgentId?: string; rootTaskId?: string; parentTaskId?: string; parentSessionId?: string; status?: DelegatedTaskStatus }): DelegatedTaskRecord[] {
		const where: string[] = [];
		const vals: any[] = [];
		if (filter?.ownerAgentId) { where.push("owner_agent_id = ?"); vals.push(filter.ownerAgentId); }
		if (filter?.rootTaskId) { where.push("root_task_id = ?"); vals.push(filter.rootTaskId); }
		if (filter?.parentTaskId) { where.push("parent_task_id = ?"); vals.push(filter.parentTaskId); }
		if (filter?.parentSessionId) { where.push("parent_session_id = ?"); vals.push(filter.parentSessionId); }
		if (filter?.status) { where.push("status = ?"); vals.push(filter.status); }
		const sql = "SELECT * FROM delegated_tasks" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC";
		const rows = this.db.prepare(sql).all(...vals) as any[];
		return rows.map((r) => this.delegatedTaskRowToRecord(r));
	}

	/** Mark still-running/finishing delegated tasks interrupted (startup recovery). */
	markRunningDelegatedTasksInterrupted(): number {
		const now = new Date().toISOString();
		const result = this.db.prepare(
			"UPDATE delegated_tasks SET status = 'interrupted', updated_at = ? WHERE status IN ('running', 'finishing')",
		).run(now);
		return result.changes;
	}
}
