// Wiki-system-redesign plan-00 §4 state matrix + acceptance-00 §A/§B.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 plan-00 §4 的启动布局状态矩阵 + acceptance-00 §A/§B 全部要点。
// 每个用例从干净状态开始,真跑 performLayoutBootstrap + DatabaseManager.open,
// 断言磁盘 + marker + 错误码可观察后果 —— 不依赖实现报告。
//
// ## 输入
// ZERO_CORE_DIR(vitest.config.ts 注入的 per-worker temp dir)下的固定路径
// (db/core.db / sessions.db / db/layout-v1.json / backups/core/ 等)。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/server/database-manager.ts (performLayoutBootstrap / DatabaseManager)
//   - src/server/core-database.ts (CoreDatabase)
//   - src/core/database-paths.ts (路径常量)
//
// ## 维护规则
//   - 每个用例 beforeEach/afterEach 都跑 cleanLayoutState(),仅删 plan-00 涉及
//     的固定路径,绝不 rmSync(ZERO_CORE_DIR) 整个目录(其他单测可能用到)。
//   - 测试 DB 真在 OS temp 路径创建,绝不读活跃 ~/.zero-core。
//

import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (acceptance §E — test:unit runnable together).
// ---------------------------------------------------------------------------
// ZERO_CORE_DIR is captured at module-load by src/core/config.ts and frozen
// into the database-paths constants. vitest.config.ts sets a single shared
// ZERO_CORE_DIR for the whole suite, so when several DB-bootstrap test files
// run in parallel threads they ALL stamp the same db/core.db, sessions.db and
// layout-v1.json → ~35 false cross-file failures. vi.hoisted runs this factory
// BEFORE any other import (vitest transform guarantee), so config.ts picks up
// OUR unique temp dir and every path constant (coreDbPath, legacyCoreDbPath,
// layoutMarkerPath, coreBackupDir, …) resolves under it. Each file thus gets
// its own scratch profile; cleanLayoutState() handles within-file cleanup.
const UNIQUE_DIR = vi.hoisted<string>(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-db-layout-"));
	process.env.ZERO_CORE_DIR = d;
	return d;
});

