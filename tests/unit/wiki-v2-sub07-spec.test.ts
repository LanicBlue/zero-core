// wiki-system-redesign sub-07 acceptance — 规约 (spec) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-07 §A-H (管理 API 与配置 UI)。本文件从**规约**视角逐
// 条断言 plan-07 的管理面契约。所有断言基于:
//   - **真 admin router + 真 WikiService/AgentService/AgentStore**(临时 wiki.db
//     + core.db)验 §A.1-A.5/B/C8/D3/H:伪造身份拒绝、validate/preview 无副作用、
//     publish CAS、audit 字段、address 注册/解析、grant publish 与 runtime 一致、
//     context 无 grant 阻 publish。
//   - **静态/结构断言** 验 §A.2(WIKI_V2_ACTIONS enum 闭集 + wiki-router endpoint
//     闭集,无管理面 action)。
//   - **fresh-DB migration** 验 PromptTemplate.wikiGrants/wikiContext 列落地
//     (orchestrator 重点 #3 / feedback-fresh-db-migrations)。
//   - **runtime-alive wiring** 验 §6 publish → agentStore.onChange → loop.config
//     .wikiAccess 真刷新 (orchestrator 重点 #2 / feedback-verify-runtime-wiring)。
//
// ## round-2 状态(BLOCKER 已修,本 lens 重写 stale 测试为正确行为)
//   round-1 发现的 BLOCKER —— admin-plane FORBIDDEN_BODY_KEYS 把合法 payload 字
//   段 `grants`/`projectId`/`activeProjectId` 当 caller 身份拒,导致 grants/repos
//   endpoint 全 400 —— 已在 round-2 由 implementer 修(wiki-admin-router.ts 移除
//   这三个 payload 字段,保留真身份键,补 canManage)。本 lens 的 round-2 任务:
//   (a) 把 round-1「断言 blocker 存在」的 stale 测试改写为「断言 fix 后正确行
//       为」(grants endpoints 接受合法 body 返 200;fresh-DB runMigrations 直接
//       含 wiki_grants 列 —— Fix 4);
//   (b) 把 round-1 被 blocker 掩盖、从没经 HTTP 测过的 criteria(C2 round-trip /
//       C3 删最后 grant→[] 并 runtime 真撤销 / C8 publish 后 tool 权限==preview)
//       端到端验证,并断言下游真消费(WikiAuthorizationService.authorize 数据面
//       纯函数 gate,而非只查 store 字段);
//   (c) 保留 grantsBlockMessage() 作回归探针:若 Fix 1 退化,带 gate 的 A.4/C.4
//       测试会 loud-fail 而非静默文档化(现 blocker 已无,gate 走真路径)。
//
// ## 输入
//   - vi.hoisted 唯一 temp ZERO_CORE_DIR (sub-00 教训)。
//
// ## 维护规则
//   - 不改实现源;FAIL finding 由 test 文档化,不修 src/。
//   - 只跑本文件 (npx vitest run tests/unit/wiki-v2-sub07-spec.test.ts)。
//   - 跨 lens 隔离:文件名 wiki-v2-sub07-spec,不碰 adversarial/arch 文件。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Express } from "express";
import { createServer, type Server } from "http";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
	const { tmpdir: td } = require("node:os") as typeof import("node:os");
	const { join: j } = require("node:path") as typeof import("node:path");
	const d = mk(j(td(), "zc-wiki-v2-sub07-spec-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { AgentService } from "../../src/server/agent-service.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import {
	setWikiRuntime,
	_resetWikiRuntimeForTests,
} from "../../src/server/wiki/wiki-runtime.js";
import { createWikiAdminRouter } from "../../src/server/wiki-admin-router.js";
import { compileWikiAccess } from "../../src/server/wiki/wiki-access-compiler.js";
import * as dataChangeHub from "../../src/server/data-change-hub.js";

// Static import for §A.2 closed-set assertion (read the actual enum, not grep).
import { wikiV2ActionSchema } from "../../src/tools/wiki-v2-tool.js";

// provider-factory mock so AgentService loops can be built (§6 wiring).
const resolveModelMock = vi.fn();
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: (...args: unknown[]) => resolveModelMock(...args),
	getContextWindow: () => 128000,
	getMultimodal: () => false,
}));

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface SvcCtx {
	db: CoreDatabase;
	wikiDb: WikiDatabase;
	wikiSvc: WikiService;
	nodeRepo: WikiNodeRepository;
	repositoryStore: WikiRepositoryStore;
	addressService: WikiAddressService;
	auditRepo: WikiAuditRepository;
	agentService: AgentService;
	agentStore: AgentStore;
	projectStore: ProjectStore;
	app: Express;
	server: Server;
	port: number;
	dir: string;
}

function inlineFinishModel(modelId = "sub07-mock") {
	return {
		specificationVersion: "v2" as const,
		provider: "mock",
		modelId,
		supportedUrls: {},
		async doGenerate() { throw new Error("doGenerate not used"); },
		async doStream() {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue([{ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]);
					controller.close();
				},
			});
			return { stream };
		},
	};
}

