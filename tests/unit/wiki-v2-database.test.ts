// wiki-system-redesign sub-01 acceptance — 对抗 (adversarial-edge) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级 + 结构级编码 acceptance-01 §A items 1, 2, 4, 10 + §E (a, c, e, f)
// 中属于「fresh 隔离 / 幂等 / FK 攻击 / path 攻击 / clean-cutover 攻击 /
// DatabaseManager wiring」的对抗性要点。本文件从**对抗边界**视角断言:
//   - 临时 profile fresh open 后只在 `${ZERO_CORE_DIR}/db/wiki.db{,-wal,-shm}`
//     创建 Wiki DB/WAL/SHM,core.db BYTE-UNCHANGED(sha 比较)。
//   - PRAGMA journal_mode=WAL(prod 路径,unset ZERO_CORE_DB_NO_WAL)、
//     foreign_keys=1、busy_timeout > 0。
//   - 同一 DB 连续初始化两次 → 无错、无重复 root、root created_at/revision 不变。
//   - 固定根恰好 wiki-root + knowledge/memory/projects;无 wiki-root:global 合成 ID;
//     确定性非空 summary。
//   - FK 行为逐项验证:link target RESTRICT / link source CASCADE /
//     address target RESTRICT / repository project_node_id RESTRICT /
//     source_binding node_id CASCADE / source_binding repository_id CASCADE /
//     wiki_nodes parent_id RESTRICT。
//   - audit request_id 重复 → 恰好 1 行,第二次返回同一 auditId。
//   - canonical path 每个 §A 拒绝分支都真触发(./, .., 空, \, 控制字符, scheme,
//     over-length),isSameOrDescendant("wiki-root/a","wiki-root/ab")===false。
//   - clean-cutover(grep):新 src/server/wiki/ + shared/wiki-types.ts 中 ZERO
//     代码引用 project_wiki / WIKI_DISK_ROOT / wiki-node-store / wiki-router /
//     wiki-operations;新 repository 写入不进 project_wiki(运行时证明)。
//   - DatabaseManager wiring:open() 在返回前双 ready core+wiki;checkpointWiki()
//     只对 wiki 做 wal_checkpoint(TRUNCATE),不碰 core;health() 含 wiki 项;
//     无 ATTACH DATABASE / 无指向 core.db 的第二个连接。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db(vi.hoisted,sub-00 教训)。
//   - src/server/wiki/ + src/shared/wiki-types.ts + src/server/database-manager.ts
//     源文件文本(用于 clean-cutover grep 审计)。
//
// ## 输出
// Vitest 用例。每用例开真 SQLite temp DB,绝不读活跃 ~/.zero-core。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - FK 测试必须真触发 RESTRICT/CASCADE,不能只看 schema 字符串。
//   - WAL 测试:env ZERO_CORE_DB_NO_WAL 是 prod/test 切换阀,本文件通过临时
//     delete 该 env 验证 prod 路径(WAL),其余测试沿用 test 默认(MEMORY)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
// UNIQUE ZERO_CORE_DIR per file. vi.hoisted runs BEFORE any other import so
// config.ts / database-paths.ts constants resolve under OUR temp dir. The
// wiki.db path is also UNIQUE per file — separate from schema/path lens files
// (which use their own UNIQUE_WIKI_DB) so the 3 files can run concurrently
// without stamping each other's wiki.db.
const { UNIQUE_DIR, UNIQUE_WIKI_DB, UNIQUE_WIKI_DB_FOR_WAL } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-db-adv-"));
	process.env.ZERO_CORE_DIR = d;
	return {
		UNIQUE_DIR: d,
		UNIQUE_WIKI_DB: join(d, "wiki-adv.db"),
		UNIQUE_WIKI_DB_FOR_WAL: join(d, "wiki-adv-wal.db"),
	};
});

