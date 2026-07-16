// wiki-system-redesign sub-02 acceptance — 规约 (service-contract) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-02 §A.1 / §A.2 / §A.3 / §A.7 + §D.1 / §D.2 / §D.3
// (transactions / revision / CRUD atomicity / memory root lifecycle)。
// 本文件从**service 契约**视角断言 WikiService 数据面操作的事务/并发/记忆
// 根语义,所有断言用**真临时 SQLite DB**:
//   - §A.1 create/update/archive/link/unlink/move 每个成功 op 原子更新
//     node + FTS + audit ( wiki_links 对应 link/unlink )。
//   - §A.2 fault injection:wikiDb.transaction 内部最后一步 audit.append 抛错
//     → node / wiki_links / FTS / audit 全部回到提交前状态。
//   - §A.3 update 正确 expected_revision → revision 恰好 +1;错误 expected_revision
//     → 完全无写入 + WRITE_CONFLICT。
//   - §A.7 move 更新整棵后代 materialized path;wiki_links.source_id/target_id
//     不变;wiki_addresses.target_id 不变;alias 解析到新 path;仅根 revision+1;
//     后代 revision AND updated_at 不变。
//   - §D.1 ensureAgentMemoryRoot 同一 stable agentId 多次调用幂等(无 revision
//     bump / 无重复节点);displayName 变化只改 display_name/summary,不改 path。
//   - §D.2 ensureAgentMemoryRoot 不创建固定子树(preferences/lessons)。
//   - §D.3 archiveAgentMemoryRoot 归档(archived_at),不硬删历史。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db(vi.hoisted,sub-00 教训)。
//   - 每个 test 在自己的 mkdtemp 子目录开 fresh wiki.db,无跨 test 状态污染。
//
// ## 输出
// Vitest 用例。每用例开真 SQLite temp DB,绝不读活跃 ~/.zero-core。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - fault injection 必须真触发 transaction rollback,不能只 mock authorization。
//   - 跨 lens 隔离:vi.hoisted 用唯一前缀 `zc-wiki-v2-svc-`,wiki.db 路径每 test 独有。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
// UNIQUE ZERO_CORE_DIR per file. vi.hoisted runs BEFORE any other import so
// config.ts / database-paths.ts constants resolve under OUR temp dir.
// UNIQUE_DIR 是本 file 的根 temp;每个 test 在其下再开 mkdtemp 子目录放
// 独立的 wiki.db,确保 test 之间完全隔离。
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-svc-"));
	process.env.ZERO_CORE_DIR = d;
	// sub-01 教训:better-sqlite3 在 test worker 退出时 WAL checkpoint 偶发卡死,
	// 用 MEMORY journal mode 绕开(database.ts 构造器读到本 env 切换)。
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
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
	WikiAction,
} from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 全权限 grant (wiki-root 及所有后代) —— 本 lens 聚焦事务/规约,不做授权边界测试。 */
function wideOpenAccess(): CompiledWikiAccess {
	const allActions: WikiAction[] = [
		"expand",
		"read",
		"search",
		"create",
		"update",
		"delete",
		"link",
		"unlink",
		"move",
	];
	return {
		agentId: "test-agent",
		grants: [
			{
				canonicalScope: "wiki-root",
				actions: allActions,
			},
		],
		policyRevision: 1,
	};
}

function makeCtx(): WikiRequestContext {
	return {
		access: wideOpenAccess(),
		agentId: "test-agent",
		activeProjectId: undefined,
		sessionId: "test-session",
		requestId: null,
	};
}

/**
 * 包装 WikiAuditRepository,提供 armFault() 让下一次 append 抛错。用于 §A.2
 * fault injection:服务在 transaction 内做完 node + FTS + (link) 写入后调
 * audit.append,我们让它抛错,验证整个 transaction 回滚。
 *
 * 用 Proxy 拦截 `append`,其它方法透传到真实实例。
 */
function makeControllableAudit(real: WikiAuditRepository): WikiAuditRepository & {
	armFault: () => void;
	faulted: () => boolean;
} {
	let shouldThrowNext = false;
	let didFault = false;
	const handler: ProxyHandler<WikiAuditRepository> = {
		get(target, prop, receiver) {
			if (prop === "append") {
				return (input: Parameters<WikiAuditRepository["append"]>[0]) => {
					if (shouldThrowNext) {
						shouldThrowNext = false;
						didFault = true;
						throw new Error("INJECTED_AUDIT_FAULT");
					}
					return target.append(input);
				};
			}
			if (prop === "armFault") {
				return () => {
					shouldThrowNext = true;
				};
			}
			if (prop === "faulted") {
				return () => didFault;
			}
			return Reflect.get(target, prop, receiver);
		},
	};
	return new Proxy(real, handler) as WikiAuditRepository & {
		armFault: () => void;
		faulted: () => boolean;
	};
}

/**
 * 用显式 deps 构造 WikiService。auditOverride 用于注入 fault-injecting audit。
 */
function buildService(
	wikiDb: WikiDatabase,
	auditOverride?: WikiAuditRepository,
): WikiService {
	const db = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const linkRepo = new WikiLinkRepository(db);
	const auditRepo = auditOverride ?? new WikiAuditRepository(db);
	const repositoryStore = new WikiRepositoryStore(db);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const editService = new WikiEditService();
	return new WikiService({
		wikiDb,
		nodeRepo,
		linkRepo,
		auditRepo,
		repositoryStore,
		addressService,
		authorizationService,
		editService,
	});
}

