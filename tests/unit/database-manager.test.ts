// Wiki-system-redesign plan-00 §3 + acceptance-00 §D (architecture lens).
//
// # 文件说明书
//
// ## 核心功能
// 行为级 + 结构级编码 plan-00 §3 的接口形状锁与 acceptance-00 §D 全部 4 条
// 生命周期/周边工具要点。本文件从**架构约束**视角断言:
//   - DatabaseManager 是生产 composition root 唯一的 CoreDatabase 生命周期所有者
//     (全仓 grep: new DatabaseManager 只出现在 cli.ts + server/index.ts;没有
//      独立于 DatabaseManager 的 CoreDatabase 生产构造路径)。
//   - open/close/health/checkpointCore 行为正确,idempotent,句柄在 close 后真正
//     关闭 (process exit 无未关闭句柄)。
//   - wiki getter / checkpointWiki / health().wiki: plan-01 起为真实实现
//     (open() 构造 WikiDatabase,checkpointWiki 调 wal_checkpoint(TRUNCATE),
//      health() 返回 core + wiki 两项)。
//   - P1-4: backupCore / backupWiki 已从 DatabaseManager 删除。backup 单 owner
//     是 src/server/wiki-backup-service.ts 的 BackupService(snapshot/manifest/
//     restore via SQLite Backup API + 只读连接)。DatabaseManager 仅持有 DB 路
//     径 + active-handle lifecycle,通过 getCoreDbPath/getWikiDbPath/
//     getCoreBackupDir/getWikiBackupDir getter 向 BackupService 暴露路径。
//   - DatabaseManager 不暴露跨库 SQL/transaction/ATTACH(§G 拒绝条件)。
//   - core 与 wiki 的 checkpoint/backup 互不委托(结构独立性)。
//   - readonly 诊断 (check-turns.cjs) 用 file:...?mode=ro + { readonly: true },
//     不 checkpoint/VACUUM/migrate 活跃库 (acceptance §D bullet 3)。
//
// ## 输入
//   - ZERO_CORE_DIR (vitest.config.ts 注入的 per-worker temp dir)
//   - src/ + scripts/ 源文件系统读取(用于结构级 grep 审计)
//
// ## 输出
// Vitest 用例。每个用例真跑 DatabaseManager,绝不读活跃 ~/.zero-core。
//
// ## 关键文件
//   - src/server/database-manager.ts (DatabaseManager class + singleton getters)
//   - src/server/core-database.ts (CoreDatabase — owned by DatabaseManager)
//   - src/server/wiki-database.ts (WikiDatabase re-export shim → src/server/wiki/wiki-database.ts 真实实现)
//   - src/server/index.ts (composition root wiring)
//   - src/cli.ts (headless composition root)
//   - scripts/check-turns.cjs (readonly diagnostic script)
//
// ## 维护规则
//   - 每个用例 beforeEach/afterEach 跑 cleanLayoutState(),仅清 plan-00 涉及的
//     固定路径,绝不 rmSync(ZERO_CORE_DIR) 整个目录(其他单测可能共用)。
//   - 测试 DB 真在 OS temp 路径创建,绝不读活跃 ~/.zero-core。
//   - 本测试只读 scripts/check-turns.cjs 源码做 grep 审计,不 require 它。
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

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
	const d = mkdtempSync(join(tmpdir(), "zc-db-mgr-"));
	process.env.ZERO_CORE_DIR = d;
	return d;
});

import { existsSync, rmSync, readFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DatabaseManager,
	setDatabaseManager,
	getDatabaseManager,
	DATABASE_LAYOUT_CONFLICT,
} from "../../src/server/database-manager.js";
import { CoreDatabase } from "../../src/server/core-database.js";
// Value import (not `import type`): plan-01 wiki getter returns a real
// WikiDatabase instance after open(); the instanceof assertion below needs the
// class value. P1-6 removed the re-export shim at src/server/wiki-database.ts;
// import the real class directly from src/server/wiki/wiki-database.ts.
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import {
	coreDbPath,
	legacyCoreDbPath,
	layoutMarkerPath,
	coreBackupDir,
	DB_DIR,
	wikiDbPath,
} from "../../src/core/database-paths.js";
import { ZERO_CORE_DIR } from "../../src/core/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Surgical removal of every file/dir the bootstrap + DatabaseManager.open may
 * create. Does NOT touch the ZERO_CORE_DIR root itself — sibling unit tests
 * share the worker's temp dir. `force: true` so missing entries don't throw
 * and locked files don't break the run.
 */
function cleanLayoutState(): void {
	for (const p of [
		coreDbPath,
		`${coreDbPath}-wal`,
		`${coreDbPath}-shm`,
		`${coreDbPath}.tmp`,
		legacyCoreDbPath,
		`${legacyCoreDbPath}-wal`,
		`${legacyCoreDbPath}-shm`,
		layoutMarkerPath,
		// plan-01: DatabaseManager.open() now also constructs WikiDatabase at
		// wikiDbPath. Tests in this file drive open(), so wiki.db{,-wal,-shm}
		// must be cleaned between cases (defensive — MEMORY journal mode in test
		// env produces no -wal/-shm, but WAL mode would).
		wikiDbPath,
		`${wikiDbPath}-wal`,
		`${wikiDbPath}-shm`,
	]) {
		try { rmSync(p, { force: true }); } catch { /* best effort */ }
	}
	try { rmSync(coreBackupDir, { recursive: true, force: true }); } catch { /* empty */ }
}

/** Read a TS/CJS source file under the repo as a UTF-8 string (for audit). */
function readSrc(rel: string): string {
	return readFileSync(join(ROOT, rel), "utf-8");
}

/**
 * Normalize an absolute path to a forward-slash repo-relative string
 * (`./src/server/index.ts`). Windows `path.join` uses `\`; we normalize to `/`
 * so the allow-list comparison is OS-agnostic.
 */