function buildCtx(): SvcCtx {
	const dir = mkdtempSync(join(UNIQUE_DIR, `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-`));
	const db = new CoreDatabase(join(dir, "core.db"));
	runMigrations(db);

	const wikiDb = new WikiDatabase(join(dir, "wiki.db"));
	const wikiSvc = WikiService.fromDatabase(wikiDb);
	const wdb = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(wdb);
	const repositoryStore = new WikiRepositoryStore(wdb);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const auditRepo = new WikiAuditRepository(wdb);
	const searchSvc = new WikiSearchService({
		db: wdb, nodeRepo, repositoryStore, addressService, authorizationService,
	});
	setWikiRuntime({ wikiService: wikiSvc, searchService: searchSvc });

	const agentService = new AgentService(dir, db);
	const agentStore = new AgentStore(db);
	agentService.setAgentStore(agentStore);
	const projectStore = new ProjectStore(db);

	resolveModelMock.mockReset();
	resolveModelMock.mockReturnValue(inlineFinishModel());

	const app = express();
	app.use(express.json());
	// Stub indexer + git: repository endpoints need real Git checkouts and are
	// not the spec-lens focus. Addresses/grants/context/sessions exercise real
	// services. Stub methods throw if reached so a misroute is loud.
	app.use("/api/wiki-admin", createWikiAdminRouter({
		wikiService: wikiSvc,
		addressService,
		indexer: {
			ensureBinding: async () => { throw new Error("indexer stub: not exercised"); },
			fullIndex: async () => { throw new Error("indexer stub: not exercised"); },
			sync: async () => { throw new Error("indexer stub: not exercised"); },
			rebuildFromScratch: async () => { throw new Error("indexer stub: not exercised"); },
		} as any,
		repositoryStore,
		auditRepo,
		nodeRepo,
		projectStore,
		agentService,
		agentStore,
		git: {
			isGitRepo: async () => false,
			resolveRevision: async () => null,
			detectDefaultBranch: async () => "main",
		} as any,
	}));

	return {
		db, wikiDb, wikiSvc, nodeRepo, repositoryStore, addressService, auditRepo,
		agentService, agentStore, projectStore, app, server: undefined as any, port: 0, dir,
	};
}

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
async function post(port: number, path: string, body: unknown, query = ""): Promise<{ status: number; data: any }> {
	const resp = await fetch(`http://localhost:${port}${path}${query}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	try { return { status: resp.status, data: JSON.parse(text) }; }
	catch { return { status: resp.status, data: text }; }
}

/** Next-macrotask flush (data-change-hub emits via setTimeout(flush, 0)). */
function nextTick(n = 1): Promise<void> {
	let p = Promise.resolve();
	for (let i = 0; i < n; i++) p = p.then(() => new Promise<void>((r) => setTimeout(r, 0)));
	return p;
}

/** Poll until cond() returns true (or timeout). Used to deterministically wait
 *  for fire-and-forget run() completion without racing on the publish path. */
async function waitFor(cond: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor timed out after ${timeoutMs}ms (cond never became true)`);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

/**
 * BLOCKER probe: are the grants endpoints blocked by the forged-identity guard
 * treating the legitimate `grants` payload field as a forged identity key?
 * Returns the rejection message if blocked, or null if operational.
 */
async function grantsBlockMessage(port: number, agentId: string): Promise<string | null> {
	const r = await post(port, "/api/wiki-admin/grants/validate", { grants: [] }, `?agentId=${encodeURIComponent(agentId)}`);
	if (r.status === 400 && /forged identity/i.test(r.data?.error?.message ?? "")) {
		return r.data.error.message as string;
	}
	return null;
}

let ctxHolder: SvcCtx | null;

beforeEach(() => { ctxHolder = null; });
afterEach(async () => {
	const c = ctxHolder;
	if (c?.server) { try { await close(c.server); } catch { /* ignore */ } }
	try { await Promise.resolve(c?.agentService?.abort?.()); } catch { /* ignore */ }
	try { c?.wikiDb?.close(); } catch { /* ignore */ }
	try { c?.db?.close(); } catch { /* ignore */ }
	if (c) try { rmSync(c.dir, { recursive: true, force: true }); } catch { /* Windows WAL EPERM */ }
	_resetWikiRuntimeForTests();
});

function auditCount(ctx: SvcCtx, actionLike?: string): number {
	const db = ctx.wikiDb.getDb();
	if (actionLike) {
		return (db.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action LIKE ?").get(actionLike + "%") as { n: number }).n;
	}
	return (db.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log").get() as { n: number }).n;
}

// =============================================================================
// §A — 管理边界
// =============================================================================

describe("sub-07 §A 管理边界 [spec]", () => {
	test("A.1 admin endpoints reject forged identity / authority / actor fields in body", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "a1-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;

		// Authority/identity fields (NOT the grants payload) must be rejected.
		// NOTE: `grants` itself is tested separately under the BLOCKER probe —
		// here we use `entries`-style payloads + a forged identity key.
		const forged: Record<string, unknown>[] = [
			{ entries: [], admin: true },
			{ entries: [], actor: "@attacker" },
			{ entries: [], authority: { canManage: true } },
			{ entries: [], callerCtx: { agentId: "evil" } },
			{ entries: [], target_id: 42 },
			{ entries: [], project_node_id: 99 },
			{ entries: [], effectiveAccess: { agentId: "x" } },
			{ entries: [], nodeId: "12345" },
			{ entries: [], wikiAnchors: ["abc"] },
			{ entries: [], policyRevision: 999 },
			{ entries: [], global: true },
		];
		for (const body of forged) {
			const res = await post(c.port, "/api/wiki-admin/context/validate", body, q);
			expect(res.status, `forged body key must be 400: ${JSON.stringify(body)}`).toBe(400);
			expect(res.data.error.code).toBe("INVALID_REQUEST");
			expect(res.data.error.message).toMatch(/forged identity/i);
		}
	});

	test("A.1b agentId in body is a forbidden key; server resolves agentId only from query string", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		// No ?agentId= query, and body declares agentId (forbidden) → 400.
		const res = await post(c.port, "/api/wiki-admin/context/validate", { entries: [], agentId: "forged" }, "");
		expect(res.status).toBe(400);
	});

	test("A.2 WIKI_V2_ACTIONS enum is exactly the 9 data-plane actions (no admin action)", () => {
		const shape = (wikiV2ActionSchema as unknown as { _def: { shape: Record<string, { options?: readonly string[] }> } })._def.shape;
		const opts = shape.action?.options ?? [];
		expect(opts, "WIKI_V2_ACTIONS must be exactly the 9 data-plane actions").toEqual([
			"expand", "read", "search", "create", "update", "delete", "link", "unlink", "move",
		]);
		const adminWords = ["address", "repository", "grant", "context", "publish", "bind", "unbind", "reindex", "validate", "preview", "impact"];
		for (const w of adminWords) {
			expect(opts.some((o) => o.toLowerCase().includes(w)), `data-plane action must not include admin word "${w}"`).toBe(false);
		}
	});

	test("A.2b wiki-router (data plane) exposes exactly the 10 data endpoints; admin paths 404", async () => {
		const c = buildCtx(); ctxHolder = c;
		const { createWikiBrowserRouter } = await import("../../src/server/wiki-router.js");
		const dataApp = express();
		dataApp.use(express.json());
		dataApp.use("/api/wiki", createWikiBrowserRouter());
		const l = await listen(dataApp);
		const dataPaths = ["/expand", "/read", "/search", "/create", "/update", "/delete", "/link", "/unlink", "/move", "/history"];
		for (const p of dataPaths) {
			const r = await post(l.port, `/api/wiki${p}`, {});
			expect(r.status, `data endpoint ${p} must be handled (not 404)`).not.toBe(404);
		}
		const adminPaths = ["/addresses/list", "/grants/validate", "/context/preview", "/repositories/bind"];
		for (const p of adminPaths) {
			const r = await post(l.port, `/api/wiki${p}`, {});
			expect(r.status, `admin path ${p} must 404 on data router (boundary)`).toBe(404);
		}
		await close(l.server);
	});

	test("A.3 validate/preview have zero DB side-effects (no audit row, no revision bump)", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "a3-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read", "expand"] }],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const beforeAudits = auditCount(c);
		const beforeRev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;

		// context/validate + context/preview (entries-based, operational).
		const cv = await post(c.port, "/api/wiki-admin/context/validate", {
			entries: [{ address: "memory://", profile: "standard", channel: "system" }],
		}, q);
		expect(cv.status).toBe(200);
		const cp = await post(c.port, "/api/wiki-admin/context/preview", {
			entries: [{ address: "memory://", profile: "standard", channel: "system" }],
		}, q);
		expect(cp.status).toBe(200);

		// addresses/validate + addresses/impact.
		const av = await post(c.port, "/api/wiki-admin/addresses/validate", {
			address: "runtime://test", scope: "runtime", kind: "alias", resolver: null,
			targetPath: "wiki-root/knowledge",
		});
		expect(av.status).toBe(200);
		const ai = await post(c.port, "/api/wiki-admin/addresses/impact", {
			address: "runtime://test", targetPath: "wiki-root/knowledge", resolver: null,
		});
		expect(ai.status).toBe(200);

		expect(auditCount(c), "validate/preview must not append audit rows").toBe(beforeAudits);
		expect(c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0, "validate/preview must not bump policy revision").toBe(beforeRev);

		// grants/validate side-effect probe — gated by the BLOCKER (if blocked,
		// assert no audit was written despite the 400; the guard runs before any
		// service call, so still no mutation).
		const midAudits = auditCount(c);
		const gv = await post(c.port, "/api/wiki-admin/grants/validate", {
			grants: [{ scope: "wiki-root/knowledge", actions: ["read"] }],
		}, q);
		expect(auditCount(c), "grants/validate must not append audit rows (even if 400)").toBe(midAudits);
		if (gv.status === 200) {
			// Operational path: also assert no revision change.
			expect(c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0).toBe(beforeRev);
		}
	});

	test("A.4 grants/publish CAS: stale expectedRevision → 409 WRITE_CONFLICT (gated by grants BLOCKER)", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "a4-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const blocked = await grantsBlockMessage(c.port, agent.id);
		if (blocked) {
			// BLOCKER present: grants/publish is unreachable. Document and stop.
			expect(blocked).toMatch(/grants/);
			return;
		}
		const currentRev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const res = await post(c.port, "/api/wiki-admin/grants/publish", {
			grants: [{ scope: "wiki-root/knowledge", actions: ["read", "expand"] }],
			expectedRevision: currentRev + 5,
		}, q);
		expect(res.status).toBe(409);
		expect(res.data.error.code).toBe("WRITE_CONFLICT");
		expect(res.data.error.currentRevision).toBe(currentRev);
		// Record unchanged.
		const after = c.agentStore.get(agent.id)!;
		expect(after.wikiPolicyRevision ?? 0).toBe(currentRev);
		expect(after.wikiGrants).toEqual([{ scope: "memory://", actions: ["read"] }]);
	});

	test("A.4b grants/publish correct revision → success +1 (gated by grants BLOCKER)", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "a4b-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const blocked = await grantsBlockMessage(c.port, agent.id);
		if (blocked) { expect(blocked).toMatch(/grants/); return; }
		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const res = await post(c.port, "/api/wiki-admin/grants/publish", {
			grants: [{ scope: "wiki-root/knowledge", actions: ["read", "expand"] }],
			expectedRevision: rev,
		}, q);
		expect(res.status).toBe(200);
		expect(res.data.result.newRevision).toBe(rev + 1);
		expect(c.agentStore.get(agent.id)!.wikiGrants).toEqual([{ scope: "wiki-root/knowledge", actions: ["read", "expand"] }]);
	});

	test("A.5 address.create + context.publish write audit with actor=@wiki-admin + action + time + impact", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;

		// address.create → audit address.create.
		const beforeAddr = auditCount(c, "address.create");
		const created = await post(c.port, "/api/wiki-admin/addresses/create", {
			address: "runtime://svc", scope: "runtime", kind: "alias", resolver: null,
			targetPath: "wiki-root/knowledge",
		});
		expect(created.status).toBe(200);
		expect(auditCount(c, "address.create")).toBe(beforeAddr + 1);
		const addrAudit = c.wikiDb.getDb()
			.prepare("SELECT actor_agent_id, action, created_at FROM wiki_audit_log WHERE action = ? ORDER BY created_at DESC LIMIT 1")
			.get("address.create") as any;
		expect(addrAudit.actor_agent_id).toBe("@wiki-admin");
		expect(addrAudit.action).toBe("address.create");
		expect(typeof addrAudit.created_at).toBe("string");
		expect(addrAudit.created_at.length).toBeGreaterThan(0);

		// context.publish (entries-based, operational) → audit policy.publish.context.
		const agent = c.agentStore.create({
			name: "a5-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read", "expand"] }],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const pub = await post(c.port, "/api/wiki-admin/context/publish", {
			entries: [{ address: "memory://", profile: "standard", channel: "system" }],
			expectedRevision: rev,
		}, q);
		expect(pub.status).toBe(200);
		const ctxAudit = c.wikiDb.getDb()
			.prepare("SELECT actor_agent_id, action, new_revision, detail_json FROM wiki_audit_log WHERE action = ? ORDER BY created_at DESC LIMIT 1")
			.get("policy.publish.context") as any;
		expect(ctxAudit.actor_agent_id).toBe("@wiki-admin");
		expect(ctxAudit.action).toBe("policy.publish.context");
		expect(ctxAudit.new_revision).toBe(rev + 1);
		const detail = JSON.parse(ctxAudit.detail_json);
		expect(detail.agentId).toBe(agent.id);
		expect(Array.isArray(detail.affectedSessions)).toBe(true);
	});
});

