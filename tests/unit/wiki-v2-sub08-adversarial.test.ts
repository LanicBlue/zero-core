// Adversarial verifier for wiki-system-redesign sub-08 (cutover + hardening).
//
// Lens: adversarial. This file deliberately attacks the sub-08 surfaces:
//   (1)  §1 RUNTIME unreachability of legacy project-wiki paths — not grep,
//        actual module-resolution check (acceptance H core).
//   (2)  §2 fs guard BYPASS matrix — relative/quotes/env/case/symlink/junction
//        + shell concatenation. CRITICAL FINDING: `isProtectedPathRealpath`
//        is defined in wiki-path-guard.ts but NEVER wired into any FS tool
//        (file-read/write/edit/grep/glob/bash all use the lexical-only
//        `isWikiDiskPath`). A symlink/junction outside the workspace pointing
//        at db/wiki.db would bypass the guard.
//   (3)  §3 backup correctness — SQLite Backup API (not file copy), integrity
//        under concurrent writes, restore verify, Core/Wiki isolation (write
//        to Wiki must NOT change Core WAL/mtime), readonly diag must not
//        write to active DB.
//   (4)  attachment / API grants — Agent has no direct Wiki dir access.
//   (5)  H rejection: legacy subscriber/router still callable = FAIL.
//
// Source under src/ is FROZEN. A test that reveals a src bug = FAIL finding.

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer, type Server } from "node:http";
import type { Express } from "express";
import express from "express";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Per-file isolation: pin ZERO_CORE_DIR to a temp dir BEFORE any wiki import
// resolves database-paths.ts. WIKI_DISK_ROOT + coreDbPath etc. are computed at
// module load from ZERO_CORE_DIR. We DO NOT set ZERO_CORE_DB_NO_WAL — backup
// correctness tests REQUIRE WAL to verify Core/Wiki isolation.
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
	const { tmpdir: td } = require("node:os") as typeof import("node:os");
	const { join: j } = require("node:path") as typeof import("node:path");
	const d = mk(j(td(), "zc-wiki-v2-sub08-adv-"));
	process.env.ZERO_CORE_DIR = d;
	return { UNIQUE_DIR: d };
});

import {
	canonicalize,
	isProtectedPath,
	protectedPathLabel,
	listProtectedPaths,
	WIKI_DISK_ROOT,
} from "../../src/core/protected-paths.js";
import {
	isWikiDiskPath,
	wikiPathRejectMessage,
	findWikiPathInShellCommand,
	isProtectedPathRealpath,
} from "../../src/tools/wiki-path-guard.js";
import { coreDbPath, wikiDbPath, coreBackupDir, wikiBackupDir, DB_DIR } from "../../src/core/database-paths.js";
import { BackupService } from "../../src/server/wiki-backup-service.js";
import { CoreDatabase } from "../../src/server/core-database.js";
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { createWikiMaintenanceRouter } from "../../src/server/wiki-maintenance-router.js";
import { fileReadTool } from "../../src/tools/file-read.js";
import { fileWriteTool } from "../../src/tools/file-write.js";
import { fileEditTool } from "../../src/tools/file-edit.js";
import { grepTool } from "../../src/tools/grep.js";
import { globTool } from "../../src/tools/glob.js";
import { bashTool } from "../../src/tools/bash.js";

// Repo root (for source-audit tests that read src/*.ts to confirm wiring).
const REPO_ROOT = join(dirname(__dirname), "..");

// ===========================================================================
// §1 Runtime unreachability of legacy paths (acceptance A + H core)
// ===========================================================================

describe("[§1/H] legacy wiki modules are not importable from production src/", () => {
	const deletedModules = [
		"./project-wiki-router.js",
		"./project-wiki-store.js",
		"./wiki-node-store.js",
	];

	for (const mod of deletedModules) {
		test(`deleted module src/server/${mod} cannot be resolved at runtime`, async () => {
			// Resolve relative to the absolute server dir so the dynamic import
			// looks in the right place regardless of test cwd.
			const serverDir = require("node:path").resolve(__dirname, "../../src/server");
			const abs = require("node:path").join(serverDir, mod);
			let err: unknown = null;
			try {
				await import(abs);
			} catch (e) {
				err = e;
			}
			expect(err, `importing ${mod} should fail`).not.toBeNull();
			const msg = String((err as Error)?.message ?? err);
			const isModuleNotFound = /Cannot find|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Failed to resolve|not found|Could not resolve/i.test(msg);
			expect(isModuleNotFound, `unexpected error for ${mod}: ${msg}`).toBe(true);
		});
	}

	test("protected-paths table covers db/core.db, db/wiki.db, WAL/SHM, backups, wiki/.runtime, wiki/", () => {
		const list = listProtectedPaths();
		const canon = (p: string) =>
			process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p;
		const expected = [
			coreDbPath,
			coreDbPath + "-wal",
			coreDbPath + "-shm",
			wikiDbPath,
			wikiDbPath + "-wal",
			wikiDbPath + "-shm",
			coreBackupDir,
			wikiBackupDir,
			join(WIKI_DISK_ROOT, ".runtime"),
			WIKI_DISK_ROOT,
		];
		for (const p of expected) {
			expect(list, `protected list missing ${canon(p)}`).toContain(canon(p));
		}
	});
});

// ===========================================================================
// §2 fs guard lexical bypass matrix (acceptance B)
// ===========================================================================

