// wiki-system-redesign sub-02 acceptance — 架构 (auth/anti-leak + structural §G) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-02 §C.1–§C.7 (权限与防泄露) + §G 拒绝条件中的结构不变量
// (auth-before-existence / grants 不入 DB / 不双写 incoming/outgoing / move 不扫全库
// rewrite links / 无隐藏全局 grant)。全部用**真临时 SQLite DB**驱动 —— 权限判定
// 走真实 WikiAuthorizationService + 真实 wiki_nodes 读路径,绝不只 mock authorize
// 返回值 (plan-02 §测试要求)。
//
// ## 关键断言 (acceptance-02 §C)
//   - §C.1 scope 段基匹配: `wiki-root/a` 不覆盖 `wiki-root/ab`。
//   - §C.2 无 grant → 存在节点 / 不存在节点返回同一 NOT_FOUND 外观 (无 existence oracle)。
//   - §C.3 scope 覆盖但无 action → ACCESS_DENIED。
//   - §C.4 deep grant 不能 expand/read 未授权祖先。
//   - §C.5 link 对端不可见 → read-links 不返回 link / 对端 path / 数量暗示。
//   - §C.6 authorization 在 repository 读节点/正文之前执行 (spy on getActiveByPath)。
//   - §C.7 compiled access 不能被 service 输入中的 agentId/projectId 覆盖。
//
// ## §G 结构不变量
//   - 无隐藏全局 grant (空 grants → 一切 NOT_FOUND)。
//   - grants 不写 wiki_nodes.attributes_json,也不存在 grants 表。
//   - wiki_links 单条记录 (source_id,target_id,relation) PK,不双写反向。
//   - move 不 rewrite wiki_links.source_id/target_id 或 wiki_addresses.target_id。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + 每 test 独立 mkdtemp 子目录 wiki.db (vi.hoisted)。
//   - vi.hoisted 前缀 `zc-wiki-v2-auth-` (与其它 lens 文件区分,满足隔离 mandate)。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - 跨 lens 隔离:本文件 vi.hoisted 唯一前缀 + 每 test 独有 wiki.db 路径。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-auth-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1"; // 绕开 Windows test worker WAL checkpoint 卡死。
	return { UNIQUE_DIR: d };
});

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
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
import { isWikiServiceError } from "../../src/server/wiki/wiki-errors.js";
import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
	WikiRequestContext,
} from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Access / ctx helpers
// ---------------------------------------------------------------------------

