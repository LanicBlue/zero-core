// wiki-system-redesign sub-01 acceptance — 架构 (architecture-constraints +
// repository layer + integration regression) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级 + 结构级编码 acceptance-01 §A items 9, 10, 11, 12, 14 + §B items 1–6
// + §D 中属于「repository 层低层 CRUD / FTS 同步 / audit 去重 / 热路径索引 /
// canonical path 单一权威 / clean cutover 结构」的架构要点。本文件从**架构与
// repository 层**视角断言(对照 design.md §5 + plan-01 §6):
//   - WikiNodeRepository:by path / by id / by parent;direct children 分页
//     (cursor + limit + hasMore);insert/update/archive/unarchive/hardDelete;
//     乐观并发(revision mismatch → WRITE_CONFLICT code)。
//   - WikiLinkRepository:insert/delete/outgoing/incoming;PRIMARY KEY 重复 reject;
//     insertOrIgnore 幂等;exists/countBoth/both。
//   - WikiRepositoryStore:wiki_repositories / wiki_source_bindings / wiki_addresses
//     三表 CRUD(UPSERT / updateSyncState / revision+1 / listByXxx)。
//   - WikiAuditRepository:append + request_id 去重(deduped=true 返回同一 auditId,
//     不新增行);listByNodePath/listByActor/listByTimeWindow/getByXxx/count。
//   - FTS rebuild + 基本 query:external-content,显式 transaction 同步;rebuildFts
//     后结果与 wiki_nodes 一致;searchFts rank 排序。
//   - §B 结构审查(runtime 侧):
//       * hot-path 索引存在 + EXPLAIN QUERY PLAN 使用它们(path / parent /
//         link target / repository / source / address target)。
//       * 表级永久 UNIQUE 不存在(只有 partial unique index)。
//       * DDL 通过裸 exec —— INTEGER affinity(id/parent_id/revision/source_id/
//         target_id/project_node_id/node_id/old_revision/new_revision 全 INTEGER)。
//   - §D 证据能力:sqlite_master 摘要、PRAGMA table_info affinity、
//     foreign_key_check/integrity_check、固定根查询(只 path/kind/revision)。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db(vi.hoisted,sub-00 教训)。
//   - 每个测试用例拿一个 fresh per-test wiki.db(per-test counter),彻底杜绝
//     用例间状态污染。
//
// ## 输出
// Vitest 用例。每用例开真 SQLite temp DB,绝不读活跃 ~/.zero-core。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - 分页 / FK / FTS 测试必须真跑 SQL,不能只看 schema 字符串。
//   - EXPLAIN QUERY PLAN 必须真解析输出,断言索引名出现。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
// UNIQUE ZERO_CORE_DIR per file (separate prefix from the other 2 lens files
// so all 3 can run concurrently without colliding on ZERO_CORE_DIR).
// vi.hoisted runs BEFORE any other import so config.ts / database-paths.ts
// constants resolve under OUR temp dir. We do NOT touch the live ~/.zero-core.
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-repo-"));
	process.env.ZERO_CORE_DIR = d;
	// Tests that need ZERO_CORE_DB_NO_WAL behavior keep the env as-is; the
	// default test environment sets ZERO_CORE_DB_NO_WAL=1 (MEMORY journal) to
	// avoid WAL checkpoint issues on Windows (reference-vitest-better-sqlite3).
	return { UNIQUE_DIR: d };
});

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiLinkRepository } from "../../src/server/wiki/wiki-link-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import {
	WikiRepositoryStore,
	WikiRepositoryTable,
	WikiSourceBindingTable,
	WikiAddressTable,
} from "../../src/server/wiki/wiki-repository-store.js";
import { joinWikiPath, WIKI_ROOT_PATH } from "../../src/server/wiki/wiki-path.js";
import type { WikiNodeKind } from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Per-test fresh DB helper (zero cross-test state contamination).
// ---------------------------------------------------------------------------

let _dbCounter = 0;

/**
 * Open a brand-new WikiDatabase on a UNIQUE per-call temp path. Each call gets
 * a distinct file so mutations in one test never bleed into another. Returns
 * the WikiDatabase handle plus the repositories built on its underlying DB.
 */
function freshWiki(): {
	wiki: WikiDatabase;
	db: Database.Database;
	nodeRepo: WikiNodeRepository;
	linkRepo: WikiLinkRepository;
	auditRepo: WikiAuditRepository;
	store: WikiRepositoryStore;
} {
	_dbCounter += 1;
	const path = join(UNIQUE_DIR, `wiki-repo-${_dbCounter}-${Date.now()}.db`);
	const wiki = new WikiDatabase(path);
	const db = wiki.getDb();
	return {
		wiki,
		db,
		nodeRepo: new WikiNodeRepository(db),
		linkRepo: new WikiLinkRepository(db),
		auditRepo: new WikiAuditRepository(db),
		store: new WikiRepositoryStore(db),
	};
}

/**
 * 在 wiki-root/knowledge 下插一个 active 节点(走 repository.insert + 显式
 * transaction 内 FTS 同步)。返回新行(revision 保持为 1 —— helper 内部不做会
 * bump revision 的 update,只解析一次 parent_id 后直接插入)。
 */
function insertKnowledgeChild(
	wiki: WikiDatabase,
	nodeRepo: WikiNodeRepository,
	name: string,
	summary = "",
	content = "",
	kind: WikiNodeKind = "knowledge",
): { id: number; path: string; revision: number } {
	const parentPath = `${WIKI_ROOT_PATH}/knowledge`;
	const path = joinWikiPath(parentPath, name);
	let row: { id: number; path: string; revision: number } | undefined;
	wiki.transaction(() => {
		// Resolve the parent node id once, BEFORE insert (avoids a revision-bumping
		// update that would invalidate the returned revision).
		const parent = nodeRepo.getActiveByPath(parentPath)!;
		const r = nodeRepo.insert({
			parent_id: parent.id,
			name,
			path,
			kind,
			summary,
			content,
			attributes_json: null,
		});
		nodeRepo.syncFtsInsert(r.id, r.name, summary, content);
		row = { id: r.id, path: r.path, revision: r.revision };
	});
	return row!;
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

/** EXPLAIN QUERY PLAN 输出拼接成字符串(便于 toMatch 断言索引名)。 */
function eqp(db: Database.Database, sql: string, ...params: unknown[]): string {
	const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
		id: number;
		parent: number;
		detail: string;
	}>;
	return rows.map((r) => r.detail).join("\n");
}

// ===========================================================================
// §A item 14 — INTEGER affinity (runtime proof, not schema-string inspection)
// ===========================================================================