// =============================================================================
// §B — 地址管理
// =============================================================================

describe("sub-07 §B 地址管理 [spec]", () => {
	test("B.1 register an active node as a static address; list view exposes no internal ID", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const ctxWide = { access: { agentId: "seed", grants: [{ canonicalScope: "wiki-root", actions: ["create"] }], policyRevision: 1 } } as any;
		c.wikiSvc.create({ parent: "wiki-root/knowledge", name: "svc-root", kind: "knowledge", summary: "" }, ctxWide);

		const created = await post(c.port, "/api/wiki-admin/addresses/create", {
			address: "runtime://svc", scope: "runtime", kind: "alias", resolver: null,
			targetPath: "wiki-root/knowledge/svc-root",
		});
		expect(created.status).toBe(200);
		expect(created.data.result.address.targetCanonicalPath).toBe("wiki-root/knowledge/svc-root");

		const list = await post(c.port, "/api/wiki-admin/addresses/list", {});
		const found = list.data.result.addresses.find((a: any) => a.address === "runtime://svc");
		expect(found).toBeDefined();
		expect(found.targetCanonicalPath).toBe("wiki-root/knowledge/svc-root");
		// No internal DB integer ID leaks.
		expect(found.target_id).toBeUndefined();
		expect(found.project_node_id).toBeUndefined();
	});

	test("B.3 invalid resolver value rejected (closed enum, no code); no audit written", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const before = auditCount(c);
		// A non-enum resolver string must be rejected (zod enum). The closed enum
		// means an attacker cannot upload executable resolver code (design §5.3).
		const res = await post(c.port, "/api/wiki-admin/addresses/validate", {
			address: "evil://x", scope: "runtime", kind: "alias",
			resolver: "function() { return hack; }" as any,
			targetPath: "wiki-root/knowledge",
		});
		expect(res.status).toBe(400);
		expect(res.data.error.code).toBe("INVALID_REQUEST");
		expect(auditCount(c)).toBe(before);
	});

	test("B.5 address impact lists agents whose grants/context reference the address", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "b5", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "runtime://api", actions: ["read"] }],
		} as any);
		const res = await post(c.port, "/api/wiki-admin/addresses/impact", {
			address: "runtime://api", targetPath: "wiki-root/knowledge", resolver: null,
		});
		expect(res.status).toBe(200);
		const ids = res.data.result.affectedAgents.map((a: any) => a.agentId);
		expect(ids).toContain(agent.id);
	});
});