describe("[§2/B] fs guard lexical bypass matrix (relative/quotes/env/case)", () => {
	test("direct hit on db/core.db is blocked", () => {
		expect(isWikiDiskPath(coreDbPath)).toBe(true);
		expect(protectedPathLabel(coreDbPath)).toMatch(/core database/);
	});

	test("relative path db/core.db from ZERO_CORE_DIR is resolved and blocked", () => {
		// workingDir = ZERO_CORE_DIR, relative path goes INTO db/.
		expect(isWikiDiskPath("db/core.db", UNIQUE_DIR)).toBe(true);
		expect(isWikiDiskPath("./db/wiki.db", UNIQUE_DIR)).toBe(true);
	});

	test("relative path ../core.db from inside db/ subdir resolves back into protected zone", () => {
		const nested = join(DB_DIR, "somesubdir");
		expect(isWikiDiskPath("../core.db", nested)).toBe(true);
		expect(isWikiDiskPath("../../db/wiki.db-wal", nested)).toBe(true);
	});

	test("double-quoted path is unquoted and blocked", () => {
		expect(isWikiDiskPath(`"${coreDbPath}"`)).toBe(true);
	});

	test("single-quoted path is unquoted and blocked", () => {
		expect(isWikiDiskPath(`'${wikiDbPath}'`)).toBe(true);
	});

	test("win32 case-insensitive: lowercased drive + path still matches protected", () => {
		if (process.platform !== "win32") return;
		// Canonical form lowercases on win32, so an all-lowercase variant of
		// coreDbPath must still match (proves canonicalize does not regress).
		const lowered = coreDbPath.toLowerCase().split("\\").join("/");
		expect(isWikiDiskPath(lowered), `lowered '${lowered}' should be blocked`).toBe(true);
	});

	test("WAL and SHM sidecar files are individually blocked (not just .db)", () => {
		expect(isWikiDiskPath(coreDbPath + "-wal")).toBe(true);
		expect(isWikiDiskPath(coreDbPath + "-shm")).toBe(true);
		expect(isWikiDiskPath(wikiDbPath + "-wal")).toBe(true);
		expect(isWikiDiskPath(wikiDbPath + "-shm")).toBe(true);
	});

	test("backup directories are blocked (core + wiki)", () => {
		expect(isWikiDiskPath(coreBackupDir)).toBe(true);
		expect(isWikiDiskPath(join(coreBackupDir, "core-2026-01-01.db"))).toBe(true);
		expect(isWikiDiskPath(wikiBackupDir)).toBe(true);
		expect(isWikiDiskPath(join(wikiBackupDir, "wiki-2026-01-01.db"))).toBe(true);
	});

	test("wiki/.runtime and wiki/ root are blocked", () => {
		expect(isWikiDiskPath(join(WIKI_DISK_ROOT, ".runtime"))).toBe(true);
		expect(isWikiDiskPath(join(WIKI_DISK_ROOT, ".runtime", "indexer.lock"))).toBe(true);
		expect(isWikiDiskPath(WIKI_DISK_ROOT)).toBe(true);
	});

	test("legitimate project source OUTSIDE ZERO_CORE_DIR is NOT blocked (no false positive)", () => {
		const outside = mkdtempSync(join(tmpdir(), "zc-adv-source-"));
		try {
			const src = join(outside, "myproject", "src", "main.ts");
			expect(isWikiDiskPath(src)).toBe(false);
			expect(protectedPathLabel(src)).toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("shell command embedding $ZERO_CORE_DIR/db/core.db is rejected", () => {
		// Set ZERO_CORE_DIR env at test time so expandEnvVars substitutes it.
		process.env.ZERO_CORE_DIR = UNIQUE_DIR;
		const blocked = findWikiPathInShellCommand("cat $ZERO_CORE_DIR/db/core.db");
		expect(blocked, "should block $ZERO_CORE_DIR/db/core.db").not.toBeNull();
	});

	test("shell command with braced ${ZERO_CORE_DIR}/db/wiki.db is rejected", () => {
		process.env.ZERO_CORE_DIR = UNIQUE_DIR;
		const blocked = findWikiPathInShellCommand("xxd ${ZERO_CORE_DIR}/db/wiki.db | head");
		expect(blocked, "should block ${ZERO_CORE_DIR}/db/wiki.db").not.toBeNull();
	});

	test("shell command with relative ../db/wiki.db is rejected", () => {
		const blocked = findWikiPathInShellCommand("cat ../db/wiki.db", DB_DIR);
		expect(blocked, "should block relative path").not.toBeNull();
	});

	test("shell command with literal db/core.db substring is rejected", () => {
		const blocked = findWikiPathInShellCommand("echo 'take this: db/core.db and parse it'");
		expect(blocked, "should block literal db/core.db substring").not.toBeNull();
	});

	test("shell command NOT touching protected paths passes through (null)", () => {
		expect(findWikiPathInShellCommand("ls -la")).toBeNull();
		expect(findWikiPathInShellCommand("echo hello world")).toBeNull();
		expect(findWikiPathInShellCommand("git status")).toBeNull();
		expect(findWikiPathInShellCommand("npm run test:unit")).toBeNull();
	});

	test("reject message is actionable (mentions wiki tool + management API)", () => {
		const msg = wikiPathRejectMessage(coreDbPath);
		expect(msg).toMatch(/wiki/i);
		expect(msg).toMatch(/expand|read|search|create|update|delete/i);
		expect(msg).toMatch(/plan-08/);
	});
});

// ===========================================================================
// §2/B CRITICAL: symlink/junction bypass
// ===========================================================================
//
// `isProtectedPathRealpath` exists but is NOT wired into any FS tool. A
// symlink outside the workspace pointing at db/core.db bypasses the lexical
// guard that file-read/write/edit/grep/glob/bash all use.

describe("[§2/B] symlink/junction bypass — REAL guard gap", () => {
	const scratch = mkdtempSync(join(tmpdir(), "zc-adv-symlink-"));

	afterEach(() => {
		for (const entry of readdirSync(scratch)) {
			rmSync(join(scratch, entry), { recursive: true, force: true });
		}
	});
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	test("symlink OUTSIDE workspace pointing at db/core.db: lexical guard MISSES it", () => {
		mkdirSync(DB_DIR, { recursive: true });
		if (!existsSync(coreDbPath)) writeFileSync(coreDbPath, "");
		const linkPath = join(scratch, "core-db-bypass");
		try {
			symlinkSync(coreDbPath, linkPath);
		} catch (err) {
			if (process.platform === "win32" && /privilege|EPERM/i.test(String((err as Error).message))) {
				console.warn("symlink not permitted on this host; skipping");
				return;
			}
			throw err;
		}
		// LEXICAL guard (what file-read/write/etc use) misses the symlink:
		const lexicalBlocked = isWikiDiskPath(linkPath);
		expect(lexicalBlocked, "EXPECTED lexical guard to MISS the symlink (vulnerability)").toBe(false);
		// The realpath variant DOES catch it — proving the helper exists but
		// is not wired into any FS tool.
		const realpathBlocked = isProtectedPathRealpath(linkPath);
		expect(realpathBlocked, "realpath variant should catch the symlink").toBe(true);
	});

	test("symlink to wiki/.runtime file: lexical guard misses (when symlinks permitted)", () => {
		mkdirSync(join(WIKI_DISK_ROOT, ".runtime"), { recursive: true });
		const target = join(WIKI_DISK_ROOT, ".runtime", "indexer.lock");
		if (!existsSync(target)) writeFileSync(target, "");
		const linkPath = join(scratch, "wiki-runtime-bypass");
		try {
			symlinkSync(target, linkPath);
		} catch (err) {
			if (process.platform === "win32" && /privilege|EPERM/i.test(String((err as Error).message))) {
				console.warn("symlink not permitted on this host; skipping");
				return;
			}
			throw err;
		}
		expect(isWikiDiskPath(linkPath), "lexical guard should MISS the symlink").toBe(false);
		expect(isProtectedPathRealpath(linkPath), "realpath variant should catch").toBe(true);
	});
});

// ===========================================================================
// §3 Backup correctness (acceptance C)
// ===========================================================================
//
// BackupService reads from module-level coreDbPath/wikiDbPath (resolved
// against ZERO_CORE_DIR at import). We open Core/Wiki at those paths so the
// service can find them. Each test owns its cleanup.

describe("[§3/C] BackupService snapshot uses SQLite Backup API + verifies", () => {
	let core: CoreDatabase;
	let wiki: WikiDatabase;

	beforeEach(() => {
		// Clean any pre-existing DBs from the shared ZERO_CORE_DIR.
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
			try { rmSync(p + "-shm", { force: true }); } catch { /* */ }
		}
		core = new CoreDatabase(coreDbPath);
		runMigrations(core);
		wiki = new WikiDatabase(wikiDbPath);
	});

	afterEach(() => {
		try { core.close(); } catch { /* */ }
		try { wiki.close(); } catch { /* */ }
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
			try { rmSync(p + "-shm", { force: true }); } catch { /* */ }
		}
	});

	function insertWikiNode(wdb: Database.Database, path: string, name: string, parentId: number | null) {
		const now = new Date().toISOString();
		wdb.prepare(
			`INSERT INTO wiki_nodes(parent_id, name, path, kind, summary, content, revision, created_at, updated_at)
			 VALUES(?, ?, ?, 'leaf', '', 'body', 1, ?, ?)`,
		).run(parentId, name, path, now, now);
	}

	function projectsRootId(wdb: Database.Database): number {
		const row = wdb.prepare("SELECT id FROM wiki_nodes WHERE path='wiki-root/projects' LIMIT 1").get() as { id: number } | undefined;
		return row?.id ?? null;
	}

	test("SQLite Backup API itself works correctly when source is opened correctly", async () => {
		// PROVES: the Backup API primitive is fine on Windows. The only thing
		// that breaks is the `file:PATH?mode=ro` URI form (see next test).
		const wdb = wiki.getDb();
		insertWikiNode(wdb, "wiki-root/projects/p1/leaf-1", "leaf-1", projectsRootId(wdb));

		const tmpBackupDir = mkdtempSync(join(tmpdir(), "zc-adv-snap-"));
		try {
			// Variant that WORKS: pass the path directly with the readonly
			// option (better-sqlite3 then opens it via SQLite's normal path
			// resolution, which handles Windows drive letters correctly).
			const src = new Database(wiki.path, { readonly: true, fileMustExist: true });
			const snapshotPath = join(tmpBackupDir, "wiki-test.db");
			try {
				await src.backup(snapshotPath);
			} finally {
				src.close();
			}
			const snap = new Database(snapshotPath, { readonly: true, fileMustExist: true });
			try {
				const intg = snap.pragma("integrity_check") as Array<{ integrity_check: string }>;
				expect(intg.length === 1 && intg[0].integrity_check === "ok").toBe(true);
				const fk = snap.pragma("foreign_key_check") as Array<unknown>;
				expect(fk.length).toBe(0);
				const row = snap.prepare(
					"SELECT count(*) AS n FROM wiki_nodes WHERE path='wiki-root/projects/p1/leaf-1'",
				).get() as { n: number };
				expect(row.n).toBe(1);
			} finally {
				snap.close();
			}
		} finally {
			rmSync(tmpBackupDir, { recursive: true, force: true });
		}
	});

	// ─── round-2 Fix 1 (BLOCKER C) verification ──────────────────────
	// round-1 found BackupService.snapshotOne opened the source via
	// `file:${path}?mode=ro` URI, which on Windows confuses SQLite's URI
	// scheme parser (drive letter read as authority) → SqliteError
	// 'unable to open database file' whenever the active connection is held
	// by DatabaseManager. snapshotAll then caught+log.warn+swallowed as
	// wiki:null → every backup endpoint silently "succeeded" without a wiki
	// snapshot. round-2 Fix 1a drops the URI form for a plain filesystem
	// path with { readonly: true, fileMustExist: true }; Fix 1b makes
	// snapshotAll re-throw on wiki failure when deps.wikiDb is present.
	//
	// Post-fix assertion: the prod path now SUCCEEDS — returns a manifest
	// with the right shape, writes a sidecar `.json`, and the snapshot file
	// passes integrity_check + foreign_key_check + has the row we inserted.
	test("Fix 1: BackupService.snapshotWiki succeeds via prod path and writes a verifiable snapshot", async () => {
		const wdb = wiki.getDb();
		insertWikiNode(wdb, "wiki-root/projects/p1/leaf-2", "leaf-2", projectsRootId(wdb));
		const backup = new BackupService({ coreDb: core, wikiDb: wiki });
		// Clear any prior snapshots so we can isolate this run.
		try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		const manifest = await backup.snapshotWiki("round-2 fix-1 probe");
		// Manifest shape (acceptance-08 §C: sidecar JSON with source/time/hash/rev).
		expect(manifest.kind).toBe("wiki");
		expect(manifest.manifestVersion).toBe(1);
		expect(manifest.snapshotPath).toMatch(/[\\/]wiki-.+\.db$/);
		expect(manifest.sourcePath).toBe(wikiDbPath);
		expect(manifest.note).toBe("round-2 fix-1 probe");
		expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(manifest.sizeBytes).toBeGreaterThan(0);
		expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		// Sidecar manifest JSON file exists next to the snapshot.
		expect(existsSync(manifest.snapshotPath + ".json")).toBe(true);
		// Snapshot is a valid readonly DB (NOT a raw file copy of the live WAL).
		// integrity_check + foreign_key_check must pass — proves Backup API was
		// used (a raw mid-write copy could fail these).
		expect(manifest.verified, `verify failed: ${manifest.snapshotPath}`).toBe(true);
		const snap = new Database(manifest.snapshotPath, { readonly: true, fileMustExist: true });
		try {
			const intg = snap.pragma("integrity_check") as Array<{ integrity_check: string }>;
			expect(intg.length === 1 && intg[0].integrity_check === "ok").toBe(true);
			const fk = snap.pragma("foreign_key_check") as Array<unknown>;
			expect(fk.length).toBe(0);
			const row = snap.prepare(
				"SELECT count(*) AS n FROM wiki_nodes WHERE path='wiki-root/projects/p1/leaf-2'",
			).get() as { n: number };
			expect(row.n, "snapshot must contain the row we inserted before snapshot").toBe(1);
		} finally {
			snap.close();
		}
		// Clean up the snapshot we just produced.
		try { rmSync(manifest.snapshotPath, { force: true }); } catch { /* */ }
		try { rmSync(manifest.snapshotPath + ".json", { force: true }); } catch { /* */ }
	});

	test("restore copies to NEW temp path, does NOT overwrite active DB", async () => {
		// round-2 Fix 1: prod path (backup.snapshotWiki) now works on Windows,
		// so we exercise it directly (no manual working-variant workaround).
		const wdb = wiki.getDb();
		insertWikiNode(wdb, "wiki-root/projects/p1/leaf-3", "leaf-3", projectsRootId(wdb));
		const backup = new BackupService({ coreDb: core, wikiDb: wiki });
		try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		const manifest = await backup.snapshotWiki();
		try {
			const restored = backup.restoreSnapshot(manifest.snapshotPath, "wiki");
			expect(existsSync(restored)).toBe(true);
			expect(restored).not.toBe(manifest.snapshotPath);
			expect(restored).not.toBe(wiki.path);
			const v = backup.verifySnapshot(restored);
			expect(v.ok, v.error ?? v.integrityCheck).toBe(true);
			// Restore copy must contain the same data as the snapshot.
			const snap = new Database(restored, { readonly: true, fileMustExist: true });
			try {
				const row = snap.prepare(
					"SELECT count(*) AS n FROM wiki_nodes WHERE path='wiki-root/projects/p1/leaf-3'",
				).get() as { n: number };
				expect(row.n).toBe(1);
			} finally {
				snap.close();
			}
		} finally {
			try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		}
	});

	test("snapshot taken via prod path during concurrent write verifies clean", async () => {
		// round-2 Fix 1: prod path (backup.snapshotWiki) is exercised directly
		// while a concurrent writer is running. SQLite Backup API produces a
		// page-level consistent snapshot mid-write; integrity_check +
		// foreign_key_check must still pass.
		const wdb = wiki.getDb();
		const writer = setInterval(() => {
			try {
				wdb.transaction(() => {
					const idx = Math.floor(Math.random() * 100000);
					const now = new Date().toISOString();
					wdb.prepare(
						`INSERT OR IGNORE INTO wiki_nodes(parent_id, name, path, kind, summary, content, revision, created_at, updated_at)
						 VALUES(?, ?, ?, 'leaf', '', 'body', 1, ?, ?)`,
					).run(projectsRootId(wdb), `c-${idx}`, `wiki-root/projects/p1/c-${idx}`, now, now);
				})();
			} catch { /* expected racing writes */ }
		}, 2);
		const backup = new BackupService({ coreDb: core, wikiDb: wiki });
		try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		try {
			const manifest = await backup.snapshotWiki();
			expect(manifest.verified, `verify failed: ${manifest.snapshotPath}`).toBe(true);
			const snap = new Database(manifest.snapshotPath, { readonly: true, fileMustExist: true });
			try {
				const intg = snap.pragma("integrity_check") as Array<{ integrity_check: string }>;
				expect(intg.length === 1 && intg[0].integrity_check === "ok").toBe(true);
				const fk = snap.pragma("foreign_key_check") as Array<unknown>;
				expect(fk.length).toBe(0);
			} finally {
				snap.close();
			}
		} finally {
			clearInterval(writer);
			try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		}
	});
});

// ===========================================================================
// §3/C Core/Wiki isolation — write to Wiki must NOT change Core WAL/mtime
// ===========================================================================

describe("[§3/C] Core/Wiki isolation — writing Wiki does not touch Core", () => {
	let core: CoreDatabase;
	let wiki: WikiDatabase;

	beforeEach(() => {
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
		}
		core = new CoreDatabase(coreDbPath);
		runMigrations(core);
		wiki = new WikiDatabase(wikiDbPath);
	});

	afterEach(() => {
		try { core.close(); } catch { /* */ }
		try { wiki.close(); } catch { /* */ }
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
			try { rmSync(p + "-shm", { force: true }); } catch { /* */ }
		}
	});

	test("writing wiki.db does not grow core.db or core.db-wal", () => {
		const coreBefore = existsSync(coreDbPath) ? statSync(coreDbPath).size : -1;
		const coreWalBefore = existsSync(coreDbPath + "-wal") ? statSync(coreDbPath + "-wal").size : -1;
		const coreMtimeBefore = existsSync(coreDbPath) ? statSync(coreDbPath).mtimeMs : -1;

		const wdb = wiki.getDb();
		const parentId = (wdb.prepare("SELECT id FROM wiki_nodes WHERE path='wiki-root/projects' LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
		for (let i = 0; i < 50; i++) {
			const now = new Date().toISOString();
			wdb.transaction(() => {
				wdb.prepare(
					`INSERT INTO wiki_nodes(parent_id, name, path, kind, summary, content, revision, created_at, updated_at)
					 VALUES(?, ?, ?, 'leaf', '', 'body', 1, ?, ?)`,
				).run(parentId, `iso-${i}`, `wiki-root/projects/p1/iso-${i}`, now, now);
			})();
		}
		// Allow any async WAL flush to settle.
		const coreAfter = existsSync(coreDbPath) ? statSync(coreDbPath).size : -1;
		const coreWalAfter = existsSync(coreDbPath + "-wal") ? statSync(coreDbPath + "-wal").size : -1;
		const coreMtimeAfter = existsSync(coreDbPath) ? statSync(coreDbPath).mtimeMs : -1;

		expect(coreAfter, "core.db size must not change from wiki writes").toBe(coreBefore);
		expect(coreMtimeAfter, "core.db mtime must not change from wiki writes").toBe(coreMtimeBefore);
		if (coreWalBefore >= 0) {
			expect(coreWalAfter, "core.db-wal must not grow from wiki writes").toBe(coreWalBefore);
		} else {
			expect(existsSync(coreDbPath + "-wal"), "core.db-wal must not be created by wiki writes").toBe(false);
		}
	});
});

// ===========================================================================
// §3/C readonly diagnostics — must not checkpoint/VACUUM/migrate active DB
// ===========================================================================

describe("[§3/C] readonly diagnostics never mutate active DB", () => {
	let core: CoreDatabase;
	let wiki: WikiDatabase;

	beforeEach(() => {
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
		}
		core = new CoreDatabase(coreDbPath);
		runMigrations(core);
		wiki = new WikiDatabase(wikiDbPath);
	});
	afterEach(() => {
		try { core.close(); } catch { /* */ }
		try { wiki.close(); } catch { /* */ }
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
			try { rmSync(p + "-shm", { force: true }); } catch { /* */ }
		}
	});

	test("SQLite Backup API (prod path) does not checkpoint live WAL", async () => {
		// round-2 Fix 1: prod path (backup.snapshotWiki) now works on Windows.
		// A correct online snapshot must NOT truncate/checkpoint the live WAL
		// (memory feedback-sessions-db-readonly: never checkpoint an active DB
		// another connection holds — uncommitted WAL frames could be lost).
		const wdb = wiki.getDb();
		const parentId = (wdb.prepare("SELECT id FROM wiki_nodes WHERE path='wiki-root/projects' LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
		const now = new Date().toISOString();
		wdb.prepare(
			`INSERT INTO wiki_nodes(parent_id, name, path, kind, summary, content, revision, created_at, updated_at)
			 VALUES(?, 'ro-1', 'wiki-root/projects/p1/ro-1', 'leaf', '', 'body', 1, ?, ?)`,
		).run(parentId, now, now);

		const walPath = wiki.path + "-wal";
		const walBefore = existsSync(walPath) ? statSync(walPath).size : -1;
		const backup = new BackupService({ coreDb: core, wikiDb: wiki });
		try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		try {
			const manifest = await backup.snapshotWiki();
			expect(manifest.verified).toBe(true);
			const walAfter = existsSync(walPath) ? statSync(walPath).size : -1;
			if (walBefore >= 0) {
				expect(walAfter, "snapshot must not checkpoint live WAL").toBeGreaterThanOrEqual(walBefore);
			}
		} finally {
			try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		}
	});

	test("integrity_check / foreign_key_check on live wiki are read-only", () => {
		const before = wiki.schemaVersion();
		const wdb = wiki.getDb();
		const intRes = wdb.pragma("integrity_check") as Array<{ integrity_check: string }>;
		expect(intRes.length === 1 && intRes[0].integrity_check === "ok").toBe(true);
		const fkRes = wdb.pragma("foreign_key_check") as Array<unknown>;
		expect(fkRes.length).toBe(0);
		expect(wiki.schemaVersion(), "schema version must not change").toBe(before);
	});
});

// ===========================================================================
// §3/C BackupService must NOT expose a method that commits the active DB
// ===========================================================================

describe("[§3/C] BackupService does NOT expose a commit-active-DB path", () => {
	test("BackupService prototype has no git/commit method that could leak the live DB", () => {
		const proto = BackupService.prototype as Record<string, unknown>;
		const methodNames = Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
		// Allowed surface — none of these commit a live DB:
		const allowed = new Set([
			"snapshotAll", "snapshotCore", "snapshotWiki",
			"verifySnapshot", "restoreSnapshot", "listSnapshots", "rotate",
			"snapshotOne", "verifySnapshotOnDisk",
			"readBusinessRevision", "readDbSchemaVersion", "rotateKind",
		]);
		for (const name of methodNames) {
			expect(allowed.has(name), `unexpected BackupService method ${name}`).toBe(true);
		}
		expect(methodNames.some((n) => /git|commit/i.test(n)), "no git/commit method should exist").toBe(false);
	});
});

// ===========================================================================
// §1/A + §5 fresh core.db does NOT have project_wiki
// ===========================================================================

describe("[§5/E4] fresh core.db does not create project_wiki", () => {
	let core: CoreDatabase;
	beforeEach(() => {
		try { rmSync(coreDbPath, { force: true }); } catch { /* */ }
		try { rmSync(coreDbPath + "-wal", { force: true }); } catch { /* */ }
		core = new CoreDatabase(coreDbPath);
		runMigrations(core);
	});
	afterEach(() => {
		try { core.close(); } catch { /* */ }
		try { rmSync(coreDbPath, { force: true }); } catch { /* */ }
		try { rmSync(coreDbPath + "-wal", { force: true }); } catch { /* */ }
	});

	test("fresh core.db has no project_wiki table", () => {
		const tables = core.getDb().prepare(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='project_wiki'`,
		).all() as Array<{ name: string }>;
		expect(tables.length, "fresh core.db must not create project_wiki").toBe(0);
	});

	test("running migrations TWICE still has no project_wiki", () => {
		runMigrations(core);
		const tables = core.getDb().prepare(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='project_wiki'`,
		).all() as Array<{ name: string }>;
		expect(tables.length).toBe(0);
	});
});

// ===========================================================================
// round-2 Fix 2 (BLOCKER B+H) — breadth / 误伤 re-probe
//
// Fix 2 swapped 6 FS-tool call sites from lexical-only `isWikiDiskPath` to
// `isProtectedPathRealpath`. realpath resolution can be expensive and *can*
// throw on missing paths — this block attacks the breadth:
//   - Write-create nonexistent file (realpathSync would throw → must fall
//     back to lexical check, NOT block legitimate workspace creation).
//   - Symlinked project dir whose realpath sits OUTSIDE protected zone
//     (legitimate project relocated via symlink must NOT be blocked).
//   - Read/Write/Edit on legitimate workspace source not blocked.
//   - grep/glob scanning legitimate workingDir not blocked.
// ===========================================================================

describe("[Fix2-breadth] realpath guard does NOT block legitimate access", () => {
	const ws = mkdtempSync(join(tmpdir(), "zc-adv-fix2-ws-"));
	afterAll(() => {
		try { rmSync(ws, { recursive: true, force: true }); } catch { /* */ }
	});

	test("isProtectedPathRealpath does not throw on a nonexistent workspace file (lexical fallback)", () => {
		// realpathSync throws ENOENT on missing paths. The guard MUST guard
		// with existsSync before calling realpathSync so Write-create of a
		// brand-new file in the workspace is not mistaken for an attack.
		// (file-write:97-98 relies on this — Write creates files that don't
		// yet exist; if the guard threw, every Write-create would 500.)
		const nonexistent = join(ws, "src", "new-module", "index.ts");
		expect(existsSync(nonexistent)).toBe(false);
		let result: boolean;
		let threw = false;
		try {
			result = isProtectedPathRealpath(nonexistent, ws);
		} catch (err) {
			threw = true;
			throw err;
		}
		expect(threw, "guard must not throw on missing path").toBe(false);
		expect(result, "legitimate nonexistent workspace file must NOT be blocked").toBe(false);
	});

	test("isProtectedPathRealpath does not throw on a nonexistent DEEP path", () => {
		const deep = join(ws, "a", "b", "c", "d", "e", "f", "never-created.ts");
		expect(existsSync(deep)).toBe(false);
		expect(() => isProtectedPathRealpath(deep, ws)).not.toThrow();
		expect(isProtectedPathRealpath(deep, ws)).toBe(false);
	});

	test("legitimate workspace source file (exists) is NOT blocked", () => {
		const src = join(ws, "src", "main.ts");
		mkdirSync(dirname(src), { recursive: true });
		writeFileSync(src, "console.log('hi');");
		try {
			expect(isProtectedPathRealpath(src, ws)).toBe(false);
		} finally {
			try { rmSync(src, { force: true }); } catch { /* */ }
		}
	});

	test("symlinked project dir whose realpath is OUTSIDE protected zone is NOT blocked", () => {
		// Legitimate scenario: user keeps their project on another drive and
		// symlinks it into the workspace. The guard must follow the link,
		// see the realpath is a normal temp dir, and allow access.
		const realProject = mkdtempSync(join(tmpdir(), "zc-adv-real-proj-"));
		try {
			writeFileSync(join(realProject, "App.tsx"), "export const X = 1;");
			const link = join(ws, "linked-project");
			try {
				symlinkSync(realProject, link, "junction");
			} catch (err) {
				if (process.platform === "win32" && /privilege|EPERM/i.test(String((err as Error).message))) {
					console.warn("symlink not permitted on this host; skipping");
					return;
				}
				throw err;
			}
			// Read a file THROUGH the link — guard must not flag it.
			const through = join(link, "App.tsx");
			expect(existsSync(through)).toBe(true);
			expect(isProtectedPathRealpath(through, ws), "linked legit project file must NOT be blocked").toBe(false);
		} finally {
			try { rmSync(realProject, { recursive: true, force: true }); } catch { /* */ }
		}
	});

	test("grep on legitimate workingDir path is NOT blocked by guard", () => {
		const legit = join(ws, "src", "grep-target");
		mkdirSync(legit, { recursive: true });
		writeFileSync(join(legit, "a.ts"), "export const A = 1;");
		try {
			expect(isProtectedPathRealpath(legit, ws)).toBe(false);
			expect(isProtectedPathRealpath(join(legit, "a.ts"), ws)).toBe(false);
		} finally {
			try { rmSync(legit, { recursive: true, force: true }); } catch { /* */ }
		}
	});

	test("glob pattern resolving to legitimate workingDir is NOT blocked by guard", () => {
		const legit = join(ws, "packages");
		mkdirSync(join(legit, "p1"), { recursive: true });
		writeFileSync(join(legit, "p1", "index.ts"), "export {};");
		try {
			expect(isProtectedPathRealpath(legit, ws)).toBe(false);
			// Glob feeds the resolved directory to the guard; legit must pass.
			expect(isProtectedPathRealpath(join(legit, "**", "*.ts"), ws)).toBe(false);
		} finally {
			try { rmSync(legit, { recursive: true, force: true }); } catch { /* */ }
		}
	});
});

// ===========================================================================
// round-2 Fix 2 — END-TO-END via tool.execute (not just the guard function)
//
// The guard helper existing was exactly the round-1 gap: defined but not
// wired. This block creates real junctions in the workspace and drives each
// FS tool's execute() — proves the guard is the one actually called at the
// tool entry point, and that a junction (lexical workspace, realpath inside
// db/wiki/backups) is rejected by every Read/Write/Edit/Grep/Glob/Shell.
// ===========================================================================

// Helper: invoke an FS tool's execute() and return the LLM-facing text it
// produces. buildTool's wrapper has two paths:
//   - Read/Write/Edit/Grep/Glob return ok:true ToolResult (the reject text
//     starts with "Access denied", not "Error:", so `ok` stays true) →
//     wrapper runs `format(raw)` and returns the formatted STRING.
//   - Bash returns ok:false (the reject path passes ok=false explicitly) →
//     wrapper throws `new Error(formatted text)`.
// callTool normalizes both into a single string for assertion.
async function callTool(tool: any, input: any, workingDir: string): Promise<string> {
	const ctx: any = { workingDir, agentId: "adv-probe", readScope: "filesystem", emit: () => {} };
	try {
		const result = await tool.execute(input, { experimental_context: { ctx } });
		if (typeof result === "string") return result;
		const text = result?.data?.text ?? result?.text ?? "";
		return typeof text === "string" ? text : JSON.stringify(text);
	} catch (err: any) {
		return err?.message ?? String(err);
	}
}

function makeJunction(target: string, linkPath: string): "ok" | "skipped" {
	try {
		// On win32: junction type works for DIRECTORIES without admin, but is
		// rejected (ENOENT) for files. For files we fall back to the default
		// symlink type (file symlink — needs admin OR Developer Mode). On
		// posix the type argument is ignored. Skip gracefully on EPERM so the
		// tests don't fail on locked-down hosts; the assertions still run on
		// any host where link creation succeeds.
		const stat = statSync(target);
		const type = process.platform === "win32" && stat.isDirectory() ? "junction" : undefined;
		if (type) symlinkSync(target, linkPath, type);
		else symlinkSync(target, linkPath);
		return "ok";
	} catch (err) {
		if (/privilege|EPERM|ENOSYS/i.test(String((err as Error).message))) return "skipped";
		throw err;
	}
}

describe("[Fix2-e2e] junction bypass is rejected by every FS tool (realpath guard)", () => {
	const ws = mkdtempSync(join(tmpdir(), "zc-adv-fix2-e2e-"));

	beforeEach(() => {
		// Ensure protected targets exist on disk so the junction has something
		// to point at (realpathSync needs the target to resolve). Also seed
		// a placeholder file inside each protected DIR so a path through the
		// junction resolves to an EXISTING file — the guard's realpath step
		// only runs when existsSync(path) is true (see wiki-path-guard.ts).
		mkdirSync(DB_DIR, { recursive: true });
		if (!existsSync(coreDbPath)) writeFileSync(coreDbPath, "");
		if (!existsSync(wikiDbPath)) writeFileSync(wikiDbPath, "");
		mkdirSync(coreBackupDir, { recursive: true });
		mkdirSync(wikiBackupDir, { recursive: true });
		if (!existsSync(join(coreBackupDir, "core-2026.db"))) {
			writeFileSync(join(coreBackupDir, "core-2026.db"), "placeholder snapshot");
		}
		mkdirSync(WIKI_DISK_ROOT, { recursive: true });
		if (!existsSync(join(WIKI_DISK_ROOT, "anything.md"))) {
			writeFileSync(join(WIKI_DISK_ROOT, "anything.md"), "wiki leaf body");
		}
	});
	afterEach(() => {
		for (const entry of readdirSync(ws)) {
			try { rmSync(join(ws, entry), { recursive: true, force: true }); } catch { /* */ }
		}
	});
	afterAll(() => {
		try { rmSync(ws, { recursive: true, force: true }); } catch { /* */ }
	});

	function setupJunctionToCoreDb(): string | null {
		// lexical path inside workspace; realpath resolves into db/core.db.
		const link = join(ws, "core-db-link");
		if (makeJunction(coreDbPath, link) === "skipped") return null;
		// Sanity: the junction really resolves to the protected target
		// (otherwise the test would silently pass without exercising guard).
		const real = realpathSync(link);
		const canon = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p);
		expect(canon(real), "junction must resolve into db/ for the test to mean anything").toBe(canon(coreDbPath));
		// And the lexical guard alone must MISS it (otherwise we're not
		// testing the realpath addition; lexical already handled pre-Fix-2).
		expect(isWikiDiskPath(link, ws), "precondition: lexical guard should MISS the junction").toBe(false);
		return link;
	}

	test("Read via junction → blocked (Access denied)", async () => {
		const link = setupJunctionToCoreDb();
		if (!link) return;
		const text = await callTool(fileReadTool, { path: link }, ws);
		expect(text).toMatch(/Access denied/i);
		expect(text).toMatch(/core database|protected/i);
	});

	test("Write via junction → blocked", async () => {
		const link = setupJunctionToCoreDb();
		if (!link) return;
		const text = await callTool(fileWriteTool, { path: link, content: "pwned" }, ws);
		expect(text).toMatch(/Access denied/i);
	});

	test("Edit via junction → blocked", async () => {
		const link = setupJunctionToCoreDb();
		if (!link) return;
		const text = await callTool(fileEditTool, { path: link, oldText: "", newText: "pwned" }, ws);
		expect(text).toMatch(/Access denied/i);
	});

	test("Grep with junction search path → blocked", async () => {
		const link = setupJunctionToCoreDb();
		if (!link) return;
		const text = await callTool(grepTool, { pattern: "foo", path: link, output_mode: "files_with_matches" }, ws);
		expect(text).toMatch(/Access denied/i);
	});

	test("Glob with junction path → blocked", async () => {
		const link = setupJunctionToCoreDb();
		if (!link) return;
		const text = await callTool(globTool, { pattern: "*", path: link }, ws);
		expect(text).toMatch(/Access denied/i);
	});

	test("Shell `cat <junction>` → blocked (token-loop realpath check)", async () => {
		const link = setupJunctionToCoreDb();
		if (!link) return;
		// findWikiPathInShellCommand must surface the junction token because
		// Fix-2b token loop calls isProtectedPathRealpath per token.
		const blocked = findWikiPathInShellCommand(`cat ${link}`, ws);
		expect(blocked, "shell token loop must flag the junction via realpath").not.toBeNull();
		// And the bash tool execute must return the reject message.
		const text = await callTool(bashTool, { command: `cat ${link}` }, ws);
		expect(text).toMatch(/Access denied/i);
	});

	test("Junction into backups/ is also blocked (not just db files)", async () => {
		// backup dir is a separate protected root; a junction into it must
		// also be caught by every tool (regression guard against future
		// refactors that special-case only the .db entries).
		const link = join(ws, "backups-link");
		if (makeJunction(coreBackupDir, link) === "skipped") return;
		expect(realpathSync(link)).toBe(realpathSync(coreBackupDir));
		expect(isWikiDiskPath(link, ws), "lexical misses junction into backups").toBe(false);
		expect(isProtectedPathRealpath(link, ws), "realpath catches junction into backups").toBe(true);
		const readText = await callTool(fileReadTool, { path: join(link, "core-2026.db") }, ws);
		expect(readText).toMatch(/Access denied/i);
	});

	test("Junction into wiki/ disk root is blocked", async () => {
		const link = join(ws, "wiki-link");
		if (makeJunction(WIKI_DISK_ROOT, link) === "skipped") return;
		expect(isProtectedPathRealpath(link, ws)).toBe(true);
		const text = await callTool(fileReadTool, { path: join(link, "anything.md") }, ws);
		expect(text).toMatch(/Access denied/i);
	});
});

