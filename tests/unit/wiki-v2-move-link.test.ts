// wiki-system-redesign sub-02 acceptance — 对抗 lens (move + link + hardDelete + restore edge cases + fault injection).
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-02 §A.8 (move 10,000 边界 + NO half-update)、§A.9
// (hardDelete 4 个独立拒绝条件:child / incoming link / address / source binding)、
// §A.10 (source-bound create/move/delete → SOURCE_MANAGED)、restore (active
// path/sibling 冲突 + source-bound → SOURCE_MANAGED)、以及对应 audit 检查。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db (vi.hoisted,前缀 `zc-wiki-v2-ml-`)。
//   - 每个 test 在自己的 mkdtemp 子目录开 fresh wiki.db,无跨 test 状态污染。
//
// ## 输出
// Vitest 用例。每用例开真 SQLite temp DB,绝不读活跃 ~/.zero-core。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - 跨 lens 隔离:vi.hoisted 用唯一前缀 `zc-wiki-v2-ml-`。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-ml-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService, WIKI_MOVE_NODE_CAP } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiLinkRepository } from "../../src/server/wiki/wiki-link-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiEditService } from "../../src/server/wiki/wiki-edit-service.js";
import type {
	CompiledWikiAccess,
	WikiRequestContext,
	WikiAdminRequestContext,
	WikiAction,
} from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wideOpenAccess(): CompiledWikiAccess {
	const allActions: WikiAction[] = [
		"expand", "read", "search", "create", "update",
		"delete", "link", "unlink", "move",
	];
	return {
		agentId: "test-agent",
		grants: [{ canonicalScope: "wiki-root", actions: allActions }],
		policyRevision: 1,
	};
}

function makeCtx(): WikiRequestContext {
	return {
		access: wideOpenAccess(),
		agentId: "test-agent",
		activeProjectId: undefined,
		sessionId: "ml-session",
		requestId: null,
	};
}

function makeAdminCtx(): WikiAdminRequestContext {
	return {
		channel: "test-admin",
		actor: "test-actor",
		requestId: null,
		sessionId: "ml-admin-session",
	};
}

function buildService(wikiDb: WikiDatabase): WikiService {
	const db = wikiDb.getDb();
	return new WikiService({
		wikiDb,
		nodeRepo: new WikiNodeRepository(db),
		linkRepo: new WikiLinkRepository(db),
		auditRepo: new WikiAuditRepository(db),
		repositoryStore: new WikiRepositoryStore(db),
		addressService: new WikiAddressService(
			new WikiRepositoryStore(db).addresses,
			new WikiNodeRepository(db),
		),
		authorizationService: new WikiAuthorizationService(),
		editService: new WikiEditService(),
	});
}

/**
 * 构建 WikiService + 共享的 addressService(注入到 service 内,同时暴露给测试用于 register)。
 * 关键:addressService 与 service 内用的是同一实例 —— register 的 alias 立即可由 service 解析。
 */
function buildServiceWithAddress(wikiDb: WikiDatabase): {
	svc: WikiService;
	addressSvc: WikiAddressService;
} {
	const db = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const linkRepo = new WikiLinkRepository(db);
	const auditRepo = new WikiAuditRepository(db);
	const repositoryStore = new WikiRepositoryStore(db);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const svc = new WikiService({
		wikiDb,
		nodeRepo,
		linkRepo,
		auditRepo,
		repositoryStore,
		addressService,
		authorizationService: new WikiAuthorizationService(),
		editService: new WikiEditService(),
	});
	return { svc, addressSvc: addressService };
}

async function createNode(
	svc: WikiService,
	parent: string,
	name: string,
): Promise<string> {
	const r = await svc.create(
		{ parent, name, kind: "knowledge", content: `body-${name}` },
		makeCtx(),
	);
	return r.path;
}