// =============================================================================
// §C — Agent grants (gated by grants BLOCKER)
// =============================================================================

describe("sub-07 §C Agent grants [spec]", () => {
	test("Fix 1: grants endpoints accept a legitimate {grants:[...]} body (200); real identity keys (admin/actor/canManage) stay forbidden", async () => {
		// Round-2 fix: the admin-plane FORBIDDEN_BODY_KEYS no longer lists the
		// legitimate `grants` payload field as a forged identity key, so all
		// three grants endpoints must accept a well-formed {grants:[...]} body
		// and return their compiled summary. The data-plane wiki-router.ts
		// STILL forbids `grants`/`projectId` (caller identity there) — that
		// isolation is proven by §A.2b above (admin path 404 on data router)
		// and by the arch lens; the two FORBIDDEN_BODY_KEYS sets are
		// intentionally divergent.
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "fix1-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const legitGrants = [{ scope: "wiki-root/knowledge", actions: ["read" as const] }];

		// validate → 200 + mergedGrants (compiled summary).
		const gv = await post(c.port, "/api/wiki-admin/grants/validate", { grants: legitGrants }, q);
		expect(gv.status, "grants/validate must accept legitimate body (Fix 1)").toBe(200);
		expect(Array.isArray(gv.data.result.mergedGrants)).toBe(true);
		expect(gv.data.result.mergedGrants.length).toBe(1);

		// preview → 200 + access.grants (compileWikiAccess result) + warnings.
		const gp = await post(c.port, "/api/wiki-admin/grants/preview", { grants: legitGrants }, q);
		expect(gp.status, "grants/preview must accept legitimate body (Fix 1)").toBe(200);
		expect(gp.data.result.access.grants[0].canonicalScope).toBe("wiki-root/knowledge");
		expect(gp.data.result.access.grants[0].actions).toEqual(["read"]);
		expect(Array.isArray(gp.data.result.warnings)).toBe(true);

		// publish → 200 + newRevision (CAS happy path).
		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const gpub = await post(c.port, "/api/wiki-admin/grants/publish", {
			grants: legitGrants, expectedRevision: rev,
		}, q);
		expect(gpub.status, "grants/publish must accept legitimate body (Fix 1)").toBe(200);
		expect(gpub.data.result.newRevision).toBe(rev + 1);

		// Regression guard: removing `grants` from FORBIDDEN_BODY_KEYS was NOT a
		// blanket bypass. Real identity/authority keys (Fix 2 added canManage;
		// admin/actor/authority were already forbidden) must still 400 as forged.
		for (const forged of [
			{ grants: legitGrants, admin: true },
			{ grants: legitGrants, actor: "@attacker" },
			{ grants: legitGrants, canManage: true },
			{ grants: legitGrants, authority: { canManage: true } },
		]) {
			const r = await post(c.port, "/api/wiki-admin/grants/validate", forged, q);
			expect(r.status, `real identity key must still be 400: ${JSON.stringify(forged)}`).toBe(400);
			expect(r.data.error.code).toBe("INVALID_REQUEST");
			expect(r.data.error.message).toMatch(/forged identity/i);
		}
	});

	test("C.3 deleting the last grant persists [] AND actually revokes runtime tool permission", async () => {
		// Round-2: blocker gone. Drive the full publish → [] path over HTTP, then
		// recompile the agent's runtime access from the persisted record and
		// assert the data-plane authorize() gate (the exact pure-function gate
		// WikiService.read invokes before reading a node) now DENIES read on the
		// previously-allowed memory scope. This is downstream real消费
		// (feedback-verify-runtime-wiring), not just a store-field check.
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "c3-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const authz = new WikiAuthorizationService();
		const memoryPath = `wiki-root/memory/${agent.id}`;

		// Pre-publish: agent CAN read its memory scope at the data-plane gate.
		const beforeAccess = compileWikiAccess({
			agentId: agent.id,
			wikiGrants: c.agentStore.get(agent.id)!.wikiGrants ?? [],
			wikiPolicyRevision: c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0,
		}).access;
		expect(authz.decide("read", memoryPath, beforeAccess).allowed,
			"pre-publish: read on memory scope must be allowed").toBe(true);

		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const res = await post(c.port, "/api/wiki-admin/grants/publish", { grants: [], expectedRevision: rev }, q);
		expect(res.status).toBe(200);
		const after = c.agentStore.get(agent.id)!;
		// §H refusal: deleting the last grant must persist [] (not undefined
		// retention — the patch.explicit-[] semantics in publishAgentWikiPolicy).
		expect(after.wikiGrants).toEqual([]);
		expect(Array.isArray(after.wikiGrants)).toBe(true);

		// Downstream real消费: runtime authorize gate now denies read.
		const afterAccess = compileWikiAccess({
			agentId: agent.id,
			wikiGrants: after.wikiGrants ?? [],
			wikiPolicyRevision: after.wikiPolicyRevision ?? 0,
		}).access;
		expect(afterAccess.grants, "no grants compiled after publishing []").toEqual([]);
		expect(authz.decide("read", memoryPath, afterAccess).allowed,
			"post-publish []: read must be denied at the data-plane authorize gate").toBe(false);
		expect(() => authz.authorize("read", memoryPath, afterAccess)).toThrow();
	});

	test("C.4/C.7 + A.5 grants: wiki-root write requires confirmRootWriteGrant; cancel = no audit; confirm writes audit actor=@wiki-admin/revision+1", async () => {
		// Round-2: blocker gone. C.4 confirm gate (router + service boundary),
		// C.7 cancel-doesn't-save, AND A.5 grants audit row shape
		// (actor/action/new_revision/detail.agentId). The confirm gate now also
		// fires at the service boundary (Fix 3) — covered adversarially; here we
		// prove the router→service happy path + audit shape end-to-end.
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "c4-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const blocked = await grantsBlockMessage(c.port, agent.id);
		if (blocked) { expect(blocked).toMatch(/grants/); return; }
		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const before = auditCount(c, "policy.publish.grants");

		// Without confirmation → rejected, no audit, no revision change (C.7).
		const rejected = await post(c.port, "/api/wiki-admin/grants/publish", {
			grants: [{ scope: "wiki-root", actions: ["create", "update", "delete"] }],
			expectedRevision: rev,
		}, q);
		expect(rejected.status).toBe(400);
		expect(rejected.data.error.message).toMatch(/confirmRootWriteGrant/i);
		expect(auditCount(c, "policy.publish.grants")).toBe(before);
		expect(c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0).toBe(rev);

		// With confirmation → published + audit row (C.4 + A.5).
		const accepted = await post(c.port, "/api/wiki-admin/grants/publish", {
			grants: [{ scope: "wiki-root", actions: ["create", "update"] }],
			expectedRevision: rev, confirmRootWriteGrant: true,
		}, q);
		expect(accepted.status).toBe(200);
		expect(accepted.data.result.newRevision).toBe(rev + 1);
		expect(auditCount(c, "policy.publish.grants")).toBe(before + 1);

		// A.5 grants audit row shape: actor=@wiki-admin, action, new_revision,
		// detail.agentId + affectedSessions + hasRootWriteGrant (impact summary).
		const grantsAudit = c.wikiDb.getDb()
			.prepare("SELECT actor_agent_id, action, new_revision, detail_json FROM wiki_audit_log WHERE action = ? ORDER BY created_at DESC LIMIT 1")
			.get("policy.publish.grants") as any;
		expect(grantsAudit.actor_agent_id).toBe("@wiki-admin");
		expect(grantsAudit.action).toBe("policy.publish.grants");
		expect(grantsAudit.new_revision).toBe(rev + 1);
		const detail = JSON.parse(grantsAudit.detail_json);
		expect(detail.agentId).toBe(agent.id);
		expect(detail.hasRootWriteGrant).toBe(true);
		expect(Array.isArray(detail.affectedSessions)).toBe(true);
	});

	test("C.8 published grants compile to the same canonical scopes + actions preview reported (runtime tool == preview)", async () => {
		// Round-2: blocker gone. Assert preview == runtime at the per-grant
		// (scope + action set) level, AND that the data-plane authorize() gate
		// actually admits each previewed action on the runtime access. This is
		// the "publish 后真实 Agent tool 权限与 preview 一致" criterion driven
		// through the real authorization gate, not a scope-string compare.
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "c8-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const authz = new WikiAuthorizationService();
		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const grants = [
			{ scope: "memory://", actions: ["read", "expand"] },
			{ scope: "wiki-root/knowledge", actions: ["read"] },
		];
		const preview = await post(c.port, "/api/wiki-admin/grants/preview", { grants }, q);
		expect(preview.status).toBe(200);
		const previewGrants = (preview.data.result.access.grants as Array<{ canonicalScope: string; actions: string[] }>)
			.map((g) => ({ canonicalScope: g.canonicalScope, actions: [...g.actions].sort() }))
			.sort((a, b) => a.canonicalScope.localeCompare(b.canonicalScope));

		const pub = await post(c.port, "/api/wiki-admin/grants/publish", { grants, expectedRevision: rev }, q);
		expect(pub.status).toBe(200);
		const after = c.agentStore.get(agent.id)!;
		const runtimeAccess = compileWikiAccess({
			agentId: agent.id,
			wikiGrants: after.wikiGrants ?? [],
			wikiPolicyRevision: after.wikiPolicyRevision ?? 0,
		}).access;
		const runtimeGrants = runtimeAccess.grants
			.map((g) => ({ canonicalScope: g.canonicalScope, actions: [...g.actions].sort() }))
			.sort((a, b) => a.canonicalScope.localeCompare(b.canonicalScope));

		// Per-grant scope + action set must match between preview and runtime.
		expect(runtimeGrants).toEqual(previewGrants);
		expect(runtimeGrants.map((g) => g.canonicalScope)).toContain(`wiki-root/memory/${agent.id}`);

		// Downstream real消费: the data-plane authorize() gate admits each
		// previewed action on the runtime access (tool permission == preview).
		const memoryPath = `wiki-root/memory/${agent.id}`;
		for (const action of ["read", "expand"] as const) {
			const matched = authz.authorize(action, memoryPath, runtimeAccess);
			expect(matched.canonicalScope, `authorize(${action}) must hit the memory grant`).toBe(`wiki-root/memory/${agent.id}`);
		}
		const knowledgePath = "wiki-root/knowledge";
		expect(authz.decide("read", knowledgePath, runtimeAccess).allowed,
			"knowledge read admitted").toBe(true);
		expect(authz.decide("expand", knowledgePath, runtimeAccess).allowed,
			"knowledge expand NOT admitted (not in published actions)").toBe(false);
	});
});