function relPosix(absPath: string): string {
	const rel = absPath.replace(ROOT, ".");
	return rel.split("\\").join("/");
}

/**
 * Strip comment lines from a source string so audits don't trip on prose
 * mentions of identifiers. Recognizes `//` line comments, `*`/`/*` block
 * comment lines. Conservative (line-level, not token-level) — sufficient for
 * audits that look for whole-word patterns on code lines.
 */
function stripComments(src: string): string {
	return src
		.split(/\r?\n/)
		.filter((l) => {
			const t = l.trim();
			return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
		})
		.join("\n");
}

/** Walk a directory recursively, returning absolute paths of files matching suffix. */
function walk(dir: string, suffix: string): string[] {
	const out: string[] = [];
	const go = (d: string) => {
		let entries: ReturnType<typeof readdirSync>;
		try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.name === "node_modules" || e.name === "dist" || e.name === ".vite") continue;
			const full = join(d, e.name);
			if (e.isDirectory()) go(full);
			else if (e.isFile() && e.name.endsWith(suffix)) out.push(full);
		}
	};
	go(dir);
	return out;
}

/**
 * Find the body of a method, skipping comment-header mentions. Method
 * definitions in this codebase are indented with a single TAB and end their
 * signature line with `{`. Comment-header mentions live on lines starting
 * with ` *` and never carry a `{`. We scan line-by-line for a code-line
 * matching `signature` AND containing `{` on the same line, then return from
 * that line through the matching closing `}` (brace-depth tracked so we don't
 * bleed into the next method's body or JSDoc).
 */
function findMethodBody(src: string, signature: RegExp): string {
	const lines = src.split(/\r?\n/);
	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
		// Method definition line: matches signature AND opens its body with `{`
		// on the same line (the convention used throughout database-manager.ts).
		if (signature.test(line) && /\{\s*$/.test(line)) {
			startIdx = i;
			break;
		}
	}
	if (startIdx === -1) return "";
	// Walk forward tracking brace depth. The signature line opened the body
	// with exactly one `{` at end-of-line. Stop when depth returns to 0.
	let depth = 0;
	let endIdx = startIdx;
	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i];
		// Count braces on this line (naive — strings/comments in database-manager.ts
		// don't contain unbalanced braces that would trip this for the methods we
		// audit). Skip pure-comment lines so their braces don't count.
		const isComment = line.trim().startsWith("//") || line.trim().startsWith("*") || line.trim().startsWith("/*");
		if (!isComment) {
			for (const ch of line) {
				if (ch === "{") depth++;
				else if (ch === "}") depth--;
			}
		}
		endIdx = i;
		if (depth <= 0 && i > startIdx) break;
	}
	return lines.slice(startIdx, endIdx + 1).join("\n");
}

beforeEach(() => {
	cleanLayoutState();
});

afterEach(() => {
	cleanLayoutState();
});

// ============================================================
// §D bullet 1 — DatabaseManager is sole CoreDatabase lifecycle owner
// ============================================================

