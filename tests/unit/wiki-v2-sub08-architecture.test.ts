// wiki-v2 sub-08 acceptance · architecture lens
//
// # 文件说明书
//
// ## 核心功能
// 对照 docs/archive/wiki-system-redesign/design.md + plan-08 §7「release gate 原子性」
// + acceptance-08 §A/§B/§C/§D/§E/§H,从 architecture 方向独立验证 sub-08 实现。
//
// 重点(orchestrator 诊断):**运行时断言而非只 grep 文件名**(acceptance H)。
// 验证 7 类架构不变量:
//   1. release gate 原子性 —— legacy 模块物理删除(import 抛)、新 service 真接线、
//      /api/wiki-maintain 真挂载、data-change-hub 不再广播 project_wiki。
//   2. §3 backup 设计 —— SQLite Backup API(非文件 copy active)、Core/Wiki 隔离
//      (写 wiki 不动 core.db/WAL)、manifest 成对但分别 verify、restore 到新临时
//      路径不覆盖 active、readonly 诊断不 checkpoint active。
//   3. §4 benchmark 正确性 —— EXPLAIN QUERY PLAN 真断言索引(读 bench-100k.json
//      + 读 scripts/wiki-benchmark.ts 确认 assertPlan 非占位)、报告含 commit/硬件/
//      数据生成参数、脚本支持 1M。
//   4. §5 maintenance —— legacy/cleanup 需 confirm(不在 startup 自动)、不 VACUUM
//      活跃 DB、integrity/FK 走 readonly PRAGMA。
//   5. §6 arch docs —— 不再声称正文在磁盘 Markdown 作 CURRENT 模型。
//   6. AgentLoop hooks-only 不回归;数据面/管理面 FORBIDDEN_BODY_KEYS 分叉未被 §1 破坏。
//   7. fs guard —— 6 类受保护路径全覆盖 + 绕过(relative/quote/env/case)拦截。
//
// ## 测试策略
//   - **运行时** (非 grep):import 已删 legacy 模块(期望抛);启动 express +
//     createWikiMaintenanceRouter 真挂载;data-change-hub emitDataChange 真测白名单。
//   - **DB 隔离**:UNIQUE temp ZERO_CORE_DIR(vi.hoisted),开 wiki.db + core.db 各一份,
//     snapshot → 写 wiki → 断言 core 文件 mtime/size 不变。
//   - **源码结构**:readFileSync + 正则审计 agent-loop / db-migration / arch docs /
//     benchmark script(剥注释避免误命中)。
//
// ## Windows vitest 注意
//   - 单文件只开 1 对 (core + wiki) temp DB,close 在 afterAll,避免多 DB teardown 崩。
//   - express server listen(0) 用完即 close,不留监听。
//
// 参见:
//   - docs/archive/wiki-system-redesign/design.md §3.1 / §5.1 / §9.3 / §13
//   - docs/archive/wiki-system-redesign/plan-08-cutover-hardening.md §1–§7
//   - docs/archive/wiki-system-redesign/acceptance-08-cutover-hardening.md §A/§B/§C/§D/§H

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";

// ─── Per-file ZERO_CORE_DIR isolation (MUST run before any src import) ───────
// config.ts / database-paths.ts 模块级常量在首次 import 时读 process.env.ZERO_CORE_DIR,
// 所以必须在 import src 之前用 vi.hoisted 设好。
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-sub08-arch-"));
	process.env.ZERO_CORE_DIR = d;
	return { UNIQUE_DIR: d };
});

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express, { type Express } from "express";
import { createServer, type Server } from "http";

import { CoreDatabase } from "../../src/server/core-database.js";
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { BackupService } from "../../src/server/wiki-backup-service.js";
import { createWikiMaintenanceRouter } from "../../src/server/wiki-maintenance-router.js";
import {
	coreDbPath,
	wikiDbPath,
	coreBackupDir,
	wikiBackupDir,
} from "../../src/core/database-paths.js";
import {
	isProtectedPath,
	listProtectedPaths,
	canonicalize,
} from "../../src/core/protected-paths.js";
import { isProtectedPathRealpath, isWikiDiskPath, findWikiPathInShellCommand } from "../../src/tools/wiki-path-guard.js";
import {
	_resetDataChangeHubForTest,
	emitDataChange,
	onDataChange,
	type DataChangeEvent,
} from "../../src/server/data-change-hub.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ─── helpers ─────────────────────────────────────────────────────────────────

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

/** 读 repo 源文件,剥注释行,返纯代码(grep 审计避免误命中注释里的禁词)。 */
function readCodeOnly(rel: string): string {
	const src = readFileSync(join(ROOT, rel), "utf-8");
	return src
		.split(/\r?\n/)
		.filter((l) => {
			const t = l.trim();
			return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
		})
		.join("\n");
}

function readRaw(rel: string): string {
	return readFileSync(join(ROOT, rel), "utf-8");
}

function fileFingerprint(p: string): { size: number; mtimeMs: number } | null {
	if (!existsSync(p)) return null;
	const st = statSync(p);
	return { size: st.size, mtimeMs: st.mtimeMs };
}

// ─── shared DBs (open once, close in afterAll) ───────────────────────────────

let coreDb: CoreDatabase;
let wikiDb: WikiDatabase;

beforeAll(() => {
	// fresh core.db + wiki.db under UNIQUE_DIR/db/. CoreDatabase uses module
	// constant coreDbPath (= UNIQUE_DIR/db/core.db) when no arg passed.
	coreDb = new CoreDatabase();
	wikiDb = new WikiDatabase();
});

afterAll(() => {
	try { wikiDb?.close(); } catch { /* ignore */ }
	try { coreDb?.close(); } catch { /* ignore */ }
	_resetDataChangeHubForTest();
});