// =============================================================================
// §D — Agent Context (entries-based; operational)
// =============================================================================

describe("sub-07 §D Agent context [spec]", () => {
	test("D.3 context publish blocked when address lacks read grant (no auto-grant)", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "d3-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const beforeAudits = auditCount(c, "policy.publish.context");

		const res = await post(c.port, "/api/wiki-admin/context/publish", {
			entries: [{ address: "wiki-root/knowledge", profile: "standard", channel: "system" }],
			expectedRevision: rev,
		}, q);
		expect(res.status).toBe(400);
		expect(res.data.error.code).toBe("INVALID_REQUEST");
		expect(c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0).toBe(rev);
		expect(auditCount(c, "policy.publish.context")).toBe(beforeAudits);
		// wikiGrants unchanged — context did NOT auto-grant.
		expect(c.agentStore.get(agent.id)!.wikiGrants).toEqual([{ scope: "memory://", actions: ["read"] }]);

		// validate surfaces unauthorized address (UI gate).
		const v = await post(c.port, "/api/wiki-admin/context/validate", {
			entries: [{ address: "wiki-root/knowledge", profile: "standard", channel: "system" }],
		}, q);
		expect(v.status).toBe(200);
		expect(v.data.result.unauthorizedAddresses).toContain("wiki-root/knowledge");
	});

	test("D.3b context publish succeeds when grant covers the address", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "d3b-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read", "expand"] }],
		} as any);
		const q = `?agentId=${encodeURIComponent(agent.id)}`;
		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const res = await post(c.port, "/api/wiki-admin/context/publish", {
			entries: [{ address: "memory://", profile: "compact", channel: "system" }],
			expectedRevision: rev,
		}, q);
		expect(res.status).toBe(200);
		expect(res.data.result.newRevision).toBe(rev + 1);
	});
});