describe("acceptance-00 §D.1 — sole CoreDatabase lifecycle ownership", () => {
	test("`new DatabaseManager(` appears ONLY in the 3 licensed sites: server/index.ts + cli.ts + agent-service.ts singleton-aware fallback", () => {
		// Audit all src TS files for direct DatabaseManager construction. The
		// invariant is "at most ONE DatabaseManager per PROCESS" (sole owner),
		// NOT "a single textual construction site". Three licensed sites exist:
		//   - src/server/index.ts  — server composition root (constructs + sets
		//     the singleton).
		//   - src/cli.ts           — headless CLI composition root (constructs
		//     + sets the singleton).
		//   - src/server/agent-service.ts — resolveCoreDatabase() DI fallback
		//     (plan-00 round-2 FIX 6). This site is singleton-aware: it checks
		//     getDatabaseManager() FIRST and only constructs when no singleton
		//     is registered, then immediately setDatabaseManager()s the new
		//     instance — so it can never spawn a second live owner. Verified
		//     structurally by the next test.
		const files = walk(join(ROOT, "src"), ".ts");
		expect(files.length).toBeGreaterThan(0);
		const hits: Array<{ file: string; line: number }> = [];
		for (const f of files) {
			const src = readFileSync(f, "utf-8").split(/\r?\n/);
			for (let i = 0; i < src.length; i++) {
				const line = src[i];
				// Skip comment lines — they may cite the symbol in prose.
				const trimmed = line.trim();
				if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
				if (/new\s+DatabaseManager\s*\(/.test(line)) {
					hits.push({ file: relPosix(f), line: i + 1 });
				}
			}
		}
		// Allow-list: the two composition roots + the singleton-aware DI fallback.
		const allowed = new Set<string>([
			"./src/server/index.ts",
			"./src/cli.ts",
			"./src/server/agent-service.ts",
		]);
		const offenders = hits.filter((h) => !allowed.has(h.file));
		if (offenders.length > 0) {
			console.error("Unexpected `new DatabaseManager(` sites:\n" +
				offenders.map((h) => `${h.file}:${h.line}`).join("\n"));
		}
		expect(offenders.length).toBe(0);
		// And all three allowed sites actually DO construct it (guards against
		// the allow-list drifting away from reality).
		expect(hits.some((h) => h.file === "./src/server/index.ts")).toBe(true);
		expect(hits.some((h) => h.file === "./src/cli.ts")).toBe(true);
		expect(hits.some((h) => h.file === "./src/server/agent-service.ts")).toBe(true);
	});

	test("agent-service.ts resolveCoreDatabase() is singleton-aware: checks getDatabaseManager() FIRST, registers via setDatabaseManager() (at most ONE owner per process)", () => {
		// plan-00 round-2 FIX 6 invariant: the agent-service.ts fallback must NOT
		// be a second independent construction site. It must (a) consult the
		// process singleton via getDatabaseManager() BEFORE constructing, (b)
		// return the existing .core when present, and (c) register any newly
		// constructed instance via setDatabaseManager() so subsequent callers see
		// it. This is what keeps "3 textual sites" safe under the "1 live owner"
		// invariant.
		const src = readSrc("src/server/agent-service.ts");
		const body = findMethodBody(src, /function\s+resolveCoreDatabase\s*\(/);
		expect(body.length).toBeGreaterThan(0);
		const code = stripComments(body);
		const lines = code.split(/\r?\n/);
		// All three calls must be present in the body.
		const idxGet = lines.findIndex((l) => /getDatabaseManager\s*\(/.test(l));
		const idxNew = lines.findIndex((l) => /new\s+DatabaseManager\s*\(/.test(l));
		const idxSet = lines.findIndex((l) => /setDatabaseManager\s*\(/.test(l));
		expect(idxGet).toBeGreaterThanOrEqual(0);
		expect(idxNew).toBeGreaterThanOrEqual(0);
		expect(idxSet).toBeGreaterThanOrEqual(0);
		// CRITICAL ordering: getDatabaseManager() is consulted BEFORE any new
		// DatabaseManager() — so when a singleton is already registered (the
		// normal prod path, server/CLI both set it), construction is skipped
		// entirely and no second owner can appear.
		expect(idxGet).toBeLessThan(idxNew);
		// And the new instance is registered (setDatabaseManager) so it becomes
		// the singleton for any later caller.
		expect(idxSet).toBeGreaterThan(idxNew);
		// The early-return on the existing singleton must be present (otherwise
		// getDatabaseManager() would be a dead read).
		expect(code).toMatch(/if\s*\(\s*existing\s*\)\s*return\s+existing\.core/);
	});

	test("`new CoreDatabase(` appears ONLY in DatabaseManager.open() + agent-service.ts DI fallback in src/", () => {
		// Direct construction of CoreDatabase outside DatabaseManager bypasses the
		// layout bootstrap — that breaks the "sole lifecycle owner" invariant.
		// We allow exactly two sites:
		//   (1) DatabaseManager.open()  — the canonical owner
		//   (2) agent-service.ts ctor   — defensive DI fallback (`sessionDb ?? new CoreDatabase()`)
		//       that NEVER fires in production: both server/index.ts and cli.ts
		//       inject `dbManager.core` into createAgentService. The fallback is
		//       a smell (see findings), but it is not a live second owner.
		const files = walk(join(ROOT, "src"), ".ts");
		const hits: Array<{ file: string; line: number; text: string }> = [];
		for (const f of files) {
			const src = readFileSync(f, "utf-8").split(/\r?\n/);
			for (let i = 0; i < src.length; i++) {
				const line = src[i];
				const trimmed = line.trim();
				if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
				if (/new\s+CoreDatabase\s*\(/.test(line)) {
					hits.push({ file: relPosix(f), line: i + 1, text: trimmed });
				}
			}
		}
		const allowedFiles = new Set<string>([
			"./src/server/database-manager.ts",
			"./src/server/agent-service.ts",
		]);
		const offenders = hits.filter((h) => !allowedFiles.has(h.file));
		if (offenders.length > 0) {
			console.error("Unexpected `new CoreDatabase(` sites:\n" +
				offenders.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n"));
		}
		expect(offenders.length).toBe(0);
		// Canonical owner exists.
		expect(hits.some((h) => h.file === "./src/server/database-manager.ts")).toBe(true);
	});

	test("server/index.ts calls setDatabaseManager(dbManager) and threads dbManager.core into createAgentService (no independent SessionDB)", () => {
		const idx = readSrc("src/server/index.ts");
		// Singleton registration.
		expect(idx).toMatch(/setDatabaseManager\s*\(\s*dbManager\s*\)/);
		// DatabaseManager construction + open.
		expect(idx).toMatch(/new\s+DatabaseManager\s*\(\s*\)/);
		expect(idx).toMatch(/dbManager\.open\s*\(\s*\)/);
		// The CoreDatabase handle handed to downstream services is dbManager.core
		// (NOT a second `new CoreDatabase()`).
		expect(idx).toMatch(/dbManager\.core\b/);
		// No SessionDB references on code lines (comment mentions are allowed; here
		// we just assert the production-callable import line was renamed).
		expect(idx).not.toMatch(/from\s+["']\.\/session-db\.js["']/);
	});

	test("cli.ts constructs DatabaseManager + open() (layout bootstrap parity with server)", () => {
		const cli = readSrc("src/cli.ts");
		expect(cli).toMatch(/new\s+DatabaseManager\s*\(\s*\)/);
		expect(cli).toMatch(/dbManager\.open\s*\(\s*\)/);
		expect(cli).toMatch(/dbManager\.core\b/);
		// No SessionDB import.
		expect(cli).not.toMatch(/from\s+["']\.\.\/server\/session-db\.js["']/);
	});

	test("getDatabaseManager() returns undefined before setDatabaseManager; returns the wired instance after", () => {
		// Default state: no singleton registered.
		setDatabaseManager(undefined);
		expect(getDatabaseManager()).toBeUndefined();

		// Open a real DatabaseManager and register it.
		const mgr = new DatabaseManager();
		mgr.open();
		setDatabaseManager(mgr);
		try {
			expect(getDatabaseManager()).toBe(mgr);
			// The registered instance is fully wired: its .core is open.
			expect(getDatabaseManager()!.core).toBe(mgr.core);
			const health = getDatabaseManager()!.health();
			expect(health.core).toBeDefined();
			expect(health.core.integrity).toBe("ok");
		} finally {
			setDatabaseManager(undefined);
			mgr.close();
		}
		expect(getDatabaseManager()).toBeUndefined();
	});
});

// ============================================================
// §D bullet 4 + plan-00 §3 — open/close/health/checkpointCore behavior
// ============================================================

describe("acceptance-00 §D.4 + plan-00 §3 — DatabaseManager lifecycle behavior", () => {
	test("open() constructs the core handle; .core is usable after open", () => {
		const mgr = new DatabaseManager();
		expect(() => mgr.core).toThrow(/before open|after close/i);
		mgr.open();
		try {
			const cdb = mgr.core;
			expect(cdb).toBeInstanceOf(CoreDatabase);
			// The handle is a real open better-sqlite3 connection.
			expect((cdb.getDb() as any).open).toBe(true);
		} finally {
			mgr.close();
		}
	});

	test("open() is idempotent (re-calling is a no-op, same core instance)", () => {
		const mgr = new DatabaseManager();
		mgr.open();
		const coreAfterFirst = mgr.core;
		// Second open is a no-op (does not re-bootstrap or replace the handle).
		expect(() => mgr.open()).not.toThrow();
		const coreAfterSecond = mgr.core;
		expect(coreAfterSecond).toBe(coreAfterFirst);
		mgr.close();
	});

	test("close() disposes the core handle; underlying better-sqlite3 connection is closed", () => {
		const mgr = new DatabaseManager();
		mgr.open();
		const coreRef = mgr.core;
		expect((coreRef.getDb() as any).open).toBe(true);

		mgr.close();
		// The better-sqlite3 handle is truly closed — not just forgotten by the
		// manager. This is the "process exit leaves no open handles" guarantee
		// (acceptance §D bullet 4).
		expect((coreRef.getDb() as any).open).toBe(false);
	});

	test("close() is idempotent (re-calling is a no-op)", () => {
		const mgr = new DatabaseManager();
		mgr.open();
		expect(() => mgr.close()).not.toThrow();
		// Second close is a no-op (must not throw on already-closed state).
		expect(() => mgr.close()).not.toThrow();
	});

	test(".core access after close() throws (no zombie handle)", () => {
		const mgr = new DatabaseManager();
		mgr.open();
		mgr.close();
		expect(() => mgr.core).toThrow(/before open|after close/i);
	});

	test("health() before open() throws", () => {
		const mgr = new DatabaseManager();
		expect(() => mgr.health()).toThrow(/before open/i);
	});

	test("health() after open returns { core: {...}, wiki: {...} } (plan-01 adds wiki entry)", () => {
		const mgr = new DatabaseManager();
		mgr.open();
		try {
			const h = mgr.health();
			// Shape lock: DatabaseHealthMap with `core` (always) and `wiki`
			// (plan-01+: open() constructs WikiDatabase, so health() reports it).
			expect(h).toHaveProperty("core");
			expect(h).toHaveProperty("wiki");

			// Core entry has the locked DatabaseHealthEntry fields.
			const c = h.core;
			expect(c).toHaveProperty("exists");
			expect(c).toHaveProperty("writable");
			expect(c).toHaveProperty("integrity");
			expect(c).toHaveProperty("foreignKeys");
			expect(c).toHaveProperty("journalMode");

			// On a fresh-opened WAL-or-MEMORY core.db these checks are sane.
			expect(c.integrity).toBe("ok");
			expect(c.foreignKeys).toBe("ok");
			expect(c.writable).toBe(true);

			// Wiki entry (plan-01) has the SAME DatabaseHealthEntry shape:
			// exists / integrity / foreignKeys / journalMode (+ writable).
			const w = h.wiki!;
			expect(w).toHaveProperty("exists");
			expect(w).toHaveProperty("writable");
			expect(w).toHaveProperty("integrity");
			expect(w).toHaveProperty("foreignKeys");
			expect(w).toHaveProperty("journalMode");
			expect(w.exists).toBe(true);
			expect(w.integrity).toBe("ok");
			expect(w.foreignKeys).toBe("ok");
		} finally {
			mgr.close();
		}
	});

	test("open → checkpointCore → close ordering works end-to-end (no throw)", () => {
		// plan-00 §3 "打开、checkpoint、close 的顺序有自动化测试" — drive the
		// canonical ordering and assert no step throws.
		const mgr = new DatabaseManager();
		mgr.open();
		// Write something so WAL has frames to checkpoint (WAL mode under
		// ZERO_CORE_DB_NO_WAL=1 uses MEMORY — checkpoint still returns cleanly).
		mgr.core.getKVStore().set("__dmgr_order_probe__", "x");
		expect(() => mgr.checkpointCore()).not.toThrow();
		mgr.core.getKVStore().delete("__dmgr_order_probe__");
		mgr.close();
	});

	test("checkpointCore() before open() throws (lifecycle guard)", () => {
		const mgr = new DatabaseManager();
		expect(() => mgr.checkpointCore()).toThrow(/before open/i);
	});

	test("checkpointCore() actually executes wal_checkpoint(TRUNCATE) on the core handle", () => {
		// Structural assertion: the source delegates to the core handle's
		// `pragma("wal_checkpoint(TRUNCATE)")`. Read the source and confirm the
		// implementation actually issues a TRUNCATE checkpoint (not a no-op).
		const src = readSrc("src/server/database-manager.ts");
		// The file as a whole contains wal_checkpoint(TRUNCATE) somewhere.
		expect(src).toMatch(/wal_checkpoint\(TRUNCATE\)/);
		// And it is inside the checkpointCore METHOD BODY (not the file-header
		// comment that enumerates the interface shape). Use findMethodBody to
		// skip the comment-header mention.
		const body = findMethodBody(src, /checkpointCore\(\)/);
		expect(body.length).toBeGreaterThan(0);
		expect(body).toMatch(/wal_checkpoint\(TRUNCATE\)/);
		expect(body).toMatch(/this\._core/);
	});
});

// ============================================================
// plan-00 §3 — placeholder signatures LOCKED (no rename in plan-01/08)
// ============================================================

describe("plan-01 §3 — wiki/checkpointWiki real (plan-01); P1-4 removed backupCore/backupWiki from DatabaseManager (single owner = BackupService)", () => {
	test("wiki getter throws before open(); returns a WikiDatabase instance after open (plan-01)", () => {
		const mgr = new DatabaseManager();
		// Pre-open: wiki getter throws (mirrors the core getter lifecycle guard).
		expect(() => mgr.wiki).toThrow(/before open|after close/i);
		mgr.open();
		try {
			// plan-01: wiki getter returns a real WikiDatabase instance once open()
			// has completed the core+wiki ready-order.
			expect(mgr.wiki).toBeInstanceOf(WikiDatabase);
		} finally {
			mgr.close();
		}
		// After close: throws again (no zombie handle).
		expect(() => mgr.wiki).toThrow(/before open|after close/i);
	});

	test("checkpointWiki() runs wal_checkpoint(TRUNCATE) on the wiki handle without throwing (plan-01)", () => {
		// plan-00 used to throw WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00; plan-01 wires
		// checkpointWiki to the wiki handle's wal_checkpoint(TRUNCATE). Mirror the
		// checkpointCore body-source assertion pattern: behavioral no-throw +
		// structural proof the chain reaches SQLite.
		const mgr = new DatabaseManager();
		// Lifecycle guard parity with checkpointCore: throws before open().
		expect(() => mgr.checkpointWiki()).toThrow(/before open/i);
		mgr.open();
		try {
			expect(() => mgr.checkpointWiki()).not.toThrow();
		} finally {
			mgr.close();
		}

		// Structural: database-manager.ts checkpointWiki body delegates to the
		// wiki handle (this._wiki) and NO LONGER carries the plan-00 placeholder.
		const src = readSrc("src/server/database-manager.ts");
		const body = findMethodBody(src, /checkpointWiki\(\)/);
		expect(body.length).toBeGreaterThan(0);
		const code = stripComments(body);
		expect(code).toMatch(/this\._wiki/);
		expect(code).not.toMatch(/WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00/);

		// And the underlying WikiDatabase.checkpoint() actually issues
		// wal_checkpoint(TRUNCATE) — proves the delegation reaches SQLite.
		const wikiSrc = readSrc("src/server/wiki/wiki-database.ts");
		const wikiCheckpointBody = findMethodBody(wikiSrc, /checkpoint\(\)\s*:\s*void/);
		expect(wikiCheckpointBody.length).toBeGreaterThan(0);
		expect(stripComments(wikiCheckpointBody)).toMatch(/wal_checkpoint\(TRUNCATE\)/);
	});

	test("backupCore/backupWiki are NOT members of DatabaseManager (P1-4: single owner = BackupService)", () => {
		// P1-4 contract: DatabaseManager no longer exposes backupCore/backupWiki.
		// The dead placeholder throws (split-ownership smell) were removed;
		// backup is unified under BackupService (src/server/wiki-backup-service.ts).
		// Assert the methods are gone from the public surface, both at the
		// type level (compile-time) and at the runtime prototype level.
		const mgr = new DatabaseManager();
		expect((mgr as unknown as Record<string, unknown>).backupCore).toBeUndefined();
		expect((mgr as unknown as Record<string, unknown>).backupWiki).toBeUndefined();
		expect("backupCore" in mgr).toBe(false);
		expect("backupWiki" in mgr).toBe(false);
	});

	// --------------------------------------------------------------------
	// Compile-time signature lock — P1-4 shapes. The kept methods are present
	// with their plan-00 §3 shapes; backupCore/backupWiki are ABSENT. If a
	// future change re-adds them or renames a kept method, the type
	// instantiations below fail at compile time.
	// --------------------------------------------------------------------
	test("compile-time signature lock — kept methods present; backupCore/backupWiki NOT members (P1-4)", () => {
		// Kept plan-00 §3 shapes:
		//   open(): void
		//   close(): void
		//   health(): DatabaseHealthMap
		//   checkpointCore(): void
		//   checkpointWiki(): void
		type _AssertOpen = DatabaseManager["open"] extends () => void ? true : never;
		type _AssertClose = DatabaseManager["close"] extends () => void ? true : never;
		type _AssertCheckpointCore = DatabaseManager["checkpointCore"] extends () => void ? true : never;
		type _AssertCheckpointWiki = DatabaseManager["checkpointWiki"] extends () => void ? true : never;
		type _AssertCore = DatabaseManager["core"] extends CoreDatabase ? true : never;
		type _AssertWiki = DatabaseManager["wiki"] extends WikiDatabase | undefined ? true : never;
		// P1-4 NEGATIVE shape lock: backupCore/backupWiki are NOT members. The
		// conditional resolves to `true` only when the key is absent from
		// keyof DatabaseManager — assigning `true` to it forces evaluation.
		type _NoBackupCore = "backupCore" extends keyof DatabaseManager ? false : true;
		type _NoBackupWiki = "backupWiki" extends keyof DatabaseManager ? false : true;
		const _ok1: _AssertOpen = true;
		const _ok2: _AssertClose = true;
		const _ok3: _AssertCheckpointCore = true;
		const _ok4: _AssertCheckpointWiki = true;
		const _ok5: _AssertCore = true;
		const _ok6: _AssertWiki = true;
		const _ok7: _NoBackupCore = true;
		const _ok8: _NoBackupWiki = true;
		void [_ok1, _ok2, _ok3, _ok4, _ok5, _ok6, _ok7, _ok8];
		expect(true).toBe(true); // runtime anchor; the real check is the type instantiations above
	});

	test("DATABASE_LAYOUT_CONFLICT is a stable string code (P1-4: WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00 removed)", () => {
		// P1-4: WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00 was deleted along with the
		// backupCore/backupWiki placeholder methods. DATABASE_LAYOUT_CONFLICT
		// remains the sole startup/layout error code (plan-00 §4 closed set).
		expect(typeof DATABASE_LAYOUT_CONFLICT).toBe("string");
		expect(DATABASE_LAYOUT_CONFLICT).toBe("DATABASE_LAYOUT_CONFLICT");
	});

	test("DatabaseManager exposes P1-4 path-authority getters (core/wiki DB + backup dirs)", () => {
		// P1-4: BackupService consumes these instead of re-importing
		// database-paths constants. The getters must return string paths
		// (callers like server/index.ts pass them to BackupService).
		const mgr = new DatabaseManager();
		expect(typeof mgr.getCoreDbPath()).toBe("string");
		expect(mgr.getCoreDbPath()).toMatch(/core\.db$/);
		expect(typeof mgr.getWikiDbPath()).toBe("string");
		expect(mgr.getWikiDbPath()).toMatch(/wiki\.db$/);
		expect(typeof mgr.getCoreBackupDir()).toBe("string");
		expect(mgr.getCoreBackupDir().length).toBeGreaterThan(0);
		expect(typeof mgr.getWikiBackupDir()).toBe("string");
		expect(mgr.getWikiBackupDir().length).toBeGreaterThan(0);
	});
});

// ============================================================
// §G bullet (d) — NO cross-DB SQL / transaction / ATTACH
// ============================================================

describe("acceptance-00 §G (d) — DatabaseManager exposes no cross-DB transaction / ATTACH", () => {
	test("database-manager.ts source does NOT use ATTACH DATABASE", () => {
		// plan-00 §G (d): "DatabaseManager 暗中提供跨库 transaction" is rejected.
		// Audit the source for any ATTACH (the canonical cross-DB primitive).
		const src = readSrc("src/server/database-manager.ts");
		// Strip comment lines (prose may mention ATTACH as a "don't do this").
		const codeLines = src.split(/\r?\n/).filter((l) => {
			const t = l.trim();
			return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
		});
		const codeOnly = codeLines.join("\n");
		expect(codeOnly).not.toMatch(/\bATTACH\b/i);
	});

	test("database-manager.ts source does NOT open a BEGIN ... COMMIT spanning two connections", () => {
		// A cross-connection transaction would require holding two Database
		// handles simultaneously and issuing BEGIN on a wrapper. The plan-00
		// DatabaseManager only ever holds `this._core` (and a brief legacy RW
		// handle during migrateLegacyToCore, which is closed before the next
		// handle opens — sequential, not concurrent).
		const src = readSrc("src/server/database-manager.ts");
		// Forbidden: any "transaction" helper that takes >1 connection. The
		// better-sqlite3 `db.transaction()` helper is per-connection, so the
		// risk is a hand-rolled BEGIN ... COMMIT bridging two `new Database()`
		// instances. We assert the file does not declare such a helper.
		// Heuristic: no `BEGIN` keyword on a code line.
		const codeLines = src.split(/\r?\n/).filter((l) => {
			const t = l.trim();
			return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
		});
		const codeOnly = codeLines.join("\n");
		expect(codeOnly).not.toMatch(/\bBEGIN\s+(TRANSACTION|DEFERRED|IMMEDIATE|EXCLUSIVE)\b/i);
		expect(codeOnly).not.toMatch(/\bCOMMIT\b/i);
	});

	test("migrateLegacyToCore opens legacy + tmp handles SEQUENTIALLY (copyFileSync, never concurrent)", () => {
		// plan-00 round-2 FIX 1: the readonly `source` handle + async
		// `source.backup(tmpPath)` was REPLACED by synchronous
		// `copyFileSync(legacyCoreDbPath, tmpPath)` AFTER wal_checkpoint(TRUNCATE)
		// + legacy.close(). The legacy handle is closed before the copy, and the
		// tmp probe handle is opened after the copy — at no point are two DB
		// handles open at once. Assert the NEW structure.
		const src = readSrc("src/server/database-manager.ts");
		const body = findMethodBody(src, /function\s+migrateLegacyToCore\s*\(/);
		expect(body.length).toBeGreaterThan(0);
		const code = stripComments(body);
		const lines = code.split(/\r?\n/);
		// 1) legacy handle: open → wal_checkpoint(TRUNCATE) → close (try/finally).
		const idxLegacyOpen = lines.findIndex((l) => /const\s+legacy\s*=\s*new\s+Database\s*\(/.test(l));
		const idxLegacyCheckpoint = lines.findIndex((l) => /wal_checkpoint\(TRUNCATE\)/.test(l));
		const idxLegacyClose = lines.findIndex((l) => /legacy\.close\s*\(\s*\)/.test(l));
		expect(idxLegacyOpen).toBeGreaterThanOrEqual(0);
		expect(idxLegacyCheckpoint).toBeGreaterThan(idxLegacyOpen);
		expect(idxLegacyClose).toBeGreaterThan(idxLegacyCheckpoint);
		// 2) Synchronous copyFileSync replaces the async Backup API (FIX 1).
		//    Must run AFTER legacy.close() (no concurrent handle on the source).
		const idxCopy = lines.findIndex((l) => /copyFileSync\s*\(\s*legacyCoreDbPath/.test(l));
		expect(idxCopy).toBeGreaterThanOrEqual(0);
		expect(idxCopy).toBeGreaterThan(idxLegacyClose);
		// 3) probe handle: open (readonly) → integrity/foreign_key checks → close.
		const idxProbeOpen = lines.findIndex((l) => /const\s+probe\s*=\s*new\s+Database\s*\(/.test(l));
		const idxProbeClose = lines.findIndex((l) => /probe\.close\s*\(\s*\)/.test(l));
		expect(idxProbeOpen).toBeGreaterThanOrEqual(0);
		expect(idxProbeOpen).toBeGreaterThan(idxCopy);
		expect(idxProbeClose).toBeGreaterThan(idxProbeOpen);
		// 4) NO async `source.backup(` on CODE lines (the FIX 1 regression we
		//    defend against — the unawaited Promise that bricked migration).
		expect(code).not.toMatch(/source\.backup\s*\(/);
		// And no `source` readonly handle is opened at all (FIX 1 removed it).
		expect(code).not.toMatch(/const\s+source\s*=\s*new\s+Database/);
	});
});

// ============================================================
// §D bullet 2 + §3 independence — core/wiki checkpoint/backup independent
// ============================================================

describe("acceptance-00 §D.2 + plan-00 §3 — core and wiki checkpoint are independent (P1-4: backup removed from DatabaseManager)", () => {
	test("checkpointCore body does NOT delegate to checkpointWiki (or vice versa)", () => {
		const src = readSrc("src/server/database-manager.ts");
		// Use findMethodBody to extract ONLY checkpointCore's body (brace-depth
		// tracked so we don't bleed into the next method's JSDoc).
		const coreBody = findMethodBody(src, /checkpointCore\(\)/);
		expect(coreBody.length).toBeGreaterThan(0);
		// checkpointCore must NOT call this.checkpointWiki (would couple them).
		// Strip comments first — the body has no `this.checkpointWiki(...)` call
		// in code, but JSDoc on the next method could mention the name.
		const coreCode = stripComments(coreBody);
		expect(coreCode).not.toMatch(/this\.checkpointWiki/);
		// And it must use the core handle's pragma (positive assertion).
		expect(coreCode).toMatch(/wal_checkpoint\(TRUNCATE\)/);

		// Conversely checkpointWiki delegates to the wiki handle (NOT to
		// checkpointCore). plan-01 filled it: it now calls this._wiki.checkpoint()
		// and no longer carries the plan-00 WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00
		// placeholder.
		const wikiBody = findMethodBody(src, /checkpointWiki\(\)/);
		expect(wikiBody.length).toBeGreaterThan(0);
		const wikiCode = stripComments(wikiBody);
		expect(wikiCode).not.toMatch(/this\.checkpointCore/);
		expect(wikiCode).toMatch(/this\._wiki/);
		expect(wikiCode).not.toMatch(/WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00/);
	});

	test("open() constructs BOTH core and wiki handles (plan-01 ready-order: core + wiki ready before open returns)", () => {
		// Structural: plan-01 open() assigns BOTH this._core (CoreDatabase) AND
		// this._wiki (WikiDatabase). The ready-order invariant (plan-01 §1)
		// requires core + wiki to both be ready before open() returns, so
		// downstream AgentService/recovery can rely on both. plan-00 only
		// assigned _core; plan-01 added the _wiki assignment.
		const src = readSrc("src/server/database-manager.ts");
		const openBody = findMethodBody(src, /open\(\)\s*:\s*void/);
		expect(openBody.length).toBeGreaterThan(0);
		const openCode = stripComments(openBody);
		// open() assigns BOTH handles (plan-01 ready-order).
		expect(openCode).toMatch(/this\._core\s*=\s*new\s+CoreDatabase/);
		expect(openCode).toMatch(/this\._wiki\s*=\s*new\s+WikiDatabase/);
	});
});

// ============================================================
// §D bullet 2 + §D bullet 3 — diagnostic scripts use new paths + readonly
// ============================================================

describe("acceptance-00 §D.2/§D.3 — diagnostic + self-update scripts use new paths, readonly invariant", () => {
	test("scripts/check-turns.cjs opens core.db via file:...?mode=ro readonly URI (no checkpoint/VACUUM/migrate)", () => {
		// memory feedback-sessions-db-readonly: external diagnostics MUST open
		// snapshots or the live Core DB with { readonly: true } and MUST NOT
		// checkpoint/VACUUM/migrate. Assert the script source obeys this.
		const rawSrc = readSrc("scripts/check-turns.cjs");
		// Strip comment lines — the source's own docstring says "绝不
		// checkpoint/VACUUM/migrate", which would false-positive the VACUUM audit.
		const src = stripComments(rawSrc);
		// Path updated to db/core.db (not sessions.db). The literal appears as
		// part of a longer path string (e.g. ".zero-core/db/core.db"), so we
		// assert `core.db` is present as a substring of a string literal.
		expect(src).toMatch(/["'][^"']*core\.db[^"']*["']/);
		expect(src).toMatch(/db[\\/]core\.db/);
		// No writable sessions.db opens on the active path.
		expect(src).not.toMatch(/file:.*sessions\.db/);
		// Readonly URI pattern.
		expect(src).toMatch(/\?mode=ro/);
		expect(src).toMatch(/\{\s*readonly:\s*true\s*\}/);
		// Forbidden write/checkpoint primitives on CODE lines only.
		expect(src).not.toMatch(/wal_checkpoint/i);
		expect(src).not.toMatch(/\bVACUUM\b/i);
		expect(src).not.toMatch(/ALTER\s+TABLE/i);
		expect(src).not.toMatch(/CREATE\s+TABLE/i);
		expect(src).not.toMatch(/INSERT\s+INTO/i);
		expect(src).not.toMatch(/UPDATE\s+\w+\s+SET/i);
		expect(src).not.toMatch(/DELETE\s+FROM/i);
	});

	test("scripts/self-update-restore.cjs detects the renamed core.db-shm (and tolerates legacy sessions.db-shm)", () => {
		// plan-00 §6: WAL/SHM "is the app still running" detection must follow
		// the rename. The script checks db/core.db-shm (new) AND sessions.db-shm
		// (legacy, for snapshots taken before the layout switch).
		const src = readSrc("scripts/self-update-restore.cjs");
		// The script constructs the path via path.join(zcDir, "db") +
		// "core.db-shm" — assert BOTH literals are present (the rename landed).
		expect(src).toMatch(/["']core\.db-shm["']/);
		expect(src).toMatch(/["']sessions\.db-shm["']/);
	});

	test("no production src TS file opens `sessions.db` as a writable active DB path", () => {
		// The legacy name may appear only in: (a) database-paths.ts as
		// `legacyCoreDbPath`, (b) database-manager.ts (the bootstrap consumer),
		// (c) comments. Any NEW database(...) open on a sessions.db path outside
		// the licensed bootstrap path is a violation.
		const files = walk(join(ROOT, "src"), ".ts");
		const offenders: Array<{ file: string; line: number; text: string }> = [];
		const allowedFiles = new Set<string>([
			relPosix(join(ROOT, "src", "core", "database-paths.ts")),
			relPosix(join(ROOT, "src", "server", "database-manager.ts")),
		]);
		for (const f of files) {
			const rel = relPosix(f);
			if (allowedFiles.has(rel)) continue;
			const src = readFileSync(f, "utf-8").split(/\r?\n/);
			for (let i = 0; i < src.length; i++) {
				const line = src[i];
				const trimmed = line.trim();
				if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
				// A writable open of "sessions.db" would be `new Database("...sessions.db")`
				// or similar. Detect the filename literal in a `new Database(...)` call.
				if (/new\s+Database\s*\([^)]*sessions\.db/.test(line)) {
					offenders.push({ file: rel, line: i + 1, text: trimmed });
				}
			}
		}
		if (offenders.length > 0) {
			console.error("Writable sessions.db opens in prod src:\n" +
				offenders.map((o) => `${o.file}:${o.line}: ${o.text}`).join("\n"));
		}
		expect(offenders.length).toBe(0);
	});
});

// ============================================================
// §D bullet 4 — performLayoutBootstrap is the DatabaseManager-owned entry
// ============================================================

describe("acceptance-00 §D.4 — performLayoutBootstrap is invoked only from DatabaseManager.open", () => {
	test("performLayoutBootstrap is called ONLY inside DatabaseManager.open() (no external prod caller)", () => {
		// Sole-ownership extends to the bootstrap entry: it must not be called
		// from anywhere other than DatabaseManager.open(). An external caller
		// could skip the knowledge.db cleanup or run bootstrap without wiring
		// the singleton.
		const files = walk(join(ROOT, "src"), ".ts");
		const hits: Array<{ file: string; line: number; text: string }> = [];
		for (const f of files) {
			const rel = relPosix(f);
			const src = readFileSync(f, "utf-8").split(/\r?\n/);
			for (let i = 0; i < src.length; i++) {
				const line = src[i];
				const trimmed = line.trim();
				if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
				// Definition site (`export function performLayoutBootstrap`) is exempt.
				if (/export\s+function\s+performLayoutBootstrap/.test(line)) continue;
				// Call site: `performLayoutBootstrap()` (possibly with leading dot).
				if (/\bperformLayoutBootstrap\s*\(\s*\)/.test(line)) {
					hits.push({ file: rel, line: i + 1, text: trimmed });
				}
			}
		}
		// Exactly ONE call site: DatabaseManager.open().
		const allowed = new Set<string>(["./src/server/database-manager.ts"]);
		const offenders = hits.filter((h) => !allowed.has(h.file));
		if (offenders.length > 0) {
			console.error("External performLayoutBootstrap callers in prod src:\n" +
				offenders.map((o) => `${o.file}:${o.line}: ${o.text}`).join("\n"));
		}
		expect(offenders.length).toBe(0);
		// And the canonical call site exists.
		expect(hits.some((h) => h.file === "./src/server/database-manager.ts")).toBe(true);
	});

	test("deleteRetiredKnowledgeDb is invoked ONLY inside DatabaseManager.open()", () => {
		// Same invariant for knowledge.db cleanup.
		const files = walk(join(ROOT, "src"), ".ts");
		const hits: Array<{ file: string; line: number; text: string }> = [];
		for (const f of files) {
			const rel = relPosix(f);
			const src = readFileSync(f, "utf-8").split(/\r?\n/);
			for (let i = 0; i < src.length; i++) {
				const line = src[i];
				const trimmed = line.trim();
				if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
				if (/export\s+function\s+deleteRetiredKnowledgeDb/.test(line)) continue;
				if (/\bdeleteRetiredKnowledgeDb\s*\(\s*\)/.test(line)) {
					hits.push({ file: rel, line: i + 1, text: trimmed });
				}
			}
		}
		const allowed = new Set<string>(["./src/server/database-manager.ts"]);
		const offenders = hits.filter((h) => !allowed.has(h.file));
		if (offenders.length > 0) {
			console.error("External deleteRetiredKnowledgeDb callers in prod src:\n" +
				offenders.map((o) => `${o.file}:${o.line}: ${o.text}`).join("\n"));
		}
		expect(offenders.length).toBe(0);
	});
});

// ============================================================
// Singleton state isolation — tests must not pollute the global singleton
// ============================================================

describe("DatabaseManager singleton isolation in tests", () => {
	test("setDatabaseManager(undefined) clears the singleton (no leakage between tests)", () => {
		// Defensive: this test guards against a prior test having left the
		// singleton populated. afterEach in the lifecycle tests must clean up.
		setDatabaseManager(undefined);
		expect(getDatabaseManager()).toBeUndefined();
		// Construct + register + clear.
		const mgr = new DatabaseManager();
		mgr.open();
		setDatabaseManager(mgr);
		expect(getDatabaseManager()).toBe(mgr);
		setDatabaseManager(undefined);
		mgr.close();
		expect(getDatabaseManager()).toBeUndefined();
	});
});
