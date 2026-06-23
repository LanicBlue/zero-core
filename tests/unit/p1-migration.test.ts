// P1 单元测试:migration 双路径 (契约 §1.2)
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P1 (acceptance-P1.md「migration 双路径」节):
//   - fresh DB:detail/type 列不存在(新 schema 直接建立),正文走文件
//   - 旧 DB:detail 列内容导出磁盘 → 删列;type 列删除;idx_wiki_type 索引删除
//   - 双路径都不崩
//
// 这是 schema 契约 §1.2 「fresh + 旧库都跑通」在 P1 阶段的物化(plan-P1 §3:
// "detail 内容先导出磁盘再删列(否则丢数据)"。
//
// ## 输入
// 临时 SessionDB + helpers/p0-test-helpers 的 createLegacySchemaDb /
// buildLegacyWikiRow(新)。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/server/db-migration.ts (migrateWikiDetailToDisk /
//    migrateWikiTableSchema / DROP COLUMN / DROP INDEX idx_wiki_type)
//   - tests/unit/helpers/p0-test-helpers.ts (buildLegacyWikiRow — P1 新增)
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { WikiStore, WIKI_DISK_ROOT } from "../../src/server/wiki-node-store.js";
import {
	createLegacySchemaDb,
	buildLegacyWikiRow,
} from "./helpers/p0-test-helpers.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p1-migration-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function columnsOf(db: Database.Database, table: string): Set<string> {
	const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

function indexesOf(db: Database.Database, table: string): Set<string> {
	const rows = db.pragma(`index_list(${table})`) as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

// ─── Fresh DB path ────────────────────────────────────────────

describe("P1 migration — fresh DB path", () => {
	test("fresh DB 没有 detail / type 列 (P1 §10.1 新 schema)", () => {
		const dbPath = join(tmpDir, "fresh.db");
		const sessionDB = new SessionDB(dbPath);
		runMigrations(sessionDB);
		const cols = columnsOf(sessionDB.getDb(), "project_wiki");
		expect(cols.has("detail")).toBe(false);
		expect(cols.has("type")).toBe(false);
		// Structural columns remain.
		expect(cols.has("doc_pointer")).toBe(true);
		expect(cols.has("links")).toBe(true);
		expect(cols.has("project_id")).toBe(true);
		expect(cols.has("node_type")).toBe(true); // legacy discriminator kept
		sessionDB.close();
	});

	test("fresh DB 没有 idx_wiki_type 索引 (依赖已删的 type 列)", () => {
		const dbPath = join(tmpDir, "fresh-idx.db");
		const sessionDB = new SessionDB(dbPath);
		runMigrations(sessionDB);
		expect(indexesOf(sessionDB.getDb(), "project_wiki").has("idx_wiki_type")).toBe(false);
		// Other wiki indexes preserved.
		expect(indexesOf(sessionDB.getDb(), "project_wiki").has("idx_wiki_project")).toBe(true);
		expect(indexesOf(sessionDB.getDb(), "project_wiki").has("idx_wiki_parent")).toBe(true);
		sessionDB.close();
	});

	test("fresh DB 上 WikiStore 正常起 + 可写正文走文件", () => {
		const dbPath = join(tmpDir, "fresh-wiki.db");
		const sessionDB = new SessionDB(dbPath);
		runMigrations(sessionDB);
		const wiki = new WikiStore(sessionDB);
		// Global root exists by construction.
		expect(wiki.get("wiki-root:global")).toBeDefined();
		// Body round-trip works.
		const proj = sessionDB.getDb().prepare(
			"INSERT INTO projects (id, name, workspace_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
		).get("p-fresh", "Fresh", join(tmpDir, "ws"), new Date().toISOString(), new Date().toISOString()) as { id: string };
		const root = wiki.ensureProjectSubtree(proj.id, "Fresh");
		const node = wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:a.ts",
			title: "a.ts", detail: "fresh body",
		});
		expect(wiki.readNodeDetail(node.id)).toBe("fresh body");
		// Clean up disk artifact so we don't pollute ~/.zero-core/wiki.
		try { wiki.delete(node.id); } catch { /* ok */ }
		try { wiki.delete(root.id); } catch { /* ok */ }
		sessionDB.close();
	});

	test("fresh DB:runMigrations 二次幂等(不抛)", () => {
		const dbPath = join(tmpDir, "fresh-idempotent.db");
		const sessionDB = new SessionDB(dbPath);
		runMigrations(sessionDB);
		expect(() => runMigrations(sessionDB)).not.toThrow();
		// Second run still has no detail/type.
		const cols = columnsOf(sessionDB.getDb(), "project_wiki");
		expect(cols.has("detail")).toBe(false);
		expect(cols.has("type")).toBe(false);
		sessionDB.close();
	});
});