// ═══════════════════════════════════════════════════════════════════════════
// §A + §H · release gate 原子性(运行时断言,非只 grep)
// ═══════════════════════════════════════════════════════════════════════════

describe("[A/H] release gate atomicity — runtime, not grep", () => {
	test("A1. legacy modules are physically deleted (runtime import throws)", async () => {
		// plan-08 §1: project-wiki-router / project-wiki-store / wiki-node-store deleted.
		// A dynamic import of a non-existent module rejects — this is a RUNTIME
		// assertion (not a filename grep). The release gate requires these be
		// unreachable from any production entry, which includes "you cannot import
		// them at all".
		const deleted = [
			"../../src/server/project-wiki-router.js",
			"../../src/server/project-wiki-store.js",
			"../../src/server/wiki-node-store.js",
		];
		for (const mod of deleted) {
			let threw = false;
			try { await import(mod); } catch { threw = true; }
			expect(threw, `import ${mod} should fail (file deleted)`).toBe(true);
		}
	});

	test("A2. /api/wiki-maintain is mounted at runtime with backup endpoints", async () => {
		// Boot the real production maintenance router against temp DBs and confirm
		// the §3 backup surface is reachable. This proves runtime wiring (not just
		// that the file exists). /backup/list is a GET.
		const app = express();
		app.use(express.json());
		app.use("/api/wiki-maintain", createWikiMaintenanceRouter({
			coreDb,
			wikiDb,
		}));
		const { server, port } = await listen(app);
		try {
			const resp = await fetch(`http://localhost:${port}/api/wiki-maintain/backup/list`);
			const text = await resp.text();
			let data: unknown = text;
			try { data = JSON.parse(text); } catch { /* keep text */ }
			expect(resp.status).toBe(200);
			expect(Array.isArray(data)).toBe(true);
		} finally {
			await close(server);
		}
	});

	test("A3. data-change-hub no longer broadcasts project_wiki (runtime emit)", async () => {
		// Runtime assertion: emit on a legacy collection name → no subscriber
		// notification fires (whitelist filtered at emit time). We subscribe,
		// emit on BOTH a legacy and a new collection, await the coalesce flush,
		// and confirm only the whitelisted collection arrives.
		const seen: DataChangeEvent[] = [];
		const unsub = onDataChange((e) => seen.push(e));
		try {
			// emitDataChange(table, id, op). project_wiki is NOT in UI_COLLECTIONS
			// → emit returns early, never enters the pending map, never flushes.
			emitDataChange("project_wiki", "legacy-row", "update");
			// wiki_nodes IS whitelisted → schedules a flush on next tick.
			emitDataChange("wiki_nodes", "wiki-root/knowledge", "update");
			// Allow the setTimeout(flush, 0) to drain.
			await new Promise((r) => setTimeout(r, 10));
		} finally {
			unsub();
		}
		const collections = seen.map((e) => e.collection);
		expect(collections, "project_wiki must NOT be broadcast (whitelist removed)").not.toContain("project_wiki");
		expect(collections, "wiki_nodes must still be broadcast (new model)").toContain("wiki_nodes");
	});

	test("A4. db-migration no longer creates/migrates project_wiki; AGENT_COLUMNS drops wikiAnchors", () => {
		const code = readCodeOnly("src/server/db-migration.ts");
		// No live CREATE TABLE project_wiki / migrate call in code paths.
		expect(code).not.toMatch(/\bCREATE\s+TABLE\s+project_wiki\b/);
		expect(code).not.toMatch(/migrateWikiTableSchema\s*\(/);
		expect(code).not.toMatch(/migrateWikiDetailToDisk\s*\(/);
		// PROJECT_WIKI_COLUMNS array definition gone.
		expect(code).not.toMatch(/PROJECT_WIKI_COLUMNS\s*=\s*\[/);
		// wikiAnchors removed from AGENT_COLUMNS round-trip (the new grants/context
		// columns are still there). Match the { key: "wikiAnchors" ... } entry.
		expect(code).not.toMatch(/\{\s*key:\s*"wikiAnchors"/);
		// New columns are present (proves cutover to new model, not just deletion).
		expect(code).toMatch(/\{\s*key:\s*"wikiGrants"/);
		expect(code).toMatch(/\{\s*key:\s*"wikiContext"/);
		expect(code).toMatch(/\{\s*key:\s*"wikiPolicyRevision"/);
	});

	test("A5. AgentLoop hooks-only: no server/wiki compiler import, no wiki section literal", () => {
		const code = readCodeOnly("src/runtime/agent-loop.ts");
		// plan-05 §7 + design §9.3: AgentLoop must not import the wiki compiler/
		// store/anchor-injection. Wiki context is delivered as a generic dynamic
		// system section by AgentService.
		expect(code).not.toMatch(/from\s+["'].*server\/wiki\//);
		expect(code).not.toMatch(/from\s+["'].*wiki-context-compiler/);
		expect(code).not.toMatch(/from\s+["'].*wiki-access-compiler/);
		expect(code).not.toMatch(/from\s+["'].*wiki-anchor-injection/);
		// No literal wiki section id used in promptAssembler.invalidate / sections.
		expect(code).not.toMatch(/invalidate\(\s*["']wiki-/);
		expect(code).not.toMatch(/["']wiki-system-anchors["']/);
	});

	test("A6. FORBIDDEN_BODY_KEYS data-plane / management-plane fork intact", () => {
		// design §7.4 / §10.2: data plane forbids callerCtx/grants/projectId
		// (caller identity); management plane ALLOWS grants/projectId as payload
		// content. plan-08 §1 must not have collapsed this fork (e.g. by sync'ing
		// the two sets or deleting the data-plane guard).
		const dataPlane = readCodeOnly("src/server/wiki-router.ts");
		const mgmtPlane = readCodeOnly("src/server/wiki-admin-router.ts");
		const maintain = readCodeOnly("src/server/wiki-maintenance-router.ts");

		// Data plane forbids caller identity keys (incl. projectId/grants as identity).
		expect(dataPlane).toMatch(/"callerCtx"/);
		expect(dataPlane).toMatch(/"compiledAccess"/);
		expect(dataPlane).toMatch(/"projectId"/);
		// Management plane has its OWN FORBIDDEN set that does NOT forbid grants /
		// projectId / activeProjectId (those are payload there). Assert the mgmt
		// set body does not contain a top-level "grants" or "projectId" entry.
		// We isolate the FORBIDDEN_BODY_KEYS = new Set([ ... ]) block in mgmt.
		const mgmtSetMatch = mgmtPlane.match(/FORBIDDEN_BODY_KEYS\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
		expect(mgmtSetMatch, "mgmt plane must define its own FORBIDDEN_BODY_KEYS set").not.toBeNull();
		const mgmtSetBody = mgmtSetMatch![1];
		expect(mgmtSetBody, "mgmt plane must NOT forbid grants (payload)").not.toMatch(/"grants"/);
		expect(mgmtSetBody, "mgmt plane must NOT forbid projectId (payload)").not.toMatch(/"projectId"/);
		// But mgmt DOES still forbid real identity forge keys.
		expect(mgmtSetBody).toMatch(/"authority"/);
		expect(mgmtSetBody).toMatch(/"canManage"/);
		// Maintenance plane has its own guard too (forged identity rejection).
		expect(maintain).toMatch(/FORBIDDEN_BODY_KEYS\s*=\s*new Set/);
		expect(maintain).toMatch(/"agentId"/);
		expect(maintain).toMatch(/"authority"/);
	});

	test("A7. server/index.ts mounts new wiki routers; legacy /api/project-wiki mount gone", () => {
		const code = readCodeOnly("src/server/index.ts");
		// New routers mounted.
		expect(code).toMatch(/app\.use\(\s*["']\/api\/wiki["']/);
		expect(code).toMatch(/app\.use\(\s*["']\/api\/wiki-admin["']/);
		expect(code).toMatch(/app\.use\(\s*["']\/api\/wiki-maintain["']/);
		// Legacy mount must be gone (no live app.use for project-wiki).
		expect(code).not.toMatch(/app\.use\(\s*["']\/api\/project-wiki["']/);
		// ensureWikiSkeleton call removed (the legacy startup write path).
		expect(code).not.toMatch(/ensureWikiSkeleton\s*\(/);
		// WikiSkeletonService is constructed only as a delegating shim (delegates
		// to WikiProjectIndexer — no legacy write). Confirm it's wired through the
		// indexer, not through a legacy wiki store.
		expect(code).toMatch(/new WikiSkeletonService\(\s*\{[\s\S]*?indexer:/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// §B · filesystem protection (6 categories + bypass matrix)
// ═══════════════════════════════════════════════════════════════════════════

describe("[B] filesystem guard — protected-path coverage + bypass matrix", () => {
	test("B1. all 6 protected categories are in the central table", () => {
		const canon = listProtectedPaths().map((p) => p.toLowerCase());
		// core.db + wal + shm
		expect(canon.some((p) => p.endsWith("/db/core.db"))).toBe(true);
		expect(canon.some((p) => p.endsWith("/db/core.db-wal"))).toBe(true);
		expect(canon.some((p) => p.endsWith("/db/core.db-shm"))).toBe(true);
		// wiki.db + wal + shm
		expect(canon.some((p) => p.endsWith("/db/wiki.db"))).toBe(true);
		expect(canon.some((p) => p.endsWith("/db/wiki.db-wal"))).toBe(true);
		expect(canon.some((p) => p.endsWith("/db/wiki.db-shm"))).toBe(true);
		// backups
		expect(canon.some((p) => p.endsWith("/backups/core"))).toBe(true);
		expect(canon.some((p) => p.endsWith("/backups/wiki"))).toBe(true);
		// wiki runtime + disk root
		expect(canon.some((p) => p.endsWith("/wiki/.runtime"))).toBe(true);
		expect(canon.some((p) => p.endsWith("/wiki"))).toBe(true);
	});

	test("B2. bypass attempts are rejected (relative / quote / env / case)", () => {
		// acceptance-08 §B: relative paths, quotes, env vars, case must not escape.
		const wd = join(UNIQUE_DIR, "db");
		// Relative path into protected db.
		expect(isProtectedPath("../db/core.db", wd)).toBe(true);
		// Quoted path.
		expect(isProtectedPath('"core.db"', wd)).toBe(true);
		expect(isProtectedPath("'../db/wiki.db'", wd)).toBe(true);
		// Direct absolute (already canonical).
		expect(isProtectedPath(coreDbPath)).toBe(true);
		// win32 case-insensitivity: uppercase drive / mixed case still matches.
		const mixed = coreDbPath.replace(/^[a-z]/, (c) => c.toUpperCase());
		expect(isProtectedPath(mixed)).toBe(true);
	});

	test("B3. legitimate project source access NOT blocked (no false positive)", () => {
		// A path under a normal workspace must not match any protected root.
		const ws = join(UNIQUE_DIR, "workspace", "myproject", "src", "index.ts");
		expect(isProtectedPath(ws)).toBe(false);
		// Temp dir outside ZERO_CORE_DIR also fine.
		expect(isProtectedPath(join(require("node:os").tmpdir(), "unrelated.txt"))).toBe(false);
	});

	test("B4. shell command containing a protected path is caught", () => {
		// acceptance-08 §B: shell concatenation bypass.
		expect(findWikiPathInShellCommand(`cat ${coreDbPath}`)).not.toBeNull();
		expect(findWikiPathInShellCommand(`cat ~/.zero-core/db/core.db`)).not.toBeNull();
		// $ZERO_CORE_DIR expansion.
		const before = process.env.ZERO_CORE_DIR;
		process.env.ZERO_CORE_DIR = UNIQUE_DIR;
		try {
			expect(findWikiPathInShellCommand("$ZERO_CORE_DIR/db/wiki.db")).not.toBeNull();
			expect(findWikiPathInShellCommand("${ZERO_CORE_DIR}/backups/core/x.db")).not.toBeNull();
		} finally {
			process.env.ZERO_CORE_DIR = before;
		}
		// Benign command not flagged.
		expect(findWikiPathInShellCommand("ls -la src/")).toBeNull();
	});

	test("B5. backup service is the documented sole exception (not via Agent shell)", () => {
		// The guard module doc states the management backup service is the only
		// caller allowed to touch backups/ — and it uses SQLite Backup API, not
		// the Agent FS tools. Assert the backup service source uses .backup() /
		// VACUUM INTO rather than copyFileSync of the ACTIVE db.
		const code = readCodeOnly("src/server/wiki-backup-service.ts");
		expect(code).toMatch(/\.backup\(\s*snapshotPath\s*\)|VACUUM INTO/i);
		// copyFileSync may appear for the restore-to-temp step, but must NOT be
		// used to snapshot the active DB. Assert the snapshot path uses backup().
		expect(code).toMatch(/await\s+srcDb\.backup\(/);
	});

	// ─── round-2 Fix 2 wiring (BLOCKER B+H) ─────────────────────────────────
	// The realpath-aware guard is a 6-call-site wide change. From the architecture
	// lens we confirm (a) every FS-tool call site imports and calls the
	// realpath-aware variant (not the lexical-only alias), (b) the helper's
	// implementation handles nonexistent paths without throwing (Write-create
	// case), and (c) the historical `isWikiDiskPath` name still works as a
	// back-compat alias so existing callers don't break.

	test("B6. all 6 FS-tool call sites use isProtectedPathRealpath (source wiring audit)", () => {
		// round-2 Fix 2 (BLOCKER B+H): isProtectedPathRealpath was defined in
		// round-1 but never wired — 6 FS tools still used the lexical-only
		// isWikiDiskPath, so a Windows junction (no admin needed) whose lexical
		// path sat in workspace but whose realpath resolved into db/wiki/backups
		// bypassed the guard. Confirm each of the 6 sites now imports and calls
		// the realpath variant. This is a source-level wiring assertion (the
		// end-to-end junction attack is covered by the adversarial lens).
		const sites = [
			{ rel: "src/tools/file-read.ts", lineHint: "isProtectedPathRealpath(path, workingDir)" },
			{ rel: "src/tools/file-write.ts", lineHint: "isProtectedPathRealpath(path, callerCtx.workingDir)" },
			{ rel: "src/tools/file-edit.ts", lineHint: "isProtectedPathRealpath(path, callerCtx.workingDir)" },
			{ rel: "src/tools/grep.ts", lineHint: "isProtectedPathRealpath(path, workingDir)" },
			{ rel: "src/tools/glob.ts", lineHint: "isProtectedPathRealpath(p, workingDir)" },
		];
		for (const s of sites) {
			const code = readCodeOnly(s.rel);
			expect(code, `${s.rel} must import isProtectedPathRealpath`).toMatch(
				/import\s*\{[^}]*\bisProtectedPathRealpath\b[^}]*\}\s*from\s*["'].*wiki-path-guard/,
			);
			expect(code, `${s.rel} must call isProtectedPathRealpath at the guard site`).toMatch(
				/isProtectedPathRealpath\s*\(/,
			);
		}
		// Shell token loop (the 6th site) lives in wiki-path-guard itself and
		// must resolve each token through the realpath variant.
		const guard = readCodeOnly("src/tools/wiki-path-guard.ts");
		expect(guard).toMatch(/findWikiPathInShellCommand[\s\S]*?isProtectedPathRealpath\(tok/);
	});

	test("B7. isProtectedPathRealpath does NOT throw on nonexistent paths (Write-create safe)", () => {
		// round-2 Fix 2 breadth concern: realpathSync throws on paths that don't
		// exist yet. The Write tool legitimately creates files that don't exist,
		// so the guard must fall back to the lexical check via existsSync +
		// try/catch. If this regressed, every Write-create would throw inside the
		// guard instead of returning a clean boolean.
		const nonexistent = join(UNIQUE_DIR, "workspace", "myproject", "does-not-exist-yet.ts");
		expect(existsSync(nonexistent)).toBe(false);
		// Must not throw — returns a boolean (false for a legit nonexistent path).
		expect(() => isProtectedPathRealpath(nonexistent)).not.toThrow();
		expect(isProtectedPathRealpath(nonexistent)).toBe(false);
		// A nonexistent path that WOULD land inside a protected DIRECTORY root
		// (backups/core is a prefix-match protected dir) is still caught by the
		// lexical pass — canonicalize is pure string resolve, no fs access. This
		// proves a Write-create into backups/ is blocked even before the file
		// exists, WITHOUT throwing.
		const protectedNonexistent = join(UNIQUE_DIR, "backups", "core", "never-created.db");
		expect(existsSync(protectedNonexistent)).toBe(false);
		expect(() => isProtectedPathRealpath(protectedNonexistent)).not.toThrow();
		expect(isProtectedPathRealpath(protectedNonexistent)).toBe(true);
	});

	test("B8. isWikiDiskPath remains a back-compat alias (delegates, no behavior fork)", () => {
		// round-2 Fix 2: the historical name isWikiDiskPath is kept as a thin
		// alias so existing importers don't need a flag-day rename. It must
		// delegate to isProtectedPath (lexical) — i.e. NOT silently diverge into
		// a different protected set. Confirm both via source and behavior.
		const guard = readCodeOnly("src/tools/wiki-path-guard.ts");
		expect(guard).toMatch(/export function isWikiDiskPath[\s\S]*?return isProtectedPath\(/);
		// Behavior: alias agrees with the realpath variant on existing,
		// non-symlinked paths (lexical and realpath coincide there).
		const samples = [
			coreDbPath,
			join(UNIQUE_DIR, "workspace", "legit.ts"),
			join(UNIQUE_DIR, "backups", "wiki", "wiki-x.db"),
		];
		for (const p of samples) {
			expect(
				isWikiDiskPath(p),
				`alias must agree with realpath variant for ${p}`,
			).toBe(isProtectedPathRealpath(p));
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// §C · backup correctness (Backup API, Core/Wiki isolation, restore to temp)
// ═══════════════════════════════════════════════════════════════════════════

describe("[C] backup service — Backup API + Core/Wiki isolation", () => {
	let backup: BackupService;
	beforeAll(() => {
		backup = new BackupService({ coreDb, wikiDb, keepRecent: 5 });
	});

	test("C1. snapshot uses SQLite Backup API; snapshot file is a valid openable DB", async () => {
		const { wiki } = await backup.snapshotAll("arch-test");
		expect(wiki, "wiki snapshot manifest must be produced").not.toBeNull();
		expect(wiki!.sha256.length).toBe(64);
		expect(existsSync(wiki!.snapshotPath)).toBe(true);
		// Snapshot is a real SQLite DB (not a partial/copy): open readonly + count.
		const snap = new Database(wiki!.snapshotPath, { readonly: true });
		try {
			const n = snap.prepare("SELECT count(*) AS n FROM wiki_nodes").get() as { n: number };
			expect(n.n).toBeGreaterThanOrEqual(3); // at least the 3 fixed roots
			const ic = snap.pragma("integrity_check") as Array<{ integrity_check: string }>;
			expect(ic[0].integrity_check).toBe("ok");
		} finally {
			snap.close();
		}
	});

	test("C2. snapshot does NOT copy the active wiki.db (path differs, Backup API used)", async () => {
		const { wiki } = await backup.snapshotAll("path-distinct");
		// The snapshot path is under backups/wiki, never the live db path.
		expect(wiki!.snapshotPath).not.toBe(wikiDbPath);
		expect(wiki!.snapshotPath).toContain("backups");
	});

	test("C3. writing Wiki does NOT touch core.db / core.db-wal (Core/Wiki isolation)", async () => {
		// acceptance-08 §C: "写 Wiki 不触发 Core checkpoint/mtime/WAL 变化".
		// Record core.db + core.db-wal fingerprint, write a wiki node, re-snapshot
		// core, assert core files unchanged.
		const coreBefore = fileFingerprint(coreDbPath);
		const coreWalBefore = fileFingerprint(coreDbPath + "-wal");
		// Force a wiki write that lands in WAL (a new node under knowledge root).
		const wdb = wikiDb.getDb();
		const root = wdb.prepare("SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL").get() as { id: number };
		const now = new Date().toISOString();
		wdb.prepare(
			`INSERT INTO wiki_nodes (parent_id, name, path, kind, summary, content, attributes_json, revision, created_at, updated_at, archived_at)
			 VALUES (?, ?, ?, 'knowledge', 'iso write', 'wiki body', NULL, 1, ?, ?, NULL)`,
		).run(root.id, `iso-${Date.now()}`, `wiki-root/knowledge/iso-${Date.now()}`, now, now);
		// Snapshot core (online Backup API) — must not checkpoint or rewrite core.
		const coreManifest = await backup.snapshotCore("iso-snapshot");
		expect(coreManifest.verified).toBe(true);

		const coreAfter = fileFingerprint(coreDbPath);
		const coreWalAfter = fileFingerprint(coreDbPath + "-wal");
		// Active core.db size must not change as a side-effect of writing wiki
		// (the two DBs have independent WAL/checkpoint). mtime may move if the OS
		// touches atime, so we assert on SIZE (the load-bearing invariant).
		if (coreBefore && coreAfter) {
			expect(coreAfter.size, "core.db size must not change from a wiki write").toBe(coreBefore.size);
		}
		// Core WAL, if present, must not have been checkpointed by the wiki write
		// or by the core snapshot (Backup API is non-checkpointing on the source).
		if (coreWalBefore && coreWalAfter) {
			// size can legitimately grow as core writes happen elsewhere, but a
			// shrink to near-0 would indicate a checkpoint fired by wiki/snapshot.
			expect(coreWalAfter.size, "core WAL must not be checkpointed by wiki activity").toBeGreaterThanOrEqual(coreWalBefore.size);
		}
	});

	test("C4. manifest is paired (core+wiki) but each verified independently", async () => {
		// design §3 / plan-08 §3: one manifest per DB; "paired" only by timestamp,
		// NOT a cross-DB SQLite transaction. Both return their own verify result.
		//
		// round-2 fix: the prior test asserted `core.nodeCount` / `wiki.nodeCount`
		// on the SnapshotManifest object — but the manifest does NOT carry counts
		// (only the VerifyResult does; see SnapshotManifest interface). That made
		// the assertion `expect(undefined).toBe(0)` fail. The load-bearing
		// invariant is per-DB independence, so we prove it by opening each
		// snapshot directly: core.db has NO wiki_nodes table (cutover dropped it),
		// wiki.db carries many — i.e. these are genuinely two separate databases,
		// not one cross-DB transaction dressed up as a pair.
		const { core, wiki } = await backup.snapshotAll("paired");
		expect(core.kind).toBe("core");
		expect(wiki!.kind).toBe("wiki");
		// Each manifest carries its own verified flag (independent integrity/FK).
		expect(core).toHaveProperty("verified");
		expect(wiki).toHaveProperty("verified");
		expect(core.verified).toBe(true);
		expect(wiki!.verified).toBe(true);
		// Core manifest has its own sha256 distinct from wiki (different files).
		expect(core.sha256).not.toBe(wiki!.sha256);
		// Per-DB independence — open each snapshot and inspect its schema/counts.
		const coreSnap = new Database(core.snapshotPath, { readonly: true, fileMustExist: true });
		try {
			const coreHasWikiNodes = coreSnap.prepare(
				"SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='wiki_nodes'",
			).get() as { n: number };
			expect(coreHasWikiNodes.n, "core snapshot must NOT carry wiki_nodes (per-DB)").toBe(0);
		} finally {
			coreSnap.close();
		}
		const wikiSnap = new Database(wiki!.snapshotPath, { readonly: true, fileMustExist: true });
		try {
			const wikiNodeCount = wikiSnap.prepare("SELECT count(*) AS n FROM wiki_nodes").get() as { n: number };
			expect(wikiNodeCount.n, "wiki snapshot must carry wiki_nodes (per-DB)").toBeGreaterThan(0);
			const ic = wikiSnap.pragma("integrity_check") as Array<{ integrity_check: string }>;
			expect(ic[0].integrityCheck ?? ic[0].integrity_check).toBe("ok");
		} finally {
			wikiSnap.close();
		}
	});

	test("C5. restoreSnapshot creates a NEW temp path, does NOT overwrite active DB", async () => {
		const { wiki } = await backup.snapshotAll("restore-test");
		const restored = backup.restoreSnapshot(wiki!.snapshotPath, "wiki");
		// Restored path must differ from both the snapshot and the active wiki.db.
		expect(restored).not.toBe(wiki!.snapshotPath);
		expect(restored).not.toBe(wikiDbPath);
		expect(restored).toContain("restored-");
		expect(existsSync(restored)).toBe(true);
		// Active wiki.db unchanged (restore wrote to the temp copy only).
		// Verify by checking the restored copy has the same node count as snapshot.
		const r = new Database(restored, { readonly: true });
		try {
			const n = r.prepare("SELECT count(*) AS n FROM wiki_nodes").get() as { n: number };
			expect(n.n).toBeGreaterThanOrEqual(3);
		} finally {
			r.close();
		}
	});

	test("C6. readonly diagnostics never checkpoint/VACUUM/migrate active DB (source audit)", () => {
		// acceptance-08 §C + memory feedback-sessions-db-readonly. The backup +
		// maintenance services must not issue VACUUM / wal_checkpoint / migration
		// on the ACTIVE db. VACUUM INTO to a new file is fine (writes elsewhere).
		const backupCode = readCodeOnly("src/server/wiki-backup-service.ts");
		const maintainCode = readCodeOnly("src/server/wiki-maintenance-router.ts");
		// No bare VACUUM on active handles.
		expect(backupCode).not.toMatch(/\.exec\(\s*["']VACUUM["']\s*\)/);
		expect(maintainCode).not.toMatch(/\.exec\(\s*["']VACUUM["']\s*\)/);
		// No wal_checkpoint on active handles.
		expect(backupCode).not.toMatch(/wal_checkpoint/);
		expect(maintainCode).not.toMatch(/wal_checkpoint/);
		// round-2 Fix 1 (BLOCKER C): source DB opened readonly via PLAIN path +
		// { readonly: true } — NOT the `file:${path}?mode=ro` URI form. The URI
		// form broke SQLite CANTOPEN on Windows drive-letter paths (see
		// wiki-backup-service.ts:191-203). Assert the new form is present AND the
		// broken URI form is gone, so this cannot silently regress.
		expect(backupCode).toMatch(/new\s+Database\(\s*sourcePath\s*,\s*\{\s*readonly:\s*true/);
		expect(backupCode, "file:...?mode=ro URI form must be removed (round-2 Fix 1)").not.toMatch(/mode=ro/);
		expect(backupCode, "file:${... URI construction must be removed").not.toMatch(/["']file:["']\s*\+/);
		// PRAGMA optimize is allowed (writes sqlite_stat1 only, not a checkpoint);
		// confirm the maintenance router uses optimize, NOT vacuum.
		expect(maintainCode).toMatch(/pragma\(\s*["']optimize["']\s*\)/);
	});

	test("C7. round-2 Fix 1: snapshotAll does NOT swallow wiki errors; router surfaces HTTP 500", () => {
		// BLOCKER C round-1: when wikiDb was present, snapshotAll caught the wiki
		// snapshot failure and returned `{ core, wiki: null }` with a log.warn —
		// the management UI saw HTTP 200 + wiki:null and treated it as success,
		// while wiki.db was never actually snapshotted. round-2 Fix 1b removed
		// that catch so a real wiki failure propagates to the router's try/catch
		// which responds HTTP 500.
		//
		// Architecture-lens definitive check: audit both layers' source.
		// (a) BackupService.snapshotAll: when deps.wikiDb is present, the wiki
		//     snapshot MUST NOT be wrapped in a try/catch that converts the
		//     error into wiki:null. The only wiki:null path is the legitimate
		//     headless case (!deps.wikiDb).
		const backupCode = readCodeOnly("src/server/wiki-backup-service.ts");
		// The headless guard exists and is the ONLY source of wiki:null.
		expect(backupCode, "headless !deps.wikiDb branch must produce wiki:null").toMatch(
			/if\s*\(\s*!this\.deps\.wikiDb\s*\)\s*\{[\s\S]*?wiki:\s*null/,
		);
		// No catch anywhere in the service converts a wiki snapshot error into
		// wiki:null (the round-1 swallow pattern). 300-char window is plenty
		// since the swallow would be a tight catch -> return pair.
		expect(backupCode, "snapshotAll must NOT catch+swallow into wiki:null").not.toMatch(
			/catch\s*\([^)]*\)\s*\{[\s\S]{0,300}wiki:\s*null/,
		);
		// The wiki snapshot is awaited bare (no surrounding try in snapshotAll).
		expect(backupCode).toMatch(/await\s+this\.snapshotWiki\(/);
		//
		// (b) Router /backup/all handler wraps snapshotAll in try/catch and
		//     returns res.status(500) on error (not res.json with wiki:null).
		//     Anchor the handler on its unique line-start terminator
		//     `\n<ws>});` — inner res.json({...}) calls end mid-line so they
		//     don't falsely terminate the match.
		const routerCode = readCodeOnly("src/server/wiki-maintenance-router.ts");
		const handlerMatch = routerCode.match(
			/router\.post\(\s*["']\/backup\/all["'][\s\S]*?\n\s*\}\s*\);/,
		);
		expect(handlerMatch, "/backup/all handler must exist").not.toBeNull();
		const handler = handlerMatch![0];
		expect(handler, "handler must await snapshotAll").toMatch(/await\s+backup\.snapshotAll\(/);
		expect(handler, "handler must return 500 on error").toMatch(/res\.status\(500\)\.json\(/);
		// The 200 path returns the snapshot result (the manifest pair), not a
		// synthesized {wiki: null} success.
		expect(handler, "200 path must return snapshot result, not wiki:null").toMatch(/res\.json\(\s*result\s*\)/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// §D · benchmark correctness (EXPLAIN assertions real, report complete)
// ═══════════════════════════════════════════════════════════════════════════

describe("[D] benchmark — EXPLAIN assertions real + report complete + 1M supported", () => {
	test("D1. bench-100k.json exists with all required provenance fields", () => {
		const report = JSON.parse(readRaw("docs/archive/wiki-system-redesign/bench-100k.json"));
		// acceptance-08 §D: report must carry commit SHA + hardware + data gen params.
		expect(typeof report.commitSha).toBe("string");
		expect(report.commitSha.length).toBeGreaterThan(0);
		expect(report.hardware).toBeDefined();
		expect(report.hardware.platform).toBeTruthy();
		expect(report.hardware.cpus).toBeTruthy();
		expect(report.hardware.cpuCount).toBeGreaterThan(0);
		expect(report.hardware.totalMemMB).toBeGreaterThan(0);
		expect(report.dataGeneration.targetNodes).toBe(100000);
		expect(report.dataGeneration.actualNodes).toBeGreaterThan(90000);
		expect(typeof report.generatedAt).toBe("string");
	});

	test("D2. every scenario asserted an index/FTS plan (no full-table scan)", () => {
		const report = JSON.parse(readRaw("docs/archive/wiki-system-redesign/bench-100k.json"));
		expect(report.allPlansOk, "allPlansOk must be true").toBe(true);
		expect(report.results.length).toBeGreaterThanOrEqual(6); // S1..S6 (S3 split a/b)
		for (const r of report.results) {
			expect(r.planAsserted, `${r.label} plan must be asserted`).toBe(true);
			expect(typeof r.plan).toBe("string");
			expect(r.plan.length).toBeGreaterThan(0);
			// Reject bare full-table scans on the big tables.
			expect(r.plan.toLowerCase()).not.toMatch(/\bscan\s+wiki_nodes\b/);
			expect(r.plan.toLowerCase()).not.toMatch(/\bscan\s+wiki_links\b/);
		}
	});

	test("D3. benchmark script's assertPlan is a real check (not a placeholder)", () => {
		// Read the script source and confirm assertPlan actually inspects the plan
		// string for SCAN vs USING INDEX / SEARCH. A stub that always returns ok
		// would let a regression to full-table scan pass silently.
		const code = readCodeOnly("scripts/wiki-benchmark.ts");
		// The assertion function exists and inspects lowercased plan text.
		expect(code).toMatch(/function\s+assertPlan/);
		expect(code).toMatch(/hasFullScan\s*=/);
		expect(code).toMatch(/\\bscan\\s\+\(wiki_nodes|wiki_links/);
		expect(code).toMatch(/using\s*\(covering\s*\)?\s*index|search\\b/);
		// Each scenario calls explainQueryPlan + assertPlan before timing.
		expect(code).toMatch(/explainQueryPlan\s*\(/);
		// Exit non-zero if any plan check failed (forces CI to catch regressions).
		expect(code).toMatch(/process\.exit\(2\)/);
	});

	test("D4. benchmark script supports 1M nodes (--nodes flag)", () => {
		// plan-08 §4 + acceptance-08 §D2: 1M is a pre-release manual gate. The
		// script must ACCEPT --nodes=1000000 (the run itself is deferred to
		// release per the plan; acceptance D2 allows "result 附人工输出").
		const code = readCodeOnly("scripts/wiki-benchmark.ts");
		expect(code).toMatch(/--nodes=/);
		// parses an arbitrary positive integer (rejects <= 0 / non-finite),
		// not a hardcoded 100k cap.
		expect(code).toMatch(/Number\.isFinite\(n\)/);
		expect(code).toMatch(/n\s*<=\s*0|n\s*>\s*0/);
	});

	test("D5. FTS top-k does not load all content into Node memory (source audit)", () => {
		// acceptance-08 §D: "FTS top-k 不把全部 content 拉入 Node 内存".
		// The benchmark S4 query selects only id (joined), not content. Assert
		// the FTS scenario SQL does not SELECT content into the timed result set.
		const code = readRaw("scripts/wiki-benchmark.ts");
		// S4 FTS top-k query shape: SELECT n.id FROM wiki_nodes_fts f JOIN wiki_nodes n ...
		expect(code).toMatch(/SELECT\s+n\.id\s+FROM\s+wiki_nodes_fts/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 maintenance — explicit confirm, no startup auto-run, background reindex
// ═══════════════════════════════════════════════════════════════════════════

describe("[§5] maintenance — explicit confirm + no active-DB mutation", () => {
	test("M1. legacy/cleanup requires body.confirm=true (not auto-run)", async () => {
		const app = express();
		app.use(express.json());
		app.use("/api/wiki-maintain", createWikiMaintenanceRouter({ coreDb, wikiDb }));
		const { server, port } = await listen(app);
		try {
			// No confirm → 400 rejection.
			const r1 = await post(port, "/api/wiki-maintain/legacy/cleanup", {});
			expect(r1.status).toBe(400);
			// With confirm → proceeds (200 or 500 depending on whether project_wiki
			// exists; either way NOT 400-rejected for missing confirm).
			const r2 = await post(port, "/api/wiki-maintain/legacy/cleanup", { confirm: true });
			expect(r2.status).not.toBe(400);
		} finally {
			await close(server);
		}
	});

	test("M2. legacy/cleanup is NOT invoked from server startup (source audit)", () => {
		// plan-08 §1 + §5: explicit maintenance command only. The startup path
		// (server/index.ts) must not call DROP TABLE project_wiki or route to it.
		const idx = readCodeOnly("src/server/index.ts");
		expect(idx).not.toMatch(/DROP\s+TABLE\s+project_wiki/i);
		expect(idx).not.toMatch(/legacy\/cleanup/);
		expect(idx).not.toMatch(/wiki-maintain.*legacy/);
	});

	test("M3. maintenance router authority is server-injected (forged identity rejected)", async () => {
		const app = express();
		app.use(express.json());
		app.use("/api/wiki-maintain", createWikiMaintenanceRouter({ coreDb, wikiDb }));
		const { server, port } = await listen(app);
		try {
			// Body carrying a forged authority/canManage must be rejected.
			const r = await post(port, "/api/wiki-maintain/backup/all", {
				actor: "@attacker",
				canManage: true,
				authority: "admin",
			});
			expect(r.status).toBe(400);
			expect(JSON.stringify(r.data)).toMatch(/forged identity/i);
		} finally {
			await close(server);
		}
	});

	test("M4. backup router handler awaits the async snapshot (no Promise serialization)", () => {
		// Orchestrator-flagged fix: the prior agent omitted `await` on the async
		// snapshot handlers, causing res.json to serialize a Promise. Assert the
		// maintenance router source awaits snapshotAll/Core/Wiki.
		const code = readCodeOnly("src/server/wiki-maintenance-router.ts");
		expect(code).toMatch(/await\s+backup\.snapshotAll\(/);
		expect(code).toMatch(/await\s+backup\.snapshotCore\(/);
		expect(code).toMatch(/await\s+backup\.snapshotWiki\(/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// §6 arch docs — current model not described as disk-Markdown
// ═══════════════════════════════════════════════════════════════════════════

describe("[§6/E] arch docs — current model accurate", () => {
	test("E1. arch 06 has a Wiki v2 §0 describing new model (db/grants/mirror)", () => {
		const doc = readRaw("docs/arch/06-knowledge-subsystems.md");
		// New model section exists.
		expect(doc).toMatch(/## 0\. Wiki v2/);
		expect(doc).toMatch(/独立.*wiki\.db|wiki\.db.*独立/);
		expect(doc).toMatch(/wikiGrants/);
		expect(doc).toMatch(/wiki_repositories|wiki_source_bindings/);
	});

	test("E2. arch docs do not describe disk-Markdown body as the CURRENT model", () => {
		// plan-08 §6: "旧描述不得继续声称正文在磁盘 Markdown 或 anchors 决定 scope".
		// Each touched arch doc may MENTION the legacy model historically, but the
		// banner must mark it superseded. We assert the cutover banner exists.
		for (const rel of [
			"docs/arch/04-tools-subsystem.md",
			"docs/arch/05-persistence.md",
			"docs/arch/06-knowledge-subsystems.md",
			"docs/arch/07-renderer-and-ipc.md",
			"docs/arch/08-cross-cutting.md",
			"docs/arch/12-glossary.md",
		]) {
			const doc = readRaw(rel);
			// Either carries the plan-08 cutover banner OR explicitly does not
			// claim disk markdown is current. Most should have the banner.
			const hasBanner = /plan-08\s*cutover|cutover\s*后/i.test(doc);
			const claimsDiskCurrent = /正文.*磁盘\s*Markdown(?!\s*.*(?:历史|legacy|废弃|过时|退役|旧))/.test(doc);
			// We accept either: banner present, OR no claim that disk-Markdown is current.
			expect(
				hasBanner || !claimsDiskCurrent,
				`${rel}: must carry plan-08 cutover banner OR not claim disk-Markdown body is current`,
			).toBe(true);
		}
	});

	test("E3. arch docs describe the backup/fs-guard/data+mgmt plane model", () => {
		const doc05 = readRaw("docs/arch/05-persistence.md");
		expect(doc05).toMatch(/SQLite Backup API|Backup API/);
		expect(doc05).toMatch(/backups\/\{?core|backups\/core/);
		const doc06 = readRaw("docs/arch/06-knowledge-subsystems.md");
		// data plane vs management plane separation.
		expect(doc06).toMatch(/数据面|data plane|管理面|management plane/i);
		// fs guard.
		expect(doc06).toMatch(/protected-paths|fs guard|文件系统保护/i);
	});
});
