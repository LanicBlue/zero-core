// Step 4A acceptance test: turn_group backfill migration.
//
// # File Spec
//
// ## Core
// Verifies migrateTurnsToSteps (called from runMigrations) correctly backfills
// the now-mandatory `turn_group` column on legacy pre-step rows, and that the
// resulting turns table round-trips through rebuildFromSteps with valid
// user/assistant/tool pairing.
//
// Legacy shape coverage:
//   - -1 sentinel (what a fresh-DB CREATE TABLE turns ... DEFAULT -1 leaves on
//     rows inserted without an explicit turn_group, AND what safeAddColumn
//     DEFAULT -1 stamps on a pre-existing DB).
//   - NULL (what safeAddColumn leaves when added WITHOUT a default on an older
//     DB; reproduced by pre-creating the turns table with a nullable column
//     before SessionDB's CREATE TABLE IF NOT EXISTS runs).
//
// Backfill invariants (per docs/design/.../accept.md A3):
//   - user row      -> turn_group = its own seq
//   - assistant row -> turn_group = the most recent preceding user seq
//   - orphan assistant (no preceding user) -> turn_group = its own seq
//
// Plus: rebuildFromSteps round-trip, fresh-DB column presence + appendStep
// write, and idempotency (runMigrations twice -> identical rows).
//
// ## Acceptance
// docs/design/hook-redesign/steps/4A-drop-turns-table/accept.md (A3).
//
// ## Constraints
// - English test bodies.
// - sessions.db readonly invariant honored: every DB lives in a mkdtempSync
//   temp directory; the production ~/.zero-core/sessions.db is NEVER touched.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentSession } from "../../src/runtime/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read back the (seq, role, turn_group) for a session in seq order. */
function readRows(db: Database.Database, sessionId: string): Array<{ seq: number; role: string; turnGroup: number | null }> {
	return db.prepare(
		"SELECT seq, role, turn_group AS turnGroup FROM turns WHERE session_id = ? ORDER BY seq",
	).all(sessionId) as Array<{ seq: number; role: string; turnGroup: number | null }>;
}

/** Read the schema for the turns table. */
function turnsColumns(db: Database.Database): string[] {
	return (db.pragma("table_info(turns)") as Array<{ name: string }>).map((c) => c.name);
}

