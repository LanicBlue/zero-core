// multimodal-input sub-2 acceptance test: steps.attachments column.
//
// # File Spec
//
// ## Core
// Adversarial verification of docs/plan/multimodal-input/acceptance-2.md.
// Independent from the implementer — exercises the real CoreDatabase +
// AgentSession.rebuildFromTurns against temp DBs, asserts the wire shape and
// back-compat invariants, not the implementer's claims.
//
// ## Acceptance cases (acceptance-2.md)
//   1. step `content` stays a plain string; `attachments` is the new field.
//   2. appendStep/upsertStep carry `attachments`; the steps table writes them
//      to the `attachments` column. (steps-overhaul sub-3: replaceStepsFromMessages
//      was deleted; it is no longer part of this acceptance case.)
//   3. steps table has the `attachments TEXT` column; initSchema ran
//      `safeAddColumn(db,"steps","attachments","TEXT")`.
//   4. fresh DB (no legacy column to migrate) — column present, no crash.
//   5. legacy DB (steps table pre-exists WITHOUT the column) — startup adds
//      the column via safeAddColumn and reads legacy rows as undefined (the
//      non-COLUMNS-array path called out in the plan).
//   6. restart recovery: rebuildFromTurns / refreshTurnsCache load attachments
//      into the in-memory CachedTurnData so a restart doesn't drop them.
//
// ## Storage shape
// steps.attachments = JSON.stringify(AttachmentMeta[]) | NULL. NULL on legacy
// rows / rows with no attachments (read back as undefined).
//
// ## Constraints
// - sessions.db readonly invariant: every DB lives in a mkdtempSync temp dir;
//   production ~/.zero-core/sessions.db is NEVER touched.
// - English test bodies.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { CoreDatabase } from "../../src/server/core-database.js";
import { AgentSession } from "../../src/runtime/session.js";
import type { AttachmentMeta } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read back the raw `attachments` column value for a session in seq order. */
function readAttachmentsColumn(db: Database.Database, sessionId: string): Array<string | null> {
	const rows = db.prepare(
		"SELECT attachments FROM steps WHERE session_id = ? ORDER BY seq",
	).all(sessionId) as Array<{ attachments: string | null } | undefined>;
	return rows.map((r) => r?.attachments ?? null);
}

/** Column names of the steps table (post-migration). */
function turnsColumns(db: Database.Database): string[] {
	return (db.pragma("table_info(steps)") as Array<{ name: string }>).map((c) => c.name);
}