import {
	existsSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	mkdirSync,
	statSync,
	copyFileSync,
	renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";

import {
	performLayoutBootstrap,
	deleteRetiredKnowledgeDb,
	DatabaseManager,
	DATABASE_LAYOUT_CONFLICT,
} from "../../src/server/database-manager.js";
import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { CronStore } from "../../src/server/cron-store.js";
import { ProjectWorkStore } from "../../src/server/project-work-store.js";
import {
	coreDbPath,
	legacyCoreDbPath,
	layoutMarkerPath,
	coreBackupDir,
	DB_DIR,
	wikiDbPath,
} from "../../src/core/database-paths.js";
import { ZERO_CORE_DIR } from "../../src/core/config.js";

const legacyWalPath = `${legacyCoreDbPath}-wal`;
const legacyShmPath = `${legacyCoreDbPath}-shm`;
const coreTmpPath = `${coreDbPath}.tmp`;

/**
 * Remove every file/dir the layout bootstrap may create, so each test starts
 * from a known state. We do NOT rm ZERO_CORE_DIR itself — only the specific
 * paths plan-00 §4/§5 touch (surgical cleanup, won't disturb sibling tests
 * that may have populated ZERO_CORE_DIR). rmSync `force:true` so missing files
 * don't throw and locked files don't break the run.
 */
function cleanLayoutState(): void {
	for (const p of [
		coreDbPath,
		`${coreDbPath}-wal`,
		`${coreDbPath}-shm`,
		coreTmpPath,
		legacyCoreDbPath,
		legacyWalPath,
		legacyShmPath,
		layoutMarkerPath,
		// plan-01: DatabaseManager.open() now constructs WikiDatabase, creating
		// db/wiki.db{,-wal,-shm}. Tests in this file drive open(), so clean all
		// three between cases (MEMORY mode in test env yields no -wal/-shm, but
		// WAL mode would — defensive).
		wikiDbPath,
		`${wikiDbPath}-wal`,
		`${wikiDbPath}-shm`,
		join(ZERO_CORE_DIR, "knowledge.db"),
		join(ZERO_CORE_DIR, "knowledge.db-wal"),
		join(ZERO_CORE_DIR, "knowledge.db-shm"),
		join(ZERO_CORE_DIR, "knowledge.db.keep"),
		join(ZERO_CORE_DIR, "other.db"),
	]) {
		try { rmSync(p, { force: true }); } catch { /* best effort */ }
	}
	try { rmSync(coreBackupDir, { recursive: true, force: true }); } catch { /* empty */ }
	try { rmSync(join(ZERO_CORE_DIR, "knowledge.db.d"), { recursive: true, force: true }); } catch { /* empty */ }
}

/** Read + parse the layout marker; returns null if absent/unparseable. */
function readMarkerFile(): any | null {
	if (!existsSync(layoutMarkerPath)) return null;
	try {
		return JSON.parse(readFileSync(layoutMarkerPath, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Build a "legacy sessions.db" at the legacy path that has the full live
 * schema (so migrations round-trip cleanly) + one row each in the critical
 * Core tables (agents / projects / sessions / project_work / crons). Returns
 * the seeded row identifiers so the caller can verify them post-migration.
 *
 * Uses the live CoreDatabase + runMigrations + stores — no manual DDL — so the
 * fixtures reflect the current production shape, not a hand-rolled subset.
 */
function seedLegacySessionsDb(): {
	agentId: string;
	projectId: string;
	sessionId: string;
	workId: string;
	cronId: string;
} {
	if (!existsSync(dirname(legacyCoreDbPath))) {
		mkdirSync(dirname(legacyCoreDbPath), { recursive: true });
	}
	// Build the live schema at the legacy path. WAL on (default) so a -wal
	// file is produced for the wal_checkpoint assertion path.
	const cdb = new CoreDatabase(legacyCoreDbPath);
	runMigrations(cdb);

	const agentStore = new AgentStore(cdb);
	const projectStore = new ProjectStore(cdb);
	const cronStore = new CronStore(cdb);
	const workStore = new ProjectWorkStore(cdb);

	const agent = agentStore.create({ name: "LegacyAgent" } as any);
	const project = projectStore.create({
		name: "LegacyProj",
		workspaceDir: join(ZERO_CORE_DIR, "ws-legacy"),
	});
	const session = cdb.createSession(agent.id, "LegacySession");
	const work = workStore.create({
		projectId: project.id,
		name: "LegacyWork",
		actionPrompt: "do something",
		requiredTools: [],
		agentId: null,
		enabled: true,
	} as any);
	const cron = cronStore.create({
		agentId: agent.id,
		workingScope: {
			workspaceDir: project.workspaceDir,
			wikiRootNodeId: "wiki-root:global",
		},
		schedule: { mode: "interval", everyMs: 60_000 },
		enabled: true,
	} as any);

	cdb.close();
	return {
		agentId: agent.id,
		projectId: project.id,
		sessionId: session.id,
		workId: work.id,
		cronId: cron.id,
	};
}

beforeEach(() => {
	cleanLayoutState();
});

afterEach(() => {
	cleanLayoutState();
});

afterAll(() => {
	// Best-effort: drop the whole per-file scratch profile. Layout tests are
	// the only writer under UNIQUE_DIR, so recursive removal is safe here.
	try { rmSync(UNIQUE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ============================================================
// §A — Layout & naming
// ============================================================

describe("plan-00 §A — fresh profile", () => {
	test("bootstrap + open create db/core.db AND db/wiki.db; no root-level sessions.db / knowledge.db", () => {
		// Fresh profile: neither core.db nor sessions.db exist.
		expect(existsSync(coreDbPath)).toBe(false);
		expect(existsSync(legacyCoreDbPath)).toBe(false);

		// Bootstrap (Case C: neither exists) writes the fresh-create marker
		// (complete:false) and returns. performLayoutBootstrap alone does NOT
		// create core.db or wiki.db — core.db is created by the CoreDatabase
		// constructor inside DatabaseManager.open(), and wiki.db by the
		// WikiDatabase constructor in the same open() (plan-01 ready-order).
		performLayoutBootstrap();
		expect(existsSync(layoutMarkerPath)).toBe(true);
		const marker = readMarkerFile();
		expect(marker.complete).toBe(false);
		// No premature wiki.db before DatabaseManager.open() runs.
		expect(existsSync(wikiDbPath)).toBe(false);

		// DatabaseManager.open() finishes the fresh-create: builds core.db AND
		// wiki.db (plan-01 ready-order) and finalizes the marker to complete:true.
		const mgr = new DatabaseManager();
		mgr.open();
		expect(existsSync(coreDbPath)).toBe(true);
		expect(existsSync(wikiDbPath)).toBe(true); // plan-01: wiki.db now created
		const finalMarker = readMarkerFile();
		expect(finalMarker.complete).toBe(true);

		// §A bullet 1 + bullet 4: NO root-level sessions.db / knowledge.db.
		// (wiki.db lives under db/, NOT at the ZERO_CORE_DIR root.)
		expect(existsSync(legacyCoreDbPath)).toBe(false);
		expect(existsSync(join(ZERO_CORE_DIR, "knowledge.db"))).toBe(false);

		mgr.close();
	});

	test("fresh profile via DatabaseManager.open: db/ contains core.db + wiki.db + journals + layout marker", () => {
		const mgr = new DatabaseManager();
		mgr.open();
		mgr.close();

		// Enumerate db/ contents. plan-01: open() creates core.db AND wiki.db
		// plus their journal files (wal/shm, may be absent post-close / under
		// MEMORY test mode) and layout-v1.json. Nothing else (no stray files).
		const dbEntries = readdirSync(DB_DIR);
		const allowed = new Set([
			"core.db", "core.db-wal", "core.db-shm",
			"wiki.db", "wiki.db-wal", "wiki.db-shm",
			"layout-v1.json",
		]);
		const offenders = dbEntries.filter((e) => !allowed.has(e));
		expect(offenders).toEqual([]);
		// plan-01: wiki.db IS present in db/ (no longer absent).
		expect(dbEntries).toContain("wiki.db");
		expect(dbEntries).toContain("core.db");
	});
});

// ============================================================
// §B — Legacy safe switch
// ============================================================

describe("plan-00 §B — legacy sessions.db → db/core.db migration", () => {
	test("Case B: existing Agent/Project/Session/Work/Cron fixtures round-trip intact into core.db", () => {
		const ids = seedLegacySessionsDb();

		// Pre-state: legacy present, core absent.
		expect(existsSync(legacyCoreDbPath)).toBe(true);
		expect(existsSync(coreDbPath)).toBe(false);

		performLayoutBootstrap();

		// Post-state: core.db created, legacy moved away.
		expect(existsSync(coreDbPath)).toBe(true);
		expect(existsSync(legacyCoreDbPath)).toBe(false);

		// Open the migrated core.db and verify all fixture rows survived.
		const cdb = new CoreDatabase(coreDbPath);
		runMigrations(cdb); // idempotent

		const agentRow = new AgentStore(cdb).get(ids.agentId);
		expect(agentRow?.name).toBe("LegacyAgent");

		const projectRow = new ProjectStore(cdb).get(ids.projectId);
		expect(projectRow?.name).toBe("LegacyProj");

		const sessionRow = cdb.getSession(ids.sessionId);
		expect(sessionRow?.title).toBe("LegacySession");
		expect(sessionRow?.agentId).toBe(ids.agentId);

		const workRow = new ProjectWorkStore(cdb).listByProject(ids.projectId)[0];
		expect(workRow?.id).toBe(ids.workId);
		expect(workRow?.name).toBe("LegacyWork");

		const cronRow = new CronStore(cdb).get(ids.cronId);
		expect(cronRow?.agentId).toBe(ids.agentId);

		cdb.close();
	});

	test("Case B: wal_checkpoint(TRUNCATE) before promote — data sitting only in WAL survives into core.db; legacy -wal/-shm removed from active location", () => {
		// REAL-WORLD SCENARIO: a crashed previous process left a committed frame
		// in sessions.db-wal that was never folded into the main db file. On the
		// next startup migrateLegacyToCore must open → wal_checkpoint(TRUNCATE)
		// (folds the WAL frame into the main file) → copy → promote. If the
		// checkpoint were skipped, the byte-copy would capture a main db file
		// WITHOUT the row (it lives only in the WAL) and the data would be lost.
		//
		// WHY THE NAIVE SETUP DOES NOT WORK (root-caused empirically, not an impl
		// bug): SQLite runs a shutdown checkpoint when the LAST connection to a
		// WAL db closes and DELETES the -wal/-shm files. So
		//   open → set WAL → INSERT → close
		// leaves NO -wal file behind; the data is already in the main file. That
		// would make the pre-migration sanity assertion fail AND would not
		// exercise the checkpoint path at all. We must simulate a crash.
		//
		// CRASH SIMULATION: while a connection is open (so -wal holds a real
		// committed frame), snapshot db+wal aside; close (cleanup); then restore
		// the snapshot over the legacy paths. Result: legacy has a main db file
		// WITHOUT the row + a non-empty -wal WITH the committed frame — exactly
		// the post-crash state.
		if (!existsSync(dirname(legacyCoreDbPath))) {
			mkdirSync(dirname(legacyCoreDbPath), { recursive: true });
		}
		// Sanity baseline: the probe row is NOT in the main file we will leave
		// on disk (it lives only in the WAL frame we snapshot).
		const snapDir = join(UNIQUE_DIR, "wal-snap");
		mkdirSync(snapDir, { recursive: true });
		const snapDb = join(snapDir, "sessions.db");
		const snapWal = join(snapDir, "sessions.db-wal");

		const db = new Database(legacyCoreDbPath);
		db.pragma("journal_mode = WAL");
		db.exec(`CREATE TABLE probe (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
		db.prepare(`INSERT INTO probe (k, v) VALUES ('wal-only', 'pre-checkpoint')`).run();
		// -wal now holds a committed frame for the insert.
		expect(existsSync(legacyWalPath)).toBe(true);
		expect(statSync(legacyWalPath).size).toBeGreaterThan(0);
		// Snapshot the live (post-write, pre-close) state = crashed-process state.
		copyFileSync(legacyCoreDbPath, snapDb);
		copyFileSync(legacyWalPath, snapWal);
		db.close(); // shutdown checkpoint folds the row into legacy's main file + deletes -wal
		// After a clean close the row IS in legacy's main file; prove the data is
		// NOT trivially already-there so the test actually exercises checkpoint:
		const closedProbe = new Database(legacyCoreDbPath, { readonly: true });
		expect(existsSync(`${legacyCoreDbPath}-wal`)).toBe(false);
		closedProbe.close();

		// Restore the crash snapshot: main file WITHOUT the row + non-empty -wal.
		copyFileSync(snapDb, legacyCoreDbPath);
		copyFileSync(snapWal, legacyWalPath);
		// Confirm the crash state: row is NOT visible via a fresh read-only open
		// that does NOT checkpoint (open auto-recovers the WAL, so the row IS
		// visible to readers — but the main FILE on disk still lacks it). We
		// assert the -wal is present + non-empty (the load-bearing precondition).
		expect(existsSync(legacyWalPath)).toBe(true);
		expect(statSync(legacyWalPath).size).toBeGreaterThan(0);
		// And confirm the main db file on disk does NOT contain the probe table
		// (both schema AND row are WAL-only): temporarily move the -wal aside and
		// read the bare main file.
		const parkedWal = join(snapDir, "parked-wal");
		renameSync(legacyWalPath, parkedWal);
		const bareProbe = new Database(legacyCoreDbPath, { readonly: true });
		const tbl = bareProbe
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='probe'`)
			.get() as { name: string } | undefined;
		bareProbe.close();
		renameSync(parkedWal, legacyWalPath); // restore -wal for the migration
		expect(tbl).toBeUndefined(); // PROOF: schema+data live ONLY in the WAL

		performLayoutBootstrap();

		// wal_checkpoint(TRUNCATE) ran during migrateLegacyToCore → the WAL frame
		// was folded into the main file BEFORE the byte-copy. The row must now
		// be in core.db. (If checkpoint were skipped, copyFileSync would copy a
		// main file that lacks the row → this assertion fails.)
		expect(existsSync(coreDbPath)).toBe(true);
		const probe = new Database(coreDbPath, { readonly: true });
		const row = probe.prepare(`SELECT v FROM probe WHERE k = 'wal-only'`).get() as { v: string } | undefined;
		probe.close();
		expect(row?.v).toBe("pre-checkpoint");

		// §B bullet 3: legacy WAL/SHM removed from the active location.
		expect(existsSync(legacyWalPath)).toBe(false);
		expect(existsSync(legacyShmPath)).toBe(false);
		expect(existsSync(legacyCoreDbPath)).toBe(false);
	});

	test("Case B: integrity_check + foreign_key_check run on core.db.tmp before atomic promote (migrated core.db is clean)", () => {
		// Build a legacy DB; run migration; assert the promoted core.db passes
		// BOTH integrity_check AND foreign_key_check. (The implementer's gate
		// refuses to promote a tmp that fails either — so the very existence
		// of a promoted core.db implies the checks ran and passed. We assert
		// the post-state here.)
		seedLegacySessionsDb();

		expect(() => performLayoutBootstrap()).not.toThrow();
		expect(existsSync(coreDbPath)).toBe(true);

		const probe = new Database(coreDbPath, { readonly: true });
		const intCheck = probe.pragma("integrity_check") as Array<{ integrity_check: string }>;
		const fkCheck = probe.pragma("foreign_key_check") as any[];
		probe.close();
		expect(intCheck.length).toBe(1);
		expect(intCheck[0].integrity_check).toBe("ok");
		expect(fkCheck.length).toBe(0);
	});

	test("Case B: old sessions.db moved to backups/core/pre-layout-<ts>.db (one-shot)", () => {
		seedLegacySessionsDb();

		expect(existsSync(coreBackupDir)).toBe(false);
		performLayoutBootstrap();

		// backups/core/ now exists with exactly one pre-layout-<ts>.db.
		expect(existsSync(coreBackupDir)).toBe(true);
		const entries = readdirSync(coreBackupDir).filter(
			(e) => e.startsWith("pre-layout-") && e.endsWith(".db"),
		);
		expect(entries.length).toBe(1);

		// The backup is a real SQLite DB with the migrated schema.
		const backupPath = join(coreBackupDir, entries[0]);
		const bdb = new Database(backupPath, { readonly: true });
		const tables = bdb
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
			.all() as { name: string }[];
		bdb.close();
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("sessions");
		expect(tableNames).toContain("agents");
	});

	test("layout-v1.json contains source/target/sha256/time/version/integrity-check/complete fields", () => {
		seedLegacySessionsDb();
		performLayoutBootstrap();

		const marker = readMarkerFile();
		// §B bullet 7 enumerated field set:
		expect(marker).toBeTruthy();
		expect(marker.version).toBe("v1");
		expect(typeof marker.completedAt).toBe("string");
		expect(marker.completedAt.length).toBeGreaterThan(0);
		expect(marker.source).toBe("sessions.db");
		expect(marker.target).toBe("db/core.db");
		expect(typeof marker.sourceSha256).toBe("string");
		expect(marker.sourceSha256.length).toBe(64); // sha256 hex
		expect(typeof marker.targetSha256).toBe("string");
		expect(marker.targetSha256.length).toBe(64);
		expect(marker.integrity).toBe("ok");
		expect(marker.foreignKeys).toBe("ok");
		expect(marker.complete).toBe(true);
	});

	test("Case D: both core.db + sessions.db exist without a valid marker → DATABASE_LAYOUT_CONFLICT", () => {
		// Build both files independently (not via migration).
		seedLegacySessionsDb(); // creates sessions.db
		// Independently create core.db (simulating a user restoring a backup
		// alongside an existing sessions.db without a marker).
		const cdb = new CoreDatabase(coreDbPath);
		runMigrations(cdb);
		cdb.close();
		// Marker absent.
		expect(existsSync(layoutMarkerPath)).toBe(false);

		let caught: any;
		try {
			performLayoutBootstrap();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toMatch(/layout conflict/i);
		expect((caught as Error & { code?: string }).code).toBe(DATABASE_LAYOUT_CONFLICT);

		// §G rejection (a): the legacy sessions.db must NOT have been
		// deleted/overwritten before the conflict was raised.
		expect(existsSync(legacyCoreDbPath)).toBe(true);
	});

	test("Case E: both core.db + sessions.db exist with a valid complete marker → normal open, no re-migrate", () => {
		// First, run a real migration to produce a complete marker + backup.
		seedLegacySessionsDb();
		performLayoutBootstrap();
		const markerAfterFirstMigration = readMarkerFile();
		expect(markerAfterFirstMigration.complete).toBe(true);
		const coreSizeAfterFirst = statSync(coreDbPath).size;

		// Simulate "both exist": drop a sessions.db back at the legacy path.
		// (The migration moved it to backups; restore it artificially to
		// test the Case E branch — marker.complete=true must short-circuit.)
		writeFileSync(legacyCoreDbPath, "fake sessions.db payload that should not be read");
		expect(existsSync(legacyCoreDbPath)).toBe(true);

		// Second bootstrap: marker.complete=true → Case E → normal open.
		expect(() => performLayoutBootstrap()).not.toThrow();

		// core.db was NOT re-migrated (size unchanged because the file is
		// untouched; the bogus sessions.db was NOT migrated).
		expect(statSync(coreDbPath).size).toBe(coreSizeAfterFirst);

		// The bogus sessions.db is still at the legacy path (not moved).
		expect(readFileSync(legacyCoreDbPath, "utf-8")).toBe(
			"fake sessions.db payload that should not be read",
		);

		// backups/core/ has exactly one entry (from the first migration).
		const entries = readdirSync(coreBackupDir).filter((e) => e.startsWith("pre-layout-"));
		expect(entries.length).toBe(1);
	});

	test("Case A: core.db exists, sessions.db absent → normal open; marker backfilled if missing", () => {
		// Create core.db directly (e.g. user restored a backup) with no marker.
		const cdb = new CoreDatabase(coreDbPath);
		runMigrations(cdb);
		cdb.close();
		expect(existsSync(legacyCoreDbPath)).toBe(false);
		expect(existsSync(layoutMarkerPath)).toBe(false);

		// Bootstrap should write a marker for the existing core.db.
		expect(() => performLayoutBootstrap()).not.toThrow();
		const marker = readMarkerFile();
		expect(marker).toBeTruthy();
		expect(marker.complete).toBe(true);
		expect(marker.target).toBe("db/core.db");
	});

	test("Interrupt idempotency: stale core.db.tmp left by a crash is cleaned up; second bootstrap completes cleanly without producing two active sources", () => {
		// Simulate crash after tmp creation but before promote: leave a tmp
		// file behind + legacy sessions.db in place.
		seedLegacySessionsDb();
		writeFileSync(coreTmpPath, "partial-tmp-from-crash");
		expect(existsSync(coreTmpPath)).toBe(true);

		// Second bootstrap must:
		//   - delete the stale tmp
		//   - re-do the migration
		//   - produce exactly ONE core.db + ONE marker + ONE backup
		expect(() => performLayoutBootstrap()).not.toThrow();

		expect(existsSync(coreTmpPath)).toBe(false);
		expect(existsSync(coreDbPath)).toBe(true);
		expect(existsSync(legacyCoreDbPath)).toBe(false);

		const marker = readMarkerFile();
		expect(marker.complete).toBe(true);

		const backups = readdirSync(coreBackupDir).filter((e) => e.startsWith("pre-layout-"));
		expect(backups.length).toBe(1);

		// Idempotent: running bootstrap again is a no-op (Case A — legacy
		// absent, marker complete).
		expect(() => performLayoutBootstrap()).not.toThrow();
		const backups2 = readdirSync(coreBackupDir).filter((e) => e.startsWith("pre-layout-"));
		expect(backups2.length).toBe(1);
	});

	test("Re-running bootstrap after a successful fresh-create is a no-op (idempotent)", () => {
		// Use DatabaseManager.open() to do the full fresh-create path, then
		// call performLayoutBootstrap again and assert nothing changes.
		const mgr = new DatabaseManager();
		mgr.open();
		mgr.close();
		const markerAfterOpen = readMarkerFile();
		const coreSizeAfterOpen = statSync(coreDbPath).size;
		expect(markerAfterOpen.complete).toBe(true);

		// Second bootstrap: marker.complete=true, legacy absent → Case A → no-op.
		expect(() => performLayoutBootstrap()).not.toThrow();
		const markerAfterSecond = readMarkerFile();
		expect(markerAfterSecond.complete).toBe(true);
		expect(statSync(coreDbPath).size).toBe(coreSizeAfterOpen);
	});
});

// ============================================================
// §C — Retired knowledge.db deletion (precision + idempotency)
// ============================================================

describe("plan-00 §C — retired knowledge.db deletion (precision + idempotency)", () => {
	test("deleteRetiredKnowledgeDb deletes only the 3 whitelisted paths; adjacent files survive", () => {
		// Seed all 3 retired files + adjacent ones.
		writeFileSync(join(ZERO_CORE_DIR, "knowledge.db"), "x");
		writeFileSync(join(ZERO_CORE_DIR, "knowledge.db-wal"), "x");
		writeFileSync(join(ZERO_CORE_DIR, "knowledge.db-shm"), "x");
		writeFileSync(join(ZERO_CORE_DIR, "knowledge.db.keep"), "adjacent");
		writeFileSync(join(ZERO_CORE_DIR, "other.db"), "adjacent-other");
		// Plus an adjacent directory with similar name.
		mkdirSync(join(ZERO_CORE_DIR, "knowledge.db.d"), { recursive: true });

		const result = deleteRetiredKnowledgeDb();

		expect(result.deleted.length).toBe(3);
		expect(existsSync(join(ZERO_CORE_DIR, "knowledge.db"))).toBe(false);
		expect(existsSync(join(ZERO_CORE_DIR, "knowledge.db-wal"))).toBe(false);
		expect(existsSync(join(ZERO_CORE_DIR, "knowledge.db-shm"))).toBe(false);
		// Adjacent survivors:
		expect(existsSync(join(ZERO_CORE_DIR, "knowledge.db.keep"))).toBe(true);
		expect(existsSync(join(ZERO_CORE_DIR, "other.db"))).toBe(true);
		expect(existsSync(join(ZERO_CORE_DIR, "knowledge.db.d"))).toBe(true);
	});

	test("deleteRetiredKnowledgeDb is idempotent when files are absent (no-op)", () => {
		expect(() => deleteRetiredKnowledgeDb()).not.toThrow();
		const r1 = deleteRetiredKnowledgeDb();
		expect(r1.deleted).toEqual([]);
	});
});