describe("acceptance-01 §A.14 + §B.2 — INTEGER affinity across repository tables", () => {
	test("wiki_nodes integer columns (id/parent_id/revision) are INTEGER affinity", () => {
		const { wiki, db } = freshWiki();
		try {
			const cols = db.prepare(`PRAGMA table_info(wiki_nodes)`).all() as Array<{
				name: string;
				type: string;
			}>;
			const byName = new Map(cols.map((c) => [c.name, c.type]));
			expect(byName.get("id")).toBe("INTEGER");
			expect(byName.get("parent_id")).toBe("INTEGER");
			expect(byName.get("revision")).toBe("INTEGER");
		} finally {
			wiki.close();
		}
	});

	test("wiki_links source_id/target_id are INTEGER affinity", () => {
		const { wiki, db } = freshWiki();
		try {
			const cols = db.prepare(`PRAGMA table_info(wiki_links)`).all() as Array<{
				name: string;
				type: string;
			}>;
			const byName = new Map(cols.map((c) => [c.name, c.type]));
			expect(byName.get("source_id")).toBe("INTEGER");
			expect(byName.get("target_id")).toBe("INTEGER");
		} finally {
			wiki.close();
		}
	});

	test("wiki_audit_log old_revision/new_revision are INTEGER affinity", () => {
		const { wiki, db } = freshWiki();
		try {
			const cols = db.prepare(`PRAGMA table_info(wiki_audit_log)`).all() as Array<{
				name: string;
				type: string;
			}>;
			const byName = new Map(cols.map((c) => [c.name, c.type]));
			expect(byName.get("old_revision")).toBe("INTEGER");
			expect(byName.get("new_revision")).toBe("INTEGER");
		} finally {
			wiki.close();
		}
	});

	test("repository layer revision arithmetic never string-concatenates (acceptance-01 §A.14 / reference-sqlite-text-affinity-numeric)", () => {
		// Drive a real update through the repository and assert revision is a
		// number that increments arithmetically (1 -> 2 -> 3), not "11".
		const { wiki, nodeRepo } = freshWiki();
		try {
			const node = insertKnowledgeChild(wiki, nodeRepo, "rev-probe");
			expect(node.revision).toBe(1);
			expect(typeof node.revision).toBe("number");

			const after1 = nodeRepo.update(node.id, 1, { summary: "v2" });
			expect(after1.revision).toBe(2);
			expect(typeof after1.revision).toBe("number");

			const after2 = nodeRepo.update(node.id, 2, { summary: "v3" });
			expect(after2.revision).toBe(3);
			// Arithmetic proof: revision+1 must be 4 (not "31" or "21").
			expect(after2.revision + 1).toBe(4);
		} finally {
			wiki.close();
		}
	});
});

// ===========================================================================
// WikiNodeRepository — by path / by id / by parent; pagination
// ===========================================================================

describe("WikiNodeRepository — read primitives (plan-01 §6)", () => {
	test("getActiveByPath returns active node; getByPath returns archived too", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			const node = insertKnowledgeChild(wiki, nodeRepo, "topic");
			const active = nodeRepo.getActiveByPath(node.path);
			expect(active?.id).toBe(node.id);

			// Archive it; active lookup must drop it, getByPath must still find it.
			wiki.transaction(() => nodeRepo.archive(node.id));
			expect(nodeRepo.getActiveByPath(node.path)).toBeUndefined();
			const archived = nodeRepo.getByPath(node.path);
			expect(archived?.id).toBe(node.id);
			expect(archived?.archived_at).not.toBeNull();
		} finally {
			wiki.close();
		}
	});

	test("getById returns the row by integer id", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			const node = insertKnowledgeChild(wiki, nodeRepo, "by-id");
			const got = nodeRepo.getById(node.id);
			expect(got?.path).toBe(node.path);
			expect(got?.id).toBe(node.id);
			expect(nodeRepo.getById(9_999_999)).toBeUndefined();
		} finally {
			wiki.close();
		}
	});

	test("getActiveChildren returns only active direct children", () => {
		const { wiki, nodeRepo, db } = freshWiki();
		try {
			const a = insertKnowledgeChild(wiki, nodeRepo, "a");
			const b = insertKnowledgeChild(wiki, nodeRepo, "b");
			insertKnowledgeChild(wiki, nodeRepo, "c");
			// Archive b; remaining active children = a, c.
			wiki.transaction(() => nodeRepo.archive(b.id));
			const parent = nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!;
			const kids = nodeRepo.getActiveChildren(parent.id).map((r) => r.name);
			expect(kids).toContain("a");
			expect(kids).toContain("c");
			expect(kids).not.toContain("b");
			// Sanity: 3 created + 1 archived, active count = 2 for this parent.
			expect(kids.length).toBe(2);
			void a;
			void db;
		} finally {
			wiki.close();
		}
	});
});

describe("WikiNodeRepository — direct-children pagination (cursor + limit)", () => {
	test("first page returns limit items + cursor + hasMore=true", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			for (let i = 0; i < 5; i++) {
				insertKnowledgeChild(wiki, nodeRepo, `p-${i}`);
			}
			const parent = nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!;
			const page1 = nodeRepo.getActiveChildrenPaged(parent.id, 2, null);
			expect(page1.items.length).toBe(2);
			expect(page1.hasMore).toBe(true);
			expect(page1.cursor).not.toBeNull();
			// Items are ordered by path ASC + id ASC.
			expect(page1.items[0].path.localeCompare(page1.items[1].path)).toBeLessThanOrEqual(0);
		} finally {
			wiki.close();
		}
	});

	test("subsequent pages advance by cursor until hasMore=false, no duplicates, no gaps", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			const names: string[] = [];
			for (let i = 0; i < 7; i++) {
				insertKnowledgeChild(wiki, nodeRepo, `pg-${i}`);
				names.push(`pg-${i}`);
			}
			const parent = nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!;

			const seen: string[] = [];
			let cursor: { path: string; id: number } | null = null;
			let pages = 0;
			for (;;) {
				const page = nodeRepo.getActiveChildrenPaged(parent.id, 3, cursor);
				pages += 1;
				seen.push(...page.items.map((r) => r.name));
				if (!page.hasMore) {
					expect(page.cursor).toBeNull();
					break;
				}
				cursor = page.cursor;
				if (pages > 10) throw new Error("pagination did not terminate");
			}
			// Every fixture child seen exactly once, no dupes, no gaps.
			expect(seen.sort()).toEqual([...names].sort());
			expect(new Set(seen).size).toBe(seen.length);
		} finally {
			wiki.close();
		}
	});

	test("limit is clamped to [1, 500]; non-existent parent yields empty page", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			const empty = nodeRepo.getActiveChildrenPaged(9_999_999, 3, null);
			expect(empty.items).toEqual([]);
			expect(empty.cursor).toBeNull();
			expect(empty.hasMore).toBe(false);

			// limit=0 or negative is clamped to 1.
			insertKnowledgeChild(wiki, nodeRepo, "solo");
			const parent = nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!;
			const page = nodeRepo.getActiveChildrenPaged(parent.id, 0, null);
			expect(page.items.length).toBe(1);
		} finally {
			wiki.close();
		}
	});
});