// =============================================================================
// §H — 拒绝条件
// =============================================================================

describe("sub-07 §H 拒绝条件 [spec]", () => {
	test("H. address view never leaks internal target_id / project_node_id", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const ctxWide = { access: { agentId: "seed", grants: [{ canonicalScope: "wiki-root", actions: ["create"] }], policyRevision: 1 } } as any;
		c.wikiSvc.create({ parent: "wiki-root/knowledge", name: "h-node", kind: "knowledge", summary: "" }, ctxWide);
		await post(c.port, "/api/wiki-admin/addresses/create", {
			address: "runtime://h", scope: "runtime", kind: "alias", resolver: null,
			targetPath: "wiki-root/knowledge/h-node",
		});
		const list = await post(c.port, "/api/wiki-admin/addresses/list", {});
		const json = JSON.stringify(list.data);
		expect(json).not.toMatch(/"target_id"/);
		expect(json).not.toMatch(/"project_node_id"/);
	});

	test("H. renderer cannot set admin/actor via body on body-parsing admin endpoints", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const r1 = await post(c.port, "/api/wiki-admin/addresses/create", {
			address: "runtime://x", scope: "runtime", kind: "alias", resolver: null,
			targetPath: "wiki-root/knowledge", actor: "@attacker",
		});
		expect(r1.status).toBe(400);
		const r2 = await post(c.port, "/api/wiki-admin/addresses/update", {
			address: "runtime://x", patch: { kind: "k", resolver: null }, admin: true,
		});
		expect(r2.status).toBe(400);
		const r3 = await post(c.port, "/api/wiki-admin/repositories/validate", {
			projectId: "p1", authority: { canManage: true },
		});
		expect(r3.status).toBe(400);
	});

	test("H. data-plane Wiki tool schema never offers address registration (boundary)", () => {
		const shape = (wikiV2ActionSchema as unknown as { _def: { shape: Record<string, { options?: readonly string[] }> } })._def.shape;
		const opts = shape.action?.options ?? [];
		expect(opts).not.toContain("register");
		expect(opts).not.toContain("publish");
		expect(opts).not.toContain("bind");
	});
});

