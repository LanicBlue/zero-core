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
// - MemoryStore
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
import type { SessionRecord, ToolExecutionRecord, ToolExecutionFilter, ToolExecutionStats } from "../shared/types.js";
import { KeyValueStore } from "./key-value-store.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryNodeStore } from "./memory-node-store.js";
import { ZERO_CORE_DIR } from "../core/config.js";

// ---------------------------------------------------------------------------
// SessionDB — SQLite-backed session & message persistence
// ---------------------------------------------------------------------------

export class SessionDB {
	private db: Database.Database;
	private kvStore: KeyValueStore;
	private memoryStore: MemoryStore;
	private memoryNodeStore: MemoryNodeStore;

	constructor(dbPath?: string) {
		const dir = join(dbPath ?? ZERO_CORE_DIR, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const path = dbPath ?? join(ZERO_CORE_DIR, "sessions.db");
		this.db = new Database(path);

		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");

		this.kvStore = new KeyValueStore(this.db);
		this.memoryStore = new MemoryStore(this.db);
		this.memoryNodeStore = new MemoryNodeStore(this.db);

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

	getMemoryStore(): MemoryStore {
		return this.memoryStore;
	}

	getMemoryNodeStore(): MemoryNodeStore {
		return this.memoryNodeStore;
	}

	// -----------------------------------------------------------------------
	// Schema — only sessions/messages/turns (owned by SessionDB itself)
	// -----------------------------------------------------------------------

	private initSchema(): void {
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

			CREATE TABLE IF NOT EXISTS messages (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				seq        INTEGER NOT NULL,
				role       TEXT NOT NULL,
				content    TEXT NOT NULL,
				msg_json   TEXT NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

			CREATE TABLE IF NOT EXISTS turns (
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
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_turns_session_seq ON turns(session_id, seq);

			CREATE TABLE IF NOT EXISTS turn_state (
				session_id  TEXT NOT NULL,
				turn_seq    INTEGER NOT NULL,
				phase       TEXT NOT NULL DEFAULT 'pending',
				checkpoint  TEXT,
				error       TEXT,
				created_at  TEXT NOT NULL,
				updated_at  TEXT NOT NULL,
				PRIMARY KEY (session_id, turn_seq),
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_turn_state_session ON turn_state(session_id);

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
		`);

		// v0.8 (M0): session context bundle columns + routing index.
		// JSON-stored context + extracted context_project_id column for the
		// (agentId, projectId) find-or-create routing key (RFC §2.11).
		this.safeAddColumn("sessions", "context", "TEXT");
		this.safeAddColumn("sessions", "context_project_id", "TEXT");
		this.safeAddColumn("sessions", "context_workspace_dir", "TEXT");
		this.safeAddColumn("sessions", "context_wiki_root_node_id", "TEXT");
		// Routing index — must come AFTER context_project_id exists.
		this.safeAddIndex("sessions", "idx_sessions_agent_project", "agent_id, context_project_id");

		// Migrate renamed tools (Bash -> Shell, etc.)
		this.migrateToolNames();
	}

	/** Check if the turns table has step-level schema (turn_group column). */
	hasStepSchema(): boolean {
		const cols = (this.db.pragma("table_info(turns)") as Array<{ name: string }>).map(r => r.name);
		return cols.includes("turn_group");
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

	createSession(agentId: string, title?: string, context?: SessionRecord["context"]): SessionRecord {
		const now = new Date().toISOString();
		const id = uuidv4();
		const ctxJson = context ? JSON.stringify(context) : null;
		this.db.prepare(
			"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at, context, context_project_id, context_workspace_dir, context_wiki_root_node_id) " +
			"VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			id, agentId, title ?? null, now, now, ctxJson,
			context?.projectId ?? null,
			context?.workspaceDir ?? null,
			context?.wikiRootNodeId ?? null,
		);
		return { id, agentId, isMain: false, title: title ?? null, createdAt: now, updatedAt: now, context };
	}

	getSession(sessionId: string): SessionRecord | undefined {
		const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
		return row ? this.rowToRecord(row) : undefined;
	}

	getMainSession(agentId: string): SessionRecord | undefined {
		const row = this.db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND is_main = 1").get(agentId) as any;
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
			"SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC",
		).all(agentId) as any[];
		return rows.map((r) => this.rowToRecord(r));
	}

	listAllSessions(): SessionRecord[] {
		const rows = this.db.prepare(
			"SELECT * FROM sessions WHERE agent_id != '__recovered__' ORDER BY updated_at DESC",
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
			"SELECT * FROM sessions WHERE agent_id = ? AND context_project_id = ? " +
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
	}

	updateSessionUsage(sessionId: string, usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; estimatedCostUsd: number }): void {
		const now = new Date().toISOString();
		this.db.prepare(
			"UPDATE sessions SET input_tokens = ?, output_tokens = ?, total_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?, estimated_cost_usd = ?, updated_at = ? WHERE id = ?"
		).run(usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens, usage.estimatedCostUsd, now, sessionId);
	}

	// -----------------------------------------------------------------------
	// Messages
	// -----------------------------------------------------------------------

	getMessages(sessionId: string): any[] {
		const rows = this.db.prepare(
			"SELECT msg_json FROM messages WHERE session_id = ? ORDER BY seq",
		).all(sessionId) as { msg_json: string }[];
		return rows.map((r) => JSON.parse(r.msg_json));
	}

	getMessagesWithSeq(sessionId: string): Array<{ seq: number; msg_json: string }> {
		return this.db.prepare(
			"SELECT seq, msg_json FROM messages WHERE session_id = ? ORDER BY seq",
		).all(sessionId) as Array<{ seq: number; msg_json: string }>;
	}

	getMessageCount(sessionId: string): number {
		const row = this.db.prepare(
			"SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?",
		).get(sessionId) as any;
		return row.cnt;
	}

	saveTurn(sessionId: string, messages: any[]): void {
		// Ensure the session row exists (FK constraint on messages.session_id)
		const existing = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
		if (!existing) {
			log.warn("db", "saveTurn: session not found, creating:", sessionId);
			this.db.prepare(
				"INSERT OR IGNORE INTO sessions (id, agent_id, is_main, title, created_at, updated_at) VALUES (?, '__recovered__', 0, NULL, ?, ?)",
			).run(sessionId, new Date().toISOString(), new Date().toISOString());
		}

		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
			const insert = this.db.prepare(
				"INSERT INTO messages (session_id, seq, role, content, msg_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (let i = 0; i < messages.length; i++) {
				const msg = messages[i];
				const role = msg.role ?? "user";
				const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
				insert.run(sessionId, i, role, content, JSON.stringify(msg), now);
			}
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	deleteMessage(sessionId: string, seq: number): void {
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM messages WHERE session_id = ? AND seq = ?").run(sessionId, seq);
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	updateMessageContent(sessionId: string, seq: number, content: string, msgJson: string): void {
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare(
				"UPDATE messages SET content = ?, msg_json = ? WHERE session_id = ? AND seq = ?",
			).run(content, msgJson, sessionId, seq);
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

				const modelMessages = data.map((sm: any) => ({
					role: sm.role === "assistant" ? "assistant" : "user",
					content: sm.text ?? "",
				}));
				this.saveTurn(session.id, modelMessages);

				renameSync(fp, fp + ".migrated.bak");
				log.db("Migrated", data.length, "messages for agent", agentId);
			} catch (err) {
				log.error("db", "Failed to migrate", file, (err as Error).message);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Turns (unified block storage)
	// -----------------------------------------------------------------------

	appendTurn(sessionId: string, seq: number, role: string, content: string | null): void {
		this.ensureSession(sessionId);
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare(
				"INSERT INTO turns (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
			).run(sessionId, seq, role, content ?? null, now);
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	getTurns(sessionId: string): Array<{ id: number; seq: number; role: string; content: string | null; createdAt: string }> {
		const rows = this.db.prepare(
			"SELECT id, seq, role, content, created_at FROM turns WHERE session_id = ? ORDER BY seq",
		).all(sessionId) as any[];
		return rows.map((r) => ({
			id: r.id,
			seq: r.seq,
			role: r.role,
			content: r.content,
			createdAt: r.created_at,
		}));
	}

	getTurnCount(sessionId: string): number {
		const row = this.db.prepare("SELECT COUNT(*) as cnt FROM turns WHERE session_id = ?").get(sessionId) as any;
		return row.cnt;
	}

	clearTurns(sessionId: string): void {
		this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(sessionId);
	}

	deleteTurn(sessionId: string, seq: number): void {
		this.db.prepare("DELETE FROM turns WHERE session_id = ? AND seq = ?").run(sessionId, seq);
	}

	updateTurnContent(sessionId: string, seq: number, content: string): void {
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare(
				"UPDATE turns SET content = ? WHERE session_id = ? AND seq = ?",
			).run(content, sessionId, seq);
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}


	upsertAssistantTurn(sessionId: string, seq: number, content: string): void {
		this.ensureSession(sessionId);
		const now = new Date().toISOString();
		const existing = this.db.prepare(
			"SELECT 1 FROM turns WHERE session_id = ? AND seq = ?"
		).get(sessionId, seq);
		if (existing) {
			this.db.prepare(
				"UPDATE turns SET content = ? WHERE session_id = ? AND seq = ?"
			).run(content, sessionId, seq);
		} else {
			this.db.prepare(
				"INSERT INTO turns (session_id, seq, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)"
			).run(sessionId, seq, content, now);
		}
		this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
	}

	// -----------------------------------------------------------------------
	// Step-level storage (new methods, kept alongside legacy turn methods)
	// -----------------------------------------------------------------------

	getSteps(sessionId: string): Array<{
		seq: number; turnGroup: number; role: string;
		content: string | null; inputTokens: number; outputTokens: number;
		totalTokens: number; createdAt: string;
	}> {
		const rows = this.db.prepare(
			"SELECT seq, turn_group, role, content, input_tokens, output_tokens, total_tokens, created_at " +
			"FROM turns WHERE session_id = ? ORDER BY seq",
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
		}));
	}

	getStepGroup(sessionId: string, turnGroup: number): Array<{
		seq: number; turnGroup: number; role: string;
		content: string | null; inputTokens: number; outputTokens: number;
		totalTokens: number; createdAt: string;
	}> {
		const rows = this.db.prepare(
			"SELECT seq, turn_group, role, content, input_tokens, output_tokens, total_tokens, created_at " +
			"FROM turns WHERE session_id = ? AND turn_group = ? ORDER BY seq",
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
		}));
	}

	appendStep(
		sessionId: string, seq: number, turnGroup: number,
		role: string, content: string | null,
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
	): void {
		this.ensureSession(sessionId);
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare(
				"INSERT INTO turns (session_id, seq, turn_group, role, content, input_tokens, output_tokens, total_tokens, created_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				sessionId, seq, turnGroup, role, content ?? null,
				usage?.inputTokens ?? 0,
				usage?.outputTokens ?? 0,
				usage?.totalTokens ?? 0,
				now,
			);
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	upsertStep(
		sessionId: string, seq: number, turnGroup: number,
		role: string, content: string | null,
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
	): void {
		this.ensureSession(sessionId);
		const now = new Date().toISOString();
		const existing = this.db.prepare(
			"SELECT 1 FROM turns WHERE session_id = ? AND seq = ?",
		).get(sessionId, seq);
		if (existing) {
			this.db.prepare(
				"UPDATE turns SET turn_group = ?, content = ?, input_tokens = ?, output_tokens = ?, total_tokens = ? " +
				"WHERE session_id = ? AND seq = ?",
			).run(
				turnGroup, content ?? null,
				usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage?.totalTokens ?? 0,
				sessionId, seq,
			);
		} else {
			this.db.prepare(
				"INSERT INTO turns (session_id, seq, turn_group, role, content, input_tokens, output_tokens, total_tokens, created_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				sessionId, seq, turnGroup, role, content ?? null,
				usage?.inputTokens ?? 0,
				usage?.outputTokens ?? 0,
				usage?.totalTokens ?? 0,
				now,
			);
		}
		this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
	}

	updateStepContent(
		sessionId: string, seq: number, content: string,
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
	): void {
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			if (usage) {
				this.db.prepare(
					"UPDATE turns SET content = ?, input_tokens = ?, output_tokens = ?, total_tokens = ? " +
					"WHERE session_id = ? AND seq = ?",
				).run(content, usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.totalTokens ?? 0, sessionId, seq);
			} else {
				this.db.prepare(
					"UPDATE turns SET content = ? WHERE session_id = ? AND seq = ?",
				).run(content, sessionId, seq);
			}
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	deleteStepGroup(sessionId: string, turnGroup: number): void {
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM turns WHERE session_id = ? AND turn_group = ?").run(sessionId, turnGroup);
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	getTurnGroupCount(sessionId: string): number {
		const row = this.db.prepare(
			"SELECT COUNT(DISTINCT turn_group) as cnt FROM turns WHERE session_id = ?",
		).get(sessionId) as any;
		return row.cnt;
	}

	/** Replace all turns for a session with step-level rows derived from messages.
	 *  Used after compression to sync the turns table with the compressed messages. */
	replaceStepsFromMessages(
		sessionId: string,
		steps: Array<{
			seq: number; turnGroup: number; role: string;
			content: string | null;
			usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
		}>,
	): void {
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(sessionId);
			const insert = this.db.prepare(
				"INSERT INTO turns (session_id, seq, turn_group, role, content, input_tokens, output_tokens, total_tokens, created_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			for (const s of steps) {
				insert.run(
					sessionId, s.seq, s.turnGroup, s.role, s.content ?? null,
					s.usage?.inputTokens ?? 0, s.usage?.outputTokens ?? 0, s.usage?.totalTokens ?? 0,
					now,
				);
			}
			this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
		});
		tx();
	}

	// -----------------------------------------------------------------------
	// Turn state (durable execution checkpointing)
	// -----------------------------------------------------------------------

	createTurnState(sessionId: string, turnSeq: number): void {
		const now = new Date().toISOString();
		try {
			this.db.prepare(
				`INSERT OR REPLACE INTO turn_state (session_id, turn_seq, phase, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`,
			).run(sessionId, turnSeq, now, now);
		} catch (e) {
			log.error("db", `createTurnState failed (session=${sessionId}, turn=${turnSeq}):`, (e as Error).message);
			throw e;
		}
	}

	updateTurnPhase(sessionId: string, turnSeq: number, phase: string, checkpoint?: any): void {
		const now = new Date().toISOString();
		try {
			this.db.prepare(
				"UPDATE turn_state SET phase = ?, checkpoint = ?, updated_at = ? WHERE session_id = ? AND turn_seq = ?",
			).run(phase, checkpoint ? JSON.stringify(checkpoint) : null, now, sessionId, turnSeq);
		} catch (e) {
			log.error("db", `updateTurnPhase failed (session=${sessionId}, turn=${turnSeq}, phase=${phase}):`, (e as Error).message);
			throw e;
		}
	}

	completeTurnState(sessionId: string, turnSeq: number): void {
		const now = new Date().toISOString();
		try {
			this.db.prepare(
				`UPDATE turn_state SET phase = 'completed', updated_at = ? WHERE session_id = ? AND turn_seq = ?`,
			).run(now, sessionId, turnSeq);
		} catch (e) {
			log.error("db", `completeTurnState failed (session=${sessionId}, turn=${turnSeq}):`, (e as Error).message);
			throw e;
		}
	}

	failTurnState(sessionId: string, turnSeq: number, error: string): void {
		const now = new Date().toISOString();
		try {
			this.db.prepare(
				`UPDATE turn_state SET phase = 'failed', error = ?, updated_at = ? WHERE session_id = ? AND turn_seq = ?`,
			).run(error, now, sessionId, turnSeq);
		} catch (e) {
			log.error("db", `failTurnState failed (session=${sessionId}, turn=${turnSeq}):`, (e as Error).message);
			throw e;
		}
	}

	getIncompleteTurns(): Array<{ sessionId: string; turnSeq: number; phase: string; checkpoint: any; error: string | null }> {
		try {
			const rows = this.db.prepare(
				`SELECT session_id, turn_seq, phase, checkpoint, error FROM turn_state WHERE phase NOT IN ('completed', 'failed')`,
			).all() as any[];
			return rows.map((r: any) => ({
				sessionId: r.session_id,
				turnSeq: r.turn_seq,
				phase: r.phase,
				checkpoint: r.checkpoint ? JSON.parse(r.checkpoint) : null,
				error: r.error,
			}));
		} catch (e) {
			log.error("db", "getIncompleteTurns failed:", (e as Error).message);
			throw e;
		}
	}

	cleanOldTurnState(maxAgeMs: number): void {
		const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
		try {
			// At startup, the previous process is gone — every row older than cutoff is stale.
			// This includes pending rows that would otherwise accumulate forever and cause
			// bogus recovery attempts on every subsequent startup.
			const result = this.db.prepare(
				`DELETE FROM turn_state WHERE updated_at < ?`,
			).run(cutoff);
			if (result.changes > 0) {
				log.db(`cleanOldTurnState removed ${result.changes} stale row(s) older than ${maxAgeMs}ms`);
			}
		} catch (e) {
			log.error("db", "cleanOldTurnState failed:", (e as Error).message);
			throw e;
		}
	}

		deleteTurnState(sessionId: string): void {
		this.db.prepare("DELETE FROM turn_state WHERE session_id = ?").run(sessionId);
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
		};
	}
}