/** Insert a session row (FK target) directly via raw SQL. */
function ensureSession(db: Database.Database, sessionId: string): void {
	db.prepare(
		"INSERT OR IGNORE INTO sessions (id, agent_id, is_main, title, created_at, updated_at) " +
		"VALUES (?, '__test__', 0, NULL, ?, ?)",
	).run(sessionId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

/** Build a deterministic attachment meta for tests. */
function makeAttachment(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
	return {
		id: overrides.id ?? "att-001",
		kind: overrides.kind ?? "image",
		fileName: overrides.fileName ?? "photo.png",
		mimeType: overrides.mimeType ?? "image/png",
		size: overrides.size ?? 12345,
		diskPath: overrides.diskPath ?? "/tmp/zero-core/attachments/sess-1/att-001-photo.png",
	};
}

/**
 * Pre-create the turns table WITHOUT the attachments column, mirroring a DB
 * from before sub-2 shipped. Must run BEFORE CoreDatabase's CREATE TABLE IF NOT
 * EXISTS so the IF NOT EXISTS no-ops and CoreDatabase has to safeAddColumn it.
 */
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
		CREATE TABLE IF NOT EXISTS steps (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			content TEXT,
			compressed INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			turn_group INTEGER NOT NULL DEFAULT -1,
			input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_steps_session_seq ON steps(session_id, seq);
	`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("multimodal-input sub-2: steps.attachments column", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-mm-sub2-turns-att-"));
		dbPath = join(tmpDir, "core.db");
	});

	afterEach(() => {
		// Best-effort cleanup; ignore Windows EPERM from lingering DB file locks.
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	test("fresh DB: steps.attachments column exists after initSchema", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const raw = (sessionDB as any).db as Database.Database;
			expect(turnsColumns(raw)).toContain("attachments");
		} finally {
			sessionDB?.close();
		}
	});

	test("appendStep with attachments persists JSON to steps.attachments and getSteps reads it back", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const raw = (sessionDB as any).db as Database.Database;
			const sessionId = "fresh-att";
			const attachments = [makeAttachment(), makeAttachment({ id: "att-002", kind: "pdf", fileName: "doc.pdf", mimeType: "application/pdf", size: 67890 })];

			// User step WITH attachments; assistant step WITHOUT (omitted arg).
			sessionDB.appendStep(sessionId, 0, 0, "user", "hello with image", undefined, attachments);
			sessionDB.appendStep(sessionId, 1, 0, "assistant", "[]");

			// Raw column value is the JSON string.
			const rawCols = readAttachmentsColumn(raw, sessionId);
			expect(rawCols[0]).toBe(JSON.stringify(attachments));
			expect(rawCols[1]).toBeNull();

			// getSteps parses it back into AttachmentMeta[].
			const steps = sessionDB.getSteps(sessionId);
			expect(steps.length).toBe(2);
			expect(steps[0].role).toBe("user");
			// content stays a plain string (design principle A — never JSON).
			expect(steps[0].content).toBe("hello with image");
			expect(steps[0].attachments).toEqual(attachments);
			expect(steps[1].role).toBe("assistant");
			expect(steps[1].attachments).toBeUndefined();
		} finally {
			sessionDB?.close();
		}
	});

	test("appendStep with no attachments arg writes NULL (legacy-equivalent row)", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const raw = (sessionDB as any).db as Database.Database;
			const sessionId = "no-att";

			sessionDB.appendStep(sessionId, 0, 0, "user", "plain text");

			expect(readAttachmentsColumn(raw, sessionId)).toEqual([null]);
			const steps = sessionDB.getSteps(sessionId);
			expect(steps[0].attachments).toBeUndefined();
		} finally {
			sessionDB?.close();
		}
	});

	test("appendStep with empty attachments array writes NULL (treated as no attachments)", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const raw = (sessionDB as any).db as Database.Database;
			const sessionId = "empty-att";

			sessionDB.appendStep(sessionId, 0, 0, "user", "text", undefined, []);

			expect(readAttachmentsColumn(raw, sessionId)).toEqual([null]);
			const steps = sessionDB.getSteps(sessionId);
			expect(steps[0].attachments).toBeUndefined();
		} finally {
			sessionDB?.close();
		}
	});

	test("upsertStep: INSERT path writes attachments; UPDATE path overwrites attachments", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const raw = (sessionDB as any).db as Database.Database;
			const sessionId = "upsert-att";
			const att1 = [makeAttachment({ id: "u-1" })];
			const att2 = [makeAttachment({ id: "u-2", kind: "file", fileName: "data.csv", mimeType: "text/csv" })];

			// INSERT path (no existing row).
			sessionDB.upsertStep(sessionId, 0, 0, "user", "v1", undefined, att1);
			expect(readAttachmentsColumn(raw, sessionId)).toEqual([JSON.stringify(att1)]);

			// UPDATE path (existing row) — attachments replaced.
			sessionDB.upsertStep(sessionId, 0, 0, "user", "v2", undefined, att2);
			expect(readAttachmentsColumn(raw, sessionId)).toEqual([JSON.stringify(att2)]);
			const steps = sessionDB.getSteps(sessionId);
			expect(steps[0].content).toBe("v2");
			expect(steps[0].attachments).toEqual(att2);
		} finally {
			sessionDB?.close();
		}
	});

	// steps-overhaul sub-3: the replaceStepsFromMessages test is REMOVED —
	// that method was deleted (it was the destructive "rebuild steps from
	// compressed messages" path used by old L1/L2 compression; with messages
	// redefined to summary+cursor there is no caller). The attachments round-
	// trip is fully covered by the appendStep / upsertStep cases above.

	test("legacy DB (no attachments column) → startup safeAddColumn adds it; legacy rows read back as undefined", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			// Pre-create the turns table WITHOUT the attachments column, mirroring
			// a DB from before sub-2 shipped. Seed a legacy row directly.
			const raw0 = new Database(dbPath);
			preCreateLegacyTurnsTable(raw0);
			const sessionId = "legacy";
			ensureSession(raw0, sessionId);
			raw0.prepare(
				"INSERT INTO steps (session_id, seq, role, content, created_at, turn_group) " +
				"VALUES (?, ?, ?, ?, ?, ?)",
			).run(sessionId, 0, "user", "legacy text", "2026-01-01T00:00:00.000Z", 0);
			raw0.close();

			// Open via CoreDatabase — initSchema.safeAddColumn must add the column
			// and NOT crash (this is the non-COLUMNS-array path called out in
			// the plan — turns has no *_COLUMNS array).
			sessionDB = new CoreDatabase(dbPath);
			const raw = (sessionDB as any).db as Database.Database;
			expect(turnsColumns(raw)).toContain("attachments");

			// Legacy row's attachments column is NULL → reads back as undefined.
			const steps = sessionDB.getSteps(sessionId);
			expect(steps.length).toBe(1);
			expect(steps[0].content).toBe("legacy text");
			expect(steps[0].attachments).toBeUndefined();

			// And new writes still work post-migration.
			sessionDB.appendStep(sessionId, 1, 0, "assistant", "[]", undefined, [makeAttachment({ id: "post-mig" })]);
			const after = sessionDB.getSteps(sessionId);
			expect(after[1].attachments).toEqual([makeAttachment({ id: "post-mig" })]);
		} finally {
			sessionDB?.close();
		}
	});

	test("corrupt JSON in steps.attachments reads back as undefined (read tolerance)", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const raw = (sessionDB as any).db as Database.Database;
			const sessionId = "corrupt";
			ensureSession(raw, sessionId);
			// Write a malformed attachments value directly.
			raw.prepare(
				"INSERT INTO steps (session_id, seq, role, content, created_at, turn_group, attachments) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(sessionId, 0, "user", "txt", "2026-01-01T00:00:00.000Z", 0, "{not valid json");

			const steps = sessionDB.getSteps(sessionId);
			expect(steps.length).toBe(1);
			expect(steps[0].content).toBe("txt");
			expect(steps[0].attachments).toBeUndefined();
		} finally {
			sessionDB?.close();
		}
	});

	test("rebuildFromTurns / refreshTurnsCache load attachments into CachedTurnData (restart recovery)", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const sessionId = "rebuild-att";
			const attachments = [
				makeAttachment({ id: "rb-1" }),
				makeAttachment({ id: "rb-2", kind: "pdf", fileName: "doc.pdf", mimeType: "application/pdf", size: 999 }),
			];

			// Persist a user step with attachments.
			sessionDB.appendStep(sessionId, 0, 0, "user", "with attachments", undefined, attachments);

			// Constructor calls rebuildFromTurns() eagerly — cached turns must
			// carry the attachments.
			const sess = new AgentSession("system", 128000, sessionId, sessionDB as any);
			const cached = sess.getCachedTurns();
			expect(cached.length).toBe(1);
			expect(cached[0].role).toBe("user");
			expect(cached[0].content).toBe("with attachments");
			expect(cached[0].attachments).toEqual(attachments);

			// refreshTurnsCache() should also pick them up.
			sess.refreshTurnsCache();
			const refreshed = sess.getCachedTurns();
			expect(refreshed[0].attachments).toEqual(attachments);
		} finally {
			sessionDB?.close();
		}
	});

	test("rebuildFromTurns on legacy rows (no attachments) yields cached turns with undefined attachments", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const sessionId = "rebuild-legacy";
			// Write WITHOUT the attachments arg — legacy-equivalent row.
			sessionDB.appendStep(sessionId, 0, 0, "user", "legacy");
			sessionDB.appendStep(sessionId, 1, 0, "assistant", "[]");

			const sess = new AgentSession("system", 128000, sessionId, sessionDB as any);
			const cached = sess.getCachedTurns();
			expect(cached.length).toBe(2);
			expect(cached[0].attachments).toBeUndefined();
			expect(cached[1].attachments).toBeUndefined();
		} finally {
			sessionDB?.close();
		}
	});

	test("getStepGroup reads attachments back for a single turn group", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const sessionId = "group-att";
			const att = [makeAttachment({ id: "g-1" })];

			sessionDB.appendStep(sessionId, 0, 0, "user", "u", undefined, att);
			sessionDB.appendStep(sessionId, 1, 0, "assistant", "[]");
			sessionDB.appendStep(sessionId, 2, 1, "user", "second turn");

			const group0 = sessionDB.getStepGroup(sessionId, 0);
			expect(group0.length).toBe(2);
			expect(group0[0].attachments).toEqual(att);
			expect(group0[1].attachments).toBeUndefined();

			const group1 = sessionDB.getStepGroup(sessionId, 1);
			expect(group1.length).toBe(1);
			expect(group1[0].attachments).toBeUndefined();
		} finally {
			sessionDB?.close();
		}
	});
});