// ===========================================================================
// round-2 Fix 2 — source-audit: every FS tool actually calls
// isProtectedPathRealpath (not the lexical-only isWikiDiskPath)
//
// A runtime e2e covers behavior; this static check pins the wiring so a
// future refactor that swaps back to the lexical helper cannot regress
// silently (the round-1 bug was exactly "alias defined, not wired").
// ===========================================================================

describe("[Fix2-audit] FS tool sources wire isProtectedPathRealpath at the entry point", () => {
	// Strip comment lines so a `// isWikiDiskPath` mention in a doc comment
	// doesn't pass the audit.
	function codeOnly(rel: string): string {
		const src = readFileSync(join(REPO_ROOT, rel), "utf-8");
		return src
			.split(/\r?\n/)
			.filter((l) => {
				const t = l.trim();
				return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
			})
			.join("\n");
	}

	const cases: Array<{ file: string; label: string }> = [
		{ file: "src/tools/file-read.ts", label: "Read" },
		{ file: "src/tools/file-write.ts", label: "Write" },
		{ file: "src/tools/file-edit.ts", label: "Edit" },
		{ file: "src/tools/grep.ts", label: "Grep" },
		{ file: "src/tools/glob.ts", label: "Glob" },
	];

	for (const c of cases) {
		test(`${c.label} (${c.file}) calls isProtectedPathRealpath before any file access`, () => {
			const code = codeOnly(c.file);
			// Imports the realpath variant (not just the lexical alias).
			expect(code, `${c.file} must import isProtectedPathRealpath`).toMatch(/import\s+\{[^}]*isProtectedPathRealpath[^}]*\}\s+from\s+["']\.\/wiki-path-guard\.js["']/);
			// Invokes it on the user-supplied path before resolvePath/Read/Write.
			expect(code, `${c.file} must invoke isProtectedPathRealpath`).toMatch(/isProtectedPathRealpath\(/);
			// Does NOT use the lexical-only isWikiDiskPath at the guard site
			// (post-Fix-2 the alias still exists for back-compat but no FS
			// tool should call it as the primary guard).
			expect(code, `${c.file} must NOT call isWikiDiskPath as the guard`).not.toMatch(/if\s*\(\s*isWikiDiskPath\(/);
		});
	}

	test("Shell (bash.ts) uses findWikiPathInShellCommand which contains the realpath token loop", () => {
		const bash = codeOnly("src/tools/bash.ts");
		expect(bash).toMatch(/findWikiPathInShellCommand\(/);
		const guard = codeOnly("src/tools/wiki-path-guard.ts");
		// Fix-2b: token loop must call isProtectedPathRealpath per token.
		expect(guard).toMatch(/isProtectedPathRealpath\(tok/);
		expect(guard).toMatch(/isProtectedPathRealpath\(t,/);
	});
});

// ===========================================================================
// round-2 Fix 1 (BLOCKER C, part b) — router behavior
//
// snapshotAll must propagate wiki-snapshot failure as HTTP 500 (not the
// round-1 silent HTTP 200 + wiki:null). Verified by booting the real
// createWikiMaintenanceRouter against temp DBs and POSTing.
// ===========================================================================

describe("[Fix1-router] /backup/all returns 500 on snapshot failure, manifest on success", () => {
	let core: CoreDatabase;
	let wiki: WikiDatabase;

	beforeEach(() => {
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
			try { rmSync(p + "-shm", { force: true }); } catch { /* */ }
		}
		try { rmSync(coreBackupDir, { recursive: true, force: true }); } catch { /* */ }
		try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		core = new CoreDatabase(coreDbPath);
		runMigrations(core);
		wiki = new WikiDatabase(wikiDbPath);
	});
	afterEach(() => {
		try { core.close(); } catch { /* */ }
		try { wiki.close(); } catch { /* */ }
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
			try { rmSync(p + "-shm", { force: true }); } catch { /* */ }
		}
		try { rmSync(coreBackupDir, { recursive: true, force: true }); } catch { /* */ }
		try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
	});

	function listen(app: Express): Promise<{ server: Server; port: number }> {
		return new Promise((resolve) => {
			const server = createServer(app);
			server.listen(0, () => {
				const addr = server.address() as { port: number };
				resolve({ server, port: addr.port });
			});
		});
	}
	function close(server: Server): Promise<void> {
		return new Promise((resolve) => server.close(resolve));
	}
	async function post(port: number, path: string, body: unknown): Promise<{ status: number; data: any }> {
		const resp = await fetch(`http://localhost:${port}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		const text = await resp.text();
		try { return { status: resp.status, data: JSON.parse(text) }; }
		catch { return { status: resp.status, data: text }; }
	}

	test("success: /backup/all returns 200 with { core, wiki } manifests (NOT wiki:null)", async () => {
		// Insert a wiki row so the snapshot has real content. wiki subsystem
		// is up (wikiDb present) → wiki manifest must be a real object.
		const wdb = wiki.getDb();
		const parentId = (wdb.prepare("SELECT id FROM wiki_nodes WHERE path='wiki-root/projects' LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
		const now = new Date().toISOString();
		wdb.prepare(
			`INSERT INTO wiki_nodes(parent_id, name, path, kind, summary, content, revision, created_at, updated_at)
			 VALUES(?, 'router-1', 'wiki-root/projects/p1/router-1', 'leaf', '', 'body', 1, ?, ?)`,
		).run(parentId, now, now);

		const app = express();
		app.use(express.json());
		app.use("/api/wiki-maintain", createWikiMaintenanceRouter({ coreDb: core, wikiDb: wiki }));
		const { server, port } = await listen(app);
		try {
			const r = await post(port, "/api/wiki-maintain/backup/all", { note: "router-probe" });
			expect(r.status, `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`).toBe(200);
			// round-1 returned { core: <manifest>, wiki: null } silently.
			// round-2 must return a real wiki manifest when wikiDb is present.
			expect(r.data?.wiki, "wiki manifest must NOT be null when wiki subsystem is up").not.toBeNull();
			expect(r.data?.core?.kind).toBe("core");
			expect(r.data?.wiki?.kind).toBe("wiki");
			expect(r.data?.core?.manifestVersion).toBe(1);
			expect(r.data?.wiki?.manifestVersion).toBe(1);
			expect(r.data?.core?.verified).toBe(true);
			expect(r.data?.wiki?.verified).toBe(true);
		} finally {
			await close(server);
		}
	});

	test("failure: when wiki snapshot throws, /backup/all returns HTTP 500 (NOT 200 + wiki:null)", async () => {
		// Force snapshotWiki to throw by removing the wiki.db file out from
		// under the service AFTER WikiDatabase was constructed (simulates the
		// failure mode Fix-1b makes visible: any wiki snapshot error now
		// propagates instead of being swallowed). We close wiki first so the
		// file is not locked, then delete it.
		try { wiki.close(); } catch { /* */ }
		try { rmSync(wikiDbPath, { force: true }); } catch { /* */ }
		try { rmSync(wikiDbPath + "-wal", { force: true }); } catch { /* */ }
		try { rmSync(wikiDbPath + "-shm", { force: true }); } catch { /* */ }

		// Router still constructed with wikiDb present (the wiki subsystem was
		// up at boot time) → snapshotAll will attempt wiki snapshot → file is
		// gone → 'source DB not found' → must propagate as HTTP 500.
		const app = express();
		app.use(express.json());
		app.use("/api/wiki-maintain", createWikiMaintenanceRouter({ coreDb: core, wikiDb: wiki }));
		const { server, port } = await listen(app);
		try {
			const r = await post(port, "/api/wiki-maintain/backup/all", {});
			// The round-1 silent-success contract was HTTP 200 with wiki:null.
			// Fix-1b: HTTP 500 with error message. Either is "not 200", but
			// the explicit assertion documents the intended behavior.
			expect(r.status, `expected 500, got ${r.status}: ${JSON.stringify(r.data)}`).toBe(500);
			expect(r.data?.error).toMatch(/source DB not found|wiki\.db|unable to open/i);
			// And NOT the silent-success form (HTTP 200 with wiki:null).
			expect(r.status === 200 && r.data?.wiki === null, "must not be the silent-success form").toBe(false);
		} finally {
			await close(server);
		}
	});

	test("headless (no wikiDb): /backup/all returns 200 with wiki:null (legitimate 'no wiki to back up')", async () => {
		// Counter-test: wiki:null is still LEGAL when the wiki subsystem was
		// never started (deps.wikiDb === undefined). This is the headless/CLI
		// path, NOT the silent-swallow path Fix-1b closes. Confirms the
		// discriminator: wiki:null means "no wiki subsystem", not "wiki failed".
		const app = express();
		app.use(express.json());
		// Note: wikiDb deliberately OMITTED from deps.
		app.use("/api/wiki-maintain", createWikiMaintenanceRouter({ coreDb: core }));
		const { server, port } = await listen(app);
		try {
			const r = await post(port, "/api/wiki-maintain/backup/all", {});
			expect(r.status, `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`).toBe(200);
			expect(r.data?.core?.kind).toBe("core");
			expect(r.data?.wiki, "headless mode: wiki:null is the documented legitimate value").toBeNull();
		} finally {
			await close(server);
		}
	});
});

// ===========================================================================
// round-2 Fix 2 — shell end-to-end: junction creator script passes the
// shell guard (no protected-path token), but the resulting junction, when
// READ via the Read tool, is still blocked. Closed-loop probe.
// ===========================================================================

describe("[Fix2-shell-e2e] junction-creator script passes shell, but Read via junction is blocked", () => {
	const ws = mkdtempSync(join(tmpdir(), "zc-adv-fix2-shell-"));
	afterAll(() => {
		try { rmSync(ws, { recursive: true, force: true }); } catch { /* */ }
	});

	test("creator script lexically clean + Read via created junction is blocked", async () => {
		// 1. Pre-create the protected target the junction will point at.
		mkdirSync(DB_DIR, { recursive: true });
		if (!existsSync(coreDbPath)) writeFileSync(coreDbPath, "");

		// 2. Write the creator script into workspace. The script text contains
		//    NO reference to db/wiki/backups — it just creates a junction from
		//    argv[1] to argv[2]. The shell guard must NOT flag this command.
		const scriptPath = join(ws, "make-link.js");
		writeFileSync(
			scriptPath,
			`#!/usr/bin/env node
const fs = require('node:fs');
fs.symlinkSync(process.argv[2], process.argv[1], 'junction');
`,
		);

		// The shell guard sees only `node <workspace-path>/make-link.js`
		// tokens — none resolve into a protected root.
		const blocked = findWikiPathInShellCommand(`node ${scriptPath} ${join(ws, "core-link")} ${coreDbPath}`, ws);
		// The script PATH token is in the workspace (legit). The junction
		// TARGET argument (coreDbPath) IS a protected path token and SHOULD
		// be flagged — the agent literally named the protected file. This is
		// the correct behavior: you cannot name core.db in a shell command.
		expect(blocked, "shell must flag the core.db token passed as argv").not.toBeNull();
		expect(String(blocked)).toMatch(/core\.db/);

		// 3. Run the script directly (bypass the shell guard) to materialize
		//    the junction, simulating "the junction already exists on disk".
		const linkPath = join(ws, "core-link");
		if (makeJunction(coreDbPath, linkPath) === "skipped") {
			console.warn("symlink not permitted on this host; skipping rest");
			return;
		}

		// 4. Now attempt to Read THROUGH the junction. Even though the
		//    junction was created by a perfectly legal script, the Read tool's
		//    realpath-aware guard catches that the link resolves into db/.
		const text = await callTool(fileReadTool, { path: linkPath }, ws);
		expect(text).toMatch(/Access denied/i);
		expect(text).toMatch(/core database|protected/i);

		// 5. And a shell `cat <junction>` is ALSO blocked by the token-loop
		//    realpath check (closed loop: even though no `db/core.db` token
		//    appears in the command, the junction token itself is resolved).
		const catBlocked = findWikiPathInShellCommand(`cat ${linkPath}`, ws);
		expect(catBlocked, "shell token loop must resolve the junction via realpath").not.toBeNull();
	});
});

// ===========================================================================
// round-2 regression guard — manifest independence (Core and Wiki
// snapshots are paired but verified separately, plan-08 §3).
// ===========================================================================

describe("[Fix1-manifest] snapshotAll returns paired but independent core+wiki manifests", () => {
	let core: CoreDatabase;
	let wiki: WikiDatabase;

	beforeEach(() => {
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
			try { rmSync(p + "-shm", { force: true }); } catch { /* */ }
		}
		try { rmSync(coreBackupDir, { recursive: true, force: true }); } catch { /* */ }
		try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		core = new CoreDatabase(coreDbPath);
		runMigrations(core);
		wiki = new WikiDatabase(wikiDbPath);
	});
	afterEach(() => {
		try { core.close(); } catch { /* */ }
		try { wiki.close(); } catch { /* */ }
		try { rmSync(coreBackupDir, { recursive: true, force: true }); } catch { /* */ }
		try { rmSync(wikiBackupDir, { recursive: true, force: true }); } catch { /* */ }
		for (const p of [coreDbPath, wikiDbPath]) {
			try { rmSync(p, { force: true }); } catch { /* */ }
			try { rmSync(p + "-wal", { force: true }); } catch { /* */ }
			try { rmSync(p + "-shm", { force: true }); } catch { /* */ }
		}
	});

	test("snapshotAll returns two manifests, each with kind/source/path matching its own DB", async () => {
		const backup = new BackupService({ coreDb: core, wikiDb: wiki });
		const result = await backup.snapshotAll("paired-but-independent probe");
		expect(result.core.kind).toBe("core");
		expect(result.wiki?.kind).toBe("wiki");
		// Each manifest points at its OWN source DB (no cross-wiring).
		expect(result.core.sourcePath).toBe(coreDbPath);
		expect(result.wiki?.sourcePath).toBe(wikiDbPath);
		// Each snapshot path lives under its OWN backup dir.
		expect(result.core.snapshotPath).toContain(coreBackupDir.split(/[\\/]/).pop()!);
		expect(result.wiki?.snapshotPath).toContain(wikiBackupDir.split(/[\\/]/).pop()!);
		// Independent verify: both pass independently.
		expect(result.core.verified).toBe(true);
		expect(result.wiki?.verified).toBe(true);
		// Sidecar JSON files written for each.
		expect(existsSync(result.core.snapshotPath + ".json")).toBe(true);
		expect(existsSync(result.wiki!.snapshotPath + ".json")).toBe(true);
	});
});