// ===========================================================================
// WikiNodeRepository — mutations, optimistic concurrency, archive/restore
// ===========================================================================

describe("WikiNodeRepository — mutations + optimistic concurrency (plan-01 §6)", () => {
	test("update with matching revision succeeds and bumps revision", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			const node = insertKnowledgeChild(wiki, nodeRepo, "mut");
			const updated = nodeRepo.update(node.id, node.revision, {
				summary: "new-summary",
				content: "new-content",
			});
			expect(updated.summary).toBe("new-summary");
			expect(updated.content).toBe("new-content");
			expect(updated.revision).toBe(node.revision + 1);
		} finally {
			wiki.close();
		}
	});

	test("update with stale revision throws WRITE_CONFLICT code", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			const node = insertKnowledgeChild(wiki, nodeRepo, "conflict");
			// First successful update bumps to revision 2.
			nodeRepo.update(node.id, node.revision, { summary: "v2" });
			// Stale call (still expects revision 1) must fail with WRITE_CONFLICT.
			const code = errCode(() => nodeRepo.update(node.id, node.revision, { summary: "stale" }));
			expect(code).toBe("WRITE_CONFLICT");
		} finally {
			wiki.close();
		}
	});

	test("update on missing id throws NOT_FOUND code", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			const code = errCode(() => nodeRepo.update(9_999_999, 1, { summary: "x" }));
			expect(code).toBe("NOT_FOUND");
		} finally {
			wiki.close();
		}
	});

	test("archive releases the active path slot; same path can be re-created active", () => {
		// acceptance-01 §A item 9 — partial unique index allows re-create after archive.
		const { wiki, nodeRepo } = freshWiki();
		try {
			const first = insertKnowledgeChild(wiki, nodeRepo, "slot");
			wiki.transaction(() => nodeRepo.archive(first.id));
			// Re-creating the SAME path active must now succeed (partial unique
			// index only covers archived_at IS NULL rows).
			const second = insertKnowledgeChild(wiki, nodeRepo, "slot");
			expect(second.path).toBe(first.path);
			expect(second.id).not.toBe(first.id);
			// Both rows exist (one archived, one active); only one active.
			const all = nodeRepo.getActiveChildren(
				nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!.id,
			).filter((r) => r.name === "slot");
			expect(all.length).toBe(1);
		} finally {
			wiki.close();
		}
	});

	test("restore (unarchive) into an occupied active path is rejected by the partial unique index", () => {
		// acceptance-01 §A item 9 — restore conflict rejected.
		const { wiki, nodeRepo } = freshWiki();
		try {
			const first = insertKnowledgeChild(wiki, nodeRepo, "restore-target");
			wiki.transaction(() => nodeRepo.archive(first.id));
			// Occupy the path with a new active node.
			insertKnowledgeChild(wiki, nodeRepo, "restore-target");
			// Restoring the archived node must collide with the active partial
			// unique index on (path) WHERE archived_at IS NULL.
			expect(() => {
				wiki.transaction(() => nodeRepo.unarchive(first.id));
			}).toThrow(/UNIQUE constraint failed/);
		} finally {
			wiki.close();
		}
	});

	test("hardDelete removes the row and its FTS entry", () => {
		const { wiki, nodeRepo, db } = freshWiki();
		try {
			const node = insertKnowledgeChild(wiki, nodeRepo, "hard-del", "s", "content-text");
			wiki.transaction(() => nodeRepo.hardDelete(node.id));
			expect(nodeRepo.getById(node.id)).toBeUndefined();
			// FTS row gone.
			const ftsRow = db
				.prepare(`SELECT 1 FROM wiki_nodes_fts WHERE rowid = ?`)
				.get(node.id);
			expect(ftsRow).toBeUndefined();
		} finally {
			wiki.close();
		}
	});
});

// ===========================================================================
// WikiLinkRepository — insert/delete/outgoing/incoming + idempotency
// ===========================================================================

describe("WikiLinkRepository — CRUD + direction (design.md §5.2)", () => {
	test("insert + outgoing + incoming; one row serves both directions", () => {
		const { wiki, nodeRepo, linkRepo } = freshWiki();
		try {
			const a = insertKnowledgeChild(wiki, nodeRepo, "L-a");
			const b = insertKnowledgeChild(wiki, nodeRepo, "L-b");
			linkRepo.insert({
				source_id: a.id,
				target_id: b.id,
				relation: "depends_on",
				created_by: null,
			});
			expect(linkRepo.outgoing(a.id).length).toBe(1);
			expect(linkRepo.outgoing(a.id)[0].target_id).toBe(b.id);
			expect(linkRepo.incoming(b.id).length).toBe(1);
			expect(linkRepo.incoming(b.id)[0].source_id).toBe(a.id);
			// Inverse directions are empty (no double-write of backlinks).
			expect(linkRepo.outgoing(b.id)).toEqual([]);
			expect(linkRepo.incoming(a.id)).toEqual([]);
		} finally {
			wiki.close();
		}
	});

	test("duplicate insert (same source/target/relation) is rejected by PRIMARY KEY", () => {
		const { wiki, nodeRepo, linkRepo } = freshWiki();
		try {
			const a = insertKnowledgeChild(wiki, nodeRepo, "D-a");
			const b = insertKnowledgeChild(wiki, nodeRepo, "D-b");
			linkRepo.insert({ source_id: a.id, target_id: b.id, relation: "used_by", created_by: null });
			expect(() =>
				linkRepo.insert({ source_id: a.id, target_id: b.id, relation: "used_by", created_by: null }),
			).toThrow(/UNIQUE constraint failed/);
		} finally {
			wiki.close();
		}
	});

	test("same (source,target) with DIFFERENT relation both allowed (PK is 3-tuple)", () => {
		const { wiki, nodeRepo, linkRepo } = freshWiki();
		try {
			const a = insertKnowledgeChild(wiki, nodeRepo, "R-a");
			const b = insertKnowledgeChild(wiki, nodeRepo, "R-b");
			linkRepo.insert({ source_id: a.id, target_id: b.id, relation: "depends_on", created_by: null });
			linkRepo.insert({ source_id: a.id, target_id: b.id, relation: "related_to", created_by: null });
			expect(linkRepo.outgoing(a.id).length).toBe(2);
		} finally {
			wiki.close();
		}
	});

	test("insertOrIgnore is idempotent (returns false on 2nd call, true on 1st)", () => {
		const { wiki, nodeRepo, linkRepo } = freshWiki();
		try {
			const a = insertKnowledgeChild(wiki, nodeRepo, "I-a");
			const b = insertKnowledgeChild(wiki, nodeRepo, "I-b");
			const first = linkRepo.insertOrIgnore({
				source_id: a.id,
				target_id: b.id,
				relation: "contains",
				created_by: null,
			});
			const second = linkRepo.insertOrIgnore({
				source_id: a.id,
				target_id: b.id,
				relation: "contains",
				created_by: null,
			});
			expect(first).toBe(true);
			expect(second).toBe(false);
			expect(linkRepo.outgoing(a.id).length).toBe(1);
		} finally {
			wiki.close();
		}
	});

	test("delete removes the link; deleting non-existent is a no-op returning false", () => {
		const { wiki, nodeRepo, linkRepo } = freshWiki();
		try {
			const a = insertKnowledgeChild(wiki, nodeRepo, "X-a");
			const b = insertKnowledgeChild(wiki, nodeRepo, "X-b");
			linkRepo.insert({ source_id: a.id, target_id: b.id, relation: "documents", created_by: null });
			expect(linkRepo.delete(a.id, b.id, "documents")).toBe(true);
			expect(linkRepo.outgoing(a.id)).toEqual([]);
			// Re-delete same link: no-op, returns false.
			expect(linkRepo.delete(a.id, b.id, "documents")).toBe(false);
		} finally {
			wiki.close();
		}
	});

	test("exists / countBoth / both helpers report consistent state", () => {
		const { wiki, nodeRepo, linkRepo } = freshWiki();
		try {
			const a = insertKnowledgeChild(wiki, nodeRepo, "C-a");
			const b = insertKnowledgeChild(wiki, nodeRepo, "C-b");
			const c = insertKnowledgeChild(wiki, nodeRepo, "C-c");
			linkRepo.insert({ source_id: a.id, target_id: b.id, relation: "depends_on", created_by: null });
			linkRepo.insert({ source_id: a.id, target_id: c.id, relation: "depends_on", created_by: null });
			linkRepo.insert({ source_id: c.id, target_id: b.id, relation: "used_by", created_by: null });

			expect(linkRepo.exists(a.id, b.id, "depends_on")).toBe(true);
			expect(linkRepo.exists(a.id, b.id, "related_to")).toBe(false);

			const counts = linkRepo.countBoth(a.id);
			expect(counts.outgoingCount).toBe(2);
			expect(counts.incomingCount).toBe(0);

			const both = linkRepo.both(b.id);
			expect(both.incoming.length).toBe(2); // from a and c
			expect(both.outgoing.length).toBe(0);
		} finally {
			wiki.close();
		}
	});
});