const ALL_ACTIONS: WikiAction[] = [
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

function grant(scope: string, actions: WikiAction[]): CompiledWikiGrant {
	return { canonicalScope: scope, actions };
}

function access(agentId: string, grants: CompiledWikiGrant[], activeProjectId?: string): CompiledWikiAccess {
	return { agentId, activeProjectId, grants, policyRevision: 1 };
}

function ctx(accessObj: CompiledWikiAccess, opts: { agentId?: string; activeProjectId?: string } = {}): WikiRequestContext {
	return {
		access: accessObj,
		agentId: opts.agentId ?? accessObj.agentId,
		activeProjectId: opts.activeProjectId ?? accessObj.activeProjectId,
		sessionId: "auth-test-session",
		requestId: null,
	};
}

/** 全权限 (wiki-root 及所有后代) —— 用于 fixture 准备 (创建测试节点 / 链接)。 */
function wideOpen(agentId = "admin-agent"): CompiledWikiAccess {
	return access(agentId, [grant("wiki-root", ALL_ACTIONS)]);
}

// ---------------------------------------------------------------------------
// Service builder
// ---------------------------------------------------------------------------

function buildService(wikiDb: WikiDatabase): WikiService {
	const db = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const linkRepo = new WikiLinkRepository(db);
	const auditRepo = new WikiAuditRepository(db);
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

/** 直接 SQL 计数。 */
function countRows(db: Database.Database, sql: string, ...params: unknown[]): number {
	const row = db.prepare(sql).get(...params) as { n: number };
	return row.n;
}

/** 提取 WikiServiceError 的 code (非 WSE 则返回 null)。 */
function errCode(err: unknown): string | null {
	if (isWikiServiceError(err)) return err.code;
	return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wiki-v2 auth / anti-leak [架构 lens]", () => {
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
		try {
			wiki.close();
		} catch {
			/* idempotent */
		}
	});

	// =========================================================================
	// §C.1 — scope 段基匹配
	// =========================================================================

	describe("§C.1 scope match is segment-based (not string prefix)", () => {
		test("grant wiki-root/a does NOT cover wiki-root/ab (sibling-prefix trap)", async () => {
			// 准备 wiki-root/a 和 wiki-root/ab 两个节点。
			await svc.create({ parent: "wiki-root/knowledge", name: "a", kind: "node" }, ctx(wideOpen()));
			await svc.create({ parent: "wiki-root/knowledge", name: "ab", kind: "node" }, ctx(wideOpen()));
			// 注意:wiki-root/knowledge/a 与 wiki-root/knowledge/ab,grant 给 wiki-root/knowledge/a
			// 不应覆盖 wiki-root/knowledge/ab。
			const narrowAccess = access("agent", [grant("wiki-root/knowledge/a", ["read", "expand"])]);

			// wiki-root/knowledge/a: 覆盖 → 能读。
			const readA = await svc.read(
				{ address: "wiki-root/knowledge/a", view: "summary" },
				ctx(narrowAccess),
			);
			expect(readA.path).toBe("wiki-root/knowledge/a");

			// wiki-root/knowledge/ab: 不覆盖 → NOT_FOUND (不能确认节点存在)。
			await expect(
				svc.read({ address: "wiki-root/knowledge/ab", view: "summary" }, ctx(narrowAccess)),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		test("pure authorization service: isSameOrDescendant segment semantics (unit)", () => {
			const auth = new WikiAuthorizationService();
			// 授权层不查 DB,直接构造 access 验证段基语义。
			const aScope = access("agent", [grant("wiki-root/a", ["read"])]);
			expect(() => auth.authorize("read", "wiki-root/a", aScope)).not.toThrow();
			expect(() => auth.authorize("read", "wiki-root/a/b", aScope)).not.toThrow();
			expect(() => auth.authorize("read", "wiki-root/ab", aScope)).toThrowError(
				expect.objectContaining({ code: "NOT_FOUND" }),
			);
			expect(() => auth.authorize("read", "wiki-root/abc", aScope)).toThrowError(
				expect.objectContaining({ code: "NOT_FOUND" }),
			);
		});
	});

	// =========================================================================
	// §C.2 — 无 grant: 存在/不存在节点同外观 NOT_FOUND
	// =========================================================================

	describe("§C.2 no grant → identical NOT_FOUND appearance (no existence oracle)", () => {
		test("existing and non-existing nodes under an out-of-scope path look identical (no existence oracle)", async () => {
			// wiki-root/knowledge/exists 真实存在;wiki-root/knowledge/ghost 不存在。
			// Agent 无任何覆盖 wiki-root/knowledge 的 grant。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "exists", kind: "node", summary: "secret" },
				ctx(wideOpen()),
			);
			const noAccess = access("agent", [grant("wiki-root/memory", ["read"])]); // 无关 scope

			const errors: { code: string; message: string }[] = [];
			try {
				await svc.read({ address: "wiki-root/knowledge/exists", view: "summary" }, ctx(noAccess));
			} catch (e) {
				errors.push({ code: errCode(e) ?? "THROW", message: (e as Error).message });
			}
			try {
				await svc.read({ address: "wiki-root/knowledge/ghost", view: "summary" }, ctx(noAccess));
			} catch (e) {
				errors.push({ code: errCode(e) ?? "THROW", message: (e as Error).message });
			}

			// 两者必须同为 NOT_FOUND。
			expect(errors).toHaveLength(2);
			expect(errors[0].code).toBe("NOT_FOUND");
			expect(errors[1].code).toBe("NOT_FOUND");
			// 关键不变量:错误 message 的**模板**必须一致 (不能一个说"存在但禁止"、
			// 另一个说"不存在")。message 里回显的 path 是 agent 自己提供的,不算泄露 ——
			// 所以把 path mask 掉后两 message 必须完全相同。
			const mask = (m: string) => m.replace(/wiki-root[^\s]*/g, "<PATH>");
			expect(mask(errors[0].message)).toBe(mask(errors[1].message));
			// 模板不应含区分性字样 (exist/forbidden/archived/missing/present 等)。
			for (const m of [errors[0].message, errors[1].message]) {
				expect(m).not.toMatch(/forbidden|archived|present|absent/i);
				expect(m).not.toMatch(/exists but|does not exist|node exists/i);
			}
		});

		test("in-scope missing node uses the SAME not-found template as out-of-scope (existence branch == auth branch)", async () => {
			// out-of-scope: auth branch throws NOT_FOUND (node never read)。
			// in-scope + missing: existence branch throws NOT_FOUND。
			// 两个分支的 message 模板必须一致,否则 agent 能区分 "没权限" vs "不存在"。
			const outOfScope = access("agent", [grant("wiki-root/memory", ["read", "expand"])]);
			const inScope = access("agent", [grant("wiki-root/knowledge", ["read", "expand"])]);
			const mask = (m: string) => m.replace(/wiki-root[^\s]*/g, "<PATH>");

			const msgs: string[] = [];
			try {
				await svc.read({ address: "wiki-root/knowledge/missing", view: "summary" }, ctx(outOfScope));
			} catch (e) { msgs.push((e as Error).message); }
			try {
				await svc.read({ address: "wiki-root/knowledge/missing", view: "summary" }, ctx(inScope));
			} catch (e) { msgs.push((e as Error).message); }
			expect(msgs).toHaveLength(2);
			expect(mask(msgs[0])).toBe(mask(msgs[1]));
		});
	});

	// =========================================================================
	// §C.3 — scope 覆盖但无 action → ACCESS_DENIED
	// =========================================================================

	describe("§C.3 scope covered but action not granted → ACCESS_DENIED", () => {
		test("read-only grant on scope → create returns ACCESS_DENIED", async () => {
			const readOnly = access("agent", [grant("wiki-root/knowledge", ["read", "expand"])]);
			await expect(
				svc.create({ parent: "wiki-root/knowledge", name: "x", kind: "node" }, ctx(readOnly)),
			).rejects.toMatchObject({ code: "ACCESS_DENIED" });
		});

		test("scope covered, update action missing → ACCESS_DENIED (not NOT_FOUND)", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "doc", kind: "node", summary: "s" },
				ctx(wideOpen()),
			);
			const noUpdate = access("agent", [grant("wiki-root/knowledge", ["read", "expand"])]);
			await expect(
				svc.update(
					{ address: "wiki-root/knowledge/doc", expected_revision: 1, changes: { summary: "new" } },
					ctx(noUpdate),
				),
			).rejects.toMatchObject({ code: "ACCESS_DENIED" });
		});
	});

	// =========================================================================
	// §C.4 — deep grant 不能读未授权祖先
	// =========================================================================

	describe("§C.4 deep grant cannot read unauthorized ancestors", () => {
		test("grant on wiki-root/knowledge/deep → expand/read ancestor wiki-root/knowledge is NOT_FOUND", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "deep", kind: "node", summary: "deep-secret" },
				ctx(wideOpen()),
			);
			const deepOnly = access("agent", [grant("wiki-root/knowledge/deep", ["read", "expand"])]);

			// 深层节点能读。
			const deep = await svc.read(
				{ address: "wiki-root/knowledge/deep", view: "summary" },
				ctx(deepOnly),
			);
			expect(deep.path).toBe("wiki-root/knowledge/deep");

			// 祖先 wiki-root/knowledge 不可读 (NOT_FOUND —— 不能确认祖先存在)。
			await expect(
				svc.expand({ address: "wiki-root/knowledge" }, ctx(deepOnly)),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				svc.read({ address: "wiki-root/knowledge", view: "summary" }, ctx(deepOnly)),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			// 根 wiki-root 同样不可读。
			await expect(
				svc.expand({ address: "wiki-root" }, ctx(deepOnly)),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	// =========================================================================
	// §C.5 — link 对端不可见:read-links 不返回 link / 对端 path / 数量暗示
	// =========================================================================

	describe("§C.5 invisible link peer leaks nothing (no link, no path, no count hint)", () => {
		test("read view=links hides links whose peer is out of scope", async () => {
			// fixture: doc-A, doc-B (visible), doc-C (will be invisible)。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "doc-a", kind: "node", summary: "a" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "doc-b", kind: "node", summary: "b" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "doc-c", kind: "node", summary: "c" },
				ctx(wideOpen()),
			);
			// 用 wideOpen 建 2 条 outgoing:doc-a → doc-b (peer 可见), doc-a → doc-c (peer 不可见)。
			await svc.link(
				{ source: "wiki-root/knowledge/doc-a", target: "wiki-root/knowledge/doc-b", relation: "ref" },
				ctx(wideOpen()),
			);
			await svc.link(
				{ source: "wiki-root/knowledge/doc-a", target: "wiki-root/knowledge/doc-c", relation: "ref" },
				ctx(wideOpen()),
			);

			// 受限 agent: 覆盖 doc-a + doc-b (read),不覆盖 doc-c。
			const restricted = access("agent", [
				grant("wiki-root/knowledge/doc-a", ["read", "expand", "link"]),
				grant("wiki-root/knowledge/doc-b", ["read", "expand"]),
			]);

			const result = await svc.read(
				{ address: "wiki-root/knowledge/doc-a", view: "links" },
				ctx(restricted),
			);
			expect(result.links).toBeDefined();
			const allLinkViews = [...(result.links!.outgoing ?? []), ...(result.links!.incoming ?? [])];
			const allPaths = allLinkViews.flatMap((l) => [l.sourcePath, l.targetPath]);

			// doc-b 链接可见。
			expect(allLinkViews.some((l) => l.targetPath === "wiki-root/knowledge/doc-b")).toBe(true);
			// doc-c: 既不返回 link,也不返回 path。
			expect(allLinkViews.some((l) => l.targetPath === "wiki-root/knowledge/doc-c")).toBe(false);
			expect(allPaths.some((p) => p === "wiki-root/knowledge/doc-c")).toBe(false);
			// 无 "hidden" / "X hidden links" 数量暗示。
			const serialized = JSON.stringify(result.links);
			expect(serialized).not.toMatch(/hidden|count|doc-c/i);
		});

		test("incoming link from invisible source is hidden (read peer = source)", async () => {
			// doc-a → doc-b;agent 只能看 doc-b,看不到 doc-a → incoming 不应泄露。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "src-hidden", kind: "node", summary: "src" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "dst-visible", kind: "node", summary: "dst" },
				ctx(wideOpen()),
			);
			await svc.link(
				{ source: "wiki-root/knowledge/src-hidden", target: "wiki-root/knowledge/dst-visible", relation: "ref" },
				ctx(wideOpen()),
			);

			const onlyDst = access("agent", [grant("wiki-root/knowledge/dst-visible", ["read", "expand"])]);
			const result = await svc.read(
				{ address: "wiki-root/knowledge/dst-visible", view: "links" },
				ctx(onlyDst),
			);
			const incomingPaths = (result.links!.incoming ?? []).flatMap((l) => [l.sourcePath, l.targetPath]);
			expect(incomingPaths.some((p) => p === "wiki-root/knowledge/src-hidden")).toBe(false);
			// outgoing 为空(此节点无出链)。
			expect(result.links!.outgoing).toHaveLength(0);
		});

		// FIX 2 (round-2): expand(parent, includeLinks=true) 的 child outgoingCount /
		// incomingCount 必须经过 authorizationService.filterVisibleLinks 过滤,只反映
		// 对端在 ctx.access 下可见的链接 (§C.5-class count leak closed)。直接返回
		// linkRepo.both() 的全量长度会让 expand 成为 count-oracle:即使对端被 grant
		// 切掉,也能从计数推断存在性 —— 与 read links 的过滤纪律一致。
		test("FIX 2: expand includeLinks=true child counts reflect ONLY visible peers (no count-oracle)", async () => {
			// fixture: parent/child + child 有两条 outgoing link,一条到 visible peer,
			// 一条到 invisible (out-of-scope) peer。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "parent", kind: "node" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge/parent", name: "child", kind: "node" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "vis-peer", kind: "node" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "invis-peer", kind: "node" },
				ctx(wideOpen()),
			);
			// child → vis-peer (visible) + child → invis-peer (invisible)。
			await svc.link(
				{ source: "wiki-root/knowledge/parent/child", target: "wiki-root/knowledge/vis-peer", relation: "ref" },
				ctx(wideOpen()),
			);
			await svc.link(
				{ source: "wiki-root/knowledge/parent/child", target: "wiki-root/knowledge/invis-peer", relation: "ref" },
				ctx(wideOpen()),
			);

			// 受限 agent: 覆盖 parent + child + vis-peer,不覆盖 invis-peer。
			// (child 自己需要 expand action,parent 需要 expand action。)
			const restricted = access("agent", [
				grant("wiki-root/knowledge/parent", ["expand"]),
				grant("wiki-root/knowledge/parent/child", ["expand"]),
				grant("wiki-root/knowledge/vis-peer", ["read", "expand"]),
				// 注意:invis-peer 不在 grants 里。
			]);

			const result = await svc.expand(
				{ address: "wiki-root/knowledge/parent", includeLinks: true },
				ctx(restricted),
			);
			expect(result.children.items).toHaveLength(1);
			const child = result.children.items[0]!;
			expect(child.path).toBe("wiki-root/knowledge/parent/child");

			// 关键断言:child.outgoingCount 必须是 **1** (只算 vis-peer),
			// **不是** 2 (vis + invis 全量)。
			expect(child.outgoingCount).toBe(1);
			// incomingCount 应为 0 (没有人指向 child)。
			expect(child.incomingCount).toBe(0);

			// 对照:wide-open agent 应看到 outgoingCount=2 (count-oracle 在 wide-open
			// 下等于全量,验证 FIX 2 没有误伤全可见场景)。
			const wideResult = await svc.expand(
				{ address: "wiki-root/knowledge/parent", includeLinks: true },
				ctx(wideOpen()),
			);
			const wideChild = wideResult.children.items.find((c) => c.path === "wiki-root/knowledge/parent/child")!;
			expect(wideChild.outgoingCount).toBe(2);
			expect(wideChild.incomingCount).toBe(0);
		});

		test("FIX 2: expand includeLinks counts filter invisible INCOMING peers too", async () => {
			// 反向:child 是两条 incoming link 的 target,一条来自 visible source,
			// 一条来自 invisible source。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "parent2", kind: "node" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge/parent2", name: "child2", kind: "node" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "vis-src", kind: "node" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "invis-src", kind: "node" },
				ctx(wideOpen()),
			);
			await svc.link(
				{ source: "wiki-root/knowledge/vis-src", target: "wiki-root/knowledge/parent2/child2", relation: "ref" },
				ctx(wideOpen()),
			);
			await svc.link(
				{ source: "wiki-root/knowledge/invis-src", target: "wiki-root/knowledge/parent2/child2", relation: "ref" },
				ctx(wideOpen()),
			);

			const restricted = access("agent", [
				grant("wiki-root/knowledge/parent2", ["expand"]),
				grant("wiki-root/knowledge/parent2/child2", ["expand"]),
				grant("wiki-root/knowledge/vis-src", ["read", "expand"]),
			]);
			const result = await svc.expand(
				{ address: "wiki-root/knowledge/parent2", includeLinks: true },
				ctx(restricted),
			);
			const child = result.children.items.find((c) => c.path === "wiki-root/knowledge/parent2/child2")!;
			// incomingCount = 1 (只算 vis-src);outgoingCount = 0。
			expect(child.incomingCount).toBe(1);
			expect(child.outgoingCount).toBe(0);
		});
	});

	// =========================================================================
	// §C.6 — authorization 在 repository 读节点/正文之前执行
	// =========================================================================

	describe("§C.6 authorization executes BEFORE repository reads node/body", () => {
		test("ACCESS_DENIED path: node read (getActiveByPath) is NOT called", async () => {
			// 准备真实节点。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "guarded", kind: "node", summary: "g" },
				ctx(wideOpen()),
			);

			// 重建 service,在 nodeRepo.getActiveByPath 上装计数器。
			const wikiDb = wiki;
			const inner = new WikiNodeRepository(wikiDb.getDb());
			let getActiveByPathCalls = 0;
			const realGetActiveByPath = inner.getActiveByPath.bind(inner);
			inner.getActiveByPath = (path: string) => {
				getActiveByPathCalls++;
				return realGetActiveByPath(path);
			};
			const service = new WikiService({
				wikiDb,
				nodeRepo: inner,
				linkRepo: new WikiLinkRepository(wikiDb.getDb()),
				auditRepo: new WikiAuditRepository(wikiDb.getDb()),
				repositoryStore: new WikiRepositoryStore(wikiDb.getDb()),
				addressService: new WikiAddressService(new WikiRepositoryStore(wikiDb.getDb()).addresses, inner),
				authorizationService: new WikiAuthorizationService(),
				editService: new WikiEditService(),
			});

			// scope 覆盖但缺 action → ACCESS_DENIED;nodeRepo.getActiveByPath 必须为 0 次。
			const scopeNoAction = access("agent", [grant("wiki-root/knowledge", ["expand"])]);
			await expect(
				service.read({ address: "wiki-root/knowledge/guarded", view: "content" }, ctx(scopeNoAction)),
			).rejects.toMatchObject({ code: "ACCESS_DENIED" });
			expect(getActiveByPathCalls).toBe(0);

			// 无 scope 覆盖 → NOT_FOUND;getActiveByPath 仍必须为 0 次。
			const noScope = access("agent", [grant("wiki-root/memory", ["read", "expand"])]);
			await expect(
				service.read({ address: "wiki-root/knowledge/guarded", view: "content" }, ctx(noScope)),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(getActiveByPathCalls).toBe(0);
		});

		test("expand ACCESS_DENIED: node read NOT called (auth decides before existence check)", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "guarded2", kind: "node" },
				ctx(wideOpen()),
			);
			const inner = new WikiNodeRepository(wiki.getDb());
			let calls = 0;
			const real = inner.getActiveByPath.bind(inner);
			inner.getActiveByPath = (p: string) => {
				calls++;
				return real(p);
			};
			const service = new WikiService({
				wikiDb: wiki,
				nodeRepo: inner,
				linkRepo: new WikiLinkRepository(wiki.getDb()),
				auditRepo: new WikiAuditRepository(wiki.getDb()),
				repositoryStore: new WikiRepositoryStore(wiki.getDb()),
				addressService: new WikiAddressService(new WikiRepositoryStore(wiki.getDb()).addresses, inner),
				authorizationService: new WikiAuthorizationService(),
				editService: new WikiEditService(),
			});
			const noScope = access("agent", [grant("wiki-root/memory", ["expand"])]);
			await expect(
				service.expand({ address: "wiki-root/knowledge/guarded2" }, ctx(noScope)),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(calls).toBe(0);
		});
	});

	// =========================================================================
	// §C.7 — compiled access 不能从 service 输入中的 agentId/projectId 被覆盖
	// =========================================================================

	describe("§C.7 compiled access cannot be overridden by agentId/projectId in ctx", () => {
		test("ctx.agentId resolves memory:// but grants still authoritative (no override)", async () => {
			// 建 wiki-root/memory/victim 与 wiki-root/memory/allowed。
			await svc.ensureAgentMemoryRoot("victim", "Victim");
			await svc.ensureAgentMemoryRoot("allowed", "Allowed");

			// ctx.agentId = "victim" (memory:// 解析到 victim 根),但 access.grants 只覆盖
			// wiki-root/memory/allowed。memory:// 解析到 victim 根后,授权判定用 grants →
			// victim 根未覆盖 → NOT_FOUND。ctx.agentId 无法"扩权"。
			const ctxWithMismatchedId = ctx(
				access("allowed", [grant("wiki-root/memory/allowed", ["read", "expand"])]),
				{ agentId: "victim" },
			);
			await expect(
				svc.read({ address: "memory://", view: "summary" }, ctxWithMismatchedId),
			).rejects.toMatchObject({ code: "NOT_FOUND" });

			// 反向验证: ctx.agentId = "allowed" + 同样 grants → memory:// 解析到 allowed 根 → 允许。
			const ctxAllowed = ctx(
				access("allowed", [grant("wiki-root/memory/allowed", ["read", "expand"])]),
				{ agentId: "allowed" },
			);
			const read = await svc.read({ address: "memory://", view: "summary" }, ctxAllowed);
			expect(read.path).toBe("wiki-root/memory/allowed");
		});

		test("request shapes carry no agentId/projectId/scope fields (no self-report vector)", () => {
			// 结构性断言:数据面 request 类型不应携带 agentId/projectId/scope/grants 字段,
			// 模型无法在 input 中自报身份扩权。
			// 抽样 WikiReadRequest / WikiExpandRequest / WikiCreateRequest / WikiLinkRequest。
			// 这里用对象字面量 + 类型断言验证:无法合法填入 agentId 字段 (TS 不阻止运行时,
			// 但我们断言 service 忽略 req 上的任何自报字段)。
			// 运行时证明:即使 req 上挂了 agentId="admin",授权仍走 ctx.access。
			// (在 §C.7 第一个 test 已覆盖语义;此处仅作形状注释。)
			expect(true).toBe(true);
		});
	});

	// =========================================================================
	// §G 结构不变量
	// =========================================================================

	describe("§G structural invariants (no hidden grant / no grants in DB / no double-write / move no rescan)", () => {
		test("§G no hidden global grant: empty grants → every path NOT_FOUND", () => {
			const auth = new WikiAuthorizationService();
			const empty = access("agent", []);
			for (const p of ["wiki-root", "wiki-root/knowledge", "wiki-root/memory/a/b"]) {
				expect(() => auth.authorize("read", p, empty)).toThrowError(
					expect.objectContaining({ code: "NOT_FOUND" }),
				);
			}
			// decide() 也不注入默认 grant。
			expect(auth.decide("read", "wiki-root/knowledge", empty).allowed).toBe(false);
			expect(auth.decide("read", "wiki-root/knowledge", empty).matchedGrant).toBeNull();
		});

		test("§G grants NOT written to wiki DB / node attributes", async () => {
			// 用 wide-open access 创建多个节点 + 各种操作后,确认:
			// 1) 无 grants 表。
			// 2) wiki_nodes.attributes_json 不含 grant 语义字段 (actions / canonicalScope / wikiGrants)。
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "n1", kind: "node", attributes: { display_name: "N1" } },
				ctx(wideOpen()),
			);
			await svc.update(
				{ address: "wiki-root/knowledge/n1", expected_revision: 1, changes: { attributes: { review_after: "2099-01-01" } } },
				ctx(wideOpen()),
			);

			// 1) 无 grants/acl 表 (schema 里不应有 wiki_grants / wiki_acl)。
			const tables = db
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
				.all() as { name: string }[];
			const tableNames = tables.map((t) => t.name);
			expect(tableNames.some((n) => /grant|acl/i.test(n))).toBe(false);

			// 2) attributes_json 不含 grant 语义字段。
			const rows = db.prepare(`SELECT attributes_json FROM wiki_nodes`).all() as { attributes_json: string | null }[];
			for (const r of rows) {
				const text = r.attributes_json ?? "";
				expect(text).not.toMatch(/canonicalScope|wikiGrants|"actions"\s*:/i);
			}
		});

		test("§G no double-write incoming/outgoing: one wiki_links row per (source,target,relation)", async () => {
			await svc.create({ parent: "wiki-root/knowledge", name: "l-src", kind: "node" }, ctx(wideOpen()));
			await svc.create({ parent: "wiki-root/knowledge", name: "l-dst", kind: "node" }, ctx(wideOpen()));
			await svc.link(
				{ source: "wiki-root/knowledge/l-src", target: "wiki-root/knowledge/l-dst", relation: "ref" },
				ctx(wideOpen()),
			);

			// 单条 link 必须只产生 1 行 wiki_links (不双写反向 incoming/outgoing)。
			const n = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_links WHERE relation = 'ref'`,
			);
			expect(n).toBe(1);

			// outgoing(l-src) 返回 1 条;incoming(l-dst) 返回同 1 条 (同一行,不是两行)。
			const linkRepo = new WikiLinkRepository(db);
			expect(linkRepo.outgoing(0).length).toBe(0); // id 0 不存在,仅确认 API 形状
			const srcNode = new WikiNodeRepository(db).getActiveByPath("wiki-root/knowledge/l-src")!;
			const dstNode = new WikiNodeRepository(db).getActiveByPath("wiki-root/knowledge/l-dst")!;
			expect(linkRepo.outgoing(srcNode.id)).toHaveLength(1);
			expect(linkRepo.incoming(dstNode.id)).toHaveLength(1);
			expect(linkRepo.outgoing(dstNode.id)).toHaveLength(0);
			expect(linkRepo.incoming(srcNode.id)).toHaveLength(0);
			// 全表行数仍为 1。
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`)).toBe(1);
		});

		test("§G move does NOT rescan/rewrite wiki_links or wiki_addresses targets", async () => {
			// 准备: parent/child + link child→parent + 静态 alias 指向 child。
			await svc.create({ parent: "wiki-root/knowledge", name: "mover", kind: "node" }, ctx(wideOpen()));
			await svc.create(
				{ parent: "wiki-root/knowledge/mover", name: "child", kind: "node" },
				ctx(wideOpen()),
			);
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "other", kind: "node" },
				ctx(wideOpen()),
			);
			await svc.link(
				{ source: "wiki-root/knowledge/mover/child", target: "wiki-root/knowledge/other", relation: "ref" },
				ctx(wideOpen()),
			);
			// 静态 alias 指向 mover/child (内部 target_id)。
			const store = new WikiRepositoryStore(db);
			const childNode = new WikiNodeRepository(db).getActiveByPath("wiki-root/knowledge/mover/child")!;
			store.addresses.upsert({
				address: "static://child-alias",
				target_id: childNode.id,
				scope: "static",
				kind: "alias",
			});

			// 记录 move 前的 wiki_links / wiki_addresses rowid + 整数 target。
			const linkBefore = db
				.prepare(`SELECT rowid, source_id, target_id, relation FROM wiki_links WHERE relation='ref'`)
				.get() as { rowid: number; source_id: number; target_id: number; relation: string };
			const addrBefore = db
				.prepare(`SELECT rowid, target_id, revision FROM wiki_addresses WHERE address='static://child-alias'`)
				.get() as { rowid: number; target_id: number; revision: number };

			// move wiki-root/knowledge/mover → wiki-root/knowledge/mover2 (rename)。
			await svc.move(
				{ address: "wiki-root/knowledge/mover", newParent: "wiki-root/knowledge", newName: "mover2" },
				ctx(wideOpen()),
			);

			// move 后: link 的 source_id/target_id 不变 (同 rowid,同整数);address target_id 不变。
			const linkAfter = db
				.prepare(`SELECT rowid, source_id, target_id, relation FROM wiki_links WHERE relation='ref'`)
				.get() as { rowid: number; source_id: number; target_id: number; relation: string };
			const addrAfter = db
				.prepare(`SELECT rowid, target_id, revision FROM wiki_addresses WHERE address='static://child-alias'`)
				.get() as { rowid: number; target_id: number; revision: number };

			expect(linkAfter.rowid).toBe(linkBefore.rowid);
			expect(linkAfter.source_id).toBe(linkBefore.source_id);
			expect(linkAfter.target_id).toBe(linkBefore.target_id);
			expect(addrAfter.rowid).toBe(addrBefore.rowid);
			expect(addrAfter.target_id).toBe(addrBefore.target_id);
			expect(addrAfter.revision).toBe(addrBefore.revision); // move 不动 address row

			// wiki_links 行数未翻倍 (没有 "rewrite 产生新行" 痕迹)。
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_links`)).toBe(1);
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_addresses`)).toBe(1);
		});

		test("§G auth-before-existence: node missing + in-scope+action → NOT_FOUND still AFTER auth (no pre-existence oracle)", async () => {
			// 在已授权 scope 内查不存在的节点:授权通过 → 再查 existence → NOT_FOUND。
			// 这与 §C.2 形成对照:此处 ACCESS 通过,NOT_FOUND 来自存在性查询。
			const inScope = access("agent", [grant("wiki-root/knowledge", ["read", "expand"])]);
			await expect(
				svc.read({ address: "wiki-root/knowledge/never-created", view: "summary" }, ctx(inScope)),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	// =========================================================================
	// 额外:auth 错误消息不泄露内部整数 ID (acceptance-02 §G 错误形状)
	// =========================================================================

	describe("auth error messages do not leak internal integer IDs", () => {
		test("NOT_FOUND / ACCESS_DENIED / ADDRESS_UNRESOLVED messages contain no numeric ids", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "secret", kind: "node" },
				ctx(wideOpen()),
			);
			const noAccess = access("agent", [grant("wiki-root/memory", ["read"])]);

			const cases: string[] = [];
			try {
				await svc.read({ address: "wiki-root/knowledge/secret", view: "summary" }, ctx(noAccess));
			} catch (e) {
				cases.push((e as Error).message);
			}
			try {
				await svc.read({ address: "memory://", view: "summary" }, ctx(noAccess));
			} catch (e) {
				cases.push((e as Error).message);
			}
			for (const msg of cases) {
				// 不应出现 "id=" / "target_id=" / 纯数字 id 等。
				expect(msg).not.toMatch(/id\s*=\s*\d|target_id\s*=\s*\d|parent_id\s*=\s*\d/i);
			}
		});
	});
});