/** 直接 SQL 计数 (避免每开一个 repository 实例)。 */
function countRows(db: Database.Database, sql: string, ...params: unknown[]): number {
	const row = db.prepare(sql).get(...params) as { n: number };
	return row.n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wiki-v2 service contract [规约 lens]", () => {
	let wiki: WikiDatabase;
	let db: Database.Database;
	let svc: WikiService;
	let auditWithFault: ReturnType<typeof makeControllableAudit> | undefined;
	let tempDir: string;

	beforeEach(() => {
		// 每 test 自己的 mkdtemp 子目录 + 自己的 wiki.db,跨 test 0 共享。
		tempDir = mkdtempSync(join(UNIQUE_DIR, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
		const wikiPath = join(tempDir, "wiki.db");
		wiki = new WikiDatabase(wikiPath);
		db = wiki.getDb();
		auditWithFault = undefined;
		svc = buildService(wiki);
	});

	afterEach(() => {
		try {
			wiki.close();
		} catch {
			/* idempotent */
		}
	});

	// =========================================================================
	// §A.1 — 每个数据面写操作原子更新 node + FTS + audit (link/unlink 是 wiki_links)
	// =========================================================================

	describe("§A.1 atomic mutation per op (node + FTS + audit change together)", () => {
		test("create: node inserted + FTS queryable + audit row present", async () => {
			const auditBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`);
			const ftsBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes_fts`);
			const nodeBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes`);

			const result = await svc.create(
				{
					parent: "wiki-root/knowledge",
					name: "alpha-doc",
					summary: "alpha summary bravo",
					content: "alpha content charlie bravo",
					kind: "knowledge",
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.path).toBe("wiki-root/knowledge/alpha-doc");
			expect(result.revision).toBe(1);
			expect(result.auditId).toBeTruthy();

			// node 写入:wiki_nodes 多了一行 (bootstrap 4 + 1 = 5)
			const nodeAfter = countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes`);
			expect(nodeAfter).toBe(nodeBefore + 1);

			// FTS 写入:wiki_nodes_fts 多了一行,且可按 content token 查询
			const ftsAfter = countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes_fts`);
			expect(ftsAfter).toBe(ftsBefore + 1);
			const nodeRepo = new WikiNodeRepository(db);
			const ftsHits = nodeRepo.searchFts("alpha", 10);
			expect(ftsHits.some((r) => r.path === "wiki-root/knowledge/alpha-doc")).toBe(true);

			// audit 写入:多了一条 action=create 的记录
			const auditAfter = countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`);
			expect(auditAfter).toBe(auditBefore + 1);
			const auditRepo = new WikiAuditRepository(db);
			const audits = auditRepo.listByNodePath("wiki-root/knowledge/alpha-doc", 10);
			expect(audits.some((a) => a.action === "create")).toBe(true);
		});

		test("update: node revision bumped + FTS reflects new content + audit row present", async () => {
			// 准备:创建一个 node
			await svc.create(
				{
					parent: "wiki-root/knowledge",
					name: "update-target",
					summary: "old summary fox",
					content: "old content giraffe",
					kind: "knowledge",
				},
				makeCtx(),
			);
			const auditBefore = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'update'`,
			);

			const result = await svc.update(
				{
					address: "wiki-root/knowledge/update-target",
					expected_revision: 1,
					changes: {
						summary: "new summary hippo",
						content: "new content iguana",
					},
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.revision).toBe(2);
			expect(result.oldRevision).toBe(1);

			// node revision: 1 → 2,字段已更新
			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/knowledge/update-target");
			expect(node).toBeDefined();
			expect(node!.revision).toBe(2);
			expect(node!.summary).toBe("new summary hippo");
			expect(node!.content).toBe("new content iguana");

			// FTS 反映新内容:新 token 命中,旧 token 不再命中
			expect(nodeRepo.searchFts("iguana", 10).some((r) => r.id === node!.id)).toBe(true);
			expect(nodeRepo.searchFts("giraffe", 10).some((r) => r.id === node!.id)).toBe(false);

			// audit 写入
			const auditAfter = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'update'`,
			);
			expect(auditAfter).toBe(auditBefore + 1);
		});

		test("archive: node archived_at set + FTS still queryable (archived row stays indexed) + audit row present", async () => {
			await svc.create(
				{
					parent: "wiki-root/knowledge",
					name: "archive-target",
					summary: "archive summary jaguar",
					content: "archive content krypto",
					kind: "knowledge",
				},
				makeCtx(),
			);
			const auditBefore = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'archive'`,
			);

			const result = await svc.archive(
				{ address: "wiki-root/knowledge/archive-target" },
				makeCtx(),
			);

			expect(result.success).toBe(true);

			// node archived_at 被置 (用 getByPath 而非 getActiveByPath 因为后者会过滤)
			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getByPath("wiki-root/knowledge/archive-target");
			expect(node).toBeDefined();
			expect(node!.archived_at).not.toBeNull();

			// FTS 仍可查到归档节点内容 (archive 不动 FTS 索引项)
			expect(nodeRepo.searchFts("krypto", 10).some((r) => r.id === node!.id)).toBe(true);

			// audit 写入
			const auditAfter = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'archive'`,
			);
			expect(auditAfter).toBe(auditBefore + 1);
		});

		test("link: wiki_links row inserted + audit row present", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "link-src", kind: "knowledge", content: "src" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "link-dst", kind: "knowledge", content: "dst" },
				makeCtx(),
			);
			const linkBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`);
			const auditBefore = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'link'`,
			);

			const result = await svc.link(
				{
					source: "wiki-root/knowledge/link-src",
					target: "wiki-root/knowledge/link-dst",
					relation: "depends_on",
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.path).toBe("wiki-root/knowledge/link-src");
			expect(result.auditId).toBeTruthy();

			// wiki_links 多了一行
			const linkAfter = countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`);
			expect(linkAfter).toBe(linkBefore + 1);

			// audit 多了一条 action=link 记录
			const auditAfter = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'link'`,
			);
			expect(auditAfter).toBe(auditBefore + 1);
		});

		test("unlink: wiki_links row removed + audit row present", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "ul-src", kind: "knowledge", content: "s" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "ul-dst", kind: "knowledge", content: "d" },
				makeCtx(),
			);
			await svc.link(
				{
					source: "wiki-root/knowledge/ul-src",
					target: "wiki-root/knowledge/ul-dst",
					relation: "depends_on",
				},
				makeCtx(),
			);
			const auditBefore = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'unlink'`,
			);

			const result = await svc.unlink(
				{
					source: "wiki-root/knowledge/ul-src",
					target: "wiki-root/knowledge/ul-dst",
					relation: "depends_on",
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);

			// wiki_links 回到 0 行 (本 test 只创建了一条)
			const linkAfter = countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`);
			expect(linkAfter).toBe(0);

			// audit 写入
			const auditAfter = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'unlink'`,
			);
			expect(auditAfter).toBe(auditBefore + 1);
		});

		test("move: node path updated + FTS reflects new name/path + audit row present", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "move-target", kind: "knowledge", content: "move content lima" },
				makeCtx(),
			);
			const auditBefore = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'move'`,
			);

			const result = await svc.move(
				{
					address: "wiki-root/knowledge/move-target",
					newParent: "wiki-root/memory",
					newName: "moved-node",
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.path).toBe("wiki-root/memory/moved-node");
			expect(result.revision).toBe(2); // move bumps root revision

			// node 路径已更新,旧路径无 active 节点
			const nodeRepo = new WikiNodeRepository(db);
			expect(nodeRepo.getActiveByPath("wiki-root/knowledge/move-target")).toBeUndefined();
			const moved = nodeRepo.getActiveByPath("wiki-root/memory/moved-node");
			expect(moved).toBeDefined();
			expect(moved!.revision).toBe(2);

			// FTS 仍可查到 (update 内部已 resync FTS)
			expect(nodeRepo.searchFts("lima", 10).some((r) => r.id === moved!.id)).toBe(true);

			// audit 写入
			const auditAfter = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'move'`,
			);
			expect(auditAfter).toBe(auditBefore + 1);
		});
	});

	// =========================================================================
	// §A.2 — fault injection: audit.append 抛错 → node + link + FTS + audit 全回滚
	// =========================================================================

	describe("§A.2 fault injection: node + link + FTS + audit roll back together", () => {
		function buildServiceWithFaultyAudit(): {
			svc: WikiService;
			audit: ReturnType<typeof makeControllableAudit>;
		} {
			const realAudit = new WikiAuditRepository(db);
			const audit = makeControllableAudit(realAudit);
			return { svc: buildService(wiki, audit), audit };
		}

		test("create rolls back node + FTS + audit when audit throws", async () => {
			const { svc, audit } = buildServiceWithFaultyAudit();
			const nodeBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes`);
			const ftsBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes_fts`);
			const auditBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`);

			audit.armFault();
			await expect(
				svc.create(
					{
						parent: "wiki-root/knowledge",
						name: "faulted-create",
						summary: "faulted summary",
						content: "faulted content mike",
						kind: "knowledge",
					},
					makeCtx(),
				),
			).rejects.toThrow(/INJECTED_AUDIT_FAULT/);

			expect(audit.faulted()).toBe(true);

			// 全部回滚到提交前
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes`)).toBe(nodeBefore);
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_nodes_fts`)).toBe(ftsBefore);
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`)).toBe(auditBefore);

			// 路径不应存在
			const nodeRepo = new WikiNodeRepository(db);
			expect(nodeRepo.getActiveByPath("wiki-root/knowledge/faulted-create")).toBeUndefined();
			// FTS 不应能查到 mike
			expect(nodeRepo.searchFts("mike", 10).length).toBe(0);
		});

		test("update rolls back node + FTS + audit when audit throws (OLD content preserved)", async () => {
			// 先用一个干净的 svc 创建节点 (audit 正常)
			await svc.create(
				{
					parent: "wiki-root/knowledge",
					name: "faulted-update",
					summary: "stable summary november",
					content: "stable content oscar",
					kind: "knowledge",
				},
				makeCtx(),
			);
			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/knowledge/faulted-update")!;
			const revBefore = node.revision;
			const auditBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`);

			// 切到 faulty svc
			const { svc: faultySvc, audit } = buildServiceWithFaultyAudit();
			audit.armFault();
			await expect(
				faultySvc.update(
					{
						address: "wiki-root/knowledge/faulted-update",
						expected_revision: revBefore,
						changes: {
							summary: "transient summary papa",
							content: "transient content quebec",
						},
					},
					makeCtx(),
				),
			).rejects.toThrow(/INJECTED_AUDIT_FAULT/);

			// node 回滚:revision/summary/content 不变
			const nodeAfter = nodeRepo.getActiveByPath("wiki-root/knowledge/faulted-update")!;
			expect(nodeAfter.revision).toBe(revBefore);
			expect(nodeAfter.summary).toBe("stable summary november");
			expect(nodeAfter.content).toBe("stable content oscar");

			// FTS 回滚:新 token 不可查,旧 token 仍可查
			expect(nodeRepo.searchFts("quebec", 10).length).toBe(0);
			expect(nodeRepo.searchFts("oscar", 10).some((r) => r.id === nodeAfter.id)).toBe(true);

			// audit 回滚:总条数不变
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`)).toBe(auditBefore);
		});

		test("archive rolls back archived_at + audit when audit throws", async () => {
			await svc.create(
				{
					parent: "wiki-root/knowledge",
					name: "faulted-archive",
					kind: "knowledge",
					content: "romeo",
				},
				makeCtx(),
			);
			const nodeRepo = new WikiNodeRepository(db);
			const auditBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`);

			const { svc: faultySvc, audit } = buildServiceWithFaultyAudit();
			audit.armFault();
			await expect(
				faultySvc.archive({ address: "wiki-root/knowledge/faulted-archive" }, makeCtx()),
			).rejects.toThrow(/INJECTED_AUDIT_FAULT/);

			// archived_at 回滚:仍为 null (active)
			const node = nodeRepo.getByPath("wiki-root/knowledge/faulted-archive")!;
			expect(node.archived_at).toBeNull();

			// audit 回滚
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`)).toBe(auditBefore);
		});

		test("link rolls back wiki_links + audit when audit throws", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "fl-src", kind: "knowledge", content: "x" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "fl-dst", kind: "knowledge", content: "y" },
				makeCtx(),
			);
			const linkBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`);
			const auditBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`);

			const { svc: faultySvc, audit } = buildServiceWithFaultyAudit();
			audit.armFault();
			await expect(
				faultySvc.link(
					{
						source: "wiki-root/knowledge/fl-src",
						target: "wiki-root/knowledge/fl-dst",
						relation: "depends_on",
					},
					makeCtx(),
				),
			).rejects.toThrow(/INJECTED_AUDIT_FAULT/);

			// wiki_links 回滚:仍为 linkBefore (没新增)
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`)).toBe(linkBefore);
			// audit 回滚
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`)).toBe(auditBefore);
		});

		test("unlink rolls back wiki_links (delete undone) + audit when audit throws", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "ful-src", kind: "knowledge", content: "x" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "ful-dst", kind: "knowledge", content: "y" },
				makeCtx(),
			);
			await svc.link(
				{
					source: "wiki-root/knowledge/ful-src",
					target: "wiki-root/knowledge/ful-dst",
					relation: "depends_on",
				},
				makeCtx(),
			);
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`)).toBe(1);
			const auditBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`);

			const { svc: faultySvc, audit } = buildServiceWithFaultyAudit();
			audit.armFault();
			await expect(
				faultySvc.unlink(
					{
						source: "wiki-root/knowledge/ful-src",
						target: "wiki-root/knowledge/ful-dst",
						relation: "depends_on",
					},
					makeCtx(),
				),
			).rejects.toThrow(/INJECTED_AUDIT_FAULT/);

			// wiki_links 回滚:delete 被撤销,仍为 1 行
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`)).toBe(1);
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`)).toBe(auditBefore);
		});

		test("move rolls back root path + descendant paths + audit when audit throws", async () => {
			// 构建一棵小树:wiki-root/knowledge/mtree/{child1,child2}
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "mtree", kind: "knowledge", content: "sierra" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge/mtree", name: "child1", kind: "knowledge", content: "tango" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge/mtree", name: "child2", kind: "knowledge", content: "uniform" },
				makeCtx(),
			);
			const auditBefore = countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`);

			const { svc: faultySvc, audit } = buildServiceWithFaultyAudit();
			audit.armFault();
			await expect(
				faultySvc.move(
					{
						address: "wiki-root/knowledge/mtree",
						newParent: "wiki-root/memory",
						newName: "mtree-moved",
					},
					makeCtx(),
				),
			).rejects.toThrow(/INJECTED_AUDIT_FAULT/);

			const nodeRepo = new WikiNodeRepository(db);
			// 根 + 后代路径都不变
			expect(nodeRepo.getActiveByPath("wiki-root/knowledge/mtree")).toBeDefined();
			expect(nodeRepo.getActiveByPath("wiki-root/knowledge/mtree/child1")).toBeDefined();
			expect(nodeRepo.getActiveByPath("wiki-root/knowledge/mtree/child2")).toBeDefined();
			// 新路径不存在
			expect(nodeRepo.getActiveByPath("wiki-root/memory/mtree-moved")).toBeUndefined();
			expect(nodeRepo.getActiveByPath("wiki-root/memory/mtree-moved/child1")).toBeUndefined();
			// audit 回滚
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_audit_log`)).toBe(auditBefore);
		});
	});

	// =========================================================================
	// §A.3 — expected_revision 正确时 revision 恰好 +1;错误时无写入 + WRITE_CONFLICT
	// =========================================================================

	describe("§A.3 revision: correct expected_revision → +1; wrong → no write + WRITE_CONFLICT", () => {
		test("correct expected_revision → revision exactly +1", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "rev-node", kind: "knowledge", content: "v1" },
				makeCtx(),
			);

			// 第一次 update: revision 1 → 2
			const r1 = await svc.update(
				{
					address: "wiki-root/knowledge/rev-node",
					expected_revision: 1,
					changes: { summary: "rev2" },
				},
				makeCtx(),
			);
			expect(r1.revision).toBe(2);
			expect(r1.oldRevision).toBe(1);

			// 第二次 update (基于新 revision 2): revision 2 → 3
			const r2 = await svc.update(
				{
					address: "wiki-root/knowledge/rev-node",
					expected_revision: 2,
					changes: { summary: "rev3" },
				},
				makeCtx(),
			);
			expect(r2.revision).toBe(3);
			expect(r2.oldRevision).toBe(2);

			// 节点最终 revision 为 3 (恰好 +2,不是更多)
			const nodeRepo = new WikiNodeRepository(db);
			expect(nodeRepo.getActiveByPath("wiki-root/knowledge/rev-node")!.revision).toBe(3);
		});

		test("wrong expected_revision → NO write + WRITE_CONFLICT", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "conflict-node", kind: "knowledge", content: "stable", summary: "stable-summary" },
				makeCtx(),
			);
			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/knowledge/conflict-node")!;
			const revBefore = node.revision;
			const summaryBefore = node.summary;
			const contentBefore = node.content;
			const updatedAtBefore = node.updated_at;
			const auditBefore = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'update'`,
			);

			// expected_revision 错 (99) → 抛 WRITE_CONFLICT (async,用 rejects 捕获)
			await expect(
				svc.update(
					{
						address: "wiki-root/knowledge/conflict-node",
						expected_revision: 99,
						changes: { summary: "transient", content: "transient-content-whiskey" },
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "WRITE_CONFLICT" });

			// 完全无写入:revision/summary/content/updated_at 全不变
			const nodeAfter = nodeRepo.getActiveByPath("wiki-root/knowledge/conflict-node")!;
			expect(nodeAfter.revision).toBe(revBefore);
			expect(nodeAfter.summary).toBe(summaryBefore);
			expect(nodeAfter.content).toBe(contentBefore);
			expect(nodeAfter.updated_at).toBe(updatedAtBefore);

			// audit 没新增 update 记录
			const auditAfter = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'update'`,
			);
			expect(auditAfter).toBe(auditBefore);

			// FTS 没改:transient-content-whiskey 不可查
			expect(nodeRepo.searchFts("whiskey", 10).length).toBe(0);
		});

		test("stale expected_revision (other client updated first) → second update WRITE_CONFLICTs", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "race-node", kind: "knowledge", content: "x-ray" },
				makeCtx(),
			);

			// 客户端 A 基于 revision=1 update → 成功 → revision 现在 2
			await svc.update(
				{
					address: "wiki-root/knowledge/race-node",
					expected_revision: 1,
					changes: { summary: "A-wins" },
				},
				makeCtx(),
			);

			// 客户端 B 仍持有 revision=1 → 必失败
			await expect(
				svc.update(
					{
						address: "wiki-root/knowledge/race-node",
						expected_revision: 1, // stale
						changes: { summary: "B-loses" },
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "WRITE_CONFLICT" });

			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/knowledge/race-node")!;
			expect(node.revision).toBe(2);
			expect(node.summary).toBe("A-wins"); // B 的写入未落库
		});
	});

	// =========================================================================
	// §A.7 — move 更新整棵后代 path;link 端点 / address target 不变;
	//         仅根 revision+1;后代 revision AND updated_at 不变
	// =========================================================================

	describe("§A.7 move subtree: paths updated, links/addresses anchored by ID, root-only rev bump", () => {
		test("move updates whole subtree materialized path; root rev+1; descendants rev/updated_at UNCHANGED", async () => {
			// 构建子树:wiki-root/knowledge/parent → child → grandchild
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "parent", kind: "knowledge", content: "parent-v1" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge/parent", name: "child", kind: "knowledge", content: "child-v1" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge/parent/child", name: "grandchild", kind: "knowledge", content: "gc-v1" },
				makeCtx(),
			);

			const nodeRepo = new WikiNodeRepository(db);
			const parent = nodeRepo.getActiveByPath("wiki-root/knowledge/parent")!;
			const child = nodeRepo.getActiveByPath("wiki-root/knowledge/parent/child")!;
			const grandchild = nodeRepo.getActiveByPath("wiki-root/knowledge/parent/child/grandchild")!;

			const parentRevBefore = parent.revision;
			const childRevBefore = child.revision;
			const childUpdatedBefore = child.updated_at;
			const grandchildRevBefore = grandchild.revision;
			const grandchildUpdatedBefore = grandchild.updated_at;

			// move: wiki-root/knowledge/parent → wiki-root/memory/parent-moved
			const result = await svc.move(
				{
					address: "wiki-root/knowledge/parent",
					newParent: "wiki-root/memory",
					newName: "parent-moved",
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.path).toBe("wiki-root/memory/parent-moved");
			expect(result.oldRevision).toBe(parentRevBefore);
			expect(result.revision).toBe(parentRevBefore + 1);

			// 根 revision +1,新路径
			const parentAfter = nodeRepo.getActiveByPath("wiki-root/memory/parent-moved")!;
			expect(parentAfter).toBeDefined();
			expect(parentAfter.revision).toBe(parentRevBefore + 1);
			// 旧路径不再 active
			expect(nodeRepo.getActiveByPath("wiki-root/knowledge/parent")).toBeUndefined();

			// child + grandchild 路径都被更新
			const childAfter = nodeRepo.getActiveByPath("wiki-root/memory/parent-moved/child")!;
			const grandchildAfter = nodeRepo.getActiveByPath("wiki-root/memory/parent-moved/child/grandchild")!;
			expect(childAfter).toBeDefined();
			expect(grandchildAfter).toBeDefined();

			// 后代 revision UNCHANGED
			expect(childAfter.revision).toBe(childRevBefore);
			expect(grandchildAfter.revision).toBe(grandchildRevBefore);

			// 后代 updated_at UNCHANGED (updateChildPathOnly 不动 updated_at)
			expect(childAfter.updated_at).toBe(childUpdatedBefore);
			expect(grandchildAfter.updated_at).toBe(grandchildUpdatedBefore);

			// 旧的后代路径都不再 active
			expect(nodeRepo.getActiveByPath("wiki-root/knowledge/parent/child")).toBeUndefined();
			expect(nodeRepo.getActiveByPath("wiki-root/knowledge/parent/child/grandchild")).toBeUndefined();
		});

		test("move leaves wiki_links.source_id/target_id UNCHANGED (anchored by internal id)", async () => {
			// 建两个节点 A、B,link A → B;然后 move A 到新位置
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "A", kind: "knowledge", content: "A" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "B", kind: "knowledge", content: "B" },
				makeCtx(),
			);
			await svc.link(
				{
					source: "wiki-root/knowledge/A",
					target: "wiki-root/knowledge/B",
					relation: "depends_on",
				},
				makeCtx(),
			);

			const beforeRow = db
				.prepare(
					`SELECT source_id, target_id, relation FROM wiki_links WHERE relation = 'depends_on' LIMIT 1`,
				)
				.get() as { source_id: number; target_id: number; relation: string };

			await svc.move(
				{ address: "wiki-root/knowledge/A", newParent: "wiki-root/memory", newName: "A-moved" },
				makeCtx(),
			);

			// wiki_links 行 source_id/target_id 完全不变
			const afterRow = db
				.prepare(
					`SELECT source_id, target_id, relation FROM wiki_links WHERE relation = 'depends_on' LIMIT 1`,
				)
				.get() as { source_id: number; target_id: number; relation: string };
			expect(afterRow.source_id).toBe(beforeRow.source_id);
			expect(afterRow.target_id).toBe(beforeRow.target_id);
			expect(afterRow.relation).toBe(beforeRow.relation);
		});

		test("move leaves wiki_addresses.target_id UNCHANGED; static alias resolves to new path", async () => {
			// 建节点 + 注册 runtime:// alias 指向它
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "aliased", kind: "knowledge", content: "alias-target-content" },
				makeCtx(),
			);
			// 用管理面 address service 注册(不经 WikiService 数据面 API)
			const addressSvc = new WikiAddressService(
				new WikiRepositoryStore(db).addresses,
				new WikiNodeRepository(db),
			);
			const registerResult = addressSvc.register({
				address: "runtime://alias-test",
				targetPath: "wiki-root/knowledge/aliased",
				scope: "runtime",
				kind: "alias",
			});
			expect(registerResult.target_id).not.toBeNull();
			const targetIdBefore = registerResult.target_id as number;

			// 解析 alias (move 前) → 老 path
			const resolvedBefore = addressSvc.resolve("runtime://alias-test", {});
			expect(resolvedBefore.canonicalPath).toBe("wiki-root/knowledge/aliased");

			// move aliased → wiki-root/memory/aliased-moved
			await svc.move(
				{ address: "wiki-root/knowledge/aliased", newParent: "wiki-root/memory", newName: "aliased-moved" },
				makeCtx(),
			);

			// wiki_addresses.target_id 完全不变 (仍指向同一内部 ID)
			const targetIdAfter = db
				.prepare(`SELECT target_id FROM wiki_addresses WHERE address = 'runtime://alias-test'`)
				.get() as { target_id: number | null };
			expect(targetIdAfter.target_id).toBe(targetIdBefore);

			// alias 仍能解析,且解析到新 path (target 节点 ID 不变,path 变了)
			const resolvedAfter = addressSvc.resolve("runtime://alias-test", {});
			expect(resolvedAfter.canonicalPath).toBe("wiki-root/memory/aliased-moved");
		});

		test("move self-into-subtree rejected (would form cycle)", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "cyc-root", kind: "knowledge", content: "x" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge/cyc-root", name: "sub", kind: "knowledge", content: "y" },
				makeCtx(),
			);

			// 试图把 cyc-root 移到自己的子树下
			await expect(
				svc.move(
					{ address: "wiki-root/knowledge/cyc-root", newParent: "wiki-root/knowledge/cyc-root/sub" },
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		});

		test("move into source-bound parent blocked (source-bound mirror protected)", async () => {
			// 不在 lens 强制范围;但 move 的 SOURCE_MANAGED 路径在 §A.7 子树保护内。
			// 此用例验证 source-bound 目标父被拒(实现:isSourceBound(newParent.id) → SOURCE_MANAGED)
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "mover", kind: "knowledge", content: "x" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "fakeproj-root", kind: "project", content: "y" },
				makeCtx(),
			);
			// 注入 source binding 到 fakeproj-root (模拟项目镜像)
			const nodeRepo = new WikiNodeRepository(db);
			const fakeProj = nodeRepo.getActiveByPath("wiki-root/knowledge/fakeproj-root")!;
			const store = new WikiRepositoryStore(db);
			// 先注册 repository (project_node_id RESTRICT 需要)
			store.repositories.upsert({
				repository_id: "fake-repo",
				project_node_id: fakeProj.id,
				project_id: "fake-proj-id",
			});
			store.sourceBindings.upsert({
				node_id: fakeProj.id,
				repository_id: "fake-repo",
				source_path: "fake",
				source_kind: "directory",
				indexed_revision: "fake-sha",
			});

			await expect(
				svc.move(
					{ address: "wiki-root/knowledge/mover", newParent: "wiki-root/knowledge/fakeproj-root" },
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "SOURCE_MANAGED" });
		});
	});

	// =========================================================================
	// §6.3 source-bound node update (FIX 3) —— Agent enrichment 允许;结构由 indexer 拥有
	//
	// design §6.3:"source-bound 项目的节点存在性、name、path、kind 和 source binding
	// 由索引器拥有;普通 Agent 可以更新其 summary/content/links,但不能用 Wiki tool
	// 移动或删除 source-bound 节点"。
	//
	// FIX 3 把 update() 的 source-bound 守卫从"全字段拒绝"收窄为"仅 STRUCTURAL 字段
	// (parent_id/path/name/kind)拒绝"。本组验证:
	//   1. summary/content/attributes patch 在 source-bound 节点上 SUCCEED,revision+1。
	//   2. 结构操作(move/archive)在 source-bound 节点上仍 SOURCE_MANAGED —— 结构所有权
	//      边界在可达的入口处(CREATE/MOVE/ARCHIVE/HARD_DELETE/RESTORE)被强制;
	//      update() 的 public 契约 (WikiUpdateFieldChanges) 不携带 name/path/kind/
	//      parent_id,所以 STRUCTURAL 守卫对当前 API 是防御性 no-op(implementer 注释
	//      已承认这一点)。
	// =========================================================================

	describe("§6.3 source-bound update (FIX 3): summary/content/attributes SUCCEED; structural ops blocked at their own entry points", () => {
		/** 在 node 上注入 wiki_source_bindings 行(使其 source-bound)。需要先建 repository 行(FK)。 */
		function bindAsSource(nodeId: number, repositoryId: string, projectNodeId: number): void {
			const store = new WikiRepositoryStore(db);
			store.repositories.upsert({
				repository_id: repositoryId,
				project_node_id: projectNodeId,
				project_id: `proj-${repositoryId}`,
			});
			store.sourceBindings.upsert({
				node_id: nodeId,
				repository_id: repositoryId,
				source_path: `src/${repositoryId}/file.md`,
				source_kind: "file",
				indexed_revision: `sha-${repositoryId}`,
			});
		}

		test("source-bound node: update summary + content + attributes SUCCEEDS, revision exactly +1", async () => {
			await svc.create(
				{
					parent: "wiki-root/knowledge",
					name: "sb-enrich",
					kind: "knowledge",
					summary: "orig summary zuluseed",
					content: "orig content yankeeseed",
				},
				makeCtx(),
			);
			// 一个 project 节点作为 repository.project_node_id (FK RESTRICT) 锚点。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "sb-enrich-proj", kind: "project", content: "p" },
				makeCtx(),
			);
			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-enrich")!;
			const projNode = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-enrich-proj")!;
			bindAsSource(node.id, "repo-enrich", projNode.id);

			// sanity: 节点确实 source-bound
			expect(new WikiRepositoryStore(db).sourceBindings.getByNodeId(node.id)).toBeDefined();

			const auditBefore = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'update'`,
			);

			const result = await svc.update(
				{
					address: "wiki-root/knowledge/sb-enrich",
					expected_revision: node.revision,
					changes: {
						summary: "enriched summary alphaseed",
						content: "enriched content bravoseed",
						attributes: { display_name: "Enriched Title", source_kind: "test" },
					},
				},
				makeCtx(),
			);

			// update 成功,revision 恰好 +1
			expect(result.success).toBe(true);
			expect(result.path).toBe("wiki-root/knowledge/sb-enrich");
			expect(result.revision).toBe(node.revision + 1);
			expect(result.oldRevision).toBe(node.revision);

			// 字段确实落库
			const updated = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-enrich")!;
			expect(updated.revision).toBe(node.revision + 1);
			expect(updated.summary).toBe("enriched summary alphaseed");
			expect(updated.content).toBe("enriched content bravoseed");
			const attrs = JSON.parse(updated.attributes_json ?? "{}");
			expect(attrs.display_name).toBe("Enriched Title");
			expect(attrs.source_kind).toBe("test");

			// FTS 反映新内容(新 token 命中,旧 token 不再命中)
			expect(nodeRepo.searchFts("bravoseed", 10).some((r) => r.id === updated.id)).toBe(true);
			expect(nodeRepo.searchFts("yankeeseed", 10).some((r) => r.id === updated.id)).toBe(false);

			// audit 记录了 update
			const auditAfter = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'update'`,
			);
			expect(auditAfter).toBe(auditBefore + 1);
		});

		test("source-bound node: partial update (content + operations) SUCCEEDS", async () => {
			await svc.create(
				{
					parent: "wiki-root/knowledge",
					name: "sb-ops",
					kind: "knowledge",
					content: "# Title\n\nbody line one.\n",
				},
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "sb-ops-proj", kind: "project", content: "p" },
				makeCtx(),
			);
			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-ops")!;
			const projNode = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-ops-proj")!;
			bindAsSource(node.id, "repo-ops", projNode.id);

			// 局部编辑 operation(append)在 source-bound 节点上应 SUCCEED
			const result = await svc.update(
				{
					address: "wiki-root/knowledge/sb-ops",
					expected_revision: node.revision,
					operations: [{ op: "append", text: "\n\nappended paragraph charlie-fix3." }],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			expect(result.revision).toBe(node.revision + 1);

			const updated = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-ops")!;
			expect(updated.content).toContain("appended paragraph charlie-fix3");
			expect(updated.content).toContain("body line one.");
		});

		test("source-bound node: structural ops (move/archive) still SOURCE_MANAGED at their entry points", async () => {
			// 结构所有权边界在可达入口(MOVE/ARCHIVE)强制 —— 这是 design §6.3 真正
			// 保护的语义。update() 的 STRUCTURAL 守卫对 public API 是 no-op,因为
			// WikiUpdateFieldChanges 不携带 name/path/kind/parent_id;这里验证结构操作
			// 仍被拒,确保 FIX 3 的"收窄"没有意外放开 move/archive。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "sb-struct", kind: "knowledge", content: "x-fix3" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "sb-struct-proj", kind: "project", content: "p" },
				makeCtx(),
			);
			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-struct")!;
			const projNode = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-struct-proj")!;
			bindAsSource(node.id, "repo-struct", projNode.id);

			// move 在 source-bound 节点上 → SOURCE_MANAGED
			await expect(
				svc.move(
					{ address: "wiki-root/knowledge/sb-struct", newParent: "wiki-root/memory", newName: "moved" },
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "SOURCE_MANAGED" });

			// archive 在 source-bound 节点上 → SOURCE_MANAGED
			await expect(
				svc.archive({ address: "wiki-root/knowledge/sb-struct" }, makeCtx()),
			).rejects.toMatchObject({ code: "SOURCE_MANAGED" });

			// 节点未被改动(结构保护生效,且无副作用)
			const stillHere = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-struct")!;
			expect(stillHere).toBeDefined();
			expect(stillHere.revision).toBe(node.revision);
			expect(stillHere.archived_at).toBeNull();
		});

		test("source-bound node: update() public API cannot carry structural fields (guard is defensive no-op)", async () => {
			// design §6.3 的"结构字段由 indexer 拥有"在 update() 上通过契约形状保护:
			// WikiUpdateFieldChanges 只有 summary/content/attributes。即使调用方用 as any
			// 塞入 name/path,update() 内部 patch 构建只读 summary/content/attributes,
			// STRUCTURAL 守卫永不会触发。本用例固化这一契约事实,防止未来 regress。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "sb-guard", kind: "knowledge", content: "g" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "sb-guard-proj", kind: "project", content: "p" },
				makeCtx(),
			);
			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-guard")!;
			const projNode = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-guard-proj")!;
			bindAsSource(node.id, "repo-guard", projNode.id);

			// 用 as any 试图走私结构字段 —— public 契约不允许,但即便允许,
			// update() 也只读 changes.summary/content/attributes,守卫不触发。
			const smuggled = {
				summary: "guard-summary-fix3",
				name: "should-be-ignored",
				path: "wiki-root/knowledge/PWNED",
				kind: "memory",
			} as unknown as import("../../src/shared/wiki-types.js").WikiUpdateFieldChanges;

			const result = await svc.update(
				{
					address: "wiki-root/knowledge/sb-guard",
					expected_revision: node.revision,
					changes: smuggled,
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			expect(result.revision).toBe(node.revision + 1);

			// 结构字段未被改写:name/path/kind 全不变(走私字段被忽略)
			const updated = nodeRepo.getActiveByPath("wiki-root/knowledge/sb-guard")!;
			expect(updated.name).toBe("sb-guard");
			expect(updated.path).toBe("wiki-root/knowledge/sb-guard");
			expect(updated.kind).toBe("knowledge");
			// summary 被正常 patch
			expect(updated.summary).toBe("guard-summary-fix3");
		});
	});

	// =========================================================================
	// §D — Memory root lifecycle
	// =========================================================================

	describe("§D.1 ensureAgentMemoryRoot idempotency + displayName change", () => {
		test("first call creates root at wiki-root/memory/<agentId>", async () => {
			const result = await svc.ensureAgentMemoryRoot("stable-agent-1", "Display One");
			expect(result.success).toBe(true);
			expect(result.path).toBe("wiki-root/memory/stable-agent-1");
			expect(result.revision).toBe(1);
			expect(result.oldRevision).toBeNull(); // 新建

			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/memory/stable-agent-1")!;
			expect(node).toBeDefined();
			expect(node.kind).toBe("memory");
			expect(node.name).toBe("stable-agent-1");
			expect(node.summary).toBe("Display One");
			// display_name attribute 写入
			const attrs = JSON.parse(node.attributes_json ?? "{}");
			expect(attrs.display_name).toBe("Display One");
		});

		test("second call with SAME displayName → no revision bump + no duplicate node", async () => {
			const first = await svc.ensureAgentMemoryRoot("stable-agent-2", "Same Display");
			expect(first.revision).toBe(1);
			expect(first.oldRevision).toBeNull();

			const second = await svc.ensureAgentMemoryRoot("stable-agent-2", "Same Display");
			// 幂等:revision 不变 (仍 1),path 不变,oldRevision = 当前 revision (1)
			expect(second.success).toBe(true);
			expect(second.path).toBe("wiki-root/memory/stable-agent-2");
			expect(second.revision).toBe(1);
			expect(second.oldRevision).toBe(1);

			// 唯一性:wiki_nodes 中此 path 仍只有 1 个 active 行
			const count = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_nodes WHERE path = 'wiki-root/memory/stable-agent-2' AND archived_at IS NULL`,
			);
			expect(count).toBe(1);

			// 节点 revision 仍是 1 (没 bump)
			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/memory/stable-agent-2")!;
			expect(node.revision).toBe(1);
		});

		test("third call with CHANGED displayName → updates display_name/summary, NOT path/name", async () => {
			const first = await svc.ensureAgentMemoryRoot("stable-agent-3", "Name V1");
			expect(first.revision).toBe(1);

			const second = await svc.ensureAgentMemoryRoot("stable-agent-3", "Name V2");
			expect(second.success).toBe(true);
			// displayName 变化 → revision +1
			expect(second.revision).toBe(2);
			expect(second.oldRevision).toBe(1);
			// path 不变
			expect(second.path).toBe("wiki-root/memory/stable-agent-3");

			const nodeRepo = new WikiNodeRepository(db);
			const node = nodeRepo.getActiveByPath("wiki-root/memory/stable-agent-3")!;
			expect(node.revision).toBe(2);
			// name 不变 (stable agentId)
			expect(node.name).toBe("stable-agent-3");
			// summary = 新 displayName (实现把 displayName 写到 summary)
			expect(node.summary).toBe("Name V2");
			// display_name attribute 更新到新值
			const attrs = JSON.parse(node.attributes_json ?? "{}");
			expect(attrs.display_name).toBe("Name V2");

			// 唯一性:仍只有 1 个 active 行 (没创建新节点)
			const count = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_nodes WHERE path = 'wiki-root/memory/stable-agent-3' AND archived_at IS NULL`,
			);
			expect(count).toBe(1);
		});

		test("multiple distinct agents → multiple distinct roots (no collision)", async () => {
			await svc.ensureAgentMemoryRoot("agent-a", "A");
			await svc.ensureAgentMemoryRoot("agent-b", "B");
			await svc.ensureAgentMemoryRoot("agent-c", "C");

			const nodeRepo = new WikiNodeRepository(db);
			expect(nodeRepo.getActiveByPath("wiki-root/memory/agent-a")).toBeDefined();
			expect(nodeRepo.getActiveByPath("wiki-root/memory/agent-b")).toBeDefined();
			expect(nodeRepo.getActiveByPath("wiki-root/memory/agent-c")).toBeDefined();
			// 各自独立,互不影响
			expect(nodeRepo.getActiveByPath("wiki-root/memory/agent-a")!.revision).toBe(1);
			expect(nodeRepo.getActiveByPath("wiki-root/memory/agent-b")!.revision).toBe(1);
		});
	});

	describe("§D.2 ensureAgentMemoryRoot creates NO fixed subtree", () => {
		test("no preferences/lessons auto-nodes under created root", async () => {
			await svc.ensureAgentMemoryRoot("subtree-agent", "With Subtree Check");

			// root 节点存在
			const nodeRepo = new WikiNodeRepository(db);
			const root = nodeRepo.getActiveByPath("wiki-root/memory/subtree-agent");
			expect(root).toBeDefined();

			// 直接查 children:必须为 0 (不创建 preferences / lessons / 任何固定子树)
			const children = nodeRepo.getActiveChildren(root!.id);
			expect(children.length).toBe(0);

			// 整体 memory namespace 下只有这一个 root (没有自动生成的兄弟节点)
			const memoryNamespace = nodeRepo.getActiveByPath("wiki-root/memory")!;
			const memoryChildren = nodeRepo.getActiveChildren(memoryNamespace.id);
			const memoryChildNames = memoryChildren.map((c) => c.name);
			expect(memoryChildNames).toEqual(["subtree-agent"]);
		});
	});

	describe("§D.3 archiveAgentMemoryRoot archives, does NOT hard-delete", () => {
		test("archive sets archived_at, leaves row in wiki_nodes (no hard delete)", async () => {
			await svc.ensureAgentMemoryRoot("archive-agent", "To Be Archived");

			const nodeRepo = new WikiNodeRepository(db);
			const root = nodeRepo.getActiveByPath("wiki-root/memory/archive-agent")!;
			const auditBefore = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'archiveAgentMemoryRoot'`,
			);

			const result = await svc.archiveAgentMemoryRoot("archive-agent");
			expect(result.success).toBe(true);

			// archived_at 已置 (用 getByPath 看含归档)
			const archived = nodeRepo.getByPath("wiki-root/memory/archive-agent")!;
			expect(archived).toBeDefined();
			expect(archived.archived_at).not.toBeNull();

			// active 视图不再可见
			expect(nodeRepo.getActiveByPath("wiki-root/memory/archive-agent")).toBeUndefined();

			// **不**硬删:行仍在 wiki_nodes 表 (row count 与归档前一致)
			const stillPresent = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_nodes WHERE path = 'wiki-root/memory/archive-agent'`,
			);
			expect(stillPresent).toBe(1);

			// audit 写入
			const auditAfter = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'archiveAgentMemoryRoot'`,
			);
			expect(auditAfter).toBe(auditBefore + 1);
		});

		test("archive cascades to subtree (children archived too)", async () => {
			await svc.ensureAgentMemoryRoot("cascade-agent", "Cascade");
			// 手动添加子节点 (使用 create 数据面 API)
			await svc.create(
				{ parent: "wiki-root/memory/cascade-agent", name: "lesson1", kind: "memory", content: "L1" },
				makeCtx(),
			);
			await svc.create(
				{ parent: "wiki-root/memory/cascade-agent", name: "prefs", kind: "memory", content: "P1" },
				makeCtx(),
			);

			const nodeRepo = new WikiNodeRepository(db);
			expect(nodeRepo.getActiveByPath("wiki-root/memory/cascade-agent/lesson1")).toBeDefined();
			expect(nodeRepo.getActiveByPath("wiki-root/memory/cascade-agent/prefs")).toBeDefined();

			await svc.archiveAgentMemoryRoot("cascade-agent");

			// 子树都归档,但仍存在 (硬删会消失;归档保留)
			expect(nodeRepo.getByPath("wiki-root/memory/cascade-agent")!.archived_at).not.toBeNull();
			expect(nodeRepo.getByPath("wiki-root/memory/cascade-agent/lesson1")!.archived_at).not.toBeNull();
			expect(nodeRepo.getByPath("wiki-root/memory/cascade-agent/prefs")!.archived_at).not.toBeNull();

			// 都不 active
			expect(nodeRepo.getActiveByPath("wiki-root/memory/cascade-agent/lesson1")).toBeUndefined();
			expect(nodeRepo.getActiveByPath("wiki-root/memory/cascade-agent/prefs")).toBeUndefined();

			// 行仍在 wiki_nodes (历史保留供审计)
			const total = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_nodes WHERE path LIKE 'wiki-root/memory/cascade-agent%'`,
			);
			expect(total).toBe(3); // root + 2 children,全部保留
		});

		test("archiveAgentMemoryRoot is idempotent on missing / already-archived root", async () => {
			// 不存在的 agent:幂等不报错
			const r1 = await svc.archiveAgentMemoryRoot("never-existed");
			expect(r1.success).toBe(true);

			// 已归档的 agent:第二次仍幂等成功
			await svc.ensureAgentMemoryRoot("double-archive", "First");
			await svc.archiveAgentMemoryRoot("double-archive");
			const r2 = await svc.archiveAgentMemoryRoot("double-archive");
			expect(r2.success).toBe(true);
		});
	});
});