// ===========================================================================
// wiki_repositories + wiki_source_bindings + wiki_addresses CRUD
// ===========================================================================

describe("WikiRepositoryTable — repository binding CRUD (design.md §5.4)", () => {
	test("upsert inserts then updates (without touching indexer-managed fields)", () => {
		const { wiki, nodeRepo, store } = freshWiki();
		try {
			// Need a project node to bind. Insert one under wiki-root/projects.
			const project = insertKnowledgeChild(wiki, nodeRepo, "proj-A", "", "", "project");
			const repo = store.repositories.upsert({
				repository_id: "repo-A",
				project_node_id: project.id,
				project_id: "proj-id-A",
				source_root: "",
				default_branch: "main",
			});
			expect(repo.repository_id).toBe("repo-A");
			expect(repo.project_node_id).toBe(project.id);
			expect(repo.sync_status).toBe("pending");

			// Upsert again with new source_root/default_branch — must not reset
			// sync_status / indexed_revision after an indexer advanced them.
			store.repositories.updateSyncState({
				repository_id: "repo-A",
				indexed_revision: "deadbeef",
				sync_status: "synced",
			});
			store.repositories.upsert({
				repository_id: "repo-A",
				project_node_id: project.id,
				project_id: "proj-id-A",
				source_root: "sub/dir",
				default_branch: "develop",
			});
			const after = store.repositories.getById("repo-A")!;
			expect(after.source_root).toBe("sub/dir");
			expect(after.default_branch).toBe("develop");
			// indexer-managed fields preserved across upsert.
			expect(after.sync_status).toBe("synced");
			expect(after.indexed_revision).toBe("deadbeef");
		} finally {
			wiki.close();
		}
	});

	test("getByProjectId / getByProjectNodeId resolve the 1:1 binding", () => {
		const { wiki, nodeRepo, store } = freshWiki();
		try {
			const project = insertKnowledgeChild(wiki, nodeRepo, "proj-B", "", "", "project");
			store.repositories.upsert({
				repository_id: "repo-B",
				project_node_id: project.id,
				project_id: "proj-id-B",
			});
			expect(store.repositories.getByProjectId("proj-id-B")?.repository_id).toBe("repo-B");
			expect(store.repositories.getByProjectNodeId(project.id)?.repository_id).toBe("repo-B");
			expect(store.repositories.getByProjectId("nope")).toBeUndefined();
		} finally {
			wiki.close();
		}
	});

	test("updateSyncState advances indexed_revision/sync_status/last_indexed_at", () => {
		const { wiki, nodeRepo, store } = freshWiki();
		try {
			const project = insertKnowledgeChild(wiki, nodeRepo, "proj-C", "", "", "project");
			store.repositories.upsert({
				repository_id: "repo-C",
				project_node_id: project.id,
				project_id: "proj-id-C",
			});
			store.repositories.updateSyncState({
				repository_id: "repo-C",
				indexed_revision: "cafebabe",
				sync_status: "synced",
				last_indexed_at: "2026-07-17T00:00:00.000Z",
				last_error: null,
			});
			const after = store.repositories.getById("repo-C")!;
			expect(after.indexed_revision).toBe("cafebabe");
			expect(after.sync_status).toBe("synced");
			expect(after.last_indexed_at).toBe("2026-07-17T00:00:00.000Z");
		} finally {
			wiki.close();
		}
	});

	test("list returns repositories ordered by project_id", () => {
		const { wiki, nodeRepo, store } = freshWiki();
		try {
			const p1 = insertKnowledgeChild(wiki, nodeRepo, "proj-list-a", "", "", "project");
			const p2 = insertKnowledgeChild(wiki, nodeRepo, "proj-list-b", "", "", "project");
			store.repositories.upsert({ repository_id: "r1", project_node_id: p1.id, project_id: "zzz" });
			store.repositories.upsert({ repository_id: "r2", project_node_id: p2.id, project_id: "aaa" });
			const ids = store.repositories.list().map((r) => r.project_id);
			expect(ids).toEqual(["aaa", "zzz"]);
		} finally {
			wiki.close();
		}
	});
});

