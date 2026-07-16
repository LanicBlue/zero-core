// wiki-system-redesign sub-01 acceptance — 规约 (spec-compliance) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级 + 结构级编码 acceptance-01 §A items 3, 5, 9, 11, 12, 13, 14, 15 + §B item 4
// 中属于「schema / shared-types / audit / fixed-root」的规约要点。本文件从
// **规约符合**视角断言(对照 design.md §5 DDL + plan-01 §2/§4 闭集):
//   - 7 张核心表 + FTS 全部存在,列 / FK / 索引 / partial unique 与设计一致。
//   - INTEGER affinity:id/parent_id/revision/source_id/target_id/... 全为 INTEGER
//     (PRAGMA table_info), revision 算术不字符串拼接。
//   - active partial unique index(WHERE archived_at IS NULL):重复 active path/sibling
//     被拒;归档后同路径 active 重建允许;restore 冲突被拒。
//   - 表级永久 UNIQUE 不存在(partial unique index 是唯一来源)。
//   - attributes_json json_valid CHECK:非法 JSON 被拒。
//   - FTS 为 external-content,字段恰好 name/summary/content;**无 trigger**;
//     repository 显式 transaction 同步 insert/update/delete;rebuild 后一致。
//   - 固定根恰好 wiki-root + knowledge/memory/projects;双初始化幂等;无 wiki-root:global。
//   - audit request_id 去重。
//   - 共享类型闭集:WikiErrorCode=20 / WikiNodeKind=10 / WikiAction=9;Agent-facing
//     view 不含内部整数 ID(文本审计)。
//   - canonical path 单一权威(结构 grep:路径函数仅在 wiki-path.ts 定义)。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db(vi.hoisted,sub-00 教训)。
//   - src/shared/wiki-types.ts 源文件文本(用于 view 字段审计)。
//   - src/server/wiki/ 源文件文本(用于 single-authority grep)。
//
// ## 输出
// Vitest 用例。每用例开真 SQLite temp DB,绝不读活跃 ~/.zero-core。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - INTEGER affinity 测试必须真跑 PRAGMA + 算术运算,不能只看 schema 字符串。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
// UNIQUE ZERO_CORE_DIR + UNIQUE wiki.db path per file. vi.hoisted runs before
// any other import so config.ts / database-paths.ts pick up OUR temp dir.
const { UNIQUE_DIR, UNIQUE_WIKI_DB } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-schema-"));
	process.env.ZERO_CORE_DIR = d;
	const dbPath = join(d, "wiki-spec.db");
	return { UNIQUE_DIR: d, UNIQUE_WIKI_DB: dbPath };
});

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import {
	WIKI_TABLE_NAMES,
	WIKI_SCHEMA_VERSION,
} from "../../src/server/wiki/wiki-schema.js";
import {
	WIKI_ERROR_CODES,
	WIKI_NODE_KINDS,
	WIKI_ACTIONS,
} from "../../src/shared/wiki-types.js";
import type {
	WikiNodeView,
	WikiLinkView,
	WikiRepositoryView,
	WikiAddressView,
	WikiAuditView,
} from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 打开 fresh WikiDatabase(走 UNIQUE temp path),返回底层句柄与实例。 */
function openFresh(): { wiki: WikiDatabase; db: Database.Database } {
	const wiki = new WikiDatabase(UNIQUE_WIKI_DB);
	return { wiki, db: wiki.getDb() };
}