// ─── Legacy DB upgrade path ───────────────────────────────────

describe("P1 migration — legacy DB upgrade path (detail → disk)", () => {
	test("旧 DB 的 detail 内容被导出到磁盘 + doc_pointer 被 stamp + 列删除", () => {
		const dbPath = join(tmpDir, "legacy.db");
		// Build legacy schema (has detail + type) + a row with content.
		const legacy = new Database(dbPath);
		createLegacySchemaDb(legacy);
		buildLegacyWikiRow(legacy, {
			id: "node-legacy-1",
			parentId: null,
			projectId: "proj-leg",
			type: "header",
			nodeType: "file",
			path: "header:src/legacy.ts",
			title: "legacy.ts",
			summary: "Legacy module",
			detail: "LEGACY BODY CONTENT — must survive to disk",
		});
		// A second row with empty detail — should not stamp doc_pointer.
		buildLegacyWikiRow(legacy, {
			id: "node-legacy-2",
			parentId: null,
			projectId: "proj-leg",
			type: "structure",
			nodeType: "directory",
			path: "structure:src",
			title: "src/",
			detail: "   ", // blank
		});
		legacy.close();

		// Migrate.
		const sessionDB = new SessionDB(dbPath);
		expect(() => runMigrations(sessionDB)).not.toThrow();
		const db = sessionDB.getDb();

		// detail + type columns dropped.
		const cols = columnsOf(db, "project_wiki");
		expect(cols.has("detail")).toBe(false);
		expect(cols.has("type")).toBe(false);

		// idx_wiki_type dropped.
		expect(indexesOf(db, "project_wiki").has("idx_wiki_type")).toBe(false);

		// Row 1 — doc_pointer stamped, file exists on disk with the body.
		const row1 = db.prepare("SELECT doc_pointer FROM project_wiki WHERE id = ?").get("node-legacy-1") as { doc_pointer: string | null };
		expect(row1.doc_pointer).toBeTruthy();
		expect(existsSync(row1.doc_pointer!)).toBe(true);
		expect(readFileSync(row1.doc_pointer!, "utf-8")).toBe("LEGACY BODY CONTENT — must survive to disk");

		// Row 2 — no doc_pointer (blank detail).
		const row2 = db.prepare("SELECT doc_pointer FROM project_wiki WHERE id = ?").get("node-legacy-2") as { doc_pointer: string | null };
		expect(row2.doc_pointer).toBeNull();

		sessionDB.close();

		// Cleanup the disk artifact.
		try { rmSync(row1.doc_pointer!, { force: true }); } catch { /* ok */ }
	});

	test("旧 DB 的 detail 路由按 area:project → projects/<projectId>/, memory → memory/<agentId>/, knowledge → knowledge/", () => {
		const dbPath = join(tmpDir, "legacy-areas.db");
		const legacy = new Database(dbPath);
		createLegacySchemaDb(legacy);
		// Project node → projects/<projectId>/.
		buildLegacyWikiRow(legacy, {
			id: "node-proj-area",
			projectId: "p-area",
			type: "header", nodeType: "file",
			path: "header:src/x.ts", title: "x.ts",
			detail: "project body",
		});
		// Memory node → memory/<agentId>/ (path signals memory; agentId is the
		// 2nd colon segment — here "legacy-fact").
		buildLegacyWikiRow(legacy, {
			id: "node-mem-area",
			type: "memory", nodeType: "section",
			path: "memory:legacy-fact", title: "Legacy fact",
			detail: "memory body",
		});
		// Knowledge-ish node (no project, no memory signal) → knowledge/.
		buildLegacyWikiRow(legacy, {
			id: "node-kn-area",
			type: "structure", nodeType: "directory",
			path: "knowledge:adr-1", title: "ADR 1",
			detail: "knowledge body",
		});
		legacy.close();

		const sessionDB = new SessionDB(dbPath);
		runMigrations(sessionDB);
		const db = sessionDB.getDb();

		const getPtr = (id: string) =>
			(db.prepare("SELECT doc_pointer FROM project_wiki WHERE id = ?").get(id) as { doc_pointer: string }).doc_pointer;

		const projPtr = getPtr("node-proj-area");
		const memPtr = getPtr("node-mem-area");
		const knPtr = getPtr("node-kn-area");

		// Area routing.
		expect(projPtr.replace(/\\/g, "/")).toContain("projects/p-area/");
		expect(memPtr.replace(/\\/g, "/")).toContain("memory/legacy-fact/");
		expect(knPtr.replace(/\\/g, "/")).toContain("knowledge/");

		// Each body actually exported to disk.
		expect(existsSync(projPtr)).toBe(true);
		expect(readFileSync(projPtr, "utf-8")).toBe("project body");
		expect(existsSync(memPtr)).toBe(true);
		expect(readFileSync(memPtr, "utf-8")).toBe("memory body");
		expect(existsSync(knPtr)).toBe(true);
		expect(readFileSync(knPtr, "utf-8")).toBe("knowledge body");

		sessionDB.close();
		// Cleanup.
		for (const p of [projPtr, memPtr, knPtr]) {
			try { rmSync(p, { force: true }); } catch { /* ok */ }
		}
	});

	test("旧 DB 上 WikiStore 起来后可正常读 detail (走 readNodeDetail)", () => {
		const dbPath = join(tmpDir, "legacy-readback.db");
		const legacy = new Database(dbPath);
		createLegacySchemaDb(legacy);
		buildLegacyWikiRow(legacy, {
			id: "rb-1",
			projectId: "rb-proj",
			type: "header", nodeType: "file",
			path: "header:src/rb.ts", title: "rb.ts",
			detail: "round-trip body",
		});
		legacy.close();

		const sessionDB = new SessionDB(dbPath);
		runMigrations(sessionDB);
		const wiki = new WikiStore(sessionDB);
		// runMigrations writes bodies to the LEGACY flat layout; the tree-mirror
		// disk layout migration (run by ensureWikiSkeleton on startup) moves them
		// to diskPathFor locations so readNodeDetail finds them.
		wiki.migrateWikiDiskLayout();

		// readNodeDetail finds the migrated body.
		const body = wiki.readNodeDetail("rb-1");
		expect(body).toBe("round-trip body");
		// get()/list() do NOT populate detail.
		const node = wiki.get("rb-1");
		expect(node).toBeDefined();
		expect((node as any).detail).toBeUndefined();

		sessionDB.close();
		try { rmSync(wiki.get("rb-1")!.docPointer!, { force: true }); } catch { /* ok */ }
	});

	test("旧 DB 已迁移后再 runMigrations 幂等(不重复导出,不抛)", () => {
		const dbPath = join(tmpDir, "legacy-twice.db");
		const legacy = new Database(dbPath);
		createLegacySchemaDb(legacy);
		buildLegacyWikiRow(legacy, {
			id: "twice-1",
			projectId: "p-twice",
			type: "header", nodeType: "file",
			path: "header:src/t.ts", title: "t.ts",
			detail: "twice body",
		});
		legacy.close();

		const sessionDB = new SessionDB(dbPath);
		runMigrations(sessionDB);
		// Second run — idempotent (detail already dropped, no error).
		expect(() => runMigrations(sessionDB)).not.toThrow();

		const cols = columnsOf(sessionDB.getDb(), "project_wiki");
		expect(cols.has("detail")).toBe(false);
		expect(cols.has("type")).toBe(false);

		const row = sessionDB.getDb().prepare(
			"SELECT doc_pointer FROM project_wiki WHERE id = ?",
		).get("twice-1") as { doc_pointer: string };
		expect(existsSync(row.doc_pointer)).toBe(true);
		expect(readFileSync(row.doc_pointer, "utf-8")).toBe("twice body");

		sessionDB.close();
		try { rmSync(row.doc_pointer, { force: true }); } catch { /* ok */ }
	});
});