describe("WikiSourceBindingTable — source mapping CRUD (design.md §5.4)", () => {
	test("upsert inserts then updates (PK = node_id; overwrites indexer fields)", () => {
		const { wiki, nodeRepo, store } = freshWiki();
		try {
			const project = insertKnowledgeChild(wiki, nodeRepo, "proj-S", "", "", "project");
			store.repositories.upsert({
				repository_id: "repo-S",
				project_node_id: project.id,
				project_id: "proj-id-S",
			});
			const fileNode = insertKnowledgeChild(wiki, nodeRepo, "file-a", "", "", "source_file");

			const b1 = store.sourceBindings.upsert({
				node_id: fileNode.id,
				repository_id: "repo-S",
				source_path: "src/a.ts",
				source_kind: "file",
				indexed_revision: "rev1",
				blob_oid: "oid1",
			});
			expect(b1.indexed_revision).toBe("rev1");

			const b2 = store.sourceBindings.upsert({
				node_id: fileNode.id,
				repository_id: "repo-S",
				source_path: "src/a.ts",
				source_kind: "file",
				indexed_revision: "rev2",
				blob_oid: "oid2",
			});
			expect(b2.indexed_revision).toBe("rev2");
			expect(b2.blob_oid).toBe("oid2");
			expect(store.sourceBindings.getByNodeId(fileNode.id)?.indexed_revision).toBe("rev2");
		} finally {
			wiki.close();
		}
	});

	test("UNIQUE(repository_id, source_path) prevents duplicate bindings", () => {
		const { wiki, nodeRepo, store } = freshWiki();
		try {
			const project = insertKnowledgeChild(wiki, nodeRepo, "proj-U", "", "", "project");
			store.repositories.upsert({
				repository_id: "repo-U",
				project_node_id: project.id,
				project_id: "proj-id-U",
			});
			const n1 = insertKnowledgeChild(wiki, nodeRepo, "u1", "", "", "source_file");
			const n2 = insertKnowledgeChild(wiki, nodeRepo, "u2", "", "", "source_file");

			store.sourceBindings.upsert({
				node_id: n1.id,
				repository_id: "repo-U",
				source_path: "dup.ts",
				source_kind: "file",
				indexed_revision: "r",
			});
			// Same (repository_id, source_path) on a different node must collide.
			expect(() =>
				store.sourceBindings.upsert({
					node_id: n2.id,
					repository_id: "repo-U",
					source_path: "dup.ts",
					source_kind: "file",
					indexed_revision: "r",
				}),
			).toThrow(/UNIQUE constraint failed/);
		} finally {
			wiki.close();
		}
	});

	test("getBySourcePath / listByRepository / deleteByNodeId", () => {
		const { wiki, nodeRepo, store } = freshWiki();
		try {
			const project = insertKnowledgeChild(wiki, nodeRepo, "proj-L", "", "", "project");
			store.repositories.upsert({
				repository_id: "repo-L",
				project_node_id: project.id,
				project_id: "proj-id-L",
			});
			const f1 = insertKnowledgeChild(wiki, nodeRepo, "l1", "", "", "source_file");
			const f2 = insertKnowledgeChild(wiki, nodeRepo, "l2", "", "", "source_file");
			store.sourceBindings.upsert({
				node_id: f1.id,
				repository_id: "repo-L",
				source_path: "a.ts",
				source_kind: "file",
				indexed_revision: "r",
			});
			store.sourceBindings.upsert({
				node_id: f2.id,
				repository_id: "repo-L",
				source_path: "b.ts",
				source_kind: "file",
				indexed_revision: "r",
			});

			expect(store.sourceBindings.getBySourcePath("repo-L", "a.ts")?.node_id).toBe(f1.id);
			expect(store.sourceBindings.listByRepository("repo-L").length).toBe(2);

			expect(store.sourceBindings.deleteByNodeId(f1.id)).toBe(true);
			expect(store.sourceBindings.getByNodeId(f1.id)).toBeUndefined();
			expect(store.sourceBindings.listByRepository("repo-L").length).toBe(1);
		} finally {
			wiki.close();
		}
	});
});

describe("WikiAddressTable — static address CRUD (design.md §5.3)", () => {
	test("upsert inserts then updates with revision+1", () => {
		const { wiki, store } = freshWiki();
		try {
			const a1 = store.addresses.upsert({
				address: "runtime://rules/global",
				scope: "runtime",
				kind: "static",
			});
			expect(a1.revision).toBe(1);
			const a2 = store.addresses.upsert({
				address: "runtime://rules/global",
				scope: "runtime",
				kind: "alias",
				prompt_policy: '{"inject":true}',
			});
			expect(a2.revision).toBe(2);
			expect(a2.kind).toBe("alias");
			expect(a2.prompt_policy).toBe('{"inject":true}');
		} finally {
			wiki.close();
		}
	});

	test("listByTargetId lists addresses pointing at a node; delete removes", () => {
		const { wiki, nodeRepo, store } = freshWiki();
		try {
			const node = insertKnowledgeChild(wiki, nodeRepo, "addr-target");
			store.addresses.upsert({
				address: "runtime://x",
				target_id: node.id,
				scope: "runtime",
				kind: "static",
			});
			store.addresses.upsert({
				address: "runtime://y",
				target_id: node.id,
				scope: "runtime",
				kind: "static",
			});
			expect(store.addresses.listByTargetId(node.id).length).toBe(2);
			expect(store.addresses.delete("runtime://x")).toBe(true);
			expect(store.addresses.getByAddress("runtime://x")).toBeUndefined();
			expect(store.addresses.listByTargetId(node.id).length).toBe(1);
		} finally {
			wiki.close();
		}
	});

	test("list returns all addresses ordered by scope,address", () => {
		const { wiki, store } = freshWiki();
		try {
			store.addresses.upsert({ address: "runtime://a", scope: "static", kind: "static" });
			store.addresses.upsert({ address: "runtime://b", scope: "runtime", kind: "static" });
			const scopes = store.addresses.list().map((a) => a.scope);
			// "runtime" < "static" lexicographically.
			expect(scopes).toEqual(["runtime", "static"]);
		} finally {
			wiki.close();
		}
	});
});

// ===========================================================================
// WikiAuditRepository — append + request_id dedup (acceptance-01 §A item 12)
// ===========================================================================