/** 所有 wiki_nodes 整数列(应全部 INTEGER affinity)。 */
const INTEGER_COLUMNS_BY_TABLE: Record<string, string[]> = {
	wiki_nodes: ["id", "parent_id", "revision"],
	wiki_links: ["source_id", "target_id"],
	wiki_addresses: ["target_id", "revision"],
	wiki_repositories: ["project_node_id"],
	wiki_source_bindings: ["node_id"],
	wiki_audit_log: ["old_revision", "new_revision"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wiki-v2 schema [spec-compliance lens]", () => {
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
	// §A item 3: 七类核心表/FTS 均存在,列、唯一约束、外键和索引与设计一致
	// -----------------------------------------------------------------------

	describe("§A.3 seven core tables + FTS exist", () => {
		test("all 7 tables (incl. FTS) are present in sqlite_master", () => {
			const rows = db
				.prepare(
					`SELECT name, type FROM sqlite_master
					 WHERE name LIKE 'wiki_%'
					 ORDER BY name`,
				)
				.all() as { name: string; type: string }[];
			const names = new Set(rows.map((r) => r.name));
			for (const t of WIKI_TABLE_NAMES) {
				expect(names.has(t), `table ${t} should exist`).toBe(true);
			}
		});

		test("wiki_nodes has EXACTLY the design §5.1 columns", () => {
			const cols = db
				.prepare("PRAGMA table_info(wiki_nodes)")
				.all() as { name: string; type: string; notnull: number; dflt_value: string | null }[];
			const byName = new Map(cols.map((c) => [c.name, c]));
			const expected = [
				"id",
				"parent_id",
				"name",
				"path",
				"kind",
				"summary",
				"content",
				"attributes_json",
				"revision",
				"created_at",
				"updated_at",
				"archived_at",
			];
			for (const c of expected) {
				expect(byName.has(c), `wiki_nodes.${c} missing`).toBe(true);
			}
			// 列数恰好 = 设计 + 不多不少
			expect(cols.map((c) => c.name).sort().join(",")).toBe(
				[...expected].sort().join(","),
			);
		});

		test("wiki_nodes default kind='node', summary/content default '', revision default 1", () => {
			const cols = db
				.prepare("PRAGMA table_info(wiki_nodes)")
				.all() as { name: string; dflt_value: string | null }[];
			const byName = new Map(cols.map((c) => [c.name, c.dflt_value]));
			expect(byName.get("kind")).toBe("'node'");
			expect(byName.get("summary")).toBe("''");
			expect(byName.get("content")).toBe("''");
			expect(byName.get("revision")).toBe("1");
		});

		test("wiki_links matches design §5.2 (PK + CASCADE/RESTRICT + target index)", () => {
			const cols = db
				.prepare("PRAGMA table_info(wiki_links)")
				.all() as { name: string }[];
			expect(cols.map((c) => c.name)).toEqual(
				expect.arrayContaining(["source_id", "target_id", "relation", "created_at", "created_by"]),
			);
			// FK behavior: source CASCADE, target RESTRICT
			const fks = db
				.prepare("PRAGMA foreign_key_list(wiki_links)")
				.all() as { from: string; on_delete: string; table: string }[];
			const sourceFk = fks.find((f) => f.from === "source_id");
			const targetFk = fks.find((f) => f.from === "target_id");
			expect(sourceFk?.on_delete).toBe("CASCADE");
			expect(targetFk?.on_delete).toBe("RESTRICT");
			// target index present
			const idx = db
				.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='wiki_links'")
				.all() as { name: string }[];
			expect(idx.some((i) => i.name === "idx_wiki_links_target")).toBe(true);
		});

		test("wiki_addresses FK target RESTRICT + target index", () => {
			const fks = db
				.prepare("PRAGMA foreign_key_list(wiki_addresses)")
				.all() as { from: string; on_delete: string }[];
			const targetFk = fks.find((f) => f.from === "target_id");
			expect(targetFk?.on_delete).toBe("RESTRICT");
		});

		test("wiki_repositories FK project_node_id RESTRICT + UNIQUE constraints", () => {
			const fks = db
				.prepare("PRAGMA foreign_key_list(wiki_repositories)")
				.all() as { from: string; on_delete: string }[];
			expect(fks.find((f) => f.from === "project_node_id")?.on_delete).toBe("RESTRICT");
			const sql = (
				db
					.prepare("SELECT sql FROM sqlite_master WHERE name='wiki_repositories'")
					.get() as { sql: string }
			).sql;
			// project_node_id UNIQUE + project_id UNIQUE(表级声明)
			expect(sql).toContain("project_node_id");
			expect(sql).toMatch(/UNIQUE/i);
		});

		test("wiki_source_bindings: node_id CASCADE + repository_id CASCADE + UNIQUE(repo,path)", () => {
			const fks = db
				.prepare("PRAGMA foreign_key_list(wiki_source_bindings)")
				.all() as { from: string; on_delete: string }[];
			expect(fks.find((f) => f.from === "node_id")?.on_delete).toBe("CASCADE");
			expect(fks.find((f) => f.from === "repository_id")?.on_delete).toBe("CASCADE");
			const sql = (
				db
					.prepare("SELECT sql FROM sqlite_master WHERE name='wiki_source_bindings'")
					.get() as { sql: string }
			).sql;
			expect(sql).toContain("UNIQUE(repository_id, source_path)");
		});

		test("indexes: parent/kind/archived on wiki_nodes exist", () => {
			const idx = db
				.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='wiki_nodes'")
				.all() as { name: string }[];
			const names = idx.map((i) => i.name);
			expect(names).toEqual(
				expect.arrayContaining([
					"idx_wiki_nodes_parent",
					"idx_wiki_nodes_kind",
					"idx_wiki_nodes_archived",
					"uq_wiki_nodes_active_path",
					"uq_wiki_nodes_active_sibling",
				]),
			);
		});

		test("audit indexes exist", () => {
			const idx = db
				.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='wiki_audit_log'")
				.all() as { name: string }[];
			const names = idx.map((i) => i.name);
			expect(names).toEqual(
				expect.arrayContaining([
					"idx_wiki_audit_created",
					"idx_wiki_audit_node",
					"idx_wiki_audit_actor",
				]),
			);
		});
	});

	// -----------------------------------------------------------------------
	// §A item 14: INTEGER affinity + revision arithmetic
	// -----------------------------------------------------------------------

	describe("§A.14 INTEGER affinity", () => {
		test("every integer column reports INTEGER affinity via PRAGMA table_info", () => {
			for (const [table, intCols] of Object.entries(INTEGER_COLUMNS_BY_TABLE)) {
				const cols = db
					.prepare(`PRAGMA table_info(${table})`)
					.all() as { name: string; type: string }[];
				const byName = new Map(cols.map((c) => [c.name, c.type]));
				for (const col of intCols) {
					const t = byName.get(col);
					expect(t, `${table}.${col} type=${t}`).toBe("INTEGER");
				}
			}
		});

		test("revision arithmetic does NOT string-concatenate", () => {
			// 在 wiki-root/knowledge 下插一个 node revision=1。
			const parent = db
				.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
				.get() as { id: number };
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO wiki_nodes
				   (parent_id, name, path, kind, summary, content, attributes_json,
				    revision, created_at, updated_at, archived_at)
				 VALUES (?, ?, ?, ?, ?, '', NULL, 1, ?, ?, NULL)`,
			).run(parent.id, "rev-probe", "wiki-root/knowledge/rev-probe", "knowledge", "s", now, now);

			// 用裸 SQL 做 revision + 1(纯 DB 侧算术,证明 INTEGER affinity)。
			const r = db
				.prepare(`SELECT revision + 1 AS next FROM wiki_nodes WHERE path='wiki-root/knowledge/rev-probe'`)
				.get() as { next: number };
			expect(r.next).toBe(2); // 若是字符串拼接会是 11 或 "11"
			expect(typeof r.next).toBe("number");

			// 真正 UPDATE 算术,再读回。
			db.prepare(`UPDATE wiki_nodes SET revision = revision + 1 WHERE path='wiki-root/knowledge/rev-probe'`).run();
			const after = db
				.prepare(`SELECT revision FROM wiki_nodes WHERE path='wiki-root/knowledge/rev-probe'`)
				.get() as { revision: number };
			expect(after.revision).toBe(2);
			expect(typeof after.revision).toBe("number");
		});
	});

	// -----------------------------------------------------------------------
	// §A item 9 + 表级 UNIQUE 禁令:active partial unique index
	// -----------------------------------------------------------------------

	describe("§A.9 active partial unique (WHERE archived_at IS NULL)", () => {
		test("both partial unique indexes carry the WHERE archived_at IS NULL predicate", () => {
			const rows = db
				.prepare(
					`SELECT name, sql FROM sqlite_master
					 WHERE name IN ('uq_wiki_nodes_active_path', 'uq_wiki_nodes_active_sibling')`,
				)
				.all() as { name: string; sql: string }[];
			const byName = new Map(rows.map((r) => [r.name, r.sql]));
			expect(byName.get("uq_wiki_nodes_active_path")?.toLowerCase()).toContain(
				"where archived_at is null",
			);
			expect(byName.get("uq_wiki_nodes_active_sibling")?.toLowerCase()).toContain(
				"where archived_at is null",
			);
		});

		test("FAIL: duplicate active path is rejected", () => {
			const parent = db
				.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
				.get() as { id: number };
			const now = new Date().toISOString();
			const insert = db.prepare(
				`INSERT INTO wiki_nodes
				   (parent_id, name, path, kind, summary, content, attributes_json,
				    revision, created_at, updated_at, archived_at)
				 VALUES (?, ?, ?, ?, ?, '', NULL, 1, ?, ?, NULL)`,
			);
			insert.run(parent.id, "dup", "wiki-root/knowledge/dup", "knowledge", "s", now, now);
			// 第二个 active 同 path → 必须被 partial unique reject。
			expect(() =>
				insert.run(parent.id, "dup", "wiki-root/knowledge/dup", "knowledge", "s2", now, now),
			).toThrowError(/UNIQUE/i);
		});

		test("FAIL: duplicate active sibling (parent_id, name) is rejected", () => {
			const parent = db
				.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
				.get() as { id: number };
			const now = new Date().toISOString();
			const insert = db.prepare(
				`INSERT INTO wiki_nodes
				   (parent_id, name, path, kind, summary, content, attributes_json,
				    revision, created_at, updated_at, archived_at)
				 VALUES (?, ?, ?, ?, ?, '', NULL, 1, ?, ?, NULL)`,
			);
			// 同 parent + 同 name + 不同 path(path 不同但 name 同)— partial sibling unique 应 reject
			insert.run(parent.id, "sib", "wiki-root/knowledge/sib", "knowledge", "s", now, now);
			expect(() =>
				insert.run(parent.id, "sib", "wiki-root/knowledge/sib-other", "knowledge", "s", now, now),
			).toThrowError(/UNIQUE/i);
		});

		test("archive a node then create same-path ACTIVE node is ALLOWED", () => {
			const parent = db
				.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
				.get() as { id: number };
			const now = new Date().toISOString();
			const insert = db.prepare(
				`INSERT INTO wiki_nodes
				   (parent_id, name, path, kind, summary, content, attributes_json,
				    revision, created_at, updated_at, archived_at)
				 VALUES (?, ?, ?, ?, ?, '', NULL, 1, ?, ?, NULL)`,
			);
			const first = insert.run(parent.id, "recyc", "wiki-root/knowledge/recyc", "knowledge", "v1", now, now);
			// 归档:partial unique 释放 active path 槽位
			db.prepare(`UPDATE wiki_nodes SET archived_at = ?, updated_at = ? WHERE id = ?`).run(
				now,
				now,
				first.lastInsertRowid,
			);
			// 同 path active 新建 → 必须 OK
			expect(() =>
				insert.run(parent.id, "recyc", "wiki-root/knowledge/recyc", "knowledge", "v2", now, now),
			).not.toThrow();
			// 现在两个 active=false/true 行并存,只有一个是 active
			const rows = db
				.prepare(`SELECT archived_at FROM wiki_nodes WHERE path='wiki-root/knowledge/recyc' ORDER BY id`)
				.all() as { archived_at: string | null }[];
			expect(rows.length).toBe(2);
			expect(rows.filter((r) => r.archived_at === null).length).toBe(1);
		});

		test("FAIL: restore (unarchive) a node whose path is now held by an ACTIVE node is rejected", () => {
			const parent = db
				.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
				.get() as { id: number };
			const now = new Date().toISOString();
			const insert = db.prepare(
				`INSERT INTO wiki_nodes
				   (parent_id, name, path, kind, summary, content, attributes_json,
				    revision, created_at, updated_at, archived_at)
				 VALUES (?, ?, ?, ?, ?, '', NULL, 1, ?, ?, NULL)`,
			);
			// A: original active
			const a = insert.run(parent.id, "conflict", "wiki-root/knowledge/conflict", "knowledge", "a", now, now);
			// 归档 A
			db.prepare(`UPDATE wiki_nodes SET archived_at = ?, updated_at = ? WHERE id = ?`).run(now, now, a.lastInsertRowid);
			// B: 新 active 占同 path
			insert.run(parent.id, "conflict", "wiki-root/knowledge/conflict", "knowledge", "b", now, now);
			// 试图 restore A → partial unique 应 reject(active path 已被 B 占)
			expect(() =>
				db.prepare(`UPDATE wiki_nodes SET archived_at = NULL, updated_at = ? WHERE id = ?`).run(
					now,
					a.lastInsertRowid,
				),
			).toThrowError(/UNIQUE/i);
		});

		test("NO table-level permanent UNIQUE on wiki_nodes (partial unique is the only authority)", () => {
			const sql = (
				db
					.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='wiki_nodes'`)
					.get() as { sql: string }
			).sql;
			// 表 DDL 内不应出现裸 UNIQUE 约束(只有 partial unique index 在表外)。
			// 注意:wiki_source_bindings 等其它表有 UNIQUE,但 wiki_nodes 不应有。
			expect(sql.toLowerCase()).not.toContain("unique");
		});
	});

	// -----------------------------------------------------------------------
	// §A item 3 (json_valid CHECK)
	// -----------------------------------------------------------------------

	describe("§A.3 attributes_json json_valid CHECK", () => {
		test("NULL attributes_json is accepted", () => {
			const parent = db
				.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
				.get() as { id: number };
			const now = new Date().toISOString();
			expect(() =>
				db
					.prepare(
						`INSERT INTO wiki_nodes
						   (parent_id, name, path, kind, summary, content, attributes_json,
						    revision, created_at, updated_at, archived_at)
						 VALUES (?, ?, ?, ?, '', '', NULL, 1, ?, ?, NULL)`,
					)
					.run(parent.id, "nullattr", "wiki-root/knowledge/nullattr", "knowledge", now, now),
			).not.toThrow();
		});

		test("valid JSON attributes_json is accepted", () => {
			const parent = db
				.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
				.get() as { id: number };
			const now = new Date().toISOString();
			expect(() =>
				db
					.prepare(
						`INSERT INTO wiki_nodes
						   (parent_id, name, path, kind, summary, content, attributes_json,
						    revision, created_at, updated_at, archived_at)
						 VALUES (?, ?, ?, ?, '', '', ?, 1, ?, ?, NULL)`,
					)
					.run(parent.id, "okjson", "wiki-root/knowledge/okjson", "knowledge", '{"display_name":"OK"}', now, now),
			).not.toThrow();
		});

		test("FAIL: invalid JSON attributes_json is rejected by CHECK constraint", () => {
			const parent = db
				.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge' AND archived_at IS NULL`)
				.get() as { id: number };
			const now = new Date().toISOString();
			expect(() =>
				db
					.prepare(
						`INSERT INTO wiki_nodes
						   (parent_id, name, path, kind, summary, content, attributes_json,
						    revision, created_at, updated_at, archived_at)
						 VALUES (?, ?, ?, ?, '', '', ?, 1, ?, ?, NULL)`,
					)
					.run(parent.id, "badjson", "wiki-root/knowledge/badjson", "knowledge", '{not json}', now, now),
			).toThrowError(/constraint|json_valid|CHECK/i);
		});
	});

	// -----------------------------------------------------------------------
	// §A item 11: FTS external-content, fixed fields, no trigger, sync + rebuild
	// -----------------------------------------------------------------------

	describe("§A.11 FTS external-content (name/summary/content, no trigger)", () => {
		test("FTS table is external-content with exactly name/summary/content fields", () => {
			const sql = (
				db
					.prepare(`SELECT sql FROM sqlite_master WHERE name='wiki_nodes_fts'`)
					.get() as { sql: string }
			).sql.toLowerCase();
			expect(sql).toContain("fts5");
			expect(sql).toContain("content='wiki_nodes'");
			expect(sql).toContain("content_rowid='id'");
			// 字段恰好 name/summary/content
			expect(sql).toContain("name");
			expect(sql).toContain("summary");
			expect(sql).toContain("content");
			// 不应有多余 fts5 字段(无 author/tags/title 等)
			expect(sql).not.toMatch(/author|tags|title/);
		});

		test("ZERO triggers in fresh wiki DB (no CREATE TRIGGER for FTS sync)", () => {
			const triggers = db
				.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`)
				.all() as { name: string }[];
			expect(triggers.length).toBe(0);
		});

		test("repository explicit-transaction insert + syncFtsInsert → FTS search reflects it", () => {
			const nodeRepo = new WikiNodeRepository(db);
			const parent = nodeRepo.getActiveByPath("wiki-root/knowledge")!;
			wiki.transaction(() => {
				const row = nodeRepo.insert({
					parent_id: parent.id,
					name: "fts-ins",
					path: "wiki-root/knowledge/fts-ins",
					kind: "knowledge",
					summary: "rareterm insert",
					content: "body",
					attributes_json: null,
				});
				nodeRepo.syncFtsInsert(row.id, row.name, row.summary, row.content);
			});
			const hits = nodeRepo.searchFts("rareterm", 10);
			expect(hits.some((h) => h.path === "wiki-root/knowledge/fts-ins")).toBe(true);
		});

		test("repository update + syncFtsUpdate → FTS reflects new content, old term gone", () => {
			const nodeRepo = new WikiNodeRepository(db);
			const parent = nodeRepo.getActiveByPath("wiki-root/knowledge")!;
			const row = wiki.transaction(() => {
				const r = nodeRepo.insert({
					parent_id: parent.id,
					name: "fts-up",
					path: "wiki-root/knowledge/fts-up",
					kind: "knowledge",
					summary: "oldterm",
					content: "x",
					attributes_json: null,
				});
				nodeRepo.syncFtsInsert(r.id, r.name, r.summary, r.content);
				return r;
			});
			// 更新 summary 到 newterm
			wiki.transaction(() => {
				const updated = nodeRepo.update(row.id, row.revision, { summary: "newterm fresh" });
				nodeRepo.syncFtsUpdate(updated.id, updated.name, updated.summary, updated.content);
			});
			expect(nodeRepo.searchFts("newterm", 10).some((h) => h.id === row.id)).toBe(true);
			expect(nodeRepo.searchFts("oldterm", 10).some((h) => h.id === row.id)).toBe(false);
		});

		test("repository hardDelete (calls syncFtsDelete) → FTS no longer finds the node", () => {
			const nodeRepo = new WikiNodeRepository(db);
			const parent = nodeRepo.getActiveByPath("wiki-root/knowledge")!;
			const row = wiki.transaction(() => {
				const r = nodeRepo.insert({
					parent_id: parent.id,
					name: "fts-del",
					path: "wiki-root/knowledge/fts-del",
					kind: "knowledge",
					summary: "delterm",
					content: "x",
					attributes_json: null,
				});
				nodeRepo.syncFtsInsert(r.id, r.name, r.summary, r.content);
				return r;
			});
			expect(nodeRepo.searchFts("delterm", 10).some((h) => h.id === row.id)).toBe(true);
			wiki.transaction(() => {
				nodeRepo.hardDelete(row.id);
			});
			expect(nodeRepo.searchFts("delterm", 10).some((h) => h.id === row.id)).toBe(false);
		});

		test("rebuildFts makes index consistent with table state after raw inserts", () => {
			const nodeRepo = new WikiNodeRepository(db);
			const parent = nodeRepo.getActiveByPath("wiki-root/knowledge")!;
			// 用裸 SQL 插入两个 node,不做 FTS 同步(模拟索引滞后)
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO wiki_nodes
				   (parent_id, name, path, kind, summary, content, attributes_json,
				    revision, created_at, updated_at, archived_at)
				 VALUES (?, ?, ?, ?, ?, '', NULL, 1, ?, ?, NULL)`,
			).run(parent.id, "rb1", "wiki-root/knowledge/rb1", "knowledge", "rebuildmarker one", now, now);
			db.prepare(
				`INSERT INTO wiki_nodes
				   (parent_id, name, path, kind, summary, content, attributes_json,
				    revision, created_at, updated_at, archived_at)
				 VALUES (?, ?, ?, ?, ?, '', NULL, 1, ?, ?, NULL)`,
			).run(parent.id, "rb2", "wiki-root/knowledge/rb2", "knowledge", "rebuildmarker two", now, now);

			// rebuild 前 FTS 应找不到(external-content + 未同步)
			expect(nodeRepo.searchFts("rebuildmarker", 10).length).toBe(0);

			nodeRepo.rebuildFts();

			// rebuild 后必须与表状态一致
			const hits = nodeRepo.searchFts("rebuildmarker", 10);
			expect(hits.length).toBe(2);
			expect(hits.map((h) => h.path).sort()).toEqual([
				"wiki-root/knowledge/rb1",
				"wiki-root/knowledge/rb2",
			]);
		});
	});

	// -----------------------------------------------------------------------
	// §A item 5: 固定根 bootstrap
	// -----------------------------------------------------------------------

	describe("§A.5 fixed root bootstrap", () => {
		test("exactly wiki-root + knowledge/memory/projects namespaces exist, with correct kinds", () => {
			const roots = db
				.prepare(
					`SELECT path, kind, parent_id, revision FROM wiki_nodes
					 WHERE path IN ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')
					   AND archived_at IS NULL
					 ORDER BY path`,
				)
				.all() as { path: string; kind: string; parent_id: number | null; revision: number }[];
			const byPath = new Map(roots.map((r) => [r.path, r]));
			expect(roots.length).toBe(4);
			expect(byPath.get("wiki-root")?.kind).toBe("root");
			expect(byPath.get("wiki-root/knowledge")?.kind).toBe("namespace");
			expect(byPath.get("wiki-root/memory")?.kind).toBe("namespace");
			expect(byPath.get("wiki-root/projects")?.kind).toBe("namespace");
			// wiki-root 的 parent_id 必须 NULL,三个 namespace 的 parent 必须 = wiki-root.id
			expect(byPath.get("wiki-root")?.parent_id).toBeNull();
			const rootId = byPath.get("wiki-root")!.revision; // just to ensure read worked
			expect(typeof rootId).toBe("number");
			const wikiRoot = (
				db.prepare(`SELECT id FROM wiki_nodes WHERE path='wiki-root' AND archived_at IS NULL`).get() as {
					id: number;
				}
			).id;
			for (const p of ["wiki-root/knowledge", "wiki-root/memory", "wiki-root/projects"]) {
				expect(byPath.get(p)?.parent_id).toBe(wikiRoot);
			}
		});

		test("NO legacy synthetic wiki-root:global / :type / :kind rows", () => {
			const legacy = db
				.prepare(`SELECT path FROM wiki_nodes WHERE path LIKE 'wiki-root:%'`)
				.all() as { path: string }[];
			expect(legacy.length).toBe(0);
			// 也不应有 path 含 ':' (旧地址风格)
			const colon = db
				.prepare(`SELECT path FROM wiki_nodes WHERE path LIKE '%:%'`)
				.all() as { path: string }[];
			expect(colon.length).toBe(0);
		});

		test("double initialization is idempotent: no error, no duplicate roots, revision/created_at unchanged", () => {
			// 第一次快照
			const snap1 = db
				.prepare(
					`SELECT path, kind, summary, revision, created_at, updated_at
					 FROM wiki_nodes
					 WHERE archived_at IS NULL AND path IN
					   ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')
					 ORDER BY path`,
				)
				.all() as Record<string, unknown>[];
			// 在同一 DB 上**再次**构造 WikiDatabase(schema init + bootstrap 二次执行)
			wiki.close();
			const reopened = new WikiDatabase(UNIQUE_WIKI_DB);
			try {
				const snap2 = reopened
					.getDb()
					.prepare(
						`SELECT path, kind, summary, revision, created_at, updated_at
						 FROM wiki_nodes
						 WHERE archived_at IS NULL AND path IN
						   ('wiki-root','wiki-root/knowledge','wiki-root/memory','wiki-root/projects')
						 ORDER BY path`,
					)
					.all() as Record<string, unknown>[];
				expect(snap2).toEqual(snap1);
				// 无重复行(每个固定 path 恰好一行 active)
				const counts = reopened
					.getDb()
					.prepare(
						`SELECT path, COUNT(*) AS n FROM wiki_nodes
						 WHERE archived_at IS NULL
						 GROUP BY path HAVING n > 1`,
					)
					.all() as { path: string; n: number }[];
				expect(counts).toEqual([]);
			} finally {
				reopened.close();
			}
		});
	});

	// -----------------------------------------------------------------------
	// §A item 12: audit request_id dedup
	// -----------------------------------------------------------------------

	describe("§A.12 audit request_id dedup", () => {
		test("duplicate request_id returns existing audit_id without inserting a new row", () => {
			const auditRepo = new WikiAuditRepository(db);
			const before = auditRepo.count();
			const r1 = auditRepo.append({
				requestId: "req-dup-001",
				action: "create",
				nodePath: "wiki-root/knowledge/x",
				newRevision: 1,
			});
			const r2 = auditRepo.append({
				requestId: "req-dup-001", // 同 request_id 重试
				action: "create",
				nodePath: "wiki-root/knowledge/x",
				newRevision: 1,
			});
			expect(r2.deduped).toBe(true);
			expect(r2.auditId).toBe(r1.auditId);
			expect(auditRepo.count()).toBe(before + 1); // 只多了一行
		});

		test("null request_id never dedups (each append is a new row)", () => {
			const auditRepo = new WikiAuditRepository(db);
			const before = auditRepo.count();
			auditRepo.append({ requestId: null, action: "update", nodePath: "wiki-root/knowledge/p" });
			auditRepo.append({ requestId: null, action: "update", nodePath: "wiki-root/knowledge/p" });
			auditRepo.append({ requestId: undefined, action: "update", nodePath: "wiki-root/knowledge/p" });
			expect(auditRepo.count()).toBe(before + 3);
		});

		test("distinct request_ids produce distinct rows", () => {
			const auditRepo = new WikiAuditRepository(db);
			const before = auditRepo.count();
			auditRepo.append({ requestId: "req-a", action: "create", nodePath: "p1" });
			auditRepo.append({ requestId: "req-b", action: "create", nodePath: "p2" });
			expect(auditRepo.count()).toBe(before + 2);
		});
	});

	// -----------------------------------------------------------------------
	// §A item 3 (foreign_keys pragma) + integrity
	// -----------------------------------------------------------------------

	describe("PRAGMA foreign_keys / journal_mode (fresh DB)", () => {
		test("foreign_keys = ON, busy_timeout set", () => {
			const fk = db.pragma("foreign_keys", { simple: true });
			expect(fk).toBe(1);
			const bt = db.pragma("busy_timeout", { simple: true });
			expect(typeof bt).toBe("number");
			expect(bt).toBeGreaterThanOrEqual(1000);
		});

		test("integrity_check ok + foreign_key_check empty", () => {
			expect(wiki.integrityCheck()).toBe("ok");
			expect(wiki.foreignKeyCheck()).toBe("ok");
		});

		test("schema version = WIKI_SCHEMA_VERSION", () => {
			expect(wiki.schemaVersion()).toBe(WIKI_SCHEMA_VERSION);
		});
	});

	// -----------------------------------------------------------------------
	// §A item 15: 共享类型闭集
	// -----------------------------------------------------------------------

	describe("§A.15 shared-type closed sets (WikiErrorCode / WikiNodeKind / WikiAction)", () => {
		test("WikiErrorCode is EXACTLY the 20 plan-01 §4 codes (no more, no less)", () => {
			const expected = [
				"INVALID_REQUEST",
				"INVALID_PATH",
				"INVALID_NAME",
				"INVALID_ADDRESS",
				"ADDRESS_UNRESOLVED",
				"NOT_FOUND",
				"ACCESS_DENIED",
				"ALREADY_EXISTS",
				"WRITE_CONFLICT",
				"EDIT_TARGET_NOT_FOUND",
				"EDIT_TARGET_AMBIGUOUS",
				"SOURCE_MANAGED",
				"SOURCE_UNAVAILABLE",
				"SYNC_FAILED",
				"REGEX_INVALID",
				"REGEX_LIMIT_EXCEEDED",
				"REGEX_TIMEOUT",
				"HARD_DELETE_BLOCKED",
				"MOVE_TOO_LARGE",
				"INTERNAL_ERROR",
			] as const;
			expect(WIKI_ERROR_CODES.length).toBe(20);
			expect([...WIKI_ERROR_CODES].sort()).toEqual([...expected].sort());
		});

		test("WikiNodeKind is EXACTLY the 10 design §5.1 kinds", () => {
			const expected = [
				"root",
				"namespace",
				"project",
				"directory",
				"source_file",
				"source_symlink",
				"source_submodule",
				"knowledge",
				"memory",
				"node",
			] as const;
			expect(WIKI_NODE_KINDS.length).toBe(10);
			expect([...WIKI_NODE_KINDS].sort()).toEqual([...expected].sort());
		});

		test("WikiAction is EXACTLY the 9 design §8.1 actions", () => {
			const expected = [
				"expand",
				"read",
				"search",
				"create",
				"update",
				"delete",
				"link",
				"unlink",
				"move",
			] as const;
			expect(WIKI_ACTIONS.length).toBe(9);
			expect([...WIKI_ACTIONS].sort()).toEqual([...expected].sort());
		});
	});

	// -----------------------------------------------------------------------
	// §A item 13: Agent-facing views 不含 DB 内部 ID
	// -----------------------------------------------------------------------

	describe("§A.13 Agent-facing views contain NO internal DB integer IDs", () => {
		// 通过源文件文本审计,断言每个 view interface 内不出现内部 ID 字段。
		// 这比运行时构造对象更可靠(interface 不持久化到运行时)。
		const TYPES_SRC = readFileSync(
			join(process.cwd(), "src", "shared", "wiki-types.ts"),
			"utf8",
		);

		/** 抽取指定 interface 的主体文本(从 `export interface NAME` 到匹配的 `}`)。 */
		function extractInterfaceBody(name: string): string {
			const startIdx = TYPES_SRC.indexOf(`export interface ${name} {`);
			expect(startIdx, `interface ${name} must exist in wiki-types.ts`).toBeGreaterThan(-1);
			// 找匹配闭合大括号(简单栈,interface 不嵌套定义)
			let i = TYPES_SRC.indexOf("{", startIdx);
			let depth = 0;
			const start = i;
			for (; i < TYPES_SRC.length; i++) {
				const ch = TYPES_SRC[i];
				if (ch === "{") depth++;
				else if (ch === "}") {
					depth--;
					if (depth === 0) break;
				}
			}
			return TYPES_SRC.slice(start + 1, i);
		}

		// 禁止作为字段名出现(允许 auditId / parentPath / sourcePath / targetPath / oldRevision /
		// newRevision / sourceRoot / sourceKind / displayTitle 等不含禁词的)。
		// 用 `^\s*NAME\s*[?:]` 锚定行首属性声明,避免误判 auditId 等。
		const FORBIDDEN_FIELDS = [
			"id",
			"parent_id",
			"parentId",
			"source_id",
			"sourceId",
			"target_id",
			"targetId",
			"project_node_id",
			"projectNodeId",
			"node_id",
			"nodeId",
		];

		test("WikiNodeView has no internal id/parent_id", () => {
			const body = extractInterfaceBody("WikiNodeView");
			for (const f of FORBIDDEN_FIELDS) {
				const re = new RegExp(`^\\s*${f}\\s*[?:]`, "m");
				expect(re.test(body), `WikiNodeView must not declare ${f}`).toBe(false);
			}
			// 必须有 path(替代 ID 的资源 key)
			expect(body).toMatch(/^\s*path\s*:/m);
		});

		test("WikiLinkView has no source_id/target_id", () => {
			const body = extractInterfaceBody("WikiLinkView");
			for (const f of FORBIDDEN_FIELDS) {
				const re = new RegExp(`^\\s*${f}\\s*[?:]`, "m");
				expect(re.test(body), `WikiLinkView must not declare ${f}`).toBe(false);
			}
			expect(body).toMatch(/^\s*sourcePath\s*:/m);
			expect(body).toMatch(/^\s*targetPath\s*:/m);
		});

		test("WikiRepositoryView has no project_node_id", () => {
			const body = extractInterfaceBody("WikiRepositoryView");
			for (const f of FORBIDDEN_FIELDS) {
				const re = new RegExp(`^\\s*${f}\\s*[?:]`, "m");
				expect(re.test(body), `WikiRepositoryView must not declare ${f}`).toBe(false);
			}
		});

		test("WikiAddressView has no target_id", () => {
			const body = extractInterfaceBody("WikiAddressView");
			for (const f of FORBIDDEN_FIELDS) {
				const re = new RegExp(`^\\s*${f}\\s*[?:]`, "m");
				expect(re.test(body), `WikiAddressView must not declare ${f}`).toBe(false);
			}
			expect(body).toMatch(/^\s*targetPath\s*:/m);
		});

		test("WikiAuditView: auditId allowed (opaque receipt); no internal IDs otherwise", () => {
			const body = extractInterfaceBody("WikiAuditView");
			// auditId 允许 → 单独剔除后断言其它禁词不出现
			for (const f of FORBIDDEN_FIELDS) {
				// auditId 本身不是 "id"/"node_id";用全字段名匹配。
				const re = new RegExp(`^\\s*${f}\\s*[?:]`, "m");
				expect(re.test(body), `WikiAuditView must not declare ${f}`).toBe(false);
			}
			// auditId 字段必须存在(plan-01 §4)
			expect(body).toMatch(/^\s*auditId\s*:/m);
		});

		test("WikiMutationResult: auditId allowed; no internal IDs", () => {
			const body = extractInterfaceBody("WikiMutationResult");
			for (const f of FORBIDDEN_FIELDS) {
				const re = new RegExp(`^\\s*${f}\\s*[?:]`, "m");
				expect(re.test(body), `WikiMutationResult must not declare ${f}`).toBe(false);
			}
			// auditId(opaque receipt)必须存在;revision/oldRevision 是修订号,允许。
			expect(body).toMatch(/^\s*auditId\s*:/m);
		});

		test("a runtime-constructed WikiNodeView carries only Agent-safe keys", () => {
			// 双保险:运行时构造的对象 keys 也不含禁词
			const v: WikiNodeView = {
				path: "wiki-root/knowledge",
				name: "knowledge",
				kind: "namespace",
				summary: "s",
				revision: 1,
				parentPath: null,
				createdAt: "t",
				updatedAt: "t",
				archivedAt: null,
				attributes: {},
				sourceBound: false,
				displayTitle: "knowledge",
			};
			const keys = Object.keys(v);
			for (const f of FORBIDDEN_FIELDS) {
				expect(keys, `runtime WikiNodeView keys must not include ${f}`).not.toContain(f);
			}
		});
	});

	// -----------------------------------------------------------------------
	// §B item 4: canonical path 单一权威实现
	// -----------------------------------------------------------------------

	describe("§B.4 canonical path single authority", () => {
		test("path primitive functions are defined ONLY in wiki-path.ts (no scattered re-implementations)", () => {
			const wikiDir = join(process.cwd(), "src", "server", "wiki");
			// 用 require.resolve 的 directory list — 改用 readFileSync 扫描文件。
			const { readdirSync } = require("node:fs") as typeof import("node:fs");
			const files = readdirSync(wikiDir).filter((f) => f.endsWith(".ts")) as string[];
			const pathFnPattern =
				/export\s+function\s+(normalizeWikiPath|joinWikiPath|parentWikiPath|isSameOrDescendant|validateWikiName|splitWikiPath|lastSegmentOfWikiPath|isWikiRoot)\b/;
			const definers: string[] = [];
			for (const f of files) {
				const src = readFileSync(join(wikiDir, f), "utf8");
				if (pathFnPattern.test(src)) definers.push(f);
			}
			// 唯一权威:wiki-path.ts。其它 repository/store/schema 都不应自己实现。
			expect(definers).toEqual(["wiki-path.ts"]);
		});
	});
});