import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiLinkRepository } from "../../src/server/wiki/wiki-link-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import {
	WikiRepositoryStore,
} from "../../src/server/wiki/wiki-repository-store.js";
import {
	normalizeWikiPath,
	joinWikiPath,
	parentWikiPath,
	isSameOrDescendant,
	validateWikiName,
	WIKI_ROOT_PATH,
	WIKI_NAME_MAX_LENGTH,
	WIKI_PATH_MAX_SEGMENTS,
} from "../../src/server/wiki/wiki-path.js";
import { WIKI_SCHEMA_VERSION } from "../../src/server/wiki/wiki-schema.js";
import {
	DatabaseManager,
} from "../../src/server/database-manager.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 同步 sha256(file)。 */
function sha256(p: string): string {
	return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** 打开 fresh WikiDatabase(走 UNIQUE temp path),返回底层句柄与实例。 */
function openFresh(): { wiki: WikiDatabase; db: Database.Database } {
	const wiki = new WikiDatabase(UNIQUE_WIKI_DB);
	return { wiki, db: wiki.getDb() };
}

/** 在 wiki-root/knowledge 下插一个节点,返回 row。 */
function insertChild(db: Database.Database, name: string, kind: string = "knowledge") {
	const parent = db
		.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
		.get() as { id: number };
	const now = new Date().toISOString();
	const r = db
		.prepare(
			`INSERT INTO wiki_nodes
			   (parent_id, name, path, kind, summary, content, attributes_json,
			    revision, created_at, updated_at, archived_at)
			 VALUES (?, ?, ?, ?, '', '', NULL, 1, ?, ?, NULL)`,
		)
		.run(parent.id, name, `wiki-root/knowledge/${name}`, kind, now, now);
	return { id: Number(r.lastInsertRowid), parent_id: parent.id, name, path: `wiki-root/knowledge/${name}` };
}

/** 抽取错误 code 字段(实现用 err.code 携带 WikiErrorCode)。 */
function errCode(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (e) {
		return (e as Error & { code?: string }).code;
	}
	return undefined;
}

/** 控制字符(避免源文件嵌入不可见字符)。 */
function ctrl(code: number): string {
	return String.fromCharCode(code);
}

/**
 * 读 repo 源文件 + 剥注释行,返回纯代码文本(用于 grep 审计,避免误命中
 * 文档/注释里的禁止词提及)。
 */
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

/** Walk src TS files (for grep audits). */
function walkSrcTs(): string[] {
	const out: string[] = [];
	const go = (d: string) => {
		let entries: ReturnType<typeof readdirSync>;
		try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.name === "node_modules" || e.name === "dist" || e.name === ".vite") continue;
			const full = join(d, e.name);
			if (e.isDirectory()) go(full);
			else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
		}
	};
	go(join(ROOT, "src", "server", "wiki"));
	return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wiki-v2 database [adversarial-edge lens]", () => {
	let wiki: WikiDatabase;
	let db: Database.Database;

	beforeEach(() => {
		const opened = openFresh();
		wiki = opened.wiki;
		db = opened.db;
	});

	afterEach(() => {
		try {
			wiki.close();
		} catch {
			/* idempotent */
		}
	});

	// -----------------------------------------------------------------------
	// §A item 1: fresh open ONLY creates wiki.db{,-wal,-shm}; core.db unchanged
	// -----------------------------------------------------------------------

	describe("§A.1 fresh open isolation", () => {
		test("WikiDatabase.open creates ONLY wiki.db* under ZERO_CORE_DIR/db (no core.db side effects)", () => {
			// Open a SEPARATE fresh dir for this test so we can reason about exactly
			// which files WikiDatabase creates. We pre-create a sentinel core.db
			// with a known marker row + capture its sha, then open wiki, then
			// assert (a) core.db sha unchanged and (b) the only wiki files are
			// wiki.db* (no spurious files).
			const freshDir = join(UNIQUE_DIR, "fresh-isolation");
			mkdirSync(join(freshDir, "db"), { recursive: true });
			const corePath = join(freshDir, "db", "core.db");
			const wikiPath = join(freshDir, "db", "wiki.db");

			// Seed core.db with a marker so we can prove byte-identity.
			const core = new Database(corePath);
			core.exec("CREATE TABLE marker(x TEXT NOT NULL)");
			core.prepare("INSERT INTO marker VALUES (?)").run("seed-v1");
			core.close();
			const shaBefore = sha256(corePath);

			// WikiDatabase with MEMORY journal (test env ZERO_CORE_DB_NO_WAL=1):
			// produces ONLY wiki.db (no -wal/-shm).
			const w = new WikiDatabase(wikiPath);
			try {
				// (a) core.db byte-unchanged
				const shaAfter = sha256(corePath);
				expect(shaAfter, "core.db must be byte-unchanged by WikiDatabase.open").toBe(shaBefore);
				// (b) only wiki.db exists under db/ besides the pre-seeded core.db
				const dbFiles = readdirSync(join(freshDir, "db"));
				const wikiFiles = dbFiles.filter((f) => f.startsWith("wiki.db"));
				for (const f of wikiFiles) {
					expect(f).toMatch(/^wiki\.db(\.wal|\.shm)?$/);
				}
				// wiki.db itself must exist.
				expect(existsSync(wikiPath)).toBe(true);
				// No spurious core.db-* WAL/SHM created by WikiDatabase.
				const coreFiles = dbFiles.filter((f) => f.startsWith("core.db"));
				expect(coreFiles.sort()).toEqual(["core.db"]);
			} finally {
				w.close();
			}
		});

		test("WikiDatabase does NOT create or attach core.db (it never opens core at all)", () => {
			// Open WikiDatabase on a fresh dir that has NO core.db; afterwards
			// core.db must still NOT exist (WikiDatabase is fully self-contained).
			const freshDir = join(UNIQUE_DIR, "no-core");
			mkdirSync(join(freshDir, "db"), { recursive: true });
			const wikiPath = join(freshDir, "db", "wiki.db");
			const w = new WikiDatabase(wikiPath);
			try {
				expect(existsSync(join(freshDir, "db", "core.db"))).toBe(false);
			} finally {
				w.close();
			}
		});
	});

	// -----------------------------------------------------------------------
	// §A item 2: PRAGMA journal_mode / foreign_keys / busy_timeout
	// -----------------------------------------------------------------------

	describe("§A.2 PRAGMA configuration", () => {
		test("foreign_keys = ON", () => {
			const fk = db.pragma("foreign_keys", { simple: true });
			expect(fk).toBe(1);
		});

		test("busy_timeout is set (> 0, design says 5000)", () => {
			const bt = db.pragma("busy_timeout", { simple: true });
			expect(typeof bt).toBe("number");
			expect(bt).toBeGreaterThanOrEqual(1000);
			expect(bt).toBe(5000); // design.md §3.2
		});

		test("PROD path: journal_mode = WAL when ZERO_CORE_DB_NO_WAL is unset", () => {
			// Vitest config globally sets ZERO_CORE_DB_NO_WAL=1 for test-stability,
			// so the default test path uses MEMORY. Toggle the env off to prove the
			// production code branch configures WAL — then restore.
			const saved = process.env.ZERO_CORE_DB_NO_WAL;
			delete process.env.ZERO_CORE_DB_NO_WAL;
			const walProbePath = join(UNIQUE_DIR, "wal-probe.db");
			try {
				const w = new WikiDatabase(walProbePath);
				try {
					const mode = w.getDb().pragma("journal_mode", { simple: true });
					expect(mode).toBe("wal");
					// WAL mode materializes a -wal file (after at least one write).
					// The fixed-root bootstrap already wrote, so wiki.db-wal exists.
					expect(existsSync(`${walProbePath}-wal`)).toBe(true);
				} finally {
					w.close();
				}
			} finally {
				if (saved !== undefined) process.env.ZERO_CORE_DB_NO_WAL = saved;
			}
		});

		test("TEST path: journal_mode = MEMORY under ZERO_CORE_DB_NO_WAL=1 (default in suite)", () => {
			// Sanity: confirm the test-suite env var flips the mode (this is what
			// every other test in the suite inherits from vitest.config.ts).
			expect(process.env.ZERO_CORE_DB_NO_WAL).toBe("1");
			const mode = db.pragma("journal_mode", { simple: true });
			expect(mode).toBe("memory");
		});
	});

	// -----------------------------------------------------------------------
	// §A item 4: idempotent double-open (no error, no duplicate, no rev bump)
	// -----------------------------------------------------------------------

	describe("§A.4 idempotent double-open", () => {
		test("reopen same DB: no error, no duplicate roots, root created_at + revision UNCHANGED", () => {
			// Snapshot the 4 fixed roots after first open.
			const snap1 = db
				.prepare(
					`SELECT path, kind, summary, revision, created_at, updated_at, archived_at
					 FROM wiki_nodes
					 WHERE archived_at IS NULL AND path IN
					   ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')
					 ORDER BY path`,
				)
				.all() as Array<Record<string, unknown>>;

			// Close + reopen on the SAME file (re-runs schema init + bootstrap).
			wiki.close();
			const reopened = new WikiDatabase(UNIQUE_WIKI_DB);
			try {
				const rdb = reopened.getDb();
				expect(() => reopened.schemaVersion()).not.toThrow();
				expect(reopened.schemaVersion()).toBe(WIKI_SCHEMA_VERSION);

				const snap2 = rdb
					.prepare(
						`SELECT path, kind, summary, revision, created_at, updated_at, archived_at
						 FROM wiki_nodes
						 WHERE archived_at IS NULL AND path IN
						   ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')
						 ORDER BY path`,
					)
					.all() as Array<Record<string, unknown>>;

				// Bit-for-bit equality of the 4 fixed roots across reopen.
				expect(snap2).toEqual(snap1);
				// Specifically: created_at + revision unchanged.
				const byPath = new Map(snap2.map((r) => [r.path as string, r]));
				for (const p of ["wiki-root", "wiki-root/knowledge", "wiki-root/memory", "wiki-root/projects"]) {
					const row = byPath.get(p)!;
					expect(row.revision, `${p} revision must remain 1`).toBe(1);
					expect(typeof row.created_at).toBe("string");
					expect((row.created_at as string).length).toBeGreaterThan(0);
				}

				// No duplicate active rows for any path.
				const dup = rdb
					.prepare(
						`SELECT path, COUNT(*) AS n FROM wiki_nodes
						 WHERE archived_at IS NULL GROUP BY path HAVING n > 1`,
					)
					.all() as { path: string; n: number }[];
				expect(dup).toEqual([]);

				// Total active root count still exactly 4.
				const totalActiveRoots = rdb
					.prepare(
						`SELECT COUNT(*) AS n FROM wiki_nodes
						 WHERE archived_at IS NULL AND path IN
						   ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')`,
					)
					.get() as { n: number };
				expect(totalActiveRoots.n).toBe(4);
			} finally {
				reopened.close();
			}
		});

		test("reopen same DB THREE times remains idempotent (cumulative reopen stability)", () => {
			// Stress: reopen twice more (so 3 total constructions on the same file).
			wiki.close();
			for (let i = 0; i < 2; i++) {
				const w = new WikiDatabase(UNIQUE_WIKI_DB);
				w.close();
			}
			// Final open: still exactly 4 active roots, no error.
			const final = new WikiDatabase(UNIQUE_WIKI_DB);
			try {
				const n = final
					.getDb()
					.prepare(
						`SELECT COUNT(*) AS n FROM wiki_nodes
						 WHERE archived_at IS NULL AND path IN
						   ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')`,
					)
					.get() as { n: number };
				expect(n.n).toBe(4);
				expect(final.foreignKeyCheck()).toBe("ok");
				expect(final.integrityCheck()).toBe("ok");
			} finally {
				final.close();
			}
		});
	});

	// -----------------------------------------------------------------------
	// §A item 5 (adversarial): fixed roots EXACT; no synthetic ids
	// -----------------------------------------------------------------------

	describe("§A.5 fixed roots exact + no synthetic ids", () => {
		test("fixed root paths EXACTLY the design §4.1 set; kinds EXACTLY root/namespace/namespace/namespace", () => {
			const rows = db
				.prepare(
					`SELECT path, kind FROM wiki_nodes
					 WHERE path IN ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')
					   AND archived_at IS NULL`,
				)
				.all() as { path: string; kind: string }[];
			const byPath = new Map(rows.map((r) => [r.path, r.kind]));
			expect(rows.length).toBe(4);
			expect(byPath.get("wiki-root")).toBe("root");
			expect(byPath.get("wiki-root/knowledge")).toBe("namespace");
			expect(byPath.get("wiki-root/memory")).toBe("namespace");
			expect(byPath.get("wiki-root/projects")).toBe("namespace");
		});

		test("NO synthetic / legacy paths (no 'wiki-root:global', no ':' anywhere, no extra root siblings)", () => {
			// No colon-style legacy address paths.
			const colon = db
				.prepare(`SELECT path FROM wiki_nodes WHERE path LIKE '%:%'`)
				.all() as { path: string }[];
			expect(colon).toEqual([]);
			// No direct children of wiki-root besides the 3 fixed namespaces.
			const rootId = (
				db.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root' AND archived_at IS NULL`).get() as {
					id: number;
				}
			).id;
			const children = db
				.prepare(
					`SELECT path FROM wiki_nodes
					 WHERE parent_id = ? AND archived_at IS NULL
					 ORDER BY path`,
				)
				.all(rootId) as { path: string }[];
			expect(children.map((c) => c.path)).toEqual([
				"wiki-root/knowledge",
				"wiki-root/memory",
				"wiki-root/projects",
			]);
		});

		test("every fixed root has a DETERMINISTIC non-empty summary", () => {
			const rows = db
				.prepare(
					`SELECT path, summary FROM wiki_nodes
					 WHERE path IN ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')
					   AND archived_at IS NULL`,
				)
				.all() as { path: string; summary: string }[];
			for (const r of rows) {
				expect(r.summary.length, `${r.path} summary must be non-empty`).toBeGreaterThan(0);
			}
			// Determinism: reopen and re-read — summaries must match exactly.
			const before = new Map(rows.map((r) => [r.path, r.summary]));
			wiki.close();
			const w = new WikiDatabase(UNIQUE_WIKI_DB);
			try {
				const after = w
					.getDb()
					.prepare(
						`SELECT path, summary FROM wiki_nodes
						 WHERE path IN ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')
						   AND archived_at IS NULL`,
					)
					.all() as { path: string; summary: string }[];
				for (const r of after) {
					expect(r.summary, `${r.path} summary deterministic across reopen`).toBe(before.get(r.path));
				}
			} finally {
				w.close();
			}
		});
	});

	// -----------------------------------------------------------------------
	// §A item 10: FK behaviors — RESTRICT / CASCADE per design §5
	// -----------------------------------------------------------------------

	describe("§A.10 FK RESTRICT / CASCADE behaviors (each verified by real DELETE)", () => {
		test("wiki_links.target_id RESTRICT: delete a node referenced as link target FAILS", () => {
			const a = insertChild(db, "fk-target-a");
			const b = insertChild(db, "fk-target-b");
			const linkRepo = new WikiLinkRepository(db);
			linkRepo.insert({ source_id: a.id, target_id: b.id, relation: "related_to", created_by: null });
			// DELETE B (target) — RESTRICT.
			expect(() => db.prepare(`DELETE FROM wiki_nodes WHERE id = ?`).run(b.id)).toThrowError(
				/FOREIGN KEY|constraint/i,
			);
			// Sanity: link still there.
			expect(linkRepo.exists(a.id, b.id, "related_to")).toBe(true);
		});

		test("wiki_links.source_id CASCADE: delete the SOURCE node cascades the link away", () => {
			const a = insertChild(db, "fk-source-a");
			const b = insertChild(db, "fk-source-b");
			const linkRepo = new WikiLinkRepository(db);
			linkRepo.insert({ source_id: a.id, target_id: b.id, relation: "related_to", created_by: null });
			expect(linkRepo.exists(a.id, b.id, "related_to")).toBe(true);
			// DELETE A (source) — CASCADE removes the link.
			expect(() => db.prepare(`DELETE FROM wiki_nodes WHERE id = ?`).run(a.id)).not.toThrow();
			// Link gone; B still exists.
			expect(linkRepo.exists(a.id, b.id, "related_to")).toBe(false);
			expect(db.prepare(`SELECT id FROM wiki_nodes WHERE id = ?`).get(b.id)).toBeTruthy();
		});

		test("wiki_nodes.parent_id RESTRICT: deleting a node that still has active children FAILS", () => {
			// wiki-root/knowledge has children created above? Not in a fresh DB.
			// Insert a child under knowledge and try to delete knowledge itself.
			insertChild(db, "child-under-knowledge");
			const knowledgeId = (
				db.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
					.get() as { id: number }
			).id;
			// Deleting knowledge must fail — it has an active child.
			expect(() =>
				db.prepare(`DELETE FROM wiki_nodes WHERE id = ?`).run(knowledgeId),
			).toThrowError(/FOREIGN KEY|constraint/i);
		});

		test("wiki_addresses.target_id RESTRICT: deleting a node referenced by an address FAILS", () => {
			const n = insertChild(db, "fk-addr-target");
			const store = new WikiRepositoryStore(db);
			store.addresses.upsert({
				address: "runtime://test/addr",
				target_id: n.id,
				resolver: "static",
				scope: "runtime",
				kind: "static",
			});
			expect(() => db.prepare(`DELETE FROM wiki_nodes WHERE id = ?`).run(n.id)).toThrowError(
				/FOREIGN KEY|constraint/i,
			);
		});

		test("wiki_repositories.project_node_id RESTRICT: deleting the bound project node FAILS", () => {
			// Build a project subtree manually: wiki-root/projects/proj1 (kind=project).
			const projectsRoot = (
				db.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/projects' AND archived_at IS NULL`)
					.get() as { id: number }
			).id;
			const now = new Date().toISOString();
			const r = db
				.prepare(
					`INSERT INTO wiki_nodes
					   (parent_id, name, path, kind, summary, content, attributes_json,
					    revision, created_at, updated_at, archived_at)
					 VALUES (?, ?, ?, 'project', '', '', NULL, 1, ?, ?, NULL)`,
				)
				.run(projectsRoot, "proj1", "wiki-root/projects/proj1", now, now);
			const projectNodeId = Number(r.lastInsertRowid);
			const store = new WikiRepositoryStore(db);
			store.repositories.upsert({
				repository_id: "repo-proj1",
				project_node_id: projectNodeId,
				project_id: "proj1-business-id",
			});
			// DELETE the project node — RESTRICT.
			expect(() =>
				db.prepare(`DELETE FROM wiki_nodes WHERE id = ?`).run(projectNodeId),
			).toThrowError(/FOREIGN KEY|constraint/i);
		});

		test("wiki_source_bindings.node_id CASCADE: deleting the node cascades the binding away", () => {
			// project node + repo + source-bound file node + binding.
			const projectsRoot = (
				db.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/projects' AND archived_at IS NULL`)
					.get() as { id: number }
			).id;
			const now = new Date().toISOString();
			const projectRow = db
				.prepare(
					`INSERT INTO wiki_nodes
					   (parent_id, name, path, kind, summary, content, attributes_json,
					    revision, created_at, updated_at, archived_at)
					 VALUES (?, ?, ?, 'project', '', '', NULL, 1, ?, ?, NULL)`,
				)
				.run(projectsRoot, "proj2", "wiki-root/projects/proj2", now, now);
			const projectNodeId = Number(projectRow.lastInsertRowid);
			const store = new WikiRepositoryStore(db);
			store.repositories.upsert({
				repository_id: "repo-proj2",
				project_node_id: projectNodeId,
				project_id: "proj2-business-id",
			});
			// source_file node under the project node.
			const fileRow = db
				.prepare(
					`INSERT INTO wiki_nodes
					   (parent_id, name, path, kind, summary, content, attributes_json,
					    revision, created_at, updated_at, archived_at)
					 VALUES (?, 'file.ts', ?, 'source_file', '', '', NULL, 1, ?, ?, NULL)`,
				)
				.run(projectNodeId, "wiki-root/projects/proj2/file.ts", now, now);
			const fileNodeId = Number(fileRow.lastInsertRowid);
			store.sourceBindings.upsert({
				node_id: fileNodeId,
				repository_id: "repo-proj2",
				source_path: "src/file.ts",
				source_kind: "file",
				indexed_revision: "deadbeef",
			});
			expect(store.sourceBindings.getByNodeId(fileNodeId)).toBeTruthy();
			// DELETE the file node — binding CASCADE-deleted.
			expect(() => db.prepare(`DELETE FROM wiki_nodes WHERE id = ?`).run(fileNodeId)).not.toThrow();
			expect(store.sourceBindings.getByNodeId(fileNodeId)).toBeUndefined();
		});

		test("wiki_source_bindings.repository_id CASCADE: deleting the repo cascades its bindings away", () => {
			// Same setup as above; delete the REPOSITORY row (not the node).
			const projectsRoot = (
				db.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/projects' AND archived_at IS NULL`)
					.get() as { id: number }
			).id;
			const now = new Date().toISOString();
			const projectRow = db
				.prepare(
					`INSERT INTO wiki_nodes
					   (parent_id, name, path, kind, summary, content, attributes_json,
					    revision, created_at, updated_at, archived_at)
					 VALUES (?, ?, ?, 'project', '', '', NULL, 1, ?, ?, NULL)`,
				)
				.run(projectsRoot, "proj3", "wiki-root/projects/proj3", now, now);
			const projectNodeId = Number(projectRow.lastInsertRowid);
			const store = new WikiRepositoryStore(db);
			store.repositories.upsert({
				repository_id: "repo-proj3",
				project_node_id: projectNodeId,
				project_id: "proj3-business-id",
			});
			const fileRow = db
				.prepare(
					`INSERT INTO wiki_nodes
					   (parent_id, name, path, kind, summary, content, attributes_json,
					    revision, created_at, updated_at, archived_at)
					 VALUES (?, 'file.ts', ?, 'source_file', '', '', NULL, 1, ?, ?, NULL)`,
				)
				.run(projectNodeId, "wiki-root/projects/proj3/file.ts", now, now);
			const fileNodeId = Number(fileRow.lastInsertRowid);
			store.sourceBindings.upsert({
				node_id: fileNodeId,
				repository_id: "repo-proj3",
				source_path: "src/file.ts",
				source_kind: "file",
				indexed_revision: "deadbeef",
			});
			expect(store.sourceBindings.getByNodeId(fileNodeId)).toBeTruthy();
			// DELETE the repository row — binding should CASCADE away.
			expect(store.repositories.delete("repo-proj3")).toBe(true);
			expect(store.sourceBindings.getByNodeId(fileNodeId)).toBeUndefined();
		});

		test("foreign_keys pragma is the ENFORCER: toggling it off is NOT how the impl passes (regression guard)", () => {
			// We must not be passing FK tests by silently disabling FKs. Confirm
			// the pragma is ON inside the WikiDatabase handle.
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
			// And foreign_key_check on a known-violating setup would be non-empty
			// if anything slipped through (here, fresh DB → empty).
			expect(wiki.foreignKeyCheck()).toBe("ok");
		});
	});

	// -----------------------------------------------------------------------
	// §A item 12 (adversarial): audit request_id dedup
	// -----------------------------------------------------------------------

	describe("§A.12 audit request_id dedup (adversarial)", () => {
		test("append twice with same requestId → exactly 1 row; second returns SAME auditId; deduped=true", () => {
			const auditRepo = new WikiAuditRepository(db);
			const before = auditRepo.count();
			const r1 = auditRepo.append({
				requestId: "adv-req-001",
				action: "create",
				nodePath: "wiki-root/knowledge/x",
				newRevision: 1,
			});
			const r2 = auditRepo.append({
				requestId: "adv-req-001",
				action: "create",
				nodePath: "wiki-root/knowledge/x",
				newRevision: 1,
			});
			expect(r2.deduped).toBe(true);
			expect(r2.auditId).toBe(r1.auditId);
			expect(auditRepo.count()).toBe(before + 1); // exactly one new row total
			// And the row's audit_id matches.
			const row = auditRepo.getByRequestId("adv-req-001");
			expect(row?.audit_id).toBe(r1.auditId);
		});

		test("append with explicit auditId + duplicate requestId → still returns the EXISTING auditId (not the new one)", () => {
			// Adversarial: caller tries to override auditId on the retry; dedup must
			// still return the ORIGINAL auditId, not the caller-supplied one.
			const auditRepo = new WikiAuditRepository(db);
			const before = auditRepo.count();
			const r1 = auditRepo.append({
				auditId: "audit-original",
				requestId: "adv-req-002",
				action: "update",
				nodePath: "wiki-root/knowledge/y",
			});
			expect(r1.auditId).toBe("audit-original");
			const r2 = auditRepo.append({
				auditId: "audit-attacker-rewrite",
				requestId: "adv-req-002", // duplicate
				action: "update",
				nodePath: "wiki-root/knowledge/y",
			});
			expect(r2.deduped).toBe(true);
			expect(r2.auditId).toBe("audit-original"); // NOT the attacker value
			expect(r2.auditId).not.toBe("audit-attacker-rewrite");
			// Only ONE new row was added total (the dedup suppressed the 2nd insert).
			expect(auditRepo.count()).toBe(before + 1);
		});
	});

	// -----------------------------------------------------------------------
	// §A items 6/7/8 (adversarial): path attack surface — every rejection fires
	// -----------------------------------------------------------------------

	describe("§A.6/7/8 canonical path attack surface (every rejection branch fires)", () => {
		test("empty / whitespace-only path is rejected with INVALID_PATH", () => {
			expect(errCode(() => normalizeWikiPath(""))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("   "))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("\t\n"))).toBe("INVALID_PATH");
		});

		test("'.' / '..' segments are rejected with INVALID_PATH", () => {
			expect(errCode(() => normalizeWikiPath("wiki-root/./a"))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("wiki-root/../a"))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("wiki-root/a/.."))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("wiki-root/a/."))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("../wiki-root"))).toBe("INVALID_PATH");
		});

		test("backslash is rejected with INVALID_PATH", () => {
			expect(errCode(() => normalizeWikiPath("wiki-root\\a"))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("wiki-root/a\\b"))).toBe("INVALID_PATH");
		});

		test("ASCII control chars (U+0000-001F, U+007F) are rejected with INVALID_PATH", () => {
			expect(errCode(() => normalizeWikiPath(`wiki-root/a${ctrl(0)}b`))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath(`wiki-root/a${ctrl(0x1f)}b`))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath(`wiki-root/a${ctrl(0x7f)}b`))).toBe("INVALID_PATH");
			// TAB inside (not just surrounding whitespace) also rejected.
			expect(errCode(() => normalizeWikiPath(`wiki-root/a${ctrl(0x09)}b`))).toBe("INVALID_PATH");
		});

		test("reserved address schemes are rejected with INVALID_PATH (memory:// / project:// / runtime://)", () => {
			expect(errCode(() => normalizeWikiPath("memory://agent-1"))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("project://zero-core"))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("runtime://rules/global"))).toBe("INVALID_PATH");
		});

		test("path not starting with 'wiki-root' is rejected with INVALID_PATH", () => {
			expect(errCode(() => normalizeWikiPath("not-root/a"))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("wikiroot/a"))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("Wiki-Root/a"))).toBe("INVALID_PATH"); // case-sensitive
		});

		test("over-length path (> 32 segments) is rejected with INVALID_PATH", () => {
			const segs = ["wiki-root"];
			for (let i = 0; i < WIKI_PATH_MAX_SEGMENTS; i++) segs.push(`s${i}`);
			const long = segs.join("/");
			expect(errCode(() => normalizeWikiPath(long))).toBe("INVALID_PATH");
		});

		test("over-length NAME (> 256 chars) is rejected with INVALID_NAME via joinWikiPath", () => {
			const tooLong = "x".repeat(WIKI_NAME_MAX_LENGTH + 1);
			expect(errCode(() => joinWikiPath("wiki-root", tooLong))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName(tooLong))).toBe("INVALID_NAME");
		});

		test("validateWikiName rejects '.', '..', '', whitespace-bordered, '/', '\\', control, scheme", () => {
			expect(errCode(() => validateWikiName("."))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName(".."))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName(""))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName(" leadingspace"))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName("trailing "))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName("a/b"))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName("a\\b"))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName(`a${ctrl(0)}b`))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName("memory://x"))).toBe("INVALID_NAME");
		});

		test("CRITICAL segment-based scope match: isSameOrDescendant('wiki-root/a', 'wiki-root/ab') === false", () => {
			expect(isSameOrDescendant("wiki-root/a", "wiki-root/ab")).toBe(false);
			expect(isSameOrDescendant("wiki-root/ab", "wiki-root/a")).toBe(false);
			// Positive controls (must still work):
			expect(isSameOrDescendant("wiki-root/a", "wiki-root/a")).toBe(true);
			expect(isSameOrDescendant("wiki-root/a", "wiki-root/a/b")).toBe(true);
			expect(isSameOrDescendant("wiki-root/a", "wiki-root/a/b/c")).toBe(true);
			// Negative (different parent entirely):
			expect(isSameOrDescendant("wiki-root/a", "wiki-root/b")).toBe(false);
		});

		test("parentWikiPath: root → null; non-root → parent path", () => {
			expect(parentWikiPath("wiki-root")).toBeNull();
			expect(parentWikiPath("wiki-root/knowledge")).toBe("wiki-root");
			expect(parentWikiPath("wiki-root/knowledge/a/b")).toBe("wiki-root/knowledge/a");
		});

		test("normalizeWikiPath canonical form: dedup slash, trim whitespace, drop trailing slash", () => {
			// Same logical path collapses to one canonical string.
			expect(normalizeWikiPath("wiki-root//a///b")).toBe("wiki-root/a/b");
			expect(normalizeWikiPath("wiki-root/a/b/")).toBe("wiki-root/a/b");
			expect(normalizeWikiPath("  wiki-root/a/b  ")).toBe("wiki-root/a/b");
			// Equivalence class: multiple surface forms → same canonical.
			const forms = [
				"wiki-root/a/b",
				"wiki-root/a/b/",
				"wiki-root//a//b",
				"  wiki-root/a/b ",
			];
			const canonical = new Set(forms.map((f) => normalizeWikiPath(f)));
			expect(canonical.size).toBe(1);
		});

		test("WIKI_ROOT_PATH is exactly 'wiki-root' (single source of truth)", () => {
			expect(WIKI_ROOT_PATH).toBe("wiki-root");
		});
	});

	// -----------------------------------------------------------------------
	// §E clean-cutover attack (grep + runtime)
	// -----------------------------------------------------------------------

	describe("§E (a, c, e, f) clean-cutover — no legacy contamination", () => {
		test("§E (a/e): ZERO code-line references to project_wiki / WIKI_DISK_ROOT in src/server/wiki/", () => {
			// Walk every .ts under src/server/wiki/ and assert NO code-line mentions
			// the legacy identifiers. Comments may cite them (documenting what NOT
			// to do); code must not.
			const files = walkSrcTs();
			expect(files.length).toBeGreaterThan(0);
			const offenders: Array<{ file: string; line: number; text: string }> = [];
			for (const f of files) {
				const src = readFileSync(f, "utf-8").split(/\r?\n/);
				for (let i = 0; i < src.length; i++) {
					const line = src[i];
					const t = line.trim();
					if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
					if (/\bproject_wiki\b/.test(line) || /\bWIKI_DISK_ROOT\b/.test(line)) {
						offenders.push({ file: f.replace(ROOT, "."), line: i + 1, text: t });
					}
				}
			}
			if (offenders.length > 0) {
				console.error(
					"Legacy identifiers on code lines:\n" +
						offenders.map((o) => `${o.file}:${o.line}: ${o.text}`).join("\n"),
				);
			}
			expect(offenders).toEqual([]);
		});

		test("§E (a): ZERO imports of legacy wiki-node-store / wiki-router / wiki-operations in src/server/wiki/", () => {
			const files = walkSrcTs();
			const offenders: Array<{ file: string; line: number; text: string }> = [];
			for (const f of files) {
				const src = readFileSync(f, "utf-8").split(/\r?\n/);
				for (let i = 0; i < src.length; i++) {
					const line = src[i];
					const t = line.trim();
					if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
					// Match import statements that resolve to the legacy modules.
					if (/from\s+["'][^"']*(wiki-node-store|wiki-router|wiki-operations)/.test(line)) {
						offenders.push({ file: f.replace(ROOT, "."), line: i + 1, text: t });
					}
				}
			}
			expect(offenders).toEqual([]);
		});

		test("§E (a): src/shared/wiki-types.ts has ZERO code-line references to project_wiki / WIKI_DISK_ROOT", () => {
			const code = readCodeOnly("src/shared/wiki-types.ts");
			expect(code).not.toMatch(/\bproject_wiki\b/);
			expect(code).not.toMatch(/\bWIKI_DISK_ROOT\b/);
		});

		test("§E (a): writing a node via the NEW repository does NOT write to project_wiki (table absent)", () => {
			// Adversarial runtime: the schema must NOT contain project_wiki at all,
			// and inserting via WikiNodeRepository must not create it. We
			// cross-verify by querying sqlite_master.
			const tables = db
				.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
				.all() as { name: string }[];
			expect(tables.map((t) => t.name)).not.toContain("project_wiki");

			// Use the new repository to insert a node.
			const nodeRepo = new WikiNodeRepository(db);
			const parent = nodeRepo.getActiveByPath("wiki-root/knowledge")!;
			wiki.transaction(() => {
				const r = nodeRepo.insert({
					parent_id: parent.id,
					name: "cutover-probe",
					path: "wiki-root/knowledge/cutover-probe",
					kind: "knowledge",
					summary: "s",
					content: "body",
					attributes_json: null,
				});
				nodeRepo.syncFtsInsert(r.id, r.name, r.summary, r.content);
			});

			// project_wiki STILL absent after a real insert via the new repository.
			const tablesAfter = db
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_wiki'`)
				.all() as { name: string }[];
			expect(tablesAfter).toEqual([]);
		});

		test("§E (c): Agent-facing views are not polluted by raw repository rows at runtime (no id leak via mutation result)", () => {
			// The repository returns WikiNodeRow (internal, has id/parent_id) — that's
			// intentional for internal use. The Agent-facing contract is the shared
			// view type (covered structurally in wiki-v2-schema). Here we add a
			// runtime guard: inserting a node + writing audit returns an auditId
			// (opaque receipt) and NEVER a raw numeric id. The repository's append
			// result shape is { auditId, deduped }; assert no numeric id leaks.
			const auditRepo = new WikiAuditRepository(db);
			const res = auditRepo.append({
				requestId: "adv-cutover-001",
				action: "create",
				nodePath: "wiki-root/knowledge/abc",
				newRevision: 1,
			});
			expect(typeof res.auditId).toBe("string");
			expect(res.auditId.length).toBeGreaterThan(0);
			// deduped is boolean, not an id.
			expect(typeof res.deduped).toBe("boolean");
		});

		test("§E (f): schema does NOT require legacy Wiki data migration to start (fresh DB self-bootstraps)", () => {
			// We already opened a fresh DB in beforeEach. Assert schema version is
			// WIKI_SCHEMA_VERSION and no migration step references legacy tables.
			expect(wiki.schemaVersion()).toBe(WIKI_SCHEMA_VERSION);
			// Code-line grep: wiki-schema.ts must not mention "project_wiki" or
			// "migrate" in code (only in comments allowed).
			const code = readCodeOnly("src/server/wiki/wiki-schema.ts");
			expect(code).not.toMatch(/\bproject_wiki\b/);
			// No migration runner (plan-01 has no migration step).
			expect(code).not.toMatch(/\bmigrate\w*\s*\(/i);
		});
	});

	// -----------------------------------------------------------------------
	// DatabaseManager wiring (plan-01 ready-order / health / checkpointWiki)
	// -----------------------------------------------------------------------

	describe("DatabaseManager wiring (open ready-order, checkpointWiki, health)", () => {
		test("open() opens BOTH core AND wiki before returning (ready-order invariant)", () => {
			const mgr = new DatabaseManager();
			expect(() => mgr.open()).not.toThrow();
			try {
				// Both handles are live immediately after open() returns.
				expect(() => mgr.core).not.toThrow();
				expect(() => mgr.wiki).not.toThrow();
				// And the wiki handle is a real WikiDatabase.
				expect(mgr.wiki).toBeInstanceOf(WikiDatabase);
				expect(mgr.wiki.schemaVersion()).toBe(WIKI_SCHEMA_VERSION);
				// Fixed roots present (bootstrap ran during open()).
				const roots = mgr
					.wiki.getDb()
					.prepare(
						`SELECT COUNT(*) AS n FROM wiki_nodes
						 WHERE archived_at IS NULL AND path IN
						   ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')`,
					)
					.get() as { n: number };
				expect(roots.n).toBe(4);
			} finally {
				mgr.close();
			}
		});

		test("health() includes a wiki entry with the locked shape (plan-01 adds wiki)", () => {
			const mgr = new DatabaseManager();
			mgr.open();
			try {
				const h = mgr.health();
				expect(h).toHaveProperty("core");
				expect(h).toHaveProperty("wiki");
				expect(h.wiki).toBeDefined();
				expect(h.wiki!.integrity).toBe("ok");
				expect(h.wiki!.foreignKeys).toBe("ok");
				expect(h.wiki!.journalMode).toBeTruthy(); // 'memory' in tests
				expect(typeof h.wiki!.exists).toBe("boolean");
				expect(h.wiki!.exists).toBe(true);
			} finally {
				mgr.close();
			}
		});

		test("checkpointWiki() does NOT touch core.db (core sha unchanged across checkpointWiki)", () => {
			const mgr = new DatabaseManager();
			mgr.open();
			try {
				// Force a write to wiki so checkpoint has something to do (MEMORY
				// journal → checkpoint is still a legal no-op-ish call; must not throw).
				mgr
					.wiki.getDb()
					.prepare(
						`INSERT INTO wiki_nodes
						   (parent_id, name, path, kind, summary, content, attributes_json,
						    revision, created_at, updated_at, archived_at)
						 VALUES (?, 'ckpt-probe', ?, 'knowledge', '', '', NULL, 1, ?, ?, NULL)`,
					)
					.run(
						(mgr.wiki.getDb().prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge'`).get() as {
							id: number;
						}).id,
						"wiki-root/knowledge/ckpt-probe",
						new Date().toISOString(),
						new Date().toISOString(),
					);
				// Compute core.db sha BEFORE checkpointWiki.
				const corePath = join(UNIQUE_DIR, "db", "core.db");
				const shaBefore = sha256(corePath);
				expect(() => mgr.checkpointWiki()).not.toThrow();
				// Force a core checkpoint to flush — wait, NO: we are testing that
				// checkpointWiki leaves core ALONE. Compare sha after.
				const shaAfter = sha256(corePath);
				expect(shaAfter, "checkpointWiki must not modify core.db").toBe(shaBefore);
			} finally {
				mgr.close();
			}
		});

		test("checkpointWiki() actually delegates to wiki wal_checkpoint(TRUNCATE) (source audit)", () => {
			// Source audit: DatabaseManager.checkpointWiki calls this._wiki.checkpoint()
			// (which itself runs wal_checkpoint(TRUNCATE)). NOT checkpointCore, NOT core.
			const src = readFileSync(join(ROOT, "src", "server", "database-manager.ts"), "utf-8");
			// Extract method body for checkpointWiki (skip JSDoc / comments).
			const lines = src.split(/\r?\n/);
			let startIdx = -1;
			for (let i = 0; i < lines.length; i++) {
				if (/checkpointWiki\s*\(\s*\)/.test(lines[i]) && /\{\s*$/.test(lines[i])) {
					startIdx = i;
					break;
				}
			}
			expect(startIdx).toBeGreaterThanOrEqual(0);
			let depth = 0;
			const bodyLines: string[] = [];
			for (let i = startIdx; i < lines.length; i++) {
				const line = lines[i];
				const isComment =
					line.trim().startsWith("//") ||
					line.trim().startsWith("*") ||
					line.trim().startsWith("/*");
				if (!isComment) {
					for (const ch of line) {
						if (ch === "{") depth++;
						else if (ch === "}") depth--;
					}
				}
				bodyLines.push(line);
				if (depth <= 0 && i > startIdx) break;
			}
			const body = bodyLines.filter((l) => {
				const t = l.trim();
				return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
			}).join("\n");
			// Must delegate to wiki handle.
			expect(body).toMatch(/this\._wiki\.checkpoint\s*\(\s*\)/);
			// Must NOT touch core handle.
			expect(body).not.toMatch(/this\._core/);
			expect(body).not.toMatch(/this\.checkpointCore/);
		});

		test("NO ATTACH DATABASE in DatabaseManager (and no second connection to core.db)", () => {
			// §G reject: DatabaseManager must not ATTACH or open a 2nd core.db connection.
			const code = readCodeOnly("src/server/database-manager.ts");
			expect(code).not.toMatch(/\bATTACH\b/i);
			// WikiDatabase wiring: open() constructs exactly ONE WikiDatabase (no
			// second handle to core or wiki).
			const wikiCtorMatches = code.match(/new\s+WikiDatabase\s*\(/g) || [];
			expect(wikiCtorMatches.length).toBe(1);
		});

		test("WikiDatabase wiring in DatabaseManager uses wikiDbPath from database-paths (single source of truth)", () => {
			// plan-01 §1: wiki path must come from database-paths, not hardcoded.
			const code = readCodeOnly("src/server/database-manager.ts");
			// wikiDbPath is imported (see import section).
			expect(code).toMatch(/wikiDbPath/);
			// And it's passed to new WikiDatabase(...).
			expect(code).toMatch(/new\s+WikiDatabase\s*\(\s*wikiDbPath\s*\)/);
		});
	});
});