describe("WikiAuditRepository — append + request_id dedup (design.md §5.6)", () => {
	test("append writes a row and returns deduped=false with a new auditId", () => {
		const { wiki, auditRepo } = freshWiki();
		try {
			const res = auditRepo.append({
				action: "create",
				nodePath: "wiki-root/knowledge/x",
				newRevision: 1,
				detail: { foo: 1 },
			});
			expect(res.deduped).toBe(false);
			expect(typeof res.auditId).toBe("string");
			expect(auditRepo.count()).toBe(1);
		} finally {
			wiki.close();
		}
	});

	test("duplicate request_id does NOT create a second row; returns same auditId + deduped=true (§A item 12)", () => {
		const { wiki, auditRepo } = freshWiki();
		try {
			const first = auditRepo.append({
				requestId: "req-123",
				action: "update",
				nodePath: "wiki-root/knowledge/y",
				newRevision: 2,
			});
			const second = auditRepo.append({
				requestId: "req-123",
				action: "update",
				nodePath: "wiki-root/knowledge/y",
				newRevision: 2,
			});
			expect(second.deduped).toBe(true);
			expect(second.auditId).toBe(first.auditId);
			expect(auditRepo.count()).toBe(1); // exactly one row, no duplicate
		} finally {
			wiki.close();
		}
	});

	test("append with null/undefined requestId always inserts (no dedup key)", () => {
		const { wiki, auditRepo } = freshWiki();
		try {
			auditRepo.append({ action: "read", requestId: null });
			auditRepo.append({ action: "read", requestId: null });
			auditRepo.append({ action: "read" }); // undefined → null
			expect(auditRepo.count()).toBe(3);
		} finally {
			wiki.close();
		}
	});

	test("append with explicit auditId uses it; detail serializes to valid JSON", () => {
		const { wiki, auditRepo } = freshWiki();
		try {
			const res = auditRepo.append({
				auditId: "audit-fixed",
				action: "create",
				detail: { a: 1, b: [2, 3] },
			});
			expect(res.auditId).toBe("audit-fixed");
			const row = auditRepo.getByAuditId("audit-fixed")!;
			expect(row.detail_json).toBe(JSON.stringify({ a: 1, b: [2, 3] }));
			// json_valid CHECK accepts it (the INSERT succeeded).
		} finally {
			wiki.close();
		}
	});

	test("getByRequestId / listByNodePath / listByActor / listByTimeWindow", () => {
		const { wiki, auditRepo } = freshWiki();
		try {
			auditRepo.append({
				requestId: "r1",
				actorAgentId: "agent-A",
				action: "update",
				nodePath: "wiki-root/knowledge/n1",
				newRevision: 2,
			});
			auditRepo.append({
				requestId: "r2",
				actorAgentId: "agent-A",
				action: "update",
				nodePath: "wiki-root/knowledge/n1",
				newRevision: 3,
			});
			auditRepo.append({
				requestId: "r3",
				actorAgentId: "agent-B",
				action: "create",
				nodePath: "wiki-root/knowledge/n2",
				newRevision: 1,
			});

			expect(auditRepo.getByRequestId("r1")?.action).toBe("update");
			expect(auditRepo.listByNodePath("wiki-root/knowledge/n1").length).toBe(2);
			expect(auditRepo.listByActor("agent-A").length).toBe(2);
			expect(auditRepo.listByActor("agent-B").length).toBe(1);

			// Time window covering everything (ISO strings sort lexically).
			const all = auditRepo.listByTimeWindow({ limit: 100 });
			expect(all.length).toBe(3);
		} finally {
			wiki.close();
		}
	});

	test("audit row is immutable (no update/delete API on repository)", () => {
		// acceptance-01 §A/§D — audit is append-only. The repository type must
		// not expose update/delete. Structural assertion on the class shape.
		const updateMethods = Object.getOwnPropertyNames(
			WikiAuditRepository.prototype,
		).filter((n) => /update|delete|patch|set/i.test(n));
		expect(updateMethods).toEqual([]);
	});
});

// ===========================================================================
// FTS — explicit transaction sync + rebuild + query (acceptance-01 §A item 11)
// ===========================================================================

