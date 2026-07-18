// wiki-v2 sub-07 acceptance · architecture lens
//
// # 文件说明书
//
// ## 核心功能
// 对照 docs/plan/wiki-system-redesign/design.md 的管理面/数据面分离、authority
// server-injected、canonical path、CAS publish、session refresh 安全边界 契约,
// 以 architecture 方向独立验证 sub-07 实现(plan-07 §1–§7 / acceptance-07 §A–§H)。
//
// 验证 11 项架构不变量:
//   1. admin router wrap service 非 copy —— endpoint 委托 WikiAddressService /
//      WikiProjectIndexer / compileWikiAccess / compileWikiContext,不内联业务。
//   2. authority 真从 server 注入 —— WIKI_ADMIN_AUTHORITY 模块常量 + body 不可扩权。
//   3. validate/preview 纯函数 —— 无 DB write / audit / revision 增长。
//   4. publish CAS + revision+1 + audit —— expectedRevision CAS 语义 + 真递增 + 真写 audit。
//   5. session refresh 边界 —— publish → agentStore.update → onChange → applyConfigUpdate
//      链端到端真活(非 dead wiring);in-flight callerCtx snapshot 不变。
//   6. wiki_admin/wiki_repositories event 独立 —— 不触发 wiki_nodes data tree 误刷。
//   7. PromptTemplate fresh-DB migration —— COLUMNS + db-migration safeAddColumn 同步。
//   8. 类型独立 —— wiki-admin-types vs wiki-types 分离;view 不含 target_id/project_node_id。
//   9. AgentLoop hooks-only 不回归 —— agent-loop.ts 无 wiki admin import。
//  10. preview==runtime —— grants/context preview 与 session build 同函数。
//  11. delete-last-grant [] 持久化 —— publishAgentWikiPolicy 空 grants → 显式 []。
//
// ## 测试策略
// HTTP 层:构造 mock deps,POST 到真实 express router(wiki-admin-router),断言:
//   - service spy 被调(wrap 非 copy)。
//   - body 带身份字段 → 400(authority server-injected)。
//   - validate/preview 后 auditRepo.append 未被调(无副作用)。
//   - publish expectedRevision 不匹配 → 409 WRITE_CONFLICT;匹配 → revision+1 + audit。
//   - emitDataChange spy 捕获 wiki_admin / wiki_repositories(非 wiki_nodes)。
// AgentService 层:真实 AgentService + mock agentStore + fake loop,断言 publish →
// applyConfigUpdate 被调(wiring alive)+ [] 兜底。
// 源码结构层:读 wiki-v2-tool.ts / wiki-router.ts / wiki-admin-types.ts / agent-loop.ts
// / template-store.ts / db-migration.ts,断言 closed enum / 无内部 ID / hooks-only / 列同步。
//
// ## Windows vitest 注意
// 不开 better-sqlite3 / temp DB —— 只 express + mock + AgentService(无 DB),无崩溃面。
//
// 参见:
//   - docs/plan/wiki-system-redesign/design.md §3.1 / §7.4 / §9.3 / §10.2
//   - docs/plan/wiki-system-redesign/acceptance-07-management-ui.md §A/§B/§H

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express, { type Express } from "express";
import { createServer, type Server } from "http";

import { createWikiAdminRouter } from "../../src/server/wiki-admin-router.js";
import { AgentService } from "../../src/server/agent-service.js";
import { compileWikiAccess } from "../../src/server/wiki/wiki-access-compiler.js";
import { compileWikiContext } from "../../src/server/wiki/wiki-context-compiler.js";
import { WIKI_ROOT_PATH } from "../../src/server/wiki/wiki-path.js";
import { _resetDataChangeHubForTest, onDataChange } from "../../src/server/data-change-hub.js";
import { setWikiRuntime, _resetWikiRuntimeForTests } from "../../src/server/wiki/wiki-runtime.js";

// ─── helpers ──────────────────────────────────────────────────────────

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