// =============================================================================
// §6 — publish → session refresh runtime-alive (orchestrator 重点 #2)
// =============================================================================

describe("sub-07 §6 publish → session refresh runtime-alive [spec]", () => {
	test("context publish hot-syncs new wikiAccess into a running loop bound to that agent", async () => {
		// Use context/publish (operational) to exercise the publish → onChange →
		// loop.config.wikiAccess wiring. grants/publish is blocked (BLOCKER), so
		// context.publish is the live path that proves §6 wiring is alive.
		//
		// P0-1: after the busy-loop StepEnd fix, a publish on an IDLE active
		// session routes through the createLoopForSession rebuild (the loop is
		// rebuilt with a fresh compileWikiAccessForSession); a publish on a BUSY
		// session routes through enqueueConfigPatch → pendingConfigPatches →
		// StepEnd flush. To keep this HTTP-path wiring test deterministic
		// (avoid the busy/idle race inherent in fire-and-forget sendProjectPrompt)
		// we wait for the loop to go idle, then publish, then re-fetch the
		// (possibly rebuilt) loop reference and assert it carries the NEW rev.
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "wiring-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
			wikiContext: [],
		} as any);

		const sessionId = `wiring-${Date.now()}`;
		await c.agentService.sendProjectPrompt(agent.id, sessionId, "go", {
			projectId: "proj-wiring", projectPath: c.dir, projectName: "Wiring",
		}, "work");
		const loop = (c.agentService as any).loops.get(sessionId);
		expect(loop, "sendProjectPrompt must register the loop").toBeDefined();
		expect(loop.config.wikiAccess, "loop must start with compiled wikiAccess").toBeDefined();

		// Wait for the fire-and-forget run() to finish so the publish below
		// deterministically hits the IDLE rebuild branch (the race-free path).
		await waitFor(() => !(c.agentService as any).runStates.get(sessionId)?.isBusy);

		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		// Publish a context entry via the admin router (real HTTP path).
		const res = await post(c.port, "/api/wiki-admin/context/publish", {
			entries: [{ address: "memory://", profile: "standard", channel: "system" }],
			expectedRevision: rev,
		}, `?agentId=${encodeURIComponent(agent.id)}`);
		expect(res.status).toBe(200);
		expect(res.data.result.newRevision).toBe(rev + 1);

		// agentStore.update → onChange → IDLE rebuild → createLoopForSession →
		// compileWikiAccessForSession (NEW wikiAccess baked into the rebuilt
		// loop's SessionConfig). The session's loop reference may have been
		// replaced by the rebuild, so re-fetch before asserting. The loop's
		// policyRevision must bump (wiring alive, not dead).
		const loopAfter = (c.agentService as any).loops.get(sessionId);
		expect(loopAfter, "session still has a loop after publish (rebuild)").toBeDefined();
		expect(loopAfter.config.wikiAccess?.policyRevision,
			"loop must reflect the bumped revision via the rebuild/apply path (wiring alive)",
		).toBe(rev + 1);
	}, 30000);

	test("publish reports affectedSessions for the bound loop", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const agent = c.agentStore.create({
			name: "aff-agent", provider: "MockProv", model: "m", toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
			wikiContext: [],
		} as any);
		const sessionId = `aff-${Date.now()}`;
		await c.agentService.sendProjectPrompt(agent.id, sessionId, "go", {
			projectId: "proj-aff", projectPath: c.dir, projectName: "Aff",
		}, "work");

		const rev = c.agentStore.get(agent.id)!.wikiPolicyRevision ?? 0;
		const res = await post(c.port, "/api/wiki-admin/context/publish", {
			entries: [{ address: "memory://", profile: "compact", channel: "system" }],
			expectedRevision: rev,
		}, `?agentId=${encodeURIComponent(agent.id)}`);
		expect(res.status).toBe(200);
		const affected = res.data.result.affectedSessions as Array<{ sessionId: string; applied: boolean }>;
		const mine = affected.find((s) => s.sessionId === sessionId);
		expect(mine, "publish must report the running session in affectedSessions").toBeDefined();
		expect(typeof mine!.applied).toBe("boolean");
	}, 30000);
});