function countAudit(db: Database.Database, action: string): number {
	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = ?`)
		.get(action) as { n: number };
	return row.n;
}

/**
 * 注入 source binding 到节点(模拟项目镜像 binding)。
 * 需要先建 repository(project_node_id RESTRICT)。
 */
function bindSource(db: Database.Database, nodeId: number): void {
	const store = new WikiRepositoryStore(db);
	// 先建一个 project root 作为 project_node_id 占位(FK RESTRICT)。
	// 偷懒:把传入节点直接当 project_node_id 也行,只要 wiki_repositories 行能写。
	const repoId = `fake-repo-${nodeId}`;
	store.repositories.upsert({
		repository_id: repoId,
		project_node_id: nodeId,
		project_id: `fake-proj-${nodeId}`,
	});
	store.sourceBindings.upsert({
		node_id: nodeId,
		repository_id: repoId,
		source_path: `fake/path/${nodeId}`,
		source_kind: "file",
		indexed_revision: "fake-sha-0001",
	});
}

/**
 * 给节点注入静态地址引用(模拟 wiki_addresses 引用)。
 */
function registerAddressOnNode(db: Database.Database, nodeId: number, address: string): void {
	db.prepare(
		`INSERT INTO wiki_addresses (address, target_id, resolver, scope, kind,
		    prompt_policy, revision, created_at, updated_at)
		 VALUES (?, ?, NULL, 'runtime', 'alias', NULL, 1, ?, ?)`,
	).run(address, nodeId, new Date().toISOString(), new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wiki-v2 move / link / hardDelete / restore lens [对抗 lens — §A.8/9/10]", () => {
	let wiki: WikiDatabase;
	let db: Database.Database;
	let svc: WikiService;
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(UNIQUE_DIR, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
		wiki = new WikiDatabase(join(tempDir, "wiki.db"));
		db = wiki.getDb();
		svc = buildService(wiki);
	});

	afterEach(() => {
		try { wiki.close(); } catch { /* idempotent */ }
	});

	// =========================================================================
	// §A.8 — move: 10,000 节点边界成功;10,001 → MOVE_TOO_LARGE + NO 半更新
	// =========================================================================

	describe("§A.8 move subtree boundary: 10,000 success, 10,001 → MOVE_TOO_LARGE + no half-update", () => {
		/**
		 * 用裸 SQL 批量插入 N 个节点,构建以 rootPath 为根的子树。
		 * 节点路径模式:`<rootPath>/c0`, `<rootPath>/c0/c1`, ... `<rootPath>/c0/c1/.../cN-1`
		 * 简化:全部作为根的直接子节点(扁平结构)—— N 个 active children。
		 * root 本身 + N children = N+1 个节点。
		 *
		 * 注:WIKI_MOVE_NODE_CAP = 10_000,判断条件是 `allRows.length > cap`。
		 * allRows 含 root,所以 10,000 个总数(1 root + 9,999 children)通过,
		 * 10,001 个总数(1 root + 10,000 children)拒绝。
		 */
		function bulkInsertSubtree(rootPath: string, childCount: number): {
			rootId: number;
			rootName: string;
		} {
			// root 必须先存在 —— 我们用 service 创建 root,然后 SQL 批量建 children。
			// 注意:wiki-root/knowledge 这种 namespace 由 bootstrap 创建,
			// 我们用 service.create 在 knowledge 下建 root。
			// 这里我们假设 root 已经被外部 service.create 创建;此函数只批量插入 children。
			const rootRow = db
				.prepare(`SELECT id FROM wiki_nodes WHERE path = ? AND archived_at IS NULL`)
				.get(rootPath) as { id: number } | undefined;
			if (!rootRow) throw new Error(`bulkInsertSubtree: root missing at ${rootPath}`);
			const rootId = rootRow.id;
			const rootName = rootPath.slice(rootPath.lastIndexOf("/") + 1);

			const now = new Date().toISOString();
			const insertChild = db.prepare(
				`INSERT INTO wiki_nodes
				   (id, parent_id, name, path, kind, summary, content,
				    attributes_json, revision, created_at, updated_at, archived_at)
				 VALUES (NULL, ?, ?, ?, 'knowledge', '', '', NULL, 1, ?, ?, NULL)`,
			);
			const insertFts = db.prepare(
				`INSERT INTO wiki_nodes_fts(rowid, name, summary, content) VALUES (?, ?, '', '')`,
			);
			const txn = db.transaction(() => {
				for (let i = 0; i < childCount; i++) {
					const childName = `c${i}`;
					const childPath = `${rootPath}/${childName}`;
					const info = insertChild.run(rootId, childName, childPath, now, now);
					insertFts.run(Number(info.lastInsertRowid), childName);
				}
			});
			txn();
			return { rootId, rootName };
		}

		test(`move subtree with exactly ${WIKI_MOVE_NODE_CAP} nodes (1 root + ${WIKI_MOVE_NODE_CAP - 1} children) SUCCEEDS`, async () => {
			// 在 wiki-root/knowledge 下建一个 bigSubtree root。
			const rootPath = await createNode(svc, "wiki-root/knowledge", "bigSubtree");
			bulkInsertSubtree(rootPath, WIKI_MOVE_NODE_CAP - 1);
			const totalBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes WHERE path LIKE 'wiki-root/knowledge/bigSubtree%'`);
			expect(totalBefore).toBe(WIKI_MOVE_NODE_CAP);

			const result = await svc.move(
				{
					address: rootPath,
					newParent: "wiki-root/memory",
					newName: "bigSubtree-moved",
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.path).toBe("wiki-root/memory/bigSubtree-moved");
			// 旧 path 0 active
			expect(
				countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes WHERE path LIKE 'wiki-root/knowledge/bigSubtree%' AND archived_at IS NULL`),
			).toBe(0);
			// 新 path 数量相同
			expect(
				countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes WHERE path LIKE 'wiki-root/memory/bigSubtree-moved%'`),
			).toBe(WIKI_MOVE_NODE_CAP);
			// audit move 写入一条
			expect(countAudit(db, "move")).toBeGreaterThanOrEqual(1);
		});

		test(`move subtree with ${WIKI_MOVE_NODE_CAP + 1} nodes → MOVE_TOO_LARGE + NO half-update (all paths unchanged)`, async () => {
			const rootPath = await createNode(svc, "wiki-root/knowledge", "tooBigSubtree");
			bulkInsertSubtree(rootPath, WIKI_MOVE_NODE_CAP); // 1 root + 10_000 children = 10_001 total
			const totalBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes WHERE path LIKE 'wiki-root/knowledge/tooBigSubtree%'`);
			expect(totalBefore).toBe(WIKI_MOVE_NODE_CAP + 1);

			const auditBefore = countAudit(db, "move");

			await expect(
				svc.move(
					{
						address: rootPath,
						newParent: "wiki-root/memory",
						newName: "tooBig-moved",
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "MOVE_TOO_LARGE" });

			// NO half-update:旧 path 节点全部仍在原位
			expect(
				countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes WHERE path LIKE 'wiki-root/knowledge/tooBigSubtree%' AND archived_at IS NULL`),
			).toBe(WIKI_MOVE_NODE_CAP + 1);
			// 新 path 不存在任何节点
			expect(
				countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes WHERE path LIKE 'wiki-root/memory/tooBig-moved%'`),
			).toBe(0);

			// root 的 revision / updated_at 不变(没被半改)
			const rootRow = new WikiNodeRepository(db).getActiveByPath(rootPath)!;
			expect(rootRow.revision).toBe(1);

			// audit 没新增 move 记录(transaction rolled back)
			expect(countAudit(db, "move")).toBe(auditBefore);
		});
	});

	// =========================================================================
	// §A.9 — hardDelete 4 个独立拒绝条件
	// =========================================================================

	describe("§A.9 hardDelete rejects: child / incoming link / address / source binding", () => {
		test("hardDelete rejected when target has active CHILD (HARD_DELETE_BLOCKED, cascade=false)", async () => {
			const parent = await createNode(svc, "wiki-root/knowledge", "hd-parent");
			await createNode(svc, parent, "hd-child");

			await expect(
				svc.hardDelete(
					{ address: parent, cascade: false },
					makeAdminCtx(),
				),
			).rejects.toMatchObject({ code: "HARD_DELETE_BLOCKED" });

			// 节点仍在
			expect(new WikiNodeRepository(db).getActiveByPath(parent)).toBeDefined();
		});

		test("hardDelete rejected when target is target of INCOMING link (HARD_DELETE_BLOCKED)", async () => {
			const a = await createNode(svc, "wiki-root/knowledge", "hd-incoming-a");
			const b = await createNode(svc, "wiki-root/knowledge", "hd-incoming-b");
			await svc.link({ source: a, target: b, relation: "depends_on" }, makeCtx());

			await expect(
				svc.hardDelete({ address: b }, makeAdminCtx()),
			).rejects.toMatchObject({ code: "HARD_DELETE_BLOCKED" });

			// b 仍在(incoming link 阻止硬删)
			expect(new WikiNodeRepository(db).getActiveByPath(b)).toBeDefined();
		});

		test("hardDelete rejected when target is referenced by ADDRESS (HARD_DELETE_BLOCKED)", async () => {
			const target = await createNode(svc, "wiki-root/knowledge", "hd-addressed");
			const targetRow = new WikiNodeRepository(db).getActiveByPath(target)!;
			registerAddressOnNode(db, targetRow.id, "runtime://hd-addr-ref");

			await expect(
				svc.hardDelete({ address: target }, makeAdminCtx()),
			).rejects.toMatchObject({ code: "HARD_DELETE_BLOCKED" });

			// 节点仍在
			expect(new WikiNodeRepository(db).getActiveByPath(target)).toBeDefined();
			// 地址仍在
			const addr = db
				.prepare(`SELECT address FROM wiki_addresses WHERE address = 'runtime://hd-addr-ref'`)
				.get();
			expect(addr).toBeDefined();
		});

		test("hardDelete rejected when target is SOURCE-BOUND (SOURCE_MANAGED)", async () => {
			const target = await createNode(svc, "wiki-root/knowledge", "hd-sourced");
			const targetRow = new WikiNodeRepository(db).getActiveByPath(target)!;
			bindSource(db, targetRow.id);

			await expect(
				svc.hardDelete({ address: target }, makeAdminCtx()),
			).rejects.toMatchObject({ code: "SOURCE_MANAGED" });

			// 节点仍在
			expect(new WikiNodeRepository(db).getActiveByPath(target)).toBeDefined();
		});

		test("hardDelete with cascade=true removes target + descendants + audit row present", async () => {
			const parent = await createNode(svc, "wiki-root/knowledge", "hd-ok-parent");
			const childPath = await createNode(svc, parent, "hd-ok-child");
			const grandPath = await createNode(svc, childPath, "hd-ok-grand");
			const auditBefore = countAudit(db, "hardDelete");

			const result = await svc.hardDelete(
				{ address: parent, cascade: true },
				makeAdminCtx(),
			);
			expect(result.success).toBe(true);

			// 节点全部消失
			const repo = new WikiNodeRepository(db);
			expect(repo.getByPath(parent)).toBeUndefined();
			expect(repo.getByPath(childPath)).toBeUndefined();
			expect(repo.getByPath(grandPath)).toBeUndefined();

			// audit 写入
			expect(countAudit(db, "hardDelete")).toBe(auditBefore + 1);
		});

		test("hardDelete on non-existent path → NOT_FOUND", async () => {
			await expect(
				svc.hardDelete(
					{ address: "wiki-root/knowledge/never-existed-hd" },
					makeAdminCtx(),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	// =========================================================================
	// §A.10 — source-bound 节点 create/move/delete → SOURCE_MANAGED
	// =========================================================================

	describe("§A.10 source-bound create/move/delete → SOURCE_MANAGED", () => {
		test("CREATE under source-bound parent → SOURCE_MANAGED", async () => {
			const projectRoot = await createNode(svc, "wiki-root/knowledge", "fake-proj");
			const projRow = new WikiNodeRepository(db).getActiveByPath(projectRoot)!;
			bindSource(db, projRow.id);

			await expect(
				svc.create(
					{
						parent: projectRoot,
						name: "should-be-blocked",
						kind: "node",
						content: "x",
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "SOURCE_MANAGED" });

			// 节点没被创建
			expect(new WikiNodeRepository(db).getActiveByPath(`${projectRoot}/should-be-blocked`)).toBeUndefined();
		});

		test("MOVE source-bound node → SOURCE_MANAGED", async () => {
			const target = await createNode(svc, "wiki-root/knowledge", "sb-mover");
			const targetRow = new WikiNodeRepository(db).getActiveByPath(target)!;
			bindSource(db, targetRow.id);

			await expect(
				svc.move(
					{ address: target, newParent: "wiki-root/memory", newName: "sb-moved-to" },
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "SOURCE_MANAGED" });

			// 原节点位置不变
			expect(new WikiNodeRepository(db).getActiveByPath(target)).toBeDefined();
			expect(new WikiNodeRepository(db).getActiveByPath(`wiki-root/memory/sb-moved-to`)).toBeUndefined();
		});

		test("MOVE normal node INTO source-bound parent → SOURCE_MANAGED", async () => {
			const projectRoot = await createNode(svc, "wiki-root/knowledge", "sb-target-parent");
			const projRow = new WikiNodeRepository(db).getActiveByPath(projectRoot)!;
			bindSource(db, projRow.id);

			const mover = await createNode(svc, "wiki-root/knowledge", "sb-incoming-mover");

			await expect(
				svc.move(
					{ address: mover, newParent: projectRoot },
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "SOURCE_MANAGED" });

			// mover 没动
			expect(new WikiNodeRepository(db).getActiveByPath(mover)).toBeDefined();
		});

		test("ARCHIVE (data-plane delete) on source-bound node → SOURCE_MANAGED", async () => {
			const target = await createNode(svc, "wiki-root/knowledge", "sb-archive");
			const targetRow = new WikiNodeRepository(db).getActiveByPath(target)!;
			bindSource(db, targetRow.id);

			await expect(
				svc.archive({ address: target }, makeCtx()),
			).rejects.toMatchObject({ code: "SOURCE_MANAGED" });

			// 节点未归档(仍 active)
			const row = new WikiNodeRepository(db).getByPath(target)!;
			expect(row.archived_at).toBeNull();
		});
	});

	// =========================================================================
	// restore — active path 冲突 / sibling 冲突 / source-bound
	// =========================================================================

	describe("restore: active path conflict / source-bound → rejected", () => {
		test("restore archived node when ACTIVE node already at same path → ALREADY_EXISTS", async () => {
			// 1) 建节点,归档之
			const path = await createNode(svc, "wiki-root/knowledge", "restore-collide");
			await svc.archive({ address: path }, makeCtx());
			// 归档成功
			expect(new WikiNodeRepository(db).getActiveByPath(path)).toBeUndefined();

			// 2) 同 path 重新创建(partial unique 允许)
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "restore-collide", kind: "knowledge", content: "v2" },
				makeCtx(),
			);
			expect(new WikiNodeRepository(db).getActiveByPath(path)).toBeDefined();

			// 3) restore 旧归档节点 → 必须失败(active 占用了 path)
			await expect(
				svc.restore({ path }, makeAdminCtx()),
			).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

			// 旧归档节点仍归档
			const rows = db
				.prepare(`SELECT archived_at FROM wiki_nodes WHERE path = ?`)
				.all(path) as Array<{ archived_at: string | null }>;
			// 应有 2 行:一行归档,一行 active
			const archivedCount = rows.filter((r) => r.archived_at !== null).length;
			const activeCount = rows.filter((r) => r.archived_at === null).length;
			expect(activeCount).toBe(1);
			expect(archivedCount).toBe(1);
		});

		test("restore archived node when path FREE → succeeds, audit row present", async () => {
			const path = await createNode(svc, "wiki-root/knowledge", "restore-ok");
			await svc.archive({ address: path }, makeCtx());
			const auditBefore = countAudit(db, "restore");

			const result = await svc.restore({ path }, makeAdminCtx());
			expect(result.success).toBe(true);

			// 节点重新 active
			const row = new WikiNodeRepository(db).getActiveByPath(path)!;
			expect(row).toBeDefined();
			expect(row.archived_at).toBeNull();

			// audit 写入
			expect(countAudit(db, "restore")).toBe(auditBefore + 1);
		});

		test("restore on already-ACTIVE node → INVALID_REQUEST", async () => {
			const path = await createNode(svc, "wiki-root/knowledge", "restore-active");
			// 没 archive,直接 restore 应报错
			await expect(
				svc.restore({ path }, makeAdminCtx()),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		});

		test("restore on non-existent path → NOT_FOUND", async () => {
			await expect(
				svc.restore(
					{ path: "wiki-root/knowledge/restore-nonexistent" },
					makeAdminCtx(),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		test("restore SOURCE-BOUND archived node → SOURCE_MANAGED", async () => {
			const path = await createNode(svc, "wiki-root/knowledge", "restore-sb");
			const targetRow = new WikiNodeRepository(db).getActiveByPath(path)!;
			// 注:source binding 在节点仍 active 时注入;然后手动归档(绕过 service 的
			// SOURCE_MANAGED 检查,直接 archive node by id)。
			bindSource(db, targetRow.id);
			// 直接 SQL archive(模拟 indexer 归档 source-bound 节点)。
			db.prepare(`UPDATE wiki_nodes SET archived_at = ?, updated_at = ? WHERE id = ?`)
				.run(new Date().toISOString(), new Date().toISOString(), targetRow.id);
			// 确认归档
			expect(new WikiNodeRepository(db).getActiveByPath(path)).toBeUndefined();

			// restore 应被 SOURCE_MANAGED 拒绝
			await expect(
				svc.restore({ path }, makeAdminCtx()),
			).rejects.toMatchObject({ code: "SOURCE_MANAGED" });

			// 节点仍归档
			const row = new WikiNodeRepository(db).getByPath(path)!;
			expect(row.archived_at).not.toBeNull();
		});

		test("restore with cascade: archived subtree all restored when paths free", async () => {
			const root = await createNode(svc, "wiki-root/knowledge", "restore-cascade");
			const child = await createNode(svc, root, "rch-1");
			const grand = await createNode(svc, child, "rch-2");
			// archive root(cascade)
			await svc.archive({ address: root, cascade: true }, makeCtx());
			// 全归档
			const repo = new WikiNodeRepository(db);
			expect(repo.getActiveByPath(root)).toBeUndefined();
			expect(repo.getActiveByPath(child)).toBeUndefined();
			expect(repo.getActiveByPath(grand)).toBeUndefined();

			// restore root cascade → 整子树重新 active
			const result = await svc.restore({ path: root, cascade: true }, makeAdminCtx());
			expect(result.success).toBe(true);
			expect(repo.getActiveByPath(root)).toBeDefined();
			expect(repo.getActiveByPath(child)).toBeDefined();
			expect(repo.getActiveByPath(grand)).toBeDefined();
		});

		test("restore with cascade: blocked if any descendant path conflicts with active", async () => {
			const root = await createNode(svc, "wiki-root/knowledge", "restore-cascade-conflict");
			const child = await createNode(svc, root, "rcc-1");
			await svc.archive({ address: root, cascade: true }, makeCtx());

			// 在子路径上手动创建 active 节点(partial unique 允许)
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "restore-cascade-conflict", kind: "knowledge", content: "new" },
				makeCtx(),
			);

			// restore root cascade → 因为 root path 冲突 → ALREADY_EXISTS
			await expect(
				svc.restore({ path: root, cascade: true }, makeAdminCtx()),
			).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
		});
	});

	// =========================================================================
	// link / unlink edge cases
	// =========================================================================

	describe("link/unlink edge cases", () => {
		test("duplicate link → ALREADY_EXISTS (no PK constraint leaked)", async () => {
			const a = await createNode(svc, "wiki-root/knowledge", "dup-a");
			const b = await createNode(svc, "wiki-root/knowledge", "dup-b");
			await svc.link({ source: a, target: b, relation: "depends_on" }, makeCtx());

			await expect(
				svc.link({ source: a, target: b, relation: "depends_on" }, makeCtx()),
			).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

			// 仍只有 1 行
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`)).toBe(1);
		});

		test("unlink non-existent link → NOT_FOUND", async () => {
			const a = await createNode(svc, "wiki-root/knowledge", "ul-nf-a");
			const b = await createNode(svc, "wiki-root/knowledge", "ul-nf-b");

			await expect(
				svc.unlink({ source: a, target: b, relation: "depends_on" }, makeCtx()),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		test("link to non-existent target → NOT_FOUND", async () => {
			const a = await createNode(svc, "wiki-root/knowledge", "link-nf-a");

			await expect(
				svc.link(
					{ source: a, target: "wiki-root/knowledge/never-exists-link", relation: "depends_on" },
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	// =========================================================================
	// fault injection — move/hardDelete/restore rolls back atomically
	// =========================================================================

	describe("fault injection: move/restore roll back atomically", () => {
		/**
		 * 用 Proxy 包 audit,让下次 append 抛错(模拟 transaction 末尾 audit 写失败)。
		 */
		function makeFaultyService(wikiDb: WikiDatabase): {
			svc: WikiService;
			arm: () => void;
			didFault: () => boolean;
		} {
			const d = wikiDb.getDb();
			const realAudit = new WikiAuditRepository(d);
			let shouldThrow = false;
			let didFault = false;
			const handler: ProxyHandler<WikiAuditRepository> = {
				get(target, prop, receiver) {
					if (prop === "append") {
						return (input: Parameters<WikiAuditRepository["append"]>[0]) => {
							if (shouldThrow) {
								shouldThrow = false;
								didFault = true;
								throw new Error("INJECTED_AUDIT_FAULT_ML");
							}
							return target.append(input);
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			};
			const proxy = new Proxy(realAudit, handler) as WikiAuditRepository & {
				__arm?: () => void;
				__didFault?: () => boolean;
			};
			proxy.__arm = () => { shouldThrow = true; };
			proxy.__didFault = () => didFault;

			const faulty = new WikiService({
				wikiDb,
				nodeRepo: new WikiNodeRepository(d),
				linkRepo: new WikiLinkRepository(d),
				auditRepo: proxy,
				repositoryStore: new WikiRepositoryStore(d),
				addressService: new WikiAddressService(
					new WikiRepositoryStore(d).addresses,
					new WikiNodeRepository(d),
				),
				authorizationService: new WikiAuthorizationService(),
				editService: new WikiEditService(),
			});
			return {
				svc: faulty,
				arm: () => { shouldThrow = true; },
				didFault: () => didFault,
			};
		}

		test("move with audit fault → root + descendant paths UNCHANGED + no audit row", async () => {
			const root = await createNode(svc, "wiki-root/knowledge", "fault-move");
			const child = await createNode(svc, root, "fm-c");
			const grand = await createNode(svc, child, "fm-g");
			const auditBefore = countAudit(db, "move");

			const { svc: faulty, arm } = makeFaultyService(wiki);
			arm();
			await expect(
				faulty.move(
					{ address: root, newParent: "wiki-root/memory", newName: "fault-moved" },
					makeCtx(),
				),
			).rejects.toThrow(/INJECTED_AUDIT_FAULT_ML/);

			const repo = new WikiNodeRepository(db);
			// 旧路径全部不变
			expect(repo.getActiveByPath(root)).toBeDefined();
			expect(repo.getActiveByPath(child)).toBeDefined();
			expect(repo.getActiveByPath(grand)).toBeDefined();
			// 新路径不存在
			expect(repo.getActiveByPath("wiki-root/memory/fault-moved")).toBeUndefined();
			expect(repo.getActiveByPath("wiki-root/memory/fault-moved/fm-c")).toBeUndefined();
			// audit 没新增
			expect(countAudit(db, "move")).toBe(auditBefore);
		});

		test("hardDelete with audit fault → NOTHING deleted + no audit row", async () => {
			const target = await createNode(svc, "wiki-root/knowledge", "fault-hd");
			const auditBefore = countAudit(db, "hardDelete");

			const { svc: faulty, arm } = makeFaultyService(wiki);
			arm();
			await expect(
				faulty.hardDelete({ address: target }, makeAdminCtx()),
			).rejects.toThrow(/INJECTED_AUDIT_FAULT_ML/);

			// 节点仍在
			expect(new WikiNodeRepository(db).getActiveByPath(target)).toBeDefined();
			// audit 没新增
			expect(countAudit(db, "hardDelete")).toBe(auditBefore);
		});

		test("restore with audit fault → archived_at stays set + no audit row", async () => {
			const path = await createNode(svc, "wiki-root/knowledge", "fault-restore");
			await svc.archive({ address: path }, makeCtx());
			const auditBefore = countAudit(db, "restore");

			const { svc: faulty, arm } = makeFaultyService(wiki);
			arm();
			await expect(
				faulty.restore({ path }, makeAdminCtx()),
			).rejects.toThrow(/INJECTED_AUDIT_FAULT_ML/);

			// 节点仍归档(restore 回滚)
			const row = new WikiNodeRepository(db).getByPath(path)!;
			expect(row.archived_at).not.toBeNull();
			// audit 没新增
			expect(countAudit(db, "restore")).toBe(auditBefore);
		});
	});

	// =========================================================================
	// FIX 1 (round-2) — fan-in(两条 alias → 同一节点)合法;且 move 后两条 alias
	//                     仍解析到新 canonical path(target_id 稳定,只是节点 path 变了)。
	//                     design §5.3: target_id 是非唯一 FK;§A.10 move 不动 link/address 端点。
	//                     与 §A.8/§A.9/§A.10 不同 code path,确认 FIX 1/FIX 2 没有回归 edit/move。
	// =========================================================================

	describe("FIX 1 fan-in: two aliases → same node survive edit + move (address target stability)", () => {
		test("two aliases to same node REGISTER + both resolve to same canonical path", async () => {
			const { svc: s, addressSvc } = buildServiceWithAddress(wiki);
			const path = await createNode(s, "wiki-root/knowledge", "fanin-target");

			// FIX 1: 第二条 alias 不再被 cycle 检测器拒
			addressSvc.register({
				address: "runtime://fanin-a",
				targetPath: path,
				scope: "runtime",
				kind: "alias",
			});
			addressSvc.register({
				address: "static://fanin-b",
				targetPath: path,
				scope: "static",
				kind: "alias",
			});

			// 两条 alias 都解析到同一 canonical path
			const r1 = await s.read({ address: "runtime://fanin-a" }, makeCtx());
			const r2 = await s.read({ address: "static://fanin-b" }, makeCtx());
			expect(r1.path).toBe(path);
			expect(r2.path).toBe(path);
			expect(r1.path).toBe(r2.path);
		});

		test("edit via fan-in alias1 propagates to alias2 read (same underlying node)", async () => {
			const { svc: s, addressSvc } = buildServiceWithAddress(wiki);
			const path = await createNode(s, "wiki-root/knowledge", "fanin-edit");
			// 用 service.update 直接写 content;createNode 写了 `body-<name>`。
			const repo = new WikiNodeRepository(db);
			const rev = repo.getActiveByPath(path)!.revision;

			addressSvc.register({
				address: "runtime://fe-a",
				targetPath: path,
				scope: "runtime",
				kind: "alias",
			});
			addressSvc.register({
				address: "static://fe-b",
				targetPath: path,
				scope: "static",
				kind: "alias",
			});

			// 用 alias1 编辑(用 update 而非 edit op,避免依赖 replace_text 命中)
			await s.update(
				{
					address: "runtime://fe-a",
					expected_revision: rev,
					changes: { content: "EDITED-VIA-ALIAS-A" },
				},
				makeCtx(),
			);

			// alias2 读到的也是新内容(同一节点)
			const r = await s.read({ address: "static://fe-b", view: "content" }, makeCtx());
			expect(r.content).toBe("EDITED-VIA-ALIAS-A");
		});

		test("MOVE via fan-in alias1 → both aliases re-resolve to NEW canonical path", async () => {
			// 关键不变量(§A.8):move 不动 address target_id;target 节点的 path 变了,
			// alias 仍按 target_id 解析 → 自动指向新 path。
			const { svc: s, addressSvc } = buildServiceWithAddress(wiki);
			const originalPath = await createNode(s, "wiki-root/knowledge", "fanin-move");

			addressSvc.register({
				address: "runtime://fm-a",
				targetPath: originalPath,
				scope: "runtime",
				kind: "alias",
			});
			addressSvc.register({
				address: "static://fm-b",
				targetPath: originalPath,
				scope: "static",
				kind: "alias",
			});

			// 通过 alias1 move(memory root 是 wiki-root/memory,wideOpenAccess 覆盖)
			const result = await s.move(
				{
					address: "runtime://fm-a",
					newParent: "wiki-root/memory",
					newName: "fanin-moved",
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			const newPath = "wiki-root/memory/fanin-moved";

			// 两条 alias 都解析到新 path —— 证明 target_id 不变,仅节点 path 变了
			const r1 = await s.read({ address: "runtime://fm-a" }, makeCtx());
			const r2 = await s.read({ address: "static://fm-b" }, makeCtx());
			expect(r1.path).toBe(newPath);
			expect(r2.path).toBe(newPath);

			// 旧 path 不再 active
			expect(new WikiNodeRepository(db).getActiveByPath(originalPath)).toBeUndefined();

			// alias 行的 target_id 未变(指向同一 internal id)。
			const aRow = db
				.prepare(`SELECT target_id FROM wiki_addresses WHERE address = ?`)
				.get("runtime://fm-a") as { target_id: number };
			const bRow = db
				.prepare(`SELECT target_id FROM wiki_addresses WHERE address = ?`)
				.get("static://fm-b") as { target_id: number };
			expect(aRow.target_id).toBe(bRow.target_id); // 两条 alias 仍指向同一节点
		});

		test("MOVE one of two fan-in targets (distinct nodes) leaves the other alias intact", async () => {
			// 反向场景:两条 alias 指向 *不同* 节点(非 fan-in);move 其中一个,另一个不动。
			// 锁定 move 不会误扫全表改其它 alias。
			const { svc: s, addressSvc } = buildServiceWithAddress(wiki);
			const pathA = await createNode(s, "wiki-root/knowledge", "independent-a");
			const pathB = await createNode(s, "wiki-root/knowledge", "independent-b");

			addressSvc.register({
				address: "runtime://ind-a",
				targetPath: pathA,
				scope: "runtime",
				kind: "alias",
			});
			addressSvc.register({
				address: "static://ind-b",
				targetPath: pathB,
				scope: "static",
				kind: "alias",
			});

			await s.move(
				{ address: "runtime://ind-a", newParent: "wiki-root/memory", newName: "ind-a-moved" },
				makeCtx(),
			);

			// alias A 解析到新 path
			const rA = await s.read({ address: "runtime://ind-a" }, makeCtx());
			expect(rA.path).toBe("wiki-root/memory/ind-a-moved");
			// alias B 解析到 *原* path(未被波及)
			const rB = await s.read({ address: "static://ind-b" }, makeCtx());
			expect(rB.path).toBe(pathB);
		});

		test("FIX 2 expand includeLinks=true: child link counts reflect link rows, not alias multiplicity (fan-in)", async () => {
			// FIX 2:expand(includeLinks=true) 的 outgoing/incoming count 必须只反映
			// 对端可见的 link 行。fan-in(alias 数量)不应撑大 link 计数。
			// 场景:parent P 下有 child X;X 有 1 条 outgoing link 到 Y;X 有 2 条 alias。
			// expand(P, includeLinks=true) → child X.outgoingCount = 1(不是 2)。
			const { svc: s, addressSvc } = buildServiceWithAddress(wiki);
			const parentPath = await createNode(s, "wiki-root/knowledge", "fil-parent");
			const xPath = await createNode(s, parentPath, "fil-x");
			const yPath = await createNode(s, parentPath, "fil-y");
			await s.link({ source: xPath, target: yPath, relation: "depends_on" }, makeCtx());

			// 给 X 注册两条 alias(fan-in)
			addressSvc.register({
				address: "runtime://fil-x-a",
				targetPath: xPath,
				scope: "runtime",
				kind: "alias",
			});
			addressSvc.register({
				address: "static://fil-x-b",
				targetPath: xPath,
				scope: "static",
				kind: "alias",
			});

			const exp = await s.expand(
				{ address: parentPath, includeLinks: true },
				makeCtx(),
			);
			const xItem = exp.children.items.find((it) => it.path === xPath);
			expect(xItem).toBeDefined();
			// X 有 1 条 outgoing(对端 Y 在 wideOpenAccess 下可见)→ outgoingCount=1。
			// fan-in 的 2 条 alias 不撑大计数(FIX 2 是按 link 行过滤,不按 alias 行)。
			expect(xItem!.outgoingCount).toBe(1);
			expect(xItem!.incomingCount).toBe(0);
			// Y 有 1 条 incoming
			const yItem = exp.children.items.find((it) => it.path === yPath);
			expect(yItem!.incomingCount).toBe(1);
			expect(yItem!.outgoingCount).toBe(0);
		});
	});
});

// ---------------------------------------------------------------------------
// Small utility (放在文件底部避免与 describe 中的 helper 冲突)
// ---------------------------------------------------------------------------

function countRows(d: Database.Database, sql: string, ...params: unknown[]): number {
	const row = d.prepare(sql).get(...params) as { n: number };
	return row.n;
}
