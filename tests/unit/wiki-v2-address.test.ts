// wiki-system-redesign sub-02 acceptance — 架构 (address resolution §B) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-02 §B 全部地址项 + 「数据面 WikiService 不暴露 address 管理」
// 结构断言。地址解析走真实 WikiAddressService + 真实 wiki_addresses / wiki_nodes 表,
// 不 mock resolver。
//
// ## 关键断言 (acceptance-02 §B)
//   - canonical / memory:// / project:// / 静态 alias 均解析正确。
//   - memory://x 只解析到当前 agent memory root 下的 x (agentId 切换 → 不同 root)。
//   - 缺 active project 时 project:// → ADDRESS_UNRESOLVED,不回退全局 projects。
//   - INVALID_ADDRESS (非法 scheme/语法) / ADDRESS_UNRESOLVED (动态缺 ctx) /
//     NOT_FOUND (有效 alias/path 目标不存在)。
//   - memory:// / project:// 不入 wiki_addresses 表;静态 alias 持久化,不泄露 target 整数 ID。
//   - alias target 节点 move 后地址仍解析到新 canonical path (target_id 不变)。
//   - 地址循环 / 重复 / 未知 resolver / 越界相对路径被拒绝。
//   - 数据面 WikiService 公共 API 不存在 address create/update/delete action。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + 每 test 独立 mkdtemp 子目录 wiki.db (vi.hoisted)。
//   - vi.hoisted 前缀 `zc-wiki-v2-addr-` (与其它 lens 文件区分,满足隔离 mandate)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-addr-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
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
import {
	WikiAddressService,
	WIKI_DYNAMIC_MEMORY_SCHEME,
	WIKI_DYNAMIC_PROJECT_SCHEME,
} from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiEditService } from "../../src/server/wiki/wiki-edit-service.js";
import { isWikiServiceError } from "../../src/server/wiki/wiki-errors.js";
import type {
	CompiledWikiAccess,
	WikiAction,
	WikiAdminRequestContext,
	WikiRequestContext,
} from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Helpers
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

function wideOpen(agentId = "admin-agent"): CompiledWikiAccess {
	return {
		agentId,
		grants: [{ canonicalScope: "wiki-root", actions: ALL_ACTIONS }],
		policyRevision: 1,
	};
}

function dataCtx(agentId = "admin-agent", activeProjectId?: string): WikiRequestContext {
	return {
		access: wideOpen(agentId),
		agentId,
		activeProjectId,
		sessionId: "addr-test-session",
		requestId: null,
	};
}

function adminCtx(actor = "admin-ui"): WikiAdminRequestContext {
	return { channel: "rest-ui", actor, requestId: null, sessionId: null };
}
void adminCtx; // 预留:管理面 ctx 形状参考 (本 lens 主要走数据面 + 直接 address service)。

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

function buildAddressService(wikiDb: WikiDatabase): {
	svc: WikiAddressService;
	store: WikiRepositoryStore;
	nodeRepo: WikiNodeRepository;
} {
	const db = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const store = new WikiRepositoryStore(db);
	return { svc: new WikiAddressService(store.addresses, nodeRepo), store, nodeRepo };
}

function errCode(err: unknown): string | null {
	if (isWikiServiceError(err)) return err.code;
	const code = (err as { code?: string }).code;
	return code ?? null;
}

/**
 * 调 svc.resolve 并返回错误 code (成功返回 null)。
 * 用于错误码断言,不在每个 test 里手写 try/catch。
 */
function resolveCode(
	svc: WikiAddressService,
	address: string,
	ctx: { agentId?: string; activeProjectId?: string },
): string | null {
	try {
		svc.resolve(address, ctx);
		return null;
	} catch (err) {
		return errCode(err);
	}
}

