// Steps table: steps.turn_group column presence and appendStep write.
//
// # File Spec
//
// ## Core
// Verifies that the `steps` table (formerly `turns`) carries the mandatory
// `turn_group` column on a fresh DB, and that `appendStep` persists the
// supplied group for both user and assistant rows.
//
// The legacy `migrateTurnsToSteps` backfill migration has been REMOVED in
// steps-overhaul sub-1 (the physical `turns` table is DROPped on every
// startup in CoreDatabase.initSchema, so there is nothing to migrate). The
// earlier tests that exercised the backfill directly have been deleted along
// with it; this file now guards only the column-presence + write contract.
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

import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the schema for the steps table. */
function stepsColumns(db: Database.Database): string[] {
	return (db.pragma("table_info(steps)") as Array<{ name: string }>).map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Steps table · steps.turn_group column", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-steps-turn-group-"));
		dbPath = join(tmpDir, "core.db");
	});

	afterEach(() => {
		// Best-effort cleanup; ignore Windows EPERM from lingering DB file locks.
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	test("fresh DB: steps.turn_group column exists and appendStep persists the group", () => {
		let sessionDB: CoreDatabase | null = null;
		try {
			sessionDB = new CoreDatabase(dbPath);
			const raw = (sessionDB as any).db as Database.Database;

			// Column exists on a fresh DB.
			expect(stepsColumns(raw)).toContain("turn_group");

			// Migrations run cleanly on the empty DB.
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
});