// =============================================================================
// PromptTemplate fresh-DB migration (orchestrator 重点 #3)
// =============================================================================

describe("sub-07 PromptTemplate wikiGrants/wikiContext fresh-DB migration [spec]", () => {
	test("Fix 4: fresh-DB runMigrations adds templates.wiki_grants + wiki_context directly (COLUMNS is the source of truth)", async () => {
		// Round-2 fix: db-migration.ts templates COLUMNS now includes
		// wikiGrants/wikiContext (feedback-fresh-db-migrations: the *_COLUMNS
		// array is the fresh-DB source of truth — CREATE TABLE comes from it, so
		// a brand-new DB that only runs runMigrations must already have both
		// columns WITHOUT relying on TemplateStore.ensureTable() self-heal).
		const dir = mkdtempSync(join(UNIQUE_DIR, `mig-${Date.now()}-`));
		const db = new CoreDatabase(join(dir, "fresh.db"));
		try {
			runMigrations(db);
			const cols = (db.getDb().prepare("PRAGMA table_info(templates)").all() as Array<{ name: string }>).map((c) => c.name);
			expect(cols, "templates.wiki_grants present after runMigrations alone (Fix 4)").toContain("wiki_grants");
			expect(cols, "templates.wiki_context present after runMigrations alone (Fix 4)").toContain("wiki_context");

			// And the column is writable: a template carrying wikiGrants round-trips
			// through migration-driven COLUMNS without any post-hoc ALTER.
			const { TemplateStore } = await import("../../src/server/template-store.js");
			const store = new TemplateStore(db);
			const created = store.create({
				name: "mig-seed",
				systemPrompt: "p",
				toolPolicy: { tools: {} },
				wikiGrants: [{ scope: "memory://", actions: ["read"] }],
				wikiContext: [{ address: "memory://", profile: "standard", channel: "system" }],
			} as any);
			expect(store.get(created.id)!.wikiGrants).toEqual([{ scope: "memory://", actions: ["read"] }]);
		} finally {
			try { db.close(); } catch { /* ignore */ }
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL EPERM */ }
		}
	});

	test("TemplateStore round-trips wikiGrants/wikiContext through create + read", async () => {
		const dir = mkdtempSync(join(UNIQUE_DIR, `tpl-${Date.now()}-`));
		const db = new CoreDatabase(join(dir, "tpl.db"));
		try {
			runMigrations(db);
			const { TemplateStore } = await import("../../src/server/template-store.js");
			const store = new TemplateStore(db);
			const created = store.create({
				name: "wiki-seed",
				systemPrompt: "p",
				toolPolicy: { tools: {} },
				wikiGrants: [{ scope: "memory://", actions: ["read", "expand"] }],
				wikiContext: [{ address: "memory://", profile: "standard", channel: "system" }],
			} as any);
			const read = store.get(created.id);
			expect(read, "template must round-trip").toBeDefined();
			expect(read!.wikiGrants).toEqual([{ scope: "memory://", actions: ["read", "expand"] }]);
			expect(read!.wikiContext).toEqual([{ address: "memory://", profile: "standard", channel: "system" }]);
		} finally {
			try { db.close(); } catch { /* ignore */ }
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL EPERM */ }
		}
	});
});

// =============================================================================
// §7 — management-plane change events are independent collections
// =============================================================================

describe("sub-07 §7 management change events [spec]", () => {
	test("management mutations emit wiki_admin events (independent from wiki_nodes data tree)", async () => {
		const c = buildCtx(); ctxHolder = c;
		const l = await listen(c.app); c.server = l.server; c.port = l.port;
		const adminCollections: string[] = [];
		const nodeCollections: string[] = [];
		const unsub = dataChangeHub.onDataChange((e: any) => {
			if (e.collection === "wiki_admin") adminCollections.push(e.collection);
			if (e.collection === "wiki_nodes") nodeCollections.push(e.collection);
		});
		try {
			const ctxWide = { access: { agentId: "seed", grants: [{ canonicalScope: "wiki-root", actions: ["create"] }], policyRevision: 1 } } as any;
			c.wikiSvc.create({ parent: "wiki-root/knowledge", name: "ev-node", kind: "knowledge", summary: "" }, ctxWide);
			const r = await post(c.port, "/api/wiki-admin/addresses/create", {
				address: "runtime://ev", scope: "runtime", kind: "alias", resolver: null,
				targetPath: "wiki-root/knowledge/ev-node",
			});
			expect(r.status).toBe(200);
			// data-change-hub flushes via setTimeout(flush, 0); wait two macrotasks.
			await nextTick(2);
			expect(adminCollections.length, "address.create must emit a wiki_admin change event").toBeGreaterThan(0);
			expect(nodeCollections.length, "management mutation must not emit wiki_nodes (independent collection)").toBe(0);
		} finally {
			unsub();
		}
	});
});