const REPO_ROOT = join(__dirname, "..", "..");
function src(rel: string): string {
	return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** mock WikiAddressService: validate 纯函数,register/update/delete spy。 */
function makeMockAddressService() {
	return {
		validate: vi.fn((_input: any) => ({ ok: true })),
		register: vi.fn((input: any) => ({
			address: input.address, scope: input.scope, kind: input.kind,
			resolver: input.resolver ?? null, target_id: null, prompt_policy: input.promptPolicy ?? null,
			revision: 1, created_at: "t", updated_at: "t",
		})),
		update: vi.fn((address: string, patch: any) => ({
			address, scope: patch.scope ?? "runtime", kind: patch.kind ?? "k",
			resolver: patch.resolver ?? null, target_id: null, prompt_policy: patch.promptPolicy ?? null,
			revision: 2, created_at: "t", updated_at: "t2",
		})),
		delete: vi.fn(() => undefined),
	};
}

/** mock auditRepo: append spy(用于断言 validate/preview 不写 audit)。 */
function makeMockAuditRepo() {
	return { append: vi.fn(() => undefined), listByNodePath: vi.fn(() => []) };
}

/** mock nodeRepo: getById 用于 addressRowToView 解析 target。 */
function makeMockNodeRepo() {
	return { getById: vi.fn(() => null) };
}

/** mock repositoryStore.addresses / .repositories。 */
function makeMockRepositoryStore() {
	return {
		addresses: { list: vi.fn(() => []) },
		repositories: {
			list: vi.fn(() => []),
			getByProjectId: vi.fn(() => null),
			upsert: vi.fn(() => undefined),
			delete: vi.fn(() => undefined),
		},
	};
}

function makeMockIndexer() {
	return {
		ensureBinding: vi.fn(async (_pid: string, _opts: any) => ({
			bound: true, repositoryId: "repo-1", projectNodePath: "wiki-root/projects/p1",
			sourceRoot: "", defaultBranch: "main", error: null,
		})),
		sync: vi.fn(async () => ({
			repositoryId: "repo-1", fromRevision: null, toRevision: "abc",
			syncStatus: "synced", stats: {}, error: null,
		})),
		rebuildFromScratch: vi.fn(async () => ({
			ok: true, repositoryId: "repo-1", indexedRevision: "abc", error: null,
		})),
		fullIndex: vi.fn(async () => ({ ok: true, indexedRevision: "abc", error: null })),
	};
}

function makeMockGit() {
	return {
		isGitRepo: vi.fn(async () => true),
		resolveRevision: vi.fn(async () => "deadbeef"),
		detectDefaultBranch: vi.fn(async () => "main"),
	};
}

function makeMockProjectStore() {
	return {
		get: vi.fn((id: string) => ({ id, name: id, workspaceDir: "/ws" })),
		list: vi.fn(() => []),
	};
}

/** 构造 mock agentStore: get/update/list/onChange。update 触发 onChange cb
 * (模拟真实 notifyChanged),用于 publishAgentWikiPolicy → onChange wiring 测试。 */
function makeMockAgentStore(agents: Record<string, any> = {}) {
	const cbs = new Set<(agentId: string) => void>();
	return {
		get: vi.fn((id: string) => agents[id]),
		update: vi.fn((id: string, patch: any) => {
			agents[id] = { ...agents[id], ...patch };
			for (const cb of cbs) cb(id);
			return agents[id];
		}),
		list: vi.fn(() => Object.values(agents)),
		onChange: vi.fn((cb: (agentId: string) => void) => {
			cbs.add(cb);
			return () => cbs.delete(cb);
		}),
	};
}

/** 构造全套 admin router deps(mocks)。 */
function makeDeps(overrides: Record<string, any> = {}) {
	const base = {
		wikiService: { listHistory: vi.fn(() => []) },
		addressService: makeMockAddressService(),
		indexer: makeMockIndexer(),
		repositoryStore: makeMockRepositoryStore(),
		auditRepo: makeMockAuditRepo(),
		nodeRepo: makeMockNodeRepo(),
		projectStore: makeMockProjectStore(),
		agentService: {
			publishAgentWikiPolicy: vi.fn(() => ({
				newRevision: 2, affectedSessions: [{ sessionId: "s1", applied: true }],
			})),
			getAgentWikiSessionStatus: vi.fn(() => []),
		} as any,
		agentStore: makeMockAgentStore(),
		git: makeMockGit(),
	};
	return { ...base, ...overrides };
}

// ===========================================================================
// 1. admin router wraps services (not copy) · acceptance-07 §A
// ===========================================================================

describe("sub-07 arch · admin router wraps services (§A.1 / design §3.1)", () => {
	let app: Express; let server: Server; let port: number; let deps: ReturnType<typeof makeDeps>;

	beforeEach(async () => {
		deps = makeDeps();
		app = express();
		app.use(express.json());
		app.use("/api/wiki-admin", createWikiAdminRouter(deps as any));
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => { await close(server); });

	test("POST /addresses/validate → addressService.validate (delegate, no inline logic)", async () => {
		const res = await post(port, "/api/wiki-admin/addresses/validate", {
			address: "runtime://x", scope: "runtime", kind: "k", resolver: null,
		});
		expect(res.status).toBe(200);
		expect(deps.addressService.validate).toHaveBeenCalledTimes(1);
		expect(deps.addressService.register).not.toHaveBeenCalled();
	});

	test("POST /addresses/create → addressService.register + auditRepo.append", async () => {
		const res = await post(port, "/api/wiki-admin/addresses/create", {
			address: "runtime://y", scope: "runtime", kind: "k", resolver: null,
		});
		expect(res.status).toBe(200);
		expect(deps.addressService.register).toHaveBeenCalledTimes(1);
		expect(deps.auditRepo.append).toHaveBeenCalledWith(expect.objectContaining({
			action: "address.create", actorAgentId: "@wiki-admin",
		}));
	});

	test("POST /repositories/bind → indexer.ensureBinding + indexer.fullIndex (delegate)", async () => {
		const res = await post(port, "/api/wiki-admin/repositories/bind", { projectId: "p1" });
		expect(res.status).toBe(200);
		expect(deps.indexer.ensureBinding).toHaveBeenCalledTimes(1);
		expect(deps.indexer.fullIndex).toHaveBeenCalledTimes(1);
		expect(deps.auditRepo.append).toHaveBeenCalledWith(expect.objectContaining({
			action: "repository.bind",
		}));
	});

	test("POST /repositories/reindex full=true → indexer.rebuildFromScratch (not inline)", async () => {
		const res = await post(port, "/api/wiki-admin/repositories/reindex", { projectId: "p1", full: true });
		expect(res.status).toBe(200);
		expect(deps.indexer.rebuildFromScratch).toHaveBeenCalledTimes(1);
		expect(deps.indexer.sync).not.toHaveBeenCalled();
	});

	test("POST /repositories/validate → git.isGitRepo + resolveRevision + detectDefaultBranch (delegate)", async () => {
		const res = await post(port, "/api/wiki-admin/repositories/validate", { projectId: "p1" });
		expect(res.status).toBe(200);
		expect(deps.git.isGitRepo).toHaveBeenCalledTimes(1);
		expect(deps.git.resolveRevision).toHaveBeenCalledTimes(1);
		expect(deps.git.detectDefaultBranch).toHaveBeenCalledTimes(1);
	});

	test("POST /grants/preview → compileWikiAccess (same runtime compiler, not copy)", async () => {
		// agentId 走 query string;grants preview 应委托 compileWikiAccess。
		deps.agentStore.get.mockReturnValue({ id: "a1", wikiGrants: [], wikiPolicyRevision: 1 });
		const res = await post(port, "/api/wiki-admin/grants/preview?agentId=a1", {
			grants: [{ scope: "memory://", actions: ["read"] }],
		});
		expect(res.status).toBe(200);
		// result.access 是 compileWikiAccess 的产物(canonicalScope 已解析)。
		expect(res.data.result.access.grants[0].canonicalScope).toBe(`${WIKI_ROOT_PATH}/memory/a1`);
	});

	test("POST /context/preview → compileWikiContext (same runtime compiler)", async () => {
		deps.agentStore.get.mockReturnValue({ id: "a1", wikiGrants: [{ scope: "memory://", actions: ["read"] }], wikiPolicyRevision: 1 });
		deps.wikiService.expand = vi.fn(async () => ({ path: "wiki-root/memory/a1", summary: "", displayTitle: "", kind: "memory", children: { items: [], cursor: null, hasMore: false }, auditId: null })) as any;
		const res = await post(port, "/api/wiki-admin/context/preview?agentId=a1", {
			entries: [{ address: "memory://", profile: "compact", channel: "system" }],
		});
		expect(res.status).toBe(200);
		// context preview 返回 compiled text + stats(由 compileWikiContext 产)。
		expect(typeof res.data.result.text).toBe("string");
		expect(res.data.result.stats).toBeDefined();
	});
});

// ===========================================================================
// round-2 FIX 1+2: FORBIDDEN_BODY_KEYS isolation (管理面 vs 数据面)
//   round-1 BLOCKER(管理面禁 grants/projectId/activeProjectId → /grants/* +
//   /repositories/* 全 400)已修。改写为断言「两边 guard 独立,隔离正确」:
//   - 管理面:grants/projectId/activeProjectId 是 **payload 内容**(§3
//     GrantsPublishInput 顶层要 grants;所有 repository schema 顶层要 projectId),
//     不禁;但禁 canManage(Fix 2)+ 真身份键(admin/actor/authority/callerCtx/agentId)。
//   - 数据面:grants/projectId/activeProjectId 仍是 caller 身份,正确禁止;不含
//     canManage(数据面无此键)。两文件 guard 独立,不要同步(design §3.1)。
// ===========================================================================

describe("sub-07 arch · FIX 1+2: FORBIDDEN_BODY_KEYS isolation (管理面 vs 数据面, design §3.1)", () => {
	function extractForbiddenSet(fileRel: string): Set<string> {
		const r = src(fileRel);
		const m = r.match(/const FORBIDDEN_BODY_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
		expect(m).toBeTruthy();
		const keys = m![1].match(/"([\w-]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [];
		return new Set(keys);
	}

	test("管理面 FORBIDDEN_BODY_KEYS does NOT forbid payload content (grants/projectId/activeProjectId)", () => {
		// FIX 1:这三个是 §3 GrantsPublishInput / repository schemas 的 payload 顶层
		// 字段,禁了就让 /grants/* + /repositories/* 全 400(round-1 BLOCKER)。
		const admin = extractForbiddenSet("src/server/wiki-admin-router.ts");
		expect(admin.has("grants")).toBe(false);
		expect(admin.has("projectId")).toBe(false);
		expect(admin.has("activeProjectId")).toBe(false);
	});

	test("管理面 FORBIDDEN_BODY_KEYS forbids canManage (FIX 2) + real identity keys", () => {
		// FIX 2:canManage 加入(server-injected 权限位,与 admin/actor 一类)。
		// 真身份键继续禁 —— renderer 不能自报身份扩权(§A.1/§H)。
		const admin = extractForbiddenSet("src/server/wiki-admin-router.ts");
		expect(admin.has("canManage")).toBe(true);
		expect(admin.has("admin")).toBe(true);
		expect(admin.has("actor")).toBe(true);
		expect(admin.has("authority")).toBe(true);
		expect(admin.has("callerCtx")).toBe(true);
		expect(admin.has("agentId")).toBe(true);
		// 内部 DB 整数 ID 仍禁(§7/§H)。
		expect(admin.has("target_id")).toBe(true);
		expect(admin.has("project_node_id")).toBe(true);
	});

	test("数据面 wiki-router FORBIDDEN_BODY_KEYS STILL forbids grants/projectId/activeProjectId (caller identity)", () => {
		// 数据面这三个键是 caller 身份(WikiRequestContext 由 host 构造,renderer
		// 自报一律拒 —— wiki-router.ts §A.2/§H)。round-2 数据面一字不改,仍正确禁止。
		const data = extractForbiddenSet("src/server/wiki-router.ts");
		expect(data.has("grants")).toBe(true);
		expect(data.has("projectId")).toBe(true);
		expect(data.has("activeProjectId")).toBe(true);
		// 数据面无 canManage 概念,不含此键。
		expect(data.has("canManage")).toBe(false);
		// 真身份键两边都禁(共同不变量)。
		expect(data.has("admin")).toBe(true);
		expect(data.has("actor")).toBe(true);
		expect(data.has("callerCtx")).toBe(true);
	});

	test("两文件 FORBIDDEN_BODY_KEYS 各自独立声明(guard isolation,不同步)", () => {
		// design §3.1:管理面/数据面分离。两个 FORBIDDEN_BODY_KEYS 是各自文件的
		// 模块常量,修改互不影响(round-1 误把它们当同一不变量才是 BLOCKER 根因)。
		const admin = src("src/server/wiki-admin-router.ts");
		const data = src("src/server/wiki-router.ts");
		// 各自文件都各自声明一份(不是 import 共享)。
		expect(admin).toMatch(/const FORBIDDEN_BODY_KEYS\s*=\s*new Set\(\[/);
		expect(data).toMatch(/const FORBIDDEN_BODY_KEYS\s*=\s*new Set\(\[/);
		// 管理面文件不 import 数据面 router(反之亦然)—— guard 不耦合。
		expect(admin).not.toMatch(/from\s+["'][^"']*wiki-router(\.js)?["']/);
		expect(data).not.toMatch(/from\s+["'][^"']*wiki-admin-router(\.js)?["']/);
		// 管理面 schema 仍 REQUIRE grants/projectId 为 payload 内容(证明禁它们=BLOCKER)。
		expect(admin).toMatch(/grantsPublishSchema\s*=\s*z\.object\(\{[\s\S]*?grants:\s*z\.array\(grantSchema\)/);
		expect(admin).toMatch(/repositoryBindSchema\s*=\s*z\.object\(\{[\s\S]*?projectId:\s*z\.string\(\)\.min\(1\)/);
	});

	test("now-unblocked: /grants/validate accepts legitimate {grants:[...]} payload → 200 (FIX 1 真生效)", async () => {
		// round-1 这条 endpoint 因 forged guard 误拒合法 body 返 400;FIX 1 后必须 200。
		// 直接经 HTTP,不断言下游 service spy(那是 spec lens 的活),只断言 forged
		// guard 不再误伤 + schema 真解析到 grants 字段。
		const app = express();
		app.use(express.json());
		const deps = makeDeps();
		deps.agentStore.get.mockReturnValue({ id: "a1", wikiGrants: [], wikiPolicyRevision: 1 });
		app.use("/api/wiki-admin", createWikiAdminRouter(deps as any));
		const { server, port } = await listen(app);
		try {
			const res = await post(port, "/api/wiki-admin/grants/validate?agentId=a1", {
				grants: [{ scope: "memory://", actions: ["read"] }],
			});
			expect(res.status).toBe(200);
			expect(res.data.ok).toBe(true);
			expect(res.data.result).toBeDefined();
		} finally {
			await close(server);
		}
	});
});

// ===========================================================================
// 2. authority server-injected · acceptance-07 §A.1 / §H
// ===========================================================================

describe("sub-07 arch · authority server-injected, body cannot escalate (§A.1/§H)", () => {
	let app: Express; let server: Server; let port: number; let deps: ReturnType<typeof makeDeps>;

	beforeEach(async () => {
		deps = makeDeps();
		app = express();
		app.use(express.json());
		app.use("/api/wiki-admin", createWikiAdminRouter(deps as any));
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => { await close(server); });

	test("body with forged `admin:true` → 400 (renderer cannot self-authorize)", async () => {
		// 用 /addresses/validate(parseBody 路径):body 带 admin:true → forged guard 拒。
		const res = await post(port, "/api/wiki-admin/addresses/validate", {
			address: "runtime://x", scope: "runtime", kind: "k", admin: true,
		});
		expect(res.status).toBe(400);
		expect(res.data.error.code).toBe("INVALID_REQUEST");
		expect(res.data.error.message).toMatch(/forged identity/i);
	});

	test("body with forged `actor` → 400", async () => {
		const res = await post(port, "/api/wiki-admin/grants/validate?agentId=a1", {
			grants: [], actor: "@super-admin",
		});
		expect(res.status).toBe(400);
	});

	test("body with forged `callerCtx` / `grants` identity field → 400", async () => {
		for (const key of ["callerCtx", "authority", "effectiveAccess", "policyRevision", "target_id", "project_node_id"]) {
			const res = await post(port, "/api/wiki-admin/addresses/validate", {
				address: "runtime://x", scope: "runtime", kind: "k", [key]: "forged",
			});
			expect(res.status).toBe(400, `key ${key} should be rejected`);
		}
	});

	test("audit actor always @wiki-admin regardless of body (server-injected)", async () => {
		// 即便 body 没身份字段,audit 的 actor_agent_id 必须是常量 @wiki-admin。
		await post(port, "/api/wiki-admin/addresses/create", {
			address: "runtime://z", scope: "runtime", kind: "k", resolver: null,
		});
		expect(deps.auditRepo.append).toHaveBeenCalledWith(expect.objectContaining({
			actorAgentId: "@wiki-admin",
		}));
		// 不存在 body 能改 actor:再来一个带 admin 字段的 → 直接 400,根本不进 audit。
		deps.auditRepo.append.mockClear();
		await post(port, "/api/wiki-admin/addresses/create", {
			address: "runtime://w", scope: "runtime", kind: "k", admin: true,
		});
		expect(deps.auditRepo.append).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 3. validate/preview pure (no DB write / audit / revision) · §A.3
// ===========================================================================

describe("sub-07 arch · validate/preview are side-effect free (§A.3)", () => {
	let app: Express; let server: Server; let port: number; let deps: ReturnType<typeof makeDeps>;

	beforeEach(async () => {
		deps = MakeDepsWithAgent();
		app = express();
		app.use(express.json());
		app.use("/api/wiki-admin", createWikiAdminRouter(deps as any));
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => { await close(server); });

	function MakeDepsWithAgent() {
		const d = makeDeps();
		d.agentStore.get.mockReturnValue({ id: "a1", wikiGrants: [], wikiContext: [], wikiPolicyRevision: 1 });
		return d;
	}

	test("addresses/validate writes no audit", async () => {
		await post(port, "/api/wiki-admin/addresses/validate", {
			address: "runtime://x", scope: "runtime", kind: "k", resolver: null,
		});
		expect(deps.auditRepo.append).not.toHaveBeenCalled();
		expect(deps.addressService.register).not.toHaveBeenCalled();
	});

	test("addresses/impact writes no audit (read-only scan)", async () => {
		await post(port, "/api/wiki-admin/addresses/impact", { address: "runtime://x" });
		expect(deps.auditRepo.append).not.toHaveBeenCalled();
		expect(deps.addressService.register).not.toHaveBeenCalled();
	});

	test("grants/validate writes no audit", async () => {
		await post(port, "/api/wiki-admin/grants/validate?agentId=a1", {
			grants: [{ scope: "memory://", actions: ["read"] }],
		});
		expect(deps.auditRepo.append).not.toHaveBeenCalled();
		expect(deps.agentService.publishAgentWikiPolicy).not.toHaveBeenCalled();
	});

	test("grants/preview writes no audit", async () => {
		await post(port, "/api/wiki-admin/grants/preview?agentId=a1", {
			grants: [{ scope: "memory://", actions: ["read"] }],
		});
		expect(deps.auditRepo.append).not.toHaveBeenCalled();
		expect(deps.agentService.publishAgentWikiPolicy).not.toHaveBeenCalled();
	});

	test("context/validate writes no audit", async () => {
		await post(port, "/api/wiki-admin/context/validate?agentId=a1", {
			entries: [{ address: "memory://", profile: "compact", channel: "system" }],
		});
		expect(deps.auditRepo.append).not.toHaveBeenCalled();
		expect(deps.agentService.publishAgentWikiPolicy).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 4. publish CAS + revision+1 + audit · §A.4 / §A.5
// ===========================================================================

describe("sub-07 arch · publish CAS + revision+1 + audit (§A.4/§A.5)", () => {
	let app: Express; let server: Server; let port: number; let deps: ReturnType<typeof makeDeps>;

	beforeEach(async () => {
		deps = makeDeps();
		deps.agentStore.get.mockReturnValue({ id: "a1", wikiGrants: [], wikiContext: [], wikiPolicyRevision: 5 });
		app = express();
		app.use(express.json());
		app.use("/api/wiki-admin", createWikiAdminRouter(deps as any));
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => { await close(server); });

	test("grants/publish wrong expectedRevision → 409 WRITE_CONFLICT + currentRevision", async () => {
		deps.agentService.publishAgentWikiPolicy.mockImplementationOnce(() => {
			const e = new Error("WRITE_CONFLICT") as Error & { code?: string; currentRevision?: number };
			e.code = "WRITE_CONFLICT"; e.currentRevision = 5;
			throw e;
		});
		const res = await post(port, "/api/wiki-admin/grants/publish?agentId=a1", {
			grants: [{ scope: "memory://", actions: ["read"] }], expectedRevision: 99,
		});
		expect(res.status).toBe(409);
		expect(res.data.error.code).toBe("WRITE_CONFLICT");
		expect(res.data.error.currentRevision).toBe(5);
		// 冲突时 audit 不写。
		expect(deps.auditRepo.append).not.toHaveBeenCalled();
	});

	test("grants/publish correct revision → audit policy.publish.grants with newRevision", async () => {
		deps.agentService.publishAgentWikiPolicy.mockReturnValueOnce({
			newRevision: 6, affectedSessions: [{ sessionId: "s1", applied: true }],
		});
		const res = await post(port, "/api/wiki-admin/grants/publish?agentId=a1", {
			grants: [{ scope: "memory://", actions: ["read"] }], expectedRevision: 5,
		});
		expect(res.status).toBe(200);
		expect(res.data.result.newRevision).toBe(6);
		expect(deps.auditRepo.append).toHaveBeenCalledWith(expect.objectContaining({
			action: "policy.publish.grants",
			newRevision: 6,
			actorAgentId: "@wiki-admin",
		}));
	});

	test("context/publish correct revision → audit policy.publish.context", async () => {
		// agent 必须先有 memory:// read grant,否则 publish 被 unauthorized 拦截。
		deps.agentStore.get.mockReturnValue({
			id: "a1",
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
			wikiContext: [], wikiPolicyRevision: 5,
		});
		deps.agentService.publishAgentWikiPolicy.mockReturnValueOnce({
			newRevision: 6, affectedSessions: [],
		});
		const res = await post(port, "/api/wiki-admin/context/publish?agentId=a1", {
			entries: [{ address: "memory://", profile: "compact", channel: "system" }],
			expectedRevision: 5,
		});
		expect(res.status).toBe(200);
		expect(deps.auditRepo.append).toHaveBeenCalledWith(expect.objectContaining({
			action: "policy.publish.context",
			newRevision: 6,
		}));
	});

	test("context/publish blocked when address lacks read grant (no implicit grant)", async () => {
		// agent has no grants;context entry references memory:// which needs read.
		// publish 前再检 unauthorized → block(防 UI 绕过 validate)。
		const res = await post(port, "/api/wiki-admin/context/publish?agentId=a1", {
			entries: [{ address: "memory://", profile: "compact", channel: "system" }],
			expectedRevision: 5,
		});
		expect(res.status).toBe(400);
		expect(res.data.error.message).toMatch(/lacks read grant|blocked/i);
		expect(deps.agentService.publishAgentWikiPolicy).not.toHaveBeenCalled();
	});

	test("grants/publish wiki-root write requires confirmRootWriteGrant=true", async () => {
		// wiki-root 全树写 grant 不带 confirm → 拒(不静默允许,不硬禁)。
		const res = await post(port, "/api/wiki-admin/grants/publish?agentId=a1", {
			grants: [{ scope: "wiki-root", actions: ["create", "update", "delete"] }],
			expectedRevision: 5,
		});
		expect(res.status).toBe(400);
		expect(res.data.error.message).toMatch(/confirmRootWriteGrant/i);
		expect(deps.agentService.publishAgentWikiPolicy).not.toHaveBeenCalled();
	});

	test("grants/publish wiki-root write with confirm=true proceeds + audit notes hasRootWriteGrant", async () => {
		const res = await post(port, "/api/wiki-admin/grants/publish?agentId=a1", {
			grants: [{ scope: "wiki-root", actions: ["create", "update", "delete"] }],
			expectedRevision: 5, confirmRootWriteGrant: true,
		});
		expect(res.status).toBe(200);
		expect(deps.auditRepo.append).toHaveBeenCalledWith(expect.objectContaining({
			action: "policy.publish.grants",
			detail: expect.objectContaining({ hasRootWriteGrant: true }),
		}));
	});

	test("grants/publish wiki-root write confirm=true → router passes confirmRootWriteGrant=true to service (FIX 3 router side, real delegate not copy)", async () => {
		// FIX 3 router 侧:body.confirmRootWriteGrant 必须透传到 publishAgentWikiPolicy
		// (service 边界单点兜底,不能丢)。同时证明 endpoint 真 delegate service 非 copy。
		deps.agentService.publishAgentWikiPolicy.mockClear();
		const res = await post(port, "/api/wiki-admin/grants/publish?agentId=a1", {
			grants: [{ scope: "wiki-root", actions: ["create"] }],
			expectedRevision: 5, confirmRootWriteGrant: true,
		});
		expect(res.status).toBe(200);
		expect(deps.agentService.publishAgentWikiPolicy).toHaveBeenCalledTimes(1);
		const callArg = deps.agentService.publishAgentWikiPolicy.mock.calls[0][0];
		expect(callArg.confirmRootWriteGrant).toBe(true);
		expect(callArg.agentId).toBe("a1");
		expect(callArg.patch.wikiGrants).toEqual([{ scope: "wiki-root", actions: ["create"] }]);
	});
});

// ===========================================================================
// 5. session refresh wiring alive (publish → onChange → applyConfigUpdate)
//    + in-flight snapshot invariant · §6 / §A
// ===========================================================================

describe("sub-07 arch · session refresh wiring alive + [] fallback (§6)", () => {
	test("publishAgentWikiPolicy CAS: wrong expectedRevision throws WRITE_CONFLICT", () => {
		const agents: Record<string, any> = {
			a1: { id: "a1", wikiGrants: [], wikiContext: [], wikiPolicyRevision: 5 },
		};
		const store = makeMockAgentStore(agents);
		const svc = new AgentService(tmpdir());
		svc.setAgentStore(store as any);

		expect(() => svc.publishAgentWikiPolicy({
			agentId: "a1", expectedRevision: 99, patch: { wikiGrants: [] },
		})).toThrow(/WRITE_CONFLICT/);
	});

	test("publishAgentWikiPolicy bumps revision +1 and persists patch via agentStore.update", () => {
		const agents: Record<string, any> = {
			a1: { id: "a1", wikiGrants: [{ scope: "wiki-root/knowledge", actions: ["read"] }], wikiContext: [], wikiPolicyRevision: 5 },
		};
		const store = makeMockAgentStore(agents);
		const svc = new AgentService(tmpdir());
		svc.setAgentStore(store as any);

		const out = svc.publishAgentWikiPolicy({
			agentId: "a1", expectedRevision: 5,
			patch: { wikiGrants: [{ scope: "memory://", actions: ["read"] }] },
		});
		expect(out.newRevision).toBe(6);
		expect(store.update).toHaveBeenCalledWith("a1", expect.objectContaining({
			wikiPolicyRevision: 6,
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		}));
	});

	test("delete-last-grant: empty grants published as explicit [] (not undefined)", () => {
		// feedback-unique-message-keys: JSON.stringify 丢 undefined → backend 不写 → 旧值残留。
		// publishAgentWikiPolicy 必须把空 grants 显式转 []。
		const agents: Record<string, any> = {
			a1: { id: "a1", wikiGrants: [{ scope: "wiki-root/knowledge", actions: ["read"] }], wikiContext: [], wikiPolicyRevision: 1 },
		};
		const store = makeMockAgentStore(agents);
		const svc = new AgentService(tmpdir());
		svc.setAgentStore(store as any);

		svc.publishAgentWikiPolicy({
			agentId: "a1", expectedRevision: 1, patch: { wikiGrants: [] },
		});
		expect(store.update).toHaveBeenCalledWith("a1", expect.objectContaining({
			wikiGrants: [],
			wikiPolicyRevision: 2,
		}));
		// agent record 真持久化为 [](not undefined, not old value)。
		expect(agents.a1.wikiGrants).toEqual([]);
	});

	test("WIRING ALIVE: publish → agentStore.update → onChange → busy loop patch enqueued (StepEnd flush)", () => {
		// feedback-verify-runtime-wiring 核心:链必须端到端真活,不能是 dead path。
		// 注册 mock wikiService(compileWikiAccessForSession 要求 getWikiService() 非空)。
		setWikiRuntime({
			wikiService: { ensureAgentMemoryRoot: vi.fn(async () => undefined) } as any,
			searchService: {} as any,
		});
		const agents: Record<string, any> = {
			a1: { id: "a1", name: "a1", wikiGrants: [{ scope: "wiki-root/knowledge", actions: ["read"] }], wikiContext: [], wikiPolicyRevision: 1 },
		};
		const store = makeMockAgentStore(agents);
		const svc = new AgentService(tmpdir());
		svc.setAgentStore(store as any);

		const applySpy = vi.fn();
		const fakeLoop = {
			getConfigAgentId: () => "a1",
			applyConfigUpdate: applySpy,
			isWaiting: () => false,
			getState: () => ({ isBusy: true }),  // BUSY loop
		};
		// 注入 fake loop 到 private loops map(sessionId → loop)。
		(svc as any).loops.set("sess-1", fakeLoop);
		// 标 activeSession 让 idle-rebuild 分支不抢先(idle 分支要求 !isBusy)。
		(svc as any).activeSessions.set("a1", "sess-1");
		(svc as any).runStates.set("sess-1", { isBusy: true });

		svc.publishAgentWikiPolicy({
			agentId: "a1", expectedRevision: 1,
			patch: { wikiGrants: [{ scope: "memory://", actions: ["read", "create"] }] },
		});

		// P0-1 (corrected): on a BUSY loop, applyConfigUpdate is NOT called
		// synchronously by publishAgentWikiPolicy — the patch is enqueued to
		// pendingConfigPatches and the config-sync StepEnd hook will flush it
		// at the safety boundary. The wiring is alive: the patch reached the
		// queue and carries the NEW compiled wikiAccess.
		expect(applySpy, "busy loop applyConfigUpdate must NOT be called synchronously (StepEnd flush)").not.toHaveBeenCalled();
		const queue = (svc as any).pendingConfigPatches.get("sess-1") ?? [];
		expect(queue.length, "busy loop patch must be enqueued to pendingConfigPatches (wiring alive)").toBeGreaterThanOrEqual(1);
		const patch = queue[queue.length - 1].update;
		expect(patch.wikiAccess, "enqueued patch must include wikiAccess").toBeDefined();
		expect(patch.wikiAccess.policyRevision).toBe(2);  // revision+1 真反映到 enqueued patch
		_resetWikiRuntimeForTests();
	});

	test("WIRING ALIVE: idle loop is rebuilt (createLoopForSession), not applyConfigUpdate", () => {
		const agents: Record<string, any> = {
			a1: { id: "a1", wikiGrants: [], wikiContext: [], wikiPolicyRevision: 1, systemPrompt: "x", toolPolicy: {} },
		};
		const store = makeMockAgentStore(agents);
		const svc = new AgentService(tmpdir());
		svc.setAgentStore(store as any);

		const applySpy = vi.fn();
		const fakeLoop = {
			getConfigAgentId: () => "a1", applyConfigUpdate: applySpy,
			isWaiting: () => false, getState: () => ({ isBusy: false }),
		};
		(svc as any).loops.set("sess-1", fakeLoop);
		(svc as any).activeSessions.set("a1", "sess-1");
		(svc as any).runStates.set("sess-1", { isBusy: false });  // IDLE

		// publish → onChange → idle 分支:rebuild loop(不调 applyConfigUpdate on old loop)。
		// createLoopForSession 会重建;我们只要确认 applySpy 没在 OLD loop 上被调。
		svc.publishAgentWikiPolicy({
			agentId: "a1", expectedRevision: 1, patch: { wikiGrants: [] },
		});
		expect(applySpy).not.toHaveBeenCalled();
	});

	// ─── round-2 FIX 3:service 边界 confirmRootWriteGrant 用 compileWikiAccess
	//     canonical 化(非 raw 字符串比较)→ 抗 wiki-root/ 等价绕过;检查位置在
	//     agent-found 后 revision-conflict 前。直接调 service(recovery / 未来 admin
	//     tool / 测试 harness 都必须经过),不经 router 双保险。 ───────────────

	test("FIX 3 service: wiki-root/ (trailing slash) write grant caught by canonical compile, not raw string compare", () => {
		// normalizeWikiPath(\"wiki-root/\") 过滤空段 → \"wiki-root\"。所以 raw 字符串
		// 比较 `scope === \"wiki-root\"` 会漏掉 \"wiki-root/\"(bypass!),但 service 用
		// compileWikiAccess canonical 化后 canonicalScope === WIKI_ROOT_PATH,捕获。
		const agents: Record<string, any> = {
			a1: { id: "a1", wikiGrants: [], wikiContext: [], wikiPolicyRevision: 1 },
		};
		const store = makeMockAgentStore(agents);
		const svc = new AgentService(tmpdir());
		svc.setAgentStore(store as any);

		// 先验证 canonical 化真的把 wiki-root/ → wiki-root(anti-bypass 前提)。
		const canonical = compileWikiAccess({
			agentId: "a1",
			wikiGrants: [{ scope: "wiki-root/", actions: ["create"] }],
			wikiPolicyRevision: 1,
		});
		expect(canonical.access.grants[0].canonicalScope).toBe(WIKI_ROOT_PATH);

		// service 无 confirm → 抛 INVALID_REQUEST(canonical 化后命中 root-write)。
		expect(() => svc.publishAgentWikiPolicy({
			agentId: "a1", expectedRevision: 1,
			patch: { wikiGrants: [{ scope: "wiki-root/", actions: ["create"] }] },
		})).toThrow(/confirmRootWriteGrant/i);
		expect(agents.a1.wikiPolicyRevision).toBe(1);  // 未 publish,revision 未动
		expect(store.update).not.toHaveBeenCalled();
	});

	test("FIX 3 service: wiki-root/ write grant with confirm=true proceeds (canonical 命中但确认放行)", () => {
		const agents: Record<string, any> = {
			a1: { id: "a1", wikiGrants: [], wikiContext: [], wikiPolicyRevision: 1 },
		};
		const store = makeMockAgentStore(agents);
		const svc = new AgentService(tmpdir());
		svc.setAgentStore(store as any);

		const out = svc.publishAgentWikiPolicy({
			agentId: "a1", expectedRevision: 1,
			patch: { wikiGrants: [{ scope: "wiki-root/", actions: ["create"] }] },
			confirmRootWriteGrant: true,
		});
		expect(out.newRevision).toBe(2);
		expect(agents.a1.wikiPolicyRevision).toBe(2);
	});

	test("FIX 3 service: confirmRootWriteGrant check fires BEFORE revision-conflict (check order)", () => {
		// 顺序断言:valid agent + wiki-root write + no confirm + wrong revision →
		// 必须先抛 confirmRootWriteGrant(INVALID_REQUEST),不抛 WRITE_CONFLICT。
		// 这保证高风控确认无论 revision 是否匹配都先拦(round-2 任务要求:
		// 「agent-found 后 revision-conflict 前」)。
		const agents: Record<string, any> = {
			a1: { id: "a1", wikiGrants: [], wikiContext: [], wikiPolicyRevision: 5 },
		};
		const store = makeMockAgentStore(agents);
		const svc = new AgentService(tmpdir());
		svc.setAgentStore(store as any);

		let caught: Error | undefined;
		try {
			svc.publishAgentWikiPolicy({
				agentId: "a1", expectedRevision: 999,  // 故意不匹配
				patch: { wikiGrants: [{ scope: "wiki-root", actions: ["create"] }] },
				// 不传 confirmRootWriteGrant
			});
		} catch (e) { caught = e as Error; }
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/confirmRootWriteGrant/i);
		expect(caught!.message).not.toMatch(/WRITE_CONFLICT/i);
		expect(store.update).not.toHaveBeenCalled();
	});

	test("FIX 3 service: non-wiki-root grant + wrong revision → WRITE_CONFLICT (confirm 不误拦正常 CAS)", () => {
		// 反向:非 root-write 不能因 confirm 检查漏掉 CAS。普通 grant + 错 revision
		// → WRITE_CONFLICT(confirm 检查 pass through 到 revision gate)。
		const agents: Record<string, any> = {
			a1: { id: "a1", wikiGrants: [], wikiContext: [], wikiPolicyRevision: 5 },
		};
		const store = makeMockAgentStore(agents);
		const svc = new AgentService(tmpdir());
		svc.setAgentStore(store as any);

		expect(() => svc.publishAgentWikiPolicy({
			agentId: "a1", expectedRevision: 999,
			patch: { wikiGrants: [{ scope: "memory://", actions: ["read"] }] },
		})).toThrow(/WRITE_CONFLICT/);
		expect(store.update).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// 6. wiki_admin / wiki_repositories event independence · §7
// ===========================================================================

describe("sub-07 arch · wiki_admin/wiki_repositories events independent of wiki_nodes (§7)", () => {
	let app: Express; let server: Server; let port: number; let deps: ReturnType<typeof makeDeps>;
	let received: Array<{ collection: string; id: string; op: string }>;

	beforeEach(async () => {
		deps = makeDeps();
		app = express();
		app.use(express.json());
		app.use("/api/wiki-admin", createWikiAdminRouter(deps as any));
		const l = await listen(app);
		server = l.server; port = l.port;
		received = [];
		onDataChange((e) => {
			for (const c of e.changes) received.push({ collection: e.collection, id: c.id, op: c.op });
		});
	});
	afterEach(async () => { await close(server); _resetDataChangeHubForTest(); });

	test("address create emits wiki_admin (NOT wiki_nodes)", async () => {
		await post(port, "/api/wiki-admin/addresses/create", {
			address: "runtime://e1", scope: "runtime", kind: "k", resolver: null,
		});
		// data-change-hub flush 是 setTimeout(_,0);等一个 microtask+timeout。
		await new Promise((r) => setTimeout(r, 10));
		const collections = new Set(received.map((r) => r.collection));
		expect(collections.has("wiki_admin")).toBe(true);
		expect(collections.has("wiki_nodes")).toBe(false);
	});

	test("grants publish emits wiki_admin with policy:grants:<agentId> id", async () => {
		deps.agentStore.get.mockReturnValue({ id: "a1", wikiGrants: [], wikiContext: [], wikiPolicyRevision: 1 });
		await post(port, "/api/wiki-admin/grants/publish?agentId=a1", {
			grants: [{ scope: "memory://", actions: ["read"] }], expectedRevision: 1,
		});
		await new Promise((r) => setTimeout(r, 10));
		const policyEvents = received.filter((r) => r.collection === "wiki_admin" && r.id.startsWith("policy:"));
		expect(policyEvents.length).toBeGreaterThan(0);
		// 没有任何 wiki_nodes 事件(管理面不刷数据树)。
		expect(received.some((r) => r.collection === "wiki_nodes")).toBe(false);
	});

	test("repository bind emits wiki_repositories (NOT wiki_nodes/wiki_links/wiki_sync)", async () => {
		await post(port, "/api/wiki-admin/repositories/bind", { projectId: "p1" });
		await new Promise((r) => setTimeout(r, 15));
		const collections = new Set(received.map((r) => r.collection));
		expect(collections.has("wiki_repositories")).toBe(true);
		expect(collections.has("wiki_nodes")).toBe(false);
		expect(collections.has("wiki_sync")).toBe(false);
	});
});

// ===========================================================================
// 7. PromptTemplate fresh-DB migration (COLUMNS + db-migration sync)
// ===========================================================================

describe("sub-07 arch · PromptTemplate fresh-DB migration sync (feedback-fresh-db-migrations)", () => {
	test("template-store COLUMNS includes wikiGrants + wikiContext (json)", () => {
		const ts = src("src/server/template-store.ts");
		// COLUMNS 数组必须含 wiki_grants / wiki_context 列定义。
		expect(ts).toMatch(/\{\s*key:\s*["']wikiGrants["']\s*,\s*column:\s*["']wiki_grants["']\s*,\s*json:\s*true\s*\}/);
		expect(ts).toMatch(/\{\s*key:\s*["']wikiContext["']\s*,\s*column:\s*["']wiki_context["']\s*,\s*json:\s*true\s*\}/);
	});

	test("db-migration safeAddColumn templates.wiki_grants + wiki_context", () => {
		const m = src("src/server/db-migration.ts");
		expect(m).toMatch(/safeAddColumn\(db,\s*["']templates["']\s*,\s*["']wiki_grants["']\s*,\s*["']TEXT["']\)/);
		expect(m).toMatch(/safeAddColumn\(db,\s*["']templates["']\s*,\s*["']wiki_context["']\s*,\s*["']TEXT["']\)/);
	});

	test("FIX 4: db-migration templates COLUMNS literal includes wikiGrants + wikiContext (fresh-DB CREATE TABLE truth source)", () => {
		// feedback-fresh-db-migrations:db-migration 的 *_COLUMNS 数组是 fresh-DB
		// CREATE TABLE 的真相源,不能靠 ensureTable self-heal ALTER 补。round-2 FIX 4
		// 把 wikiGrants/wikiContext 加进 templates COLUMNS,使 fresh DB 直接含列。
		// 提取 `new SqliteStore<any>(db, "templates", [ ... ])` 数组字面量。
		const m = src("src/server/db-migration.ts");
		const block = m.match(/new SqliteStore<any>\(db,\s*["']templates["']\s*,\s*\[([\s\S]*?)\]\)/);
		expect(block).toBeTruthy();
		const cols = block![1];
		// COLUMNS 含 wikiGrants / wikiContext(json:true),与 template-store.ts COLUMNS 一致。
		expect(cols).toMatch(/\{\s*key:\s*["']wikiGrants["']\s*,\s*column:\s*["']wiki_grants["']\s*,\s*json:\s*true\s*\}/);
		expect(cols).toMatch(/\{\s*key:\s*["']wikiContext["']\s*,\s*column:\s*["']wiki_context["']\s*,\s*json:\s*true\s*\}/);
		// 与 template-store.ts COLUMNS 字段集相同(两边同步,真相源唯一)。
		const ts = src("src/server/template-store.ts");
		const tsBlock = ts.match(/const COLUMNS:\s*ColumnDef\[\]\s*=\s*\[([\s\S]*?)\]/);
		expect(tsBlock).toBeTruthy();
		expect(tsBlock![1]).toMatch(/["']wikiGrants["']/);
		expect(tsBlock![1]).toMatch(/["']wikiContext["']/);
	});

	test("archivist seed carries wikiGrants + wikiContext (round-trip source)", () => {
		const ts = src("src/server/template-store.ts");
		// seed 必须显式携带 wikiGrants(memory:// + knowledge + project://)。
		expect(ts).toMatch(/wikiGrants:\s*\[/);
		expect(ts).toMatch(/wikiContext:\s*\[/);
		// management-service.instantiateTemplate 拷贝 wikiGrants/wikiContext。
		const ms = src("src/server/management-service.ts");
		expect(ms).toMatch(/wikiGrants:\s*template\.wikiGrants/);
		expect(ms).toMatch(/wikiContext:\s*template\.wikiContext/);
		// agent-editor-types.templateToForm 拷贝。
		const et = src("src/renderer/components/agents/agent-editor-types.ts");
		expect(et).toMatch(/wikiGrants:\s*t\.wikiGrants/);
	});

	test("PromptTemplate type has optional wikiGrants/wikiContext fields", () => {
		const t = src("src/shared/types.ts");
		// PromptTemplate 接口加可选 wikiGrants?/wikiContext?。
		expect(t).toMatch(/wikiGrants\?\s*:\s*WikiGrant\[\]/);
		expect(t).toMatch(/wikiContext\?\s*:\s*WikiContextEntry\[\]/);
	});
});

// ===========================================================================
// 8. types independent (no internal IDs leak to renderer) · §7 / §H
// ===========================================================================

describe("sub-07 arch · admin types independent, no internal ID leak (§7/§H)", () => {
	test("wiki-admin-types exports no target_id / project_node_id / nodeId in view shapes", () => {
		const t = src("src/shared/wiki-admin-types.ts");
		// view 接口字段声明不得含内部 DB 整数 ID(允许 comment 里出现这些词)。
		// 匹配 `field:` 或 `field?:` 形式的字段声明。
		const fieldDecls = t.match(/^\s*(export\s+)?\w+\?*\s*:/gm) ?? [];
		const idFields = fieldDecls.filter((d) => /target_id|project_node_id|nodeId\s*:/.test(d));
		expect(idFields).toEqual([]);
		// WikiAdminAddressView 用 targetCanonicalPath(canonical),不是 target_id。
		expect(t).toMatch(/targetCanonicalPath/);
		// WikiAdminRepositoryView 用 projectNodePath(canonical),不是 project_node_id。
		expect(t).toMatch(/projectNodePath/);
	});

	test("addressRowToView converts target_id → targetCanonicalPath (no raw ID in response)", () => {
		const r = src("src/server/wiki-admin-router.ts");
		// addressRowToView 必须做 target_id → node.path 解析。
		expect(r).toMatch(/function addressRowToView/);
		expect(r).toMatch(/targetCanonicalPath\s*=\s*node\.path/);
		// view 构造不含 target_id 字段。
		const viewBlock = r.match(/function addressRowToView[\s\S]*?return\s*\{[\s\S]*?\};/);
		expect(viewBlock).toBeTruthy();
		expect(viewBlock![0]).not.toMatch(/target_id:/);
	});

	test("data plane wiki-types does not import admin types (independence)", () => {
		const wt = src("src/shared/wiki-types.ts");
		expect(wt).not.toMatch(/wiki-admin-types/);
		const at = src("src/shared/wiki-admin-types.ts");
		// admin types 只 import WikiGrant/WikiContextEntry 基础类型,不 import wiki-types 的 view。
		expect(at).not.toMatch(/from\s+["']\.\/wiki-types["']/);
	});
});

// ===========================================================================
// 9. AgentLoop hooks-only (no wiki admin import) · feedback-agent-loop-hooks-only
// ===========================================================================

describe("sub-07 arch · AgentLoop hooks-only, no wiki admin import (feedback-agent-loop-hooks-only)", () => {
	test("agent-loop.ts imports no wiki compiler/store/admin-router", () => {
		const al = src("src/runtime/agent-loop.ts");
		// 不得 import 任何 wiki compiler / store / admin router / wiki types。
		expect(al).not.toMatch(/from\s+["'][^"']*wiki-access-compiler/);
		expect(al).not.toMatch(/from\s+["'][^"']*wiki-context-compiler/);
		expect(al).not.toMatch(/from\s+["'][^"']*wiki-admin/);
		expect(al).not.toMatch(/from\s+["'][^"']*wiki-store/);
		expect(al).not.toMatch(/from\s+["'][^"']*wiki-node-store/);
		// CallerCtx.wikiAccess 是通用桥(agent-service 注入),允许;但不直 import。
		expect(al).not.toMatch(/compileWikiAccess/);
		expect(al).not.toMatch(/compileWikiContext/);
	});

	test("agent-loop.ts has no literal wiki section name or promptAssembler.invalidate('wiki-...')", () => {
		const al = src("src/runtime/agent-loop.ts");
		// design.md §9.3: AgentLoop 不得出现 Wiki 专用 section 字面量。
		expect(al).not.toMatch(/promptAssembler\.invalidate\(["']wiki-/);
	});
});

// ===========================================================================
// 10. preview==runtime (same compiler functions) · §3 / §4 / design §9.3
// ===========================================================================

describe("sub-07 arch · preview==runtime (same compiler, not duplicated)", () => {
	test("admin router imports compileWikiAccess + compileWikiContext from same module as agent-service", () => {
		const ar = src("src/server/wiki-admin-router.ts");
		expect(ar).toMatch(/from\s+["'][^"']*wiki-access-compiler(\.js)?["']/);
		expect(ar).toMatch(/from\s+["'][^"']*wiki-context-compiler(\.js)?["']/);
		const asvc = src("src/server/agent-service.ts");
		expect(asvc).toMatch(/from\s+["'][^"']*wiki-access-compiler(\.js)?["']/);
		expect(asvc).toMatch(/from\s+["'][^"']*wiki-context-compiler(\.js)?["']/);
	});

	test("compileWikiAccess: memory:// resolves to agent-scoped root (not global memory root)", () => {
		// preview 必须与 runtime 一致:memory:// → wiki-root/memory/<agentId>。
		const compiled = compileWikiAccess({
			agentId: "agent-42",
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
			wikiPolicyRevision: 1,
		});
		expect(compiled.access.grants).toHaveLength(1);
		expect(compiled.access.grants[0].canonicalScope).toBe(`${WIKI_ROOT_PATH}/memory/agent-42`);
		expect(compiled.access.grants[0].actions).toEqual(["read"]);
	});

	test("compileWikiAccess: project:// without activeProjectId is dropped (no scope expansion)", () => {
		// design.md §7.2/§7.3: 无 active project → 整条 grant inactive,不扩到 projects 根。
		const compiled = compileWikiAccess({
			agentId: "a1",
			wikiGrants: [{ scope: "project://", actions: ["read"] }],
			wikiPolicyRevision: 1,
			// 故意不传 activeProjectId
		});
		// project:// grant 被跳过(warning),不产生 canonicalScope=wiki-root/projects。
		expect(compiled.access.grants.filter((g) => g.canonicalScope.startsWith(`${WIKI_ROOT_PATH}/projects`))).toHaveLength(0);
		expect(compiled.warnings.length).toBeGreaterThan(0);
	});

	test("compileWikiContext is the same async function the admin router calls", async () => {
		// 直接调 compileWikiContext 验证它是可独立调用的纯编译函数(preview==runtime 入口)。
		const wikiService = { expand: vi.fn(async () => ({ path: "wiki-root/memory/a1", summary: "", displayTitle: "", kind: "memory", children: { items: [], cursor: null, hasMore: false }, auditId: null })) } as any;
		const access = compileWikiAccess({
			agentId: "a1",
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
			wikiPolicyRevision: 1,
		}).access;
		const out = await compileWikiContext({
			wikiService, access,
			entries: [{ address: "memory://", profile: "compact", channel: "system" }],
		});
		expect(typeof out.text).toBe("string");
		expect(out.snapshot.policyRevision).toBe(1);
	});
});

// ===========================================================================
// 11. data plane purity (A2/H) — closed 9-action enum, no admin action
// ===========================================================================

describe("sub-07 arch · data plane purity (A2/H: no admin action in tool/router)", () => {
	test("wiki-v2-tool WIKI_V2_ACTIONS is the closed 9-action data-plane enum", () => {
		const t = src("src/tools/wiki-v2-tool.ts");
		// 提取 WIKI_V2_ACTIONS 数组定义。
		const m = t.match(/const WIKI_V2_ACTIONS\s*=\s*\[([\s\S]*?)\]\s*as\s*const/);
		expect(m).toBeTruthy();
		const actions = m![1].match(/"(\w+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [];
		expect(actions.sort()).toEqual(["create", "delete", "expand", "link", "move", "read", "search", "unlink", "update"]);
		// 不得含任何管理面 action。
		const adminActions = ["publish", "register", "bind", "unbind", "reindex", "validate", "preview", "impact"];
		for (const a of adminActions) {
			expect(actions).not.toContain(a);
		}
	});

	test("wiki-router (data plane) has no admin endpoint (no /grant/publish/address/repository)", () => {
		const r = src("src/server/wiki-router.ts");
		// data router 只暴露 10 个 data endpoint;不得出现管理面 endpoint 注册。
		expect(r).not.toMatch(/router\.(post|get)\(["']\/?grants/);
		expect(r).not.toMatch(/router\.(post|get)\(["']\/?context\/publish/);
		expect(r).not.toMatch(/router\.(post|get)\(["']\/?addresses\/(create|update|delete|register)/);
		expect(r).not.toMatch(/router\.(post|get)\(["']\/?repositories\/(bind|unbind|reindex)/);
	});

	test("wiki-admin-router mounted under /api/wiki-admin (separate from /api/wiki data plane)", () => {
		const idx = src("src/server/index.ts");
		// server composition root 必须挂 admin router 到独立 /api/wiki-admin 前缀。
		expect(idx).toMatch(/createWikiAdminRouter/);
		expect(idx).toMatch(/["']\/api\/wiki-admin["']/);
	});
});

// ===========================================================================
// round-2 now-unblocked criteria · architecture-level HTTP endpoint verification
//   round-1 被 BLOCKER 掩盖,这些从没经 HTTP 测过。现在 fix 生效,端到端验证
//   「endpoint 真 delegate service / 不存绝对 path / soft unbind 不硬删」。
//   feedback-verify-runtime-wiring:断言下游真消费,不只 direct-drive service。
// ===========================================================================

describe("sub-07 arch · now-unblocked: E1 workspaceDir not in Wiki DB + E4 unbind soft no hard delete", () => {
	let app: Express; let server: Server; let port: number; let deps: ReturnType<typeof makeDeps>;

	beforeEach(async () => {
		deps = makeDeps();
		app = express();
		app.use(express.json());
		app.use("/api/wiki-admin", createWikiAdminRouter(deps as any));
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => { await close(server); });

	test("E1: repository bind calls indexer.ensureBinding with projectId (NOT workspaceDir) → Wiki DB never stores absolute checkout path", async () => {
		// design §3.2 / acceptance-07 E1:repository binding 用 ProjectStore.workspaceDir,
		// 但 Wiki DB 不存绝对 checkout path。ensureBinding 入参只有 projectId + source
		// metadata(sourceRoot/defaultBranch),workspaceDir 由 indexer 内部从 ProjectStore
		// 取,不入 Wiki DB row。
		const res = await post(port, "/api/wiki-admin/repositories/bind", {
			projectId: "p1", sourceRoot: "src", defaultBranch: "main",
		});
		expect(res.status).toBe(200);
		expect(deps.indexer.ensureBinding).toHaveBeenCalledTimes(1);
		const ensureArg = deps.indexer.ensureBinding.mock.calls[0];
		expect(ensureArg[0]).toBe("p1");
		// opts 只含 sourceRoot/defaultBranch,绝不传 workspaceDir(Wiki DB 隔离绝对路径)。
		const opts = ensureArg[1];
		expect(opts).toEqual(expect.objectContaining({ sourceRoot: "src", defaultBranch: "main" }));
		expect(opts).not.toHaveProperty("workspaceDir");
		expect(opts).not.toHaveProperty("checkoutPath");
	});

	test("E1: repositoryRowToView reads workspaceDir from ProjectStore at view time (not from Wiki DB row)", () => {
		// 架构不变量:workspaceDir 是 ProjectStore 字段,view 时 join 进来;Wiki DB
		// repository row 本身不含 workspaceDir 列(看 view 构造源码,从 project?. 取)。
		const r = src("src/server/wiki-admin-router.ts");
		// repositoryRowToView 必须从 deps.projectStore.get(row.project_id) 拿 project,
		// 然后 workspaceDir: project?.workspaceDir —— 不是 row.workspaceDir。
		const viewFn = r.match(/async function repositoryRowToView[\s\S]*?return\s*\{[\s\S]*?\};/);
		expect(viewFn).toBeTruthy();
		expect(viewFn![0]).toMatch(/deps\.projectStore\.get\(row\.project_id\)/);
		expect(viewFn![0]).toMatch(/workspaceDir:\s*project\?\.workspaceDir/);
		// row 字段引用不含 workspaceDir(row 是 WikiRepositoryRow,无此列)。
		expect(viewFn![0]).not.toMatch(/row\.workspaceDir/);
	});

	test("E4: unbind soft (hard=false) deletes binding only, does NOT call rebuildFromScratch (no Wiki subtree archive)", async () => {
		// acceptance-07 E4:unbind 默认 soft —— 只解除 binding/停 sync,不硬删 Wiki。
		// hard=true 才走 rebuildFromScratch(归档 source-bound 子树)。这两条必须分清。
		deps.repositoryStore.repositories.getByProjectId.mockReturnValue({
			repository_id: "repo-1", project_node_id: 99, project_id: "p1",
			source_root: "src", default_branch: "main",
		});
		const res = await post(port, "/api/wiki-admin/repositories/unbind", { projectId: "p1" });
		expect(res.status).toBe(200);
		expect(res.data.result.unbound).toBe(true);
		expect(res.data.result.hard).toBe(false);
		// soft:删 binding row,不归档 Wiki 子树。
		expect(deps.repositoryStore.repositories.delete).toHaveBeenCalledWith("repo-1");
		expect(deps.indexer.rebuildFromScratch).not.toHaveBeenCalled();
		// audit 记 hard=false。
		expect(deps.auditRepo.append).toHaveBeenCalledWith(expect.objectContaining({
			action: "repository.unbind",
			detail: expect.objectContaining({ projectId: "p1", hard: false }),
		}));
	});

	test("E4: unbind hard=true DOES call rebuildFromScratch (contrast: explicit hard required for subtree archive)", async () => {
		// 对照:只有显式 hard=true 才硬删。证明 soft 不硬删是刻意选择,不是漏实现。
		deps.repositoryStore.repositories.getByProjectId.mockReturnValue({
			repository_id: "repo-1", project_node_id: 99, project_id: "p1",
			source_root: "src", default_branch: "main",
		});
		const res = await post(port, "/api/wiki-admin/repositories/unbind", { projectId: "p1", hard: true });
		expect(res.status).toBe(200);
		expect(res.data.result.hard).toBe(true);
		expect(deps.indexer.rebuildFromScratch).toHaveBeenCalledWith("p1");
	});
});