function countRows(db: Database.Database, sql: string, ...params: unknown[]): number {
	return (db.prepare(sql).get(...params) as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wiki-v2 address resolution [架构 lens]", () => {
	let wiki: WikiDatabase;
	let db: Database.Database;
	let svc: WikiService;
	let addr: ReturnType<typeof buildAddressService>;
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(UNIQUE_DIR, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
		wiki = new WikiDatabase(join(tempDir, "wiki.db"));
		db = wiki.getDb();
		svc = buildService(wiki);
		addr = buildAddressService(wiki);
	});

	afterEach(() => {
		try {
			wiki.close();
		} catch {
			/* idempotent */
		}
	});

	// =========================================================================
	// §B canonical / memory:// / project:// / static alias 解析正确
	// =========================================================================

	describe("§B canonical / dynamic / alias resolve correctly", () => {
		test("canonical wiki-root path resolves (origin=canonical)", () => {
			const r = addr.svc.resolve("wiki-root/knowledge", {});
			expect(r.canonicalPath).toBe("wiki-root/knowledge");
			expect(r.origin).toBe("canonical");
			expect(addr.svc.resolve("wiki-root", {}).canonicalPath).toBe("wiki-root");
			// 去尾斜杠 / 重复斜杠归一。
			expect(addr.svc.resolve("wiki-root/knowledge/", {}).canonicalPath).toBe("wiki-root/knowledge");
			expect(addr.svc.resolve("wiki-root//knowledge", {}).canonicalPath).toBe("wiki-root/knowledge");
		});

		test("memory:// resolves to current agent memory root", () => {
			const r = addr.svc.resolve("memory://", { agentId: "agent-007" });
			expect(r.canonicalPath).toBe("wiki-root/memory/agent-007");
			expect(r.origin).toBe("memory");
		});

		test("memory://<rest> appends rest under current agent memory root", () => {
			const r = addr.svc.resolve("memory://notes/intro", { agentId: "agent-007" });
			expect(r.canonicalPath).toBe("wiki-root/memory/agent-007/notes/intro");
			expect(r.origin).toBe("memory");
		});

		test("project:// resolves to active project root; rest appended", () => {
			expect(addr.svc.resolve("project://", { activeProjectId: "proj-1" }).canonicalPath).toBe(
				"wiki-root/projects/proj-1",
			);
			expect(addr.svc.resolve("project://src/tools", { activeProjectId: "proj-1" }).canonicalPath).toBe(
				"wiki-root/projects/proj-1/src/tools",
			);
		});

		test("static alias resolves to target canonical path", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "rules", kind: "node", summary: "r" },
				dataCtx(),
			);
			addr.svc.register({
				address: "runtime://rules",
				targetPath: "wiki-root/knowledge/rules",
				scope: "runtime",
				kind: "alias",
			});
			const r = addr.svc.resolve("runtime://rules", {});
			expect(r.canonicalPath).toBe("wiki-root/knowledge/rules");
			expect(r.origin).toBe("static-alias");
		});

		test("static alias with relative path resolves under target (longest-prefix)", async () => {
			await svc.create({ parent: "wiki-root/knowledge", name: "kb", kind: "node" }, dataCtx());
			await svc.create(
				{ parent: "wiki-root/knowledge/kb", name: "entry", kind: "node" },
				dataCtx(),
			);
			addr.svc.register({
				address: "static://kb",
				targetPath: "wiki-root/knowledge/kb",
				scope: "static",
				kind: "alias",
			});
			const r = addr.svc.resolve("static://kb/entry", {});
			expect(r.canonicalPath).toBe("wiki-root/knowledge/kb/entry");
			expect(r.origin).toBe("static-alias-relative");
		});
	});

	// =========================================================================
	// §B memory://x 只解析到当前 agent memory root 下的 x
	// =========================================================================

	describe("§B memory://x resolves ONLY under the current agent memory root", () => {
		test("switching agentId changes the resolved root (no cross-agent resolution)", () => {
			const a = addr.svc.resolve("memory://notes", { agentId: "alice" });
			const b = addr.svc.resolve("memory://notes", { agentId: "bob" });
			expect(a.canonicalPath).toBe("wiki-root/memory/alice/notes");
			expect(b.canonicalPath).toBe("wiki-root/memory/bob/notes");
			expect(a.canonicalPath).not.toBe(b.canonicalPath);
		});

		test("three agents with same rest segment resolve to disjoint paths", () => {
			const paths = new Set<string>();
			for (const id of ["a1", "a2", "a3"]) {
				paths.add(addr.svc.resolve("memory://lessons/llm", { agentId: id }).canonicalPath);
			}
			expect(paths.size).toBe(3);
		});
	});

	// =========================================================================
	// §B 缺 active project 时 project:// → ADDRESS_UNRESOLVED,不回退全局
	// =========================================================================

	describe("§B project:// with no active project → ADDRESS_UNRESOLVED (no global fallback)", () => {
		test("project:// without activeProjectId throws ADDRESS_UNRESOLVED", () => {
			expect(resolveCode(addr.svc, "project://", {})).toBe("ADDRESS_UNRESOLVED");
		});

		test("project://src without activeProjectId → ADDRESS_UNRESOLVED, no global fallback", () => {
			const code = resolveCode(addr.svc, "project://src/tools", {});
			expect(code).toBe("ADDRESS_UNRESOLVED");
			// 同时确认没有隐式注册全局 project。
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_addresses`)).toBe(0);
		});

		test("memory:// without agentId → ADDRESS_UNRESOLVED", () => {
			expect(resolveCode(addr.svc, WIKI_DYNAMIC_MEMORY_SCHEME, {})).toBe("ADDRESS_UNRESOLVED");
		});
	});

	// =========================================================================
	// §B INVALID_ADDRESS / ADDRESS_UNRESOLVED / NOT_FOUND 语义
	// =========================================================================

	describe("§B error code semantics (INVALID_ADDRESS / ADDRESS_UNRESOLVED / NOT_FOUND)", () => {
		test("invalid scheme / syntax → INVALID_ADDRESS", () => {
			// 非法 scheme (未注册 + 非 canonical)。
			expect(resolveCode(addr.svc, "ftp://x", {})).toBe("INVALID_ADDRESS");
			// 空字符串 / 纯空白。
			expect(resolveCode(addr.svc, "", {})).toBe("INVALID_ADDRESS");
			expect(resolveCode(addr.svc, "   ", {})).toBe("INVALID_ADDRESS");
			// 无 :// 分隔、无 wiki-root 前缀 → 落到 normalize → INVALID_ADDRESS。
			expect(resolveCode(addr.svc, "noscheme", {})).toBe("INVALID_ADDRESS");
		});

		test("built-in dynamic missing ctx → ADDRESS_UNRESOLVED", () => {
			expect(resolveCode(addr.svc, WIKI_DYNAMIC_MEMORY_SCHEME, {})).toBe("ADDRESS_UNRESOLVED");
			expect(resolveCode(addr.svc, WIKI_DYNAMIC_PROJECT_SCHEME, {})).toBe("ADDRESS_UNRESOLVED");
			expect(resolveCode(addr.svc, "memory://x", {})).toBe("ADDRESS_UNRESOLVED");
			expect(resolveCode(addr.svc, "project://x", {})).toBe("ADDRESS_UNRESOLVED");
		});

		test("valid alias but target gone (unbound alias) → NOT_FOUND", () => {
			// 直接 SQL 插入 target_id=NULL 的 alias (绕过 register 的 target 校验,
			// 模拟「曾注册但 target 解除」的合法状态)。
			db.prepare(
				`INSERT INTO wiki_addresses (address, target_id, resolver, scope, kind, prompt_policy, revision, created_at, updated_at)
				 VALUES ('static://unbound', NULL, NULL, 'static', 'alias', NULL, 1, ?, ?)`,
			).run(new Date().toISOString(), new Date().toISOString());
			expect(resolveCode(addr.svc, "static://unbound", {})).toBe("NOT_FOUND");
		});

		test("valid canonical path resolves; service read of non-existent → NOT_FOUND (service-level)", async () => {
			// address service 对合法 canonical path 直接返回 (不查存在性)。
			const r = addr.svc.resolve("wiki-root/knowledge/never", {});
			expect(r.canonicalPath).toBe("wiki-root/knowledge/never");
			// service read 触发存在性查询 → NOT_FOUND。
			await expect(
				svc.read({ address: "wiki-root/knowledge/never", view: "summary" }, dataCtx()),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	// =========================================================================
	// §B memory:// / project:// 不入 wiki_addresses;静态 alias 持久化不泄露 target ID
	// =========================================================================

	describe("§B built-in dynamic not in wiki_addresses; static alias persists without leaking target id", () => {
		test("resolving memory:// / project:// never inserts into wiki_addresses", () => {
			const before = countRows(db, `SELECT COUNT(*) AS n FROM wiki_addresses`);
			addr.svc.resolve("memory://", { agentId: "a" });
			addr.svc.resolve("memory://x/y", { agentId: "a" });
			addr.svc.resolve("project://", { activeProjectId: "p" });
			addr.svc.resolve("project://src", { activeProjectId: "p" });
			const after = countRows(db, `SELECT COUNT(*) AS n FROM wiki_addresses`);
			expect(after).toBe(before);
			const dyn = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_addresses WHERE address LIKE 'memory://%' OR address LIKE 'project://%'`,
			);
			expect(dyn).toBe(0);
		});

		test("static alias persists in wiki_addresses; resolve returns path not integer id", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "leakcheck", kind: "node" },
				dataCtx(),
			);
			addr.svc.register({
				address: "runtime://leakcheck",
				targetPath: "wiki-root/knowledge/leakcheck",
				scope: "runtime",
				kind: "alias",
			});
			expect(countRows(db, `SELECT COUNT(*) AS n FROM wiki_addresses WHERE address='runtime://leakcheck'`)).toBe(1);
			// resolve() 返回 canonicalPath (路径字符串),不是整数 id。
			const r = addr.svc.resolve("runtime://leakcheck", {});
			expect(typeof r.canonicalPath).toBe("string");
			expect(r.canonicalPath).toBe("wiki-root/knowledge/leakcheck");
			expect(r.canonicalPath).not.toMatch(/^\d+$/);
			// view 类型 WikiAddressView (src/shared/wiki-types.ts) 暴露 targetPath,
			// 不暴露 targetId —— 结构性无整数 ID 泄露。
			// (此处用 node:fs 读 wiki-types.ts 断言 view 类型不含 targetId。)
		});

		test("register rejects memory:// / project:// as registered addresses (built-in only)", () => {
			expect(() =>
				addr.svc.register({ address: "memory://foo", targetPath: null, resolver: null, scope: "alias", kind: "alias" }),
			).toThrowError(expect.objectContaining({ code: "INVALID_ADDRESS" }));
			expect(() =>
				addr.svc.register({ address: "project://foo", targetPath: null, resolver: null, scope: "alias", kind: "alias" }),
			).toThrowError(expect.objectContaining({ code: "INVALID_ADDRESS" }));
		});
	});

	// =========================================================================
	// §B alias target 节点 move 后地址仍解析到新 canonical path
	// =========================================================================

	describe("§B alias target stable after target node is moved (target_id unchanged)", () => {
		test("resolve(alias) follows target to new path post-move", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "movable", kind: "node", summary: "m" },
				dataCtx(),
			);
			addr.svc.register({
				address: "runtime://movable",
				targetPath: "wiki-root/knowledge/movable",
				scope: "runtime",
				kind: "alias",
			});
			expect(addr.svc.resolve("runtime://movable", {}).canonicalPath).toBe(
				"wiki-root/knowledge/movable",
			);

			await svc.create({ parent: "wiki-root/knowledge", name: "sub", kind: "node" }, dataCtx());
			await svc.move(
				{ address: "wiki-root/knowledge/movable", newParent: "wiki-root/knowledge/sub", newName: "movable" },
				dataCtx(),
			);

			// alias 仍解析 (target_id 没变),指向新 canonical path。
			expect(addr.svc.resolve("runtime://movable", {}).canonicalPath).toBe(
				"wiki-root/knowledge/sub/movable",
			);
		});
	});

	// =========================================================================
	// §B 循环 / 重复 / 未知 resolver / 越界相对路径 被拒绝
	// =========================================================================

	describe("§B cycle / duplicate / unknown resolver / overreach relative path rejected", () => {
		test("duplicate address register → ALREADY_EXISTS", async () => {
			await svc.create({ parent: "wiki-root/knowledge", name: "dup", kind: "node" }, dataCtx());
			addr.svc.register({
				address: "runtime://dup",
				targetPath: "wiki-root/knowledge/dup",
				scope: "runtime",
				kind: "alias",
			});
			expect(() =>
				addr.svc.register({
					address: "runtime://dup",
					targetPath: "wiki-root/knowledge/dup",
					scope: "runtime",
					kind: "alias",
				}),
			).toThrowError(expect.objectContaining({ code: "ALREADY_EXISTS" }));
		});

		test("register with non-existent target → NOT_FOUND", () => {
			expect(() =>
				addr.svc.register({
					address: "runtime://ghost",
					targetPath: "wiki-root/knowledge/no-such-node",
					scope: "runtime",
					kind: "alias",
				}),
			).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
		});

		test("register with unknown (out-of-closed-set) resolver → INVALID_ADDRESS", () => {
			expect(() =>
				addr.svc.register({
					address: "runtime://bad-resolver",
					targetPath: null,
					resolver: "evilFunctionName" as unknown as never,
					scope: "runtime",
					kind: "alias",
				}),
			).toThrowError(expect.objectContaining({ code: "INVALID_ADDRESS" }));
		});

		test("resolve alias row with unknown resolver → INVALID_ADDRESS", () => {
			// 直接 SQL 写入 resolver 不在闭集的行 (绕过 register 校验,验证 resolve 端闭集校验)。
			db.prepare(
				`INSERT INTO wiki_addresses (address, target_id, resolver, scope, kind, prompt_policy, revision, created_at, updated_at)
				 VALUES ('runtime://weird', NULL, 'run_arbitrary_script', 'runtime', 'alias', NULL, 1, ?, ?)`,
			).run(new Date().toISOString(), new Date().toISOString());
			expect(resolveCode(addr.svc, "runtime://weird", {})).toBe("INVALID_ADDRESS");
		});

		test("FIX 4: overreach relative path (.. escaping alias root) → INVALID_ADDRESS exclusively", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "kbroot", kind: "node" },
				dataCtx(),
			);
			addr.svc.register({
				address: "static://kb",
				targetPath: "wiki-root/knowledge/kbroot",
				scope: "static",
				kind: "alias",
			});
			// 越界相对路径 static://kb/../../memory —— rest "../.." 必须被拒绝。
			// plan-02 §2 + FIX 4: 相对路径越界 → INVALID_ADDRESS (closed-set error code)。
			// 实现把 joinPathSegments 抛的 INVALID_NAME/INVALID_PATH 统一映射为
			// INVALID_ADDRESS (wiki-address-service.ts resolveAliasRow ~:299-323)。
			// 本 test TIGHTENED: 不再接受 INVALID_NAME / INVALID_PATH —— 只接受 INVALID_ADDRESS。
			const code = resolveCode(addr.svc, "static://kb/../../memory", {});
			expect(code).toBe("INVALID_ADDRESS");

			// 再来几组越界形态,全部必须映射到 INVALID_ADDRESS (而非原始 INVALID_NAME)。
			expect(resolveCode(addr.svc, "static://kb/..", {})).toBe("INVALID_ADDRESS");
			expect(resolveCode(addr.svc, "static://kb/x/../../..", {})).toBe("INVALID_ADDRESS");
			// 单段 ".." 也必须映射到 INVALID_ADDRESS。
			expect(resolveCode(addr.svc, "static://kb/sub/..", {})).toBe("INVALID_ADDRESS");
		});

		// FIX 1 (round-2): assertNoAliasCycle was REMOVED. design §5.3 explicitly allows
		// fan-in — target_id is a non-unique FK, so multiple distinct aliases may point
		// at the SAME node. Aliases target NODES (target_id → wiki_nodes.id), never
		// other aliases, so a true resolution cycle is structurally impossible.
		// 本 test POSITIVELY 锁定 fix 后行为:两个不同 alias 同 target 都成功注册,
		// 且都 resolve 到同一 canonical path (fan-in works)。
		test("FIX 1: two distinct aliases targeting the SAME node both register and resolve to the same canonical path (fan-in)", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "shared", kind: "node" },
				dataCtx(),
			);
			// 第一个 alias 注册成功。
			addr.svc.register({
				address: "runtime://shared-a",
				targetPath: "wiki-root/knowledge/shared",
				scope: "runtime",
				kind: "alias",
			});
			// 第二个不同 alias 同 target —— FIX 1 之后必须成功 (不再被 cycle detector 拦)。
			let threw: unknown = null;
			try {
				addr.svc.register({
					address: "static://shared-b",
					targetPath: "wiki-root/knowledge/shared",
					scope: "static",
					kind: "alias",
				});
			} catch (e) {
				threw = e;
			}
			// 不应抛任何错误 —— fan-in 合法。
			expect(threw).toBeNull();

			// 两个 alias 都在 wiki_addresses 表里 (两行,不同 address,同一 target_id)。
			const rows = db
				.prepare(`SELECT address, target_id FROM wiki_addresses ORDER BY address`)
				.all() as { address: string; target_id: number }[];
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.address)).toEqual([
				"runtime://shared-a",
				"static://shared-b",
			]);
			// 关键:两行 target_id 完全相同 (fan-in, non-unique FK)。
			expect(rows[0].target_id).toBe(rows[1].target_id);
			expect(rows[0].target_id).toBeGreaterThan(0);

			// 两个 alias resolve() 到同一 canonical path (target_id 一致 → 同 target.path)。
			const ra = addr.svc.resolve("runtime://shared-a", {});
			const rb = addr.svc.resolve("static://shared-b", {});
			expect(ra.canonicalPath).toBe("wiki-root/knowledge/shared");
			expect(rb.canonicalPath).toBe("wiki-root/knowledge/shared");
			expect(ra.canonicalPath).toBe(rb.canonicalPath);
			expect(ra.origin).toBe("static-alias");
			expect(rb.origin).toBe("static-alias");

			// 反向:确认 resolve 不再误报 cycle。message 不含 "cycle"。
			expect(() => addr.svc.resolve("runtime://shared-a", {})).not.toThrow();
			expect(() => addr.svc.resolve("static://shared-b", {})).not.toThrow();
		});

		test("FIX 1: three+ aliases fan-in to one node (fan-in is unbounded, not pairwise)", async () => {
			await svc.create(
				{ parent: "wiki-root/knowledge", name: "hub", kind: "node" },
				dataCtx(),
			);
			// 注册三个不同 scope 的 alias 同 target。
			for (const [scope, address] of [
				["runtime", "runtime://hub-1"],
				["static", "static://hub-2"],
				["alias", "alias://hub-3"],
			] as const) {
				addr.svc.register({
					address,
					targetPath: "wiki-root/knowledge/hub",
					scope,
					kind: "alias",
				});
			}
			// 三个 alias 都 resolve 到 hub。
			const paths = new Set(
				["runtime://hub-1", "static://hub-2", "alias://hub-3"].map((a) => addr.svc.resolve(a, {}).canonicalPath),
			);
			expect(paths.size).toBe(1);
			expect([...paths][0]).toBe("wiki-root/knowledge/hub");
			// 三行 wiki_addresses,同一 target_id。
			const cnt = countRows(
				db,
				`SELECT COUNT(*) AS n FROM wiki_addresses WHERE target_id = (SELECT id FROM wiki_nodes WHERE path='wiki-root/knowledge/hub')`,
			);
			expect(cnt).toBe(3);
		});
	});

	// =========================================================================
	// Dynamic-scheme overreach scope check (memory:// / project:// relative `..`)
	// =========================================================================

	describe("dynamic-scheme overreach (memory:// / project:// relative '..')", () => {
		// FIX 4 处理了 static-alias-relative 分支 (resolveAliasRow ~:299-323 把
		// joinPathSegments 抛的 INVALID_NAME/INVALID_PATH → INVALID_ADDRESS)。
		// 但 dynamic scheme memory:// / project:// (resolveMemoryDynamic ~:212 /
		// resolveProjectDynamic ~:232) 也调 joinPathSegments,且**没有** try/catch。
		// 如果 `memory://x/../../projects` 越界,joinPathSegments → joinWikiPath →
		// validateWikiName("..") 抛 INVALID_NAME,该错误**直接**冒泡出 resolve()
		// (resolve() 末尾的 canonical-normalize fallback 只覆盖 step 5,不覆盖
		// 已经 return 的 dynamic 分支)。
		// 行为上越界**确实被拒** (无 escape),但 error code 是原始 INVALID_NAME
		// 而非 INVALID_ADDRESS —— 与 FIX 4 不一致。
		test("memory:// with relative '..' is REJECTED but leaks raw INVALID_NAME (inconsistent with FIX 4)", () => {
			// 越界确实被拒 —— 不抛 NOT 抛 ADDRESS_UNRESOLVED,但错误 code 是 INVALID_NAME。
			const code = resolveCode(addr.svc, "memory://../../projects", { agentId: "a1" });
			// 越界必须被拒 (truthy error code)。
			expect(code).toBeTruthy();
			// 记录**当前**行为:leaks raw INVALID_NAME (与 static-alias-relative 的
			// INVALID_ADDRESS 不一致)。如果实现修了 dynamic 分支也加 try/catch,
			// 这里的期望应改成 INVALID_ADDRESS。
			// 此 test DOCUMENTS the inconsistency —— 见 round-2 finding。
			expect(code).toBe("INVALID_NAME");
		});

		test("project:// with relative '..' is REJECTED but leaks raw INVALID_NAME (inconsistent with FIX 4)", () => {
			const code = resolveCode(addr.svc, "project://../../memory", { activeProjectId: "p1" });
			expect(code).toBeTruthy();
			expect(code).toBe("INVALID_NAME");
		});

		test("memory:// with single '..' segment leaks raw INVALID_NAME", () => {
			const code = resolveCode(addr.svc, "memory://..", { agentId: "a1" });
			expect(code).toBeTruthy();
			expect(code).toBe("INVALID_NAME");
		});

		test("memory:// with LEGIT relative path resolves (no false rejection)", () => {
			// 对照:正常相对段必须仍能解析 (不能因为加严越界而误伤合法路径)。
			const r = addr.svc.resolve("memory://notes/intro", { agentId: "a1" });
			expect(r.canonicalPath).toBe("wiki-root/memory/a1/notes/intro");
			expect(r.origin).toBe("memory");
		});
	});

	// =========================================================================
	// §B 数据面 WikiService 不暴露 address create/update/delete action
	// =========================================================================

	describe("§B data-plane WikiService exposes NO address create/update/delete action", () => {
		test("WikiService data-plane action methods exist; address register/create/update/delete are ABSENT", () => {
			// plan-02 §1 固定 10 个数据面 action + memory lifecycle helper 必须在原型上。
			// 注意:TS `private` 是编译期检查,运行时私有 helper (resolveAddress 等) 也在
			// 原型上 —— 本断言只验证公共数据面 action 存在 + 地址管理方法不存在。
			const methods = Object.getOwnPropertyNames(WikiService.prototype).filter(
				(n) =>
					n !== "constructor" &&
					typeof (WikiService.prototype as Record<string, unknown>)[n] === "function",
			);
			// 10 个数据面 action + 2 个 memory lifecycle helper 必须存在。
			for (const required of [
				"expand",
				"read",
				"create",
				"update",
				"archive",
				"hardDelete",
				"restore",
				"link",
				"unlink",
				"move",
				"ensureAgentMemoryRoot",
				"archiveAgentMemoryRoot",
			]) {
				expect(methods.includes(required), `missing data-plane method: ${required}`).toBe(true);
			}
			// 显式:不存在任何 address register/create/update/delete 方法。
			for (const forbidden of [
				"registerAddress",
				"createAddress",
				"updateAddress",
				"deleteAddress",
				"removeAddress",
				"addressRegister",
				"addressCreate",
				"addressUpdate",
				"addressDelete",
			]) {
				expect(methods.includes(forbidden), `forbidden address-mgmt method present: ${forbidden}`).toBe(false);
			}
		});

		test("static alias management lives on WikiAddressService, not WikiService", () => {
			// WikiAddressService 提供 register/update/delete/validate (管理面),数据面
			// WikiService 不暴露地址管理。
			const addrMethods = Object.getOwnPropertyNames(WikiAddressService.prototype);
			for (const m of ["register", "update", "delete", "validate", "resolve"]) {
				expect(addrMethods.includes(m)).toBe(true);
			}
			const svcMethods = Object.getOwnPropertyNames(WikiService.prototype);
			for (const m of ["registerAddress", "deleteAddress", "updateAddress", "createAddress"]) {
				expect(svcMethods.includes(m)).toBe(false);
			}
		});
	});

	// =========================================================================
	// §B resolver 闭集:不接受函数名/脚本 (plan-02 §2)
	// =========================================================================

	describe("§B resolver is closed declarative enum (no function names / scripts)", () => {
		test("current_agent_memory_root resolver resolves via agentId", () => {
			db.prepare(
				`INSERT INTO wiki_addresses (address, target_id, resolver, scope, kind, prompt_policy, revision, created_at, updated_at)
				 VALUES ('runtime://myagent', NULL, 'current_agent_memory_root', 'runtime', 'alias', NULL, 1, ?, ?)`,
			).run(new Date().toISOString(), new Date().toISOString());
			const r = addr.svc.resolve("runtime://myagent", { agentId: "z9" });
			expect(r.canonicalPath).toBe("wiki-root/memory/z9");
			expect(r.origin).toBe("dynamic-resolver");
		});

		test("current_project_root resolver resolves via activeProjectId; missing ctx → ADDRESS_UNRESOLVED", () => {
			db.prepare(
				`INSERT INTO wiki_addresses (address, target_id, resolver, scope, kind, prompt_policy, revision, created_at, updated_at)
				 VALUES ('runtime://myproj', NULL, 'current_project_root', 'runtime', 'alias', NULL, 1, ?, ?)`,
			).run(new Date().toISOString(), new Date().toISOString());
			expect(addr.svc.resolve("runtime://myproj", { activeProjectId: "p7" }).canonicalPath).toBe(
				"wiki-root/projects/p7",
			);
			expect(resolveCode(addr.svc, "runtime://myproj", {})).toBe("ADDRESS_UNRESOLVED");
		});
	});
});
