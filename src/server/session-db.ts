import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { log } from "../core/logger.js";
import type { SessionRecord } from "../shared/types.js";
import { KeyValueStore } from "./key-value-store.js";
import { MemoryStore } from "./memory-store.js";
import { ZERO_CORE_DIR } from "../core/config.js";

// ---------------------------------------------------------------------------
// SessionDB — SQLite-backed session & message persistence
// ---------------------------------------------------------------------------

export class SessionDB {
	private db: Database.Database;
	private kvStore: KeyValueStore;
	private memoryStore: MemoryStore;

	constructor(dbPath?: string) {
		const dir = join(dbPath ?? ZERO_CORE_DIR, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const path = dbPath ?? join(ZERO_CORE_DIR, "sessions.db");
		this.db = new Database(path);

		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");

		this.kvStore = new KeyValueStore(this.db);
		this.memoryStore = new MemoryStore(this.db);

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
				created_at  TEXT NOT NULL,
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
		`);
	}

	// Session CRUD
	// -----------------------------------------------------------------------

	createSession(agentId: string, title?: string): SessionRecord {
		const now = new Date().toISOString();
		const id = uuidv4();
		this.db.prepare(
			"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)",
		).run(id, agentId, title ?? null, now, now);
		return { id, agentId, isMain: false, title: title ?? null, createdAt: now, updatedAt: now };
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

	deleteSession(sessionId: string): void {
		this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
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
		this.db.prepare("DELETE FROM messages WHERE session_id = ? AND seq = ?").run(sessionId, seq);
		this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
	}

	updateMessageContent(sessionId: string, seq: number, content: string, msgJson: string): void {
		const now = new Date().toISOString();
		this.db.prepare(
			"UPDATE messages SET content = ?, msg_json = ? WHERE session_id = ? AND seq = ?",
		).run(content, msgJson, sessionId, seq);
		this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
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
		this.db.prepare(
			"INSERT INTO turns (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
		).run(sessionId, seq, role, content ?? null, now);
		this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
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
		this.db.prepare(
			"UPDATE turns SET content = ? WHERE session_id = ? AND seq = ?",
		).run(content, sessionId, seq);
		this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
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
			this.db.prepare(
				`DELETE FROM turn_state WHERE updated_at < ? AND phase IN ('completed', 'failed')`,
			).run(cutoff);
		} catch (e) {
			log.error("db", "cleanOldTurnState failed:", (e as Error).message);
			throw e;
		}
	}

		deleteTurnState(sessionId: string): void {
		this.db.prepare("DELETE FROM turn_state WHERE session_id = ?").run(sessionId);
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
		return {
			id: row.id,
			agentId: row.agent_id,
			isMain: row.is_main === 1,
			title: row.title,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}
}