/** Insert a session row (FK target) directly via raw SQL. */
function ensureSession(db: Database.Database, sessionId: string): void {
	db.prepare(
		"INSERT OR IGNORE INTO sessions (id, agent_id, is_main, title, created_at, updated_at) " +
		"VALUES (?, '__legacy__', 0, NULL, ?, ?)",
	).run(sessionId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

/** Seed a legacy row with an explicit turn_group (-1 or NULL via raw UPDATE). */
function seedRow(
	db: Database.Database,
	sessionId: string,
	seq: number,
	role: string,
	content: string | null,
	turnGroup: number | null,
): void {
	ensureSession(db, sessionId);
	db.prepare(
		"INSERT INTO turns (session_id, seq, role, content, created_at, turn_group) " +
		"VALUES (?, ?, ?, ?, ?, ?)",
	).run(sessionId, seq, role, content, `2026-01-01T00:00:0${seq}.000Z`, turnGroup === null ? null : turnGroup);
}

/** Recreate the turns table with a NULLABLE turn_group column (mirrors an old
 *  DB where safeAddColumn ran without a default). Must run BEFORE SessionDB's
 *  CREATE TABLE IF NOT EXISTS so the IF NOT EXISTS no-ops. */
function preCreateLegacyTurnsTable(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			agent_id TEXT,
			is_main INTEGER NOT NULL DEFAULT 0,
			title TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS turns (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			content TEXT,
			compressed INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			-- nullable on the legacy DB: safeAddColumn added it without a default
			turn_group INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_turns_session_seq ON turns(session_id, seq);
	`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Step 4A · A3: turn_group backfill migration", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-4a-turn-migration-"));
		dbPath = join(tmpDir, "sessions.db");
	});

	afterEach(() => {
		// Best-effort cleanup; ignore Windows EPERM from lingering DB file locks.
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	test("legacy -1 sentinel rows backfill: user->own seq, assistant->last user seq", () => {
		let sessionDB: SessionDB | null = null;
		try {
			const sessionDB0 = new SessionDB(dbPath);
			const sessionId = "mig-sentinel";
			const raw = (sessionDB0 as any).db as Database.Database;

			// Two-turn conversation, all rows carrying the -1 sentinel.
			seedRow(raw, sessionId, 0, "user", "hello", -1);
			seedRow(raw, sessionId, 1, "assistant", "hi", -1);
			seedRow(raw, sessionId, 2, "user", "again", -1);
			seedRow(raw, sessionId, 3, "assistant", "reply", -1);
			seedRow(raw, sessionId, 4, "assistant", "extra", -1);

			const before = readRows(raw, sessionId);
			expect(before.map((r) => r.turnGroup)).toEqual([-1, -1, -1, -1, -1]);
			sessionDB0.close();

			// Re-open and run the migration (production startup path).
			sessionDB = new SessionDB(dbPath);
			runMigrations(sessionDB);
			const raw2 = (sessionDB as any).db as Database.Database;

			const after = readRows(raw2, sessionId);
			// user seq 0 -> group 0 ; assistant seq 1 -> group 0
			// user seq 2 -> group 2 ; assistant seq 3,4 -> group 2
			expect(after.map((r) => r.turnGroup)).toEqual([0, 0, 2, 2, 2]);
			expect(after.map((r) => r.role)).toEqual(["user", "assistant", "user", "assistant", "assistant"]);
		} finally {
			sessionDB?.close();
		}
	});

	test("legacy NULL rows backfill identically (old DB with nullable column)", () => {
		let sessionDB: SessionDB | null = null;
		try {
			// Pre-create the turns table with a NULLABLE turn_group column so we
			// can seed genuine NULLs (the current schema enforces NOT NULL).
			const raw0 = new Database(dbPath);
			preCreateLegacyTurnsTable(raw0);
			const sessionId = "mig-null";
			seedRow(raw0, sessionId, 0, "user", "hello", null);
			seedRow(raw0, sessionId, 1, "assistant", "hi", null);
			seedRow(raw0, sessionId, 2, "user", "again", null);
			seedRow(raw0, sessionId, 3, "assistant", "reply", null);
			raw0.close();

			sessionDB = new SessionDB(dbPath);
			runMigrations(sessionDB);
			const raw = (sessionDB as any).db as Database.Database;

			const after = readRows(raw, sessionId);
			expect(after.map((r) => r.turnGroup)).toEqual([0, 0, 2, 2]);
		} finally {
			sessionDB?.close();
		}
	});

	test("orphan assistant (no preceding user) falls back to its own seq", () => {
		let sessionDB: SessionDB | null = null;
		try {
			const sessionDB0 = new SessionDB(dbPath);
			const sessionId = "mig-orphan";
			const raw = (sessionDB0 as any).db as Database.Database;

			seedRow(raw, sessionId, 0, "assistant", "stray", -1);
			seedRow(raw, sessionId, 1, "user", "first real user", -1);
			seedRow(raw, sessionId, 2, "assistant", "answers user", -1);
			sessionDB0.close();

			sessionDB = new SessionDB(dbPath);
			runMigrations(sessionDB);
			const raw2 = (sessionDB as any).db as Database.Database;

			const after = readRows(raw2, sessionId);
			// orphan assistant seq 0 -> own seq 0 ; user seq 1 -> group 1 ;
			// assistant seq 2 -> group 1.
			expect(after.map((r) => r.turnGroup)).toEqual([0, 1, 1]);
		} finally {
			sessionDB?.close();
		}
	});

	test("migrated rows round-trip through rebuildFromSteps with legal pairing", () => {
		let sessionDB: SessionDB | null = null;
		try {
			const sessionDB0 = new SessionDB(dbPath);
			const sessionId = "mig-rebuild";
			const raw = (sessionDB0 as any).db as Database.Database;

			// Content is JSON-encoded block arrays matching the step-row
			// contract (rebuildFromSteps parses each non-user row's content as
			// a block array).
			const userBlocks = JSON.stringify([{ type: "text", text: "ping" }]);
			const assistantBlocks = JSON.stringify([{ type: "text", text: "pong" }]);
			seedRow(raw, sessionId, 0, "user", userBlocks, -1);
			seedRow(raw, sessionId, 1, "assistant", assistantBlocks, -1);
			sessionDB0.close();

			sessionDB = new SessionDB(dbPath);
			runMigrations(sessionDB);

			// Constructor runs rebuildFromTurns() eagerly over migrated rows.
			const sess = new AgentSession("system", 128000, sessionId, sessionDB as any);
			const messages = sess.rebuildFromTurns();

			// User message followed by an assistant message — legal pairing.
			expect(messages.length).toBeGreaterThanOrEqual(2);
			expect(messages[0].role).toBe("user");
			expect(messages[1].role).toBe("assistant");
		} finally {
			sessionDB?.close();
		}
	});

	test("fresh DB: turns.turn_group column exists and appendStep persists the group", () => {
		let sessionDB: SessionDB | null = null;
		try {
			sessionDB = new SessionDB(dbPath);
			const raw = (sessionDB as any).db as Database.Database;

			// Column exists on a fresh DB.
			expect(turnsColumns(raw)).toContain("turn_group");

			// Migrations on the empty DB are a no-op for backfill.
			runMigrations(sessionDB);

			// Write steps through the production path.
			const sessionId = "fresh-write";
			sessionDB.appendStep(sessionId, 0, 0, "user", "u");
			sessionDB.appendStep(sessionId, 1, 0, "assistant", "a");

			const steps = sessionDB.getSteps(sessionId);
			expect(steps.length).toBe(2);
			expect(steps[0].role).toBe("user");
			expect(steps[0].turnGroup).toBe(0);
			expect(steps[1].role).toBe("assistant");
			expect(steps[1].turnGroup).toBe(0);
		} finally {
			sessionDB?.close();
		}
	});

	test("idempotent: running runMigrations twice yields identical rows", () => {
		let sessionDB1: SessionDB | null = null;
		let sessionDB2: SessionDB | null = null;
		try {
			const sessionDB0 = new SessionDB(dbPath);
			const sessionId = "mig-idempotent";
			const raw = (sessionDB0 as any).db as Database.Database;
			seedRow(raw, sessionId, 0, "user", "u", -1);
			seedRow(raw, sessionId, 1, "assistant", "a", -1);
			seedRow(raw, sessionId, 2, "user", "u2", -1);
			seedRow(raw, sessionId, 3, "assistant", "a2", -1);
			sessionDB0.close();

			// First migration pass.
			sessionDB1 = new SessionDB(dbPath);
			runMigrations(sessionDB1);
			const raw1 = (sessionDB1 as any).db as Database.Database;
			const after1 = readRows(raw1, sessionId);
			sessionDB1.close();
			sessionDB1 = null;

			// Second pass (idempotency): re-open and re-run.
			sessionDB2 = new SessionDB(dbPath);
			runMigrations(sessionDB2);
			const raw2 = (sessionDB2 as any).db as Database.Database;
			const after2 = readRows(raw2, sessionId);

			expect(after1).toEqual(after2);
			// And the values are the expected backfill, not the legacy sentinels.
			expect(after2.map((r) => r.turnGroup)).toEqual([0, 0, 2, 2]);
		} finally {
			sessionDB1?.close();
			sessionDB2?.close();
		}
	});
});