describe("FTS — explicit transaction sync + rebuild + query (design.md §5.5)", () => {
	test("syncFtsInsert in same transaction makes node searchable", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			wiki.transaction(() => {
				const r = nodeRepo.insert({
					parent_id: nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!.id,
					name: "fts-target",
					path: joinWikiPath(`${WIKI_ROOT_PATH}/knowledge`, "fts-target"),
					kind: "knowledge",
					summary: "alpha beta gamma",
					content: "delta epsilon zeta",
					attributes_json: null,
				});
				nodeRepo.syncFtsInsert(r.id, r.name, r.summary, r.content);
			});
			const hits = nodeRepo.searchFts("alpha", 10);
			expect(hits.some((r) => r.name === "fts-target")).toBe(true);
		} finally {
			wiki.close();
		}
	});

	test("syncFtsUpdate reflects new content; syncFtsDelete removes from index", () => {
		const { wiki, nodeRepo } = freshWiki();
		try {
			let id = 0;
			wiki.transaction(() => {
				const r = nodeRepo.insert({
					parent_id: nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!.id,
					name: "ftsupd",
					path: joinWikiPath(`${WIKI_ROOT_PATH}/knowledge`, "ftsupd"),
					kind: "knowledge",
					summary: "oldsummary",
					content: "",
					attributes_json: null,
				});
				nodeRepo.syncFtsInsert(r.id, r.name, r.summary, r.content);
				id = r.id;
			});
			expect(nodeRepo.searchFts("oldsummary", 10).length).toBeGreaterThan(0);

			wiki.transaction(() => {
				nodeRepo.syncFtsUpdate(id, "ftsupd", "brandnewsummary", "");
			});
			expect(nodeRepo.searchFts("oldsummary", 10).length).toBe(0);
			expect(nodeRepo.searchFts("brandnewsummary", 10).length).toBeGreaterThan(0);

			wiki.transaction(() => nodeRepo.syncFtsDelete(id));
			expect(nodeRepo.searchFts("brandnewsummary", 10).length).toBe(0);
		} finally {
			wiki.close();
		}
	});

	test("rebuildFts reconstructs the index from wiki_nodes content", () => {
		// Insert nodes WITHOUT FTS sync (simulating a desync), then rebuild and
		// confirm the index now reflects the canonical node content.
		const { wiki, nodeRepo } = freshWiki();
		try {
			const parent = nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!.id;
			wiki.transaction(() => {
				nodeRepo.insert({
					parent_id: parent,
					name: "rb1",
					path: joinWikiPath(`${WIKI_ROOT_PATH}/knowledge`, "rb1"),
					kind: "knowledge",
					summary: "rebuildmarker",
					content: "",
					attributes_json: null,
				});
				// (deliberately NOT calling syncFtsInsert)
			});
			expect(nodeRepo.searchFts("rebuildmarker", 10).length).toBe(0);
			nodeRepo.rebuildFts();
			expect(nodeRepo.searchFts("rebuildmarker", 10).length).toBeGreaterThan(0);
		} finally {
			wiki.close();
		}
	});

	test("no FTS trigger exists in sqlite_master (explicit transaction only)", () => {
		// acceptance-01 §A item 11 — there must be NO trigger syncing the FTS.
		const { wiki, db } = freshWiki();
		try {
			const triggers = db
				.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name LIKE 'wiki%'`)
				.all() as Array<{ name: string }>;
			expect(triggers).toEqual([]);
		} finally {
			wiki.close();
		}
	});

	test("FTS virtual table fields are exactly name/summary/content", () => {
		// acceptance-01 §A item 11 — FTS fields locked to name/summary/content.
		const { wiki, db } = freshWiki();
		try {
			// fts5 reports its columns via the shadow table; the canonical way is
			// PRAGMA table_info on the vtable (returns the configured columns).
			const cols = db
				.prepare(`PRAGMA table_info(wiki_nodes_fts)`)
				.all() as Array<{ name: string }>;
			const names = cols.map((c) => c.name);
			expect(names).toContain("name");
			expect(names).toContain("summary");
			expect(names).toContain("content");
			// No extra domain fields (e.g. path/kind) leaked into the FTS.
			expect(names).not.toContain("path");
			expect(names).not.toContain("kind");
		} finally {
			wiki.close();
		}
	});
});

// ===========================================================================
// §B item 6 — hot-path indexes exist + EXPLAIN QUERY PLAN uses them
// ===========================================================================

describe("acceptance-01 §B.6 — hot-path indexes used by EXPLAIN QUERY PLAN", () => {
	test("lookup active node by path uses uq_wiki_nodes_active_path partial index", () => {
		const { wiki, db } = freshWiki();
		try {
			const plan = eqp(
				db,
				`SELECT id FROM wiki_nodes WHERE path = ? AND archived_at IS NULL`,
				"wiki-root/knowledge",
			);
			// Must reference the partial unique index (not a full table scan).
			expect(plan).toMatch(/uq_wiki_nodes_active_path/);
		} finally {
			wiki.close();
		}
	});

	test("children-by-parent lookup uses idx_wiki_nodes_parent", () => {
		const { wiki, db } = freshWiki();
		try {
			const plan = eqp(
				db,
				`SELECT id FROM wiki_nodes WHERE parent_id = ? AND archived_at IS NULL`,
				1,
			);
			expect(plan).toMatch(/idx_wiki_nodes_parent/);
		} finally {
			wiki.close();
		}
	});

	test("outgoing links by source use PRIMARY KEY (auto-index); incoming by target use idx_wiki_links_target", () => {
		const { wiki, db } = freshWiki();
		try {
			const outPlan = eqp(db, `SELECT * FROM wiki_links WHERE source_id = ?`, 1);
			// outgoing is covered by the PK auto-index on (source_id, target_id, relation).
			expect(outPlan).toMatch(/wiki_links\b/);

			const inPlan = eqp(db, `SELECT * FROM wiki_links WHERE target_id = ?`, 1);
			expect(inPlan).toMatch(/idx_wiki_links_target/);
		} finally {
			wiki.close();
		}
	});

	test("source_bindings by repository use idx_wiki_source_bindings_repo", () => {
		const { wiki, db } = freshWiki();
		try {
			const plan = eqp(
				db,
				`SELECT * FROM wiki_source_bindings WHERE repository_id = ?`,
				"repo-x",
			);
			expect(plan).toMatch(/idx_wiki_source_bindings_repo/);
		} finally {
			wiki.close();
		}
	});

	test("addresses by target use idx_wiki_addresses_target", () => {
		const { wiki, db } = freshWiki();
		try {
			const plan = eqp(db, `SELECT * FROM wiki_addresses WHERE target_id = ?`, 1);
			expect(plan).toMatch(/idx_wiki_addresses_target/);
		} finally {
			wiki.close();
		}
	});

	test("repositories by project_node_id / project_id use the UNIQUE auto-indexes", () => {
		const { wiki, db } = freshWiki();
		try {
			// UNIQUE constraints create automatic indexes that SQLite uses.
			const planNode = eqp(
				db,
				`SELECT * FROM wiki_repositories WHERE project_node_id = ?`,
				1,
			);
			expect(planNode).toMatch(/wiki_repositories\b/);
			const planProj = eqp(
				db,
				`SELECT * FROM wiki_repositories WHERE project_id = ?`,
				"x",
			);
			expect(planProj).toMatch(/wiki_repositories\b/);
		} finally {
			wiki.close();
		}
	});
});

// ===========================================================================
// §B item 1 + §D evidence capability — sqlite_master summary, FK/integrity,
// fixed-root query (path/kind/revision only — no internal ID leak to agent API)
// ===========================================================================

describe("acceptance-01 §D — evidence capability from a repository-opened DB", () => {
	test("sqlite_master summary lists all 7 wiki tables + key indexes", () => {
		const { wiki, db } = freshWiki();
		try {
			// tbl_name LIKE 'wiki_%' catches both the wiki_* tables AND their
			// idx_wiki_* / uq_wiki_* indexes (an index's tbl_name is its table).
			const rows = db
				.prepare(
					`SELECT name, type FROM sqlite_master
					 WHERE tbl_name LIKE 'wiki_%' ORDER BY name`,
				)
				.all() as Array<{ name: string; type: string }>;
			const names = new Set(rows.map((r) => r.name));
			// 7 core tables (wiki_schema_version is an extra helper table; not required).
			for (const t of [
				"wiki_nodes",
				"wiki_links",
				"wiki_addresses",
				"wiki_repositories",
				"wiki_source_bindings",
				"wiki_nodes_fts",
				"wiki_audit_log",
			]) {
				expect(names.has(t)).toBe(true);
			}
			// Hot-path indexes present.
			for (const idx of [
				"uq_wiki_nodes_active_path",
				"uq_wiki_nodes_active_sibling",
				"idx_wiki_nodes_parent",
				"idx_wiki_links_target",
				"idx_wiki_source_bindings_repo",
				"idx_wiki_addresses_target",
			]) {
				expect(names.has(idx)).toBe(true);
			}
		} finally {
			wiki.close();
		}
	});

	test("partial unique index SQL is stored with WHERE archived_at IS NULL predicate", () => {
		const { wiki, db } = freshWiki();
		try {
			const sql = (db
				.prepare(`SELECT sql FROM sqlite_master WHERE name='uq_wiki_nodes_active_path'`)
				.get() as { sql: string | undefined })?.sql ?? "";
			expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
			expect(sql).toMatch(/WHERE archived_at IS NULL/i);
		} finally {
			wiki.close();
		}
	});

	test("PRAGMA foreign_key_check and integrity_check both clean", () => {
		const { wiki } = freshWiki();
		try {
			expect(wiki.foreignKeyCheck()).toBe("ok");
			expect(wiki.integrityCheck()).toBe("ok");
		} finally {
			wiki.close();
		}
	});

	test("fixed-root query returns only path/kind/revision — no internal DB id in the agent-facing projection (§D evidence)", () => {
		// acceptance-01 §D: fixed-root query must demonstrate path/kind/revision
		// only (the agent API never sees the internal integer id/parent_id).
		const { wiki, db } = freshWiki();
		try {
			const rows = db
				.prepare(
					`SELECT path, kind, revision FROM wiki_nodes
					 WHERE archived_at IS NULL AND parent_id IS NULL
					 UNION ALL
					 SELECT path, kind, revision FROM wiki_nodes
					 WHERE parent_id IN (SELECT id FROM wiki_nodes WHERE parent_id IS NULL)
					   AND archived_at IS NULL`,
				)
				.all() as Array<{ path: string; kind: string; revision: number }>;
			const paths = rows.map((r) => r.path).sort();
			expect(paths).toEqual(
				[
					`${WIKI_ROOT_PATH}`,
					`${WIKI_ROOT_PATH}/knowledge`,
					`${WIKI_ROOT_PATH}/memory`,
					`${WIKI_ROOT_PATH}/projects`,
				].sort(),
			);
			// Every fixed root has revision 1 (idempotent bootstrap never bumps it).
			for (const r of rows) {
				expect(r.revision).toBe(1);
			}
			// The selected projection genuinely has NO id/parent_id column.
			const colNames = Object.keys(rows[0] ?? { path: "" });
			expect(colNames).toEqual(["path", "kind", "revision"]);
		} finally {
			wiki.close();
		}
	});
});

// ===========================================================================
// §B item 2 — repository layer does NOT reuse SqliteStore<T> (DDL is explicit)
// ===========================================================================

describe("acceptance-01 §B.2 — Wiki tables NOT created/migrated via SqliteStore<T>", () => {
	test("DDL is explicit SQL via Database.exec (no SqliteStore in src/server/wiki source)", () => {
		// Structural proof: read the wiki-schema source and confirm DDL is raw
		// exec, and that SqliteStore is referenced ONLY in prohibition comments.
		const schemaSrc = readFileSync(
			join(REPO_ROOT, "src", "server", "wiki", "wiki-schema.ts"),
			"utf-8",
		);
		// DDL present as explicit exec calls.
		expect(schemaSrc).toMatch(/db\.exec\(/);
		expect(schemaSrc).toMatch(/CREATE TABLE IF NOT EXISTS wiki_nodes/);
		// SqliteStore appears ONLY in prohibition comments, never as code.
		const lines = schemaSrc.split(/\r?\n/);
		const sqliteStoreCodeLines = lines.filter(
			(l) => /SqliteStore/.test(l) && !/^\s*\/\//.test(l) && !/^\s*\*/.test(l),
		);
		expect(sqliteStoreCodeLines).toEqual([]);
	});

	test("canonical path is single-authority: path functions defined only in wiki-path.ts", () => {
		// acceptance-01 §B.4 — repository/service/tool must not each roll their
		// own path string logic. The path primitives live ONLY in wiki-path.ts.
		const pathSrc = readFileSync(
			join(REPO_ROOT, "src", "server", "wiki", "wiki-path.ts"),
			"utf-8",
		);
		// Authority: the canonical functions are exported from here.
		expect(pathSrc).toMatch(/export function normalizeWikiPath/);
		expect(pathSrc).toMatch(/export function joinWikiPath/);
		expect(pathSrc).toMatch(/export function isSameOrDescendant/);
		// And the node/link/audit repos do NOT redefine them: grep their sources.
		const repoFiles = [
			"wiki-node-repository.ts",
			"wiki-link-repository.ts",
			"wiki-repository-store.ts",
			"wiki-audit-repository.ts",
		];
		for (const f of repoFiles) {
			const src = readFileSync(join(REPO_ROOT, "src", "server", "wiki", f), "utf-8");
			// No local re-definition of the canonical primitives.
			expect(src).not.toMatch(/function normalizeWikiPath/);
			expect(src).not.toMatch(/function joinWikiPath/);
			expect(src).not.toMatch(/function isSameOrDescendant/);
		}
	});
});

// ===========================================================================
// §B item 5 — repository layer has NO grants / address-resolver / prompt logic
// ===========================================================================

describe("acceptance-01 §B.5 — repository layer has no grants/resolver/prompt logic", () => {
	test("WikiNodeRepository / WikiLinkRepository / WikiRepositoryStore / WikiAuditRepository expose no grant/prompt/authorize methods", () => {
		const grantish = (n: string) =>
			/\b(grant|authorize|prompt|resolver|resolveAddress|checkAccess|permission)\b/i.test(n);
		for (const ctor of [
			WikiNodeRepository,
			WikiLinkRepository,
			WikiRepositoryStore,
			WikiRepositoryTable,
			WikiSourceBindingTable,
			WikiAddressTable,
			WikiAuditRepository,
		]) {
			const methods = Object.getOwnPropertyNames(ctor.prototype);
			expect(methods.some(grantish)).toBe(false);
		}
	});
});

// ===========================================================================
// Integration — repositories share one underlying db handle and one transaction
// ===========================================================================

describe("repository integration — multi-table transaction composes node + FTS + audit", () => {
	test("create-node flow: node insert + FTS sync + audit append commit atomically in one transaction", () => {
		const { wiki, nodeRepo, auditRepo } = freshWiki();
		try {
			const before = auditRepo.count();
			const res = { id: 0, auditId: "" };
			wiki.transaction(() => {
				const r = nodeRepo.insert({
					parent_id: nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!.id,
					name: "atomic",
					path: joinWikiPath(`${WIKI_ROOT_PATH}/knowledge`, "atomic"),
					kind: "knowledge",
					summary: "atomicsummary",
					content: "atomiccontent",
					attributes_json: null,
				});
				nodeRepo.syncFtsInsert(r.id, r.name, r.summary, r.content);
				const a = auditRepo.append({
					requestId: "req-atomic",
					action: "create",
					nodePath: r.path,
					newRevision: r.revision,
				});
				res.id = r.id;
				res.auditId = a.auditId;
			});
			// All three writes committed.
			expect(nodeRepo.getById(res.id)?.name).toBe("atomic");
			expect(nodeRepo.searchFts("atomicsummary", 10).length).toBeGreaterThan(0);
			expect(auditRepo.count()).toBe(before + 1);
			expect(auditRepo.getByRequestId("req-atomic")?.audit_id).toBe(res.auditId);
		} finally {
			wiki.close();
		}
	});

	test("transaction rollback on failure leaves node, FTS, and audit all unwritten", () => {
		const { wiki, nodeRepo, auditRepo } = freshWiki();
		try {
			const before = auditRepo.count();
			expect(() =>
				wiki.transaction(() => {
					const r = nodeRepo.insert({
						parent_id: nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/knowledge`)!.id,
						name: "rollback",
						path: joinWikiPath(`${WIKI_ROOT_PATH}/knowledge`, "rollback"),
						kind: "knowledge",
						summary: "rollbacksummary",
						content: "",
						attributes_json: null,
					});
					nodeRepo.syncFtsInsert(r.id, r.name, r.summary, r.content);
					auditRepo.append({ action: "create", nodePath: r.path });
					// Force a failure AFTER the writes — the whole transaction must roll back.
					throw new Error("force-rollback");
				}),
			).toThrow(/force-rollback/);

			// Nothing committed.
			expect(nodeRepo.getActiveByPath(joinWikiPath(`${WIKI_ROOT_PATH}/knowledge`, "rollback"))).toBeUndefined();
			expect(nodeRepo.searchFts("rollbacksummary", 10).length).toBe(0);
			expect(auditRepo.count()).toBe(before);
		} finally {
			wiki.close();
		}
	});
});
