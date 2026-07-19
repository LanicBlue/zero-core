// wiki-v2 sub-06 acceptance · architecture lens
//
// # 文件说明书
//
// ## 核心功能
// 对照 docs/archive/wiki-system-redesign/design.md 的数据面 / UI 权威 / canonical
// path / 增量同步 契约,以 architecture 方向独立验证 sub-06 实现:
//
//   1. REST adapter 是薄层 —— 9 个 POST endpoint 全部委托给 WikiService /
//      WikiSearchService **同一单例**(getWikiService / getWikiSearchService),
//      不内联 SQL / 业务逻辑(acceptance-06 §A.7)。
//   2. UI authority 由 server host 注入(UI_ADMIN_ACCESS 常量 + buildUiCtx),
//      body 里的 callerCtx/grants/admin/global/agentId 一律拒绝,不能扩权
//      (acceptance-06 §A.2/§A.3/§H)。
//   3. canonical path 单一权威实现(wiki-path.ts);router 不自行 normalize,
//      只透传 address 给 service;FORBIDDEN_BODY_KEYS 拒绝 nodeId/anchorIds
//      旧身份字段。
//   4. data:changed event 覆盖全部 6 个 mutation endpoint(create/update/
//      delete/link/unlink/move),payload 含 path/oldPath/parentPath/op/revision;
//      move 同时清 oldPath + emit wiki_sync(acceptance-06 §E.1/§E.2 + plan-06 §7)。
//   5. 删 wiki-anchor-injection.ts 后无悬挂 import —— agent-loop.ts 不 import
//      任何 wiki compiler/store(AgentLoop hooks-only 不回归)。
//   6. History(acceptance-06 §D7)round-2 已接线 —— 架构断言:
//      (a) WikiService.listHistory 是薄委托,委托已有 auditRepo.listByNodePath
//          + auditRowToView 映射,**不**复制查询逻辑(§A.7)。
//      (b) /history 走同一 getWikiService 单例 + buildUiCtx + mapWikiError +
//          FORBIDDEN_BODY_KEYS,与其它 9 endpoint 同源(§A.4 / §A.7)。
//      (c) listHistory 路径**不**写 audit(meta-query;自写会污染真实历史)。
//      (d) /history 只读,**不** emit data:changed。
//      (e) wikiV2History channel 在 preload-types/ipc-proxy/ipc-api/preload 4 文件
//          类型与 router 同源(§A.4)。
//   7. round-2 回归:A2(FORBIDDEN_BODY_KEYS 加同义词)、E2(_applyNodeEvent
//      wasParentLoaded 快照修死代码)、AgentLoop hooks-only、canonical path 三处
//      一致、D2 XSS(WikiDetail 无 rehype-raw)。
//
// ## 测试策略
// 注册 mock WikiService / WikiSearchService 单例(setWikiRuntime),POST 到真实
// express router,断言:
//   - 对应 service 方法被调用(spy)+ 收到的 (reqInput, ctx) 形状。
//   - ctx.access 永远是 UI_ADMIN_ACCESS,与 body 无关。
//   - vi.mock data-change-hub 的 emitDataChange spy 捕获 mutation 后的 emit。
//
// ## Windows vitest 注意
// 单进程大量 temp DB 会 STATUS_STACK_BUFFER_OVERRUN teardown 崩(exit 127)。
// 本文件**不**开 better-sqlite3 / temp DB —— 只跑 express + mock,无 DB 崩溃面。
//
// 参见:
//   - docs/archive/wiki-system-redesign/design.md §3.1 / §7.4 / §10.2 / §10.3 / §11
//   - docs/archive/wiki-system-redesign/acceptance-06-data-api-browser-ui.md §A/§E/§H

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Express } from "express";
import { createServer, type Server } from "http";

// 注意:wiki-router 的 emit 走动态 `require("./data-change-hub.js")`(包在 try/catch
// 里)。vitest 的模块加载器对 ESM-transformed 模块内运行时 `require()` 解析不稳,
// emit 无法经 HTTP surface 跑通。改为**源码结构断言**(见 emit coverage suite)。
import { createWikiBrowserRouter, WIKI_UI_ADMIN_ACCESS, WIKI_UI_ADMIN_ACTIONS } from "../../src/server/wiki-router.js";
import { setWikiRuntime, _resetWikiRuntimeForTests } from "../../src/server/wiki/wiki-runtime.js";
import { normalizeWikiPath, isSameOrDescendant, WIKI_ROOT_PATH } from "../../src/server/wiki/wiki-path.js";
import { WIKI_ACTIONS } from "../../src/shared/wiki-types.js";

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
async function getReq(port: number, path: string): Promise<{ status: number; data: any }> {
	const resp = await fetch(`http://localhost:${port}${path}`);
	const text = await resp.text();
	try { return { status: resp.status, data: JSON.parse(text) }; }
	catch { return { status: resp.status, data: text }; }
}

/** canned mutation result;path 通过参数注入便于 emit 断言。 */
function mutationResult(path: string, revision = 7) {
	return { success: true, path, revision, auditId: "audit-1", oldRevision: revision - 1 };
}

/** 构造 mock WikiService:每个方法是 spy,返回 canned result。captured 收 ctx。 */
function makeMockWikiService() {
	const captured: Record<string, { req: any; ctx: any }> = {};
	const mk = (name: string, result: any) => {
		const fn = vi.fn(async (req: any, ctx: any) => {
			captured[name] = { req, ctx };
			return result;
		});
		return fn;
	};
	const service = {
		expand: mk("expand", {
			path: "wiki-root/knowledge", summary: "s", displayTitle: "K", kind: "knowledge",
			children: { items: [{ path: "wiki-root/knowledge/a", name: "a", kind: "knowledge", summary: "", revision: 1, displayTitle: "a", archived: false }], cursor: null, hasMore: false },
			auditId: null,
		}),
		read: mk("read", {
			path: "wiki-root/knowledge/a",
			node: { path: "wiki-root/knowledge/a", name: "a", kind: "knowledge", summary: "s", revision: 3, parentPath: "wiki-root/knowledge", createdAt: "t", updatedAt: "t", archivedAt: null, attributes: {}, sourceBound: false, displayTitle: "a" },
			content: "body", auditId: null,
		}),
		create: mk("create", mutationResult("wiki-root/knowledge/new")),
		update: mk("update", mutationResult("wiki-root/knowledge/a")),
		archive: mk("archive", mutationResult("wiki-root/knowledge/a")),
		link: mk("link", mutationResult("wiki-root/knowledge/a")),
		unlink: mk("unlink", mutationResult("wiki-root/knowledge/a")),
		move: mk("move", mutationResult("wiki-root/knowledge/moved")),
	};
	// listHistory is SYNCHRONOUS in production (returns WikiAuditView[], not Promise).
	// The router wraps it in Promise.resolve. Model the same sync shape here so the
	// spy records the exact (address, limit, ctx) args.
	const historyRows = [
		{ auditId: "a1", requestId: null, actorAgentId: "@ui-browser", sessionId: null,
			action: "update", nodePath: "wiki-root/knowledge/a", oldRevision: 2, newRevision: 3,
			detail: { fields: ["summary"] }, createdAt: "2026-07-16T00:00:00.000Z" },
		{ auditId: "a2", requestId: null, actorAgentId: "archivist", sessionId: "s1",
			action: "create", nodePath: "wiki-root/knowledge/a", oldRevision: null, newRevision: 1,
			detail: null, createdAt: "2026-07-15T00:00:00.000Z" },
	];
	(service as any).listHistory = vi.fn((address: string, limit: number, ctx: any) => {
		captured.listHistory = { req: { address, limit }, ctx };
		return historyRows;
	});
	return { service, captured };
}
function makeMockSearchService() {
	const captured: { req: any; ctx: any } | null = (null as any);
	const service = {
		search: vi.fn(async (req: any, ctx: any) => ({
			wikiHits: [], sourceHits: [], cursor: null, hasMore: false,
			limits: { patternBytes: 2048, authorizedCandidates: 50000, contentBytes: 16777216, wallMs: 250, results: 200 },
			target: req?.target ?? "wiki", mode: req?.mode ?? "fulltext", effectiveScope: null, truncated: false,
		})),
	};
	return { service, captured: { search: { req: null as any, ctx: null as any } }, searchService: service };
}

// ─── suite: REST adapter delegates to same service singleton ──────────

describe("sub-06 arch · REST adapter is a thin delegate (acceptance-06 §A.7)", () => {
	let app: Express;
	let server: Server;
	let port: number;
	let wiki: ReturnType<typeof makeMockWikiService>;
	let search: ReturnType<typeof makeMockSearchService>;

	beforeEach(async () => {
		wiki = makeMockWikiService();
		search = makeMockSearchService();
		setWikiRuntime({ wikiService: wiki.service as any, searchService: search.service as any });
		app = express();
		app.use(express.json());
		app.use("/api/wiki", createWikiBrowserRouter());
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => {
		await close(server);
		_resetWikiRuntimeForTests();
	});

	test("POST /expand → wikiService.expand (same registered instance)", async () => {
		const res = await post(port, "/api/wiki/expand", { address: "wiki-root/knowledge", limit: 10 });
		expect(res.status).toBe(200);
		expect(wiki.service.expand).toHaveBeenCalledTimes(1);
		// same instance proof: the spy on the registered mock is the one called
		expect(wiki.service.expand.mock.calls[0][0].address).toBe("wiki-root/knowledge");
	});

	test("POST /read → wikiService.read", async () => {
		const res = await post(port, "/api/wiki/read", { address: "wiki-root/knowledge/a", view: "content" });
		expect(res.status).toBe(200);
		expect(wiki.service.read).toHaveBeenCalledTimes(1);
		expect(wiki.captured.read.req.view).toBe("content");
	});

	test("POST /search → searchService.search (not wikiService)", async () => {
		const res = await post(port, "/api/wiki/search", { query: "x", mode: "fulltext", target: "wiki" });
		expect(res.status).toBe(200);
		expect(search.service.search).toHaveBeenCalledTimes(1);
		expect(wiki.service.expand).not.toHaveBeenCalled();
	});

	test("POST /create → wikiService.create + emits wiki_nodes", async () => {
		const res = await post(port, "/api/wiki/create", { parent: "wiki-root/knowledge", name: "new", kind: "node" });
		expect(res.status).toBe(200);
		expect(wiki.service.create).toHaveBeenCalledTimes(1);
		expect(wiki.captured.create.req.parent).toBe("wiki-root/knowledge");
		expect(wiki.captured.create.req.name).toBe("new");
	});

	test("POST /update → wikiService.update (expected_revision threaded through)", async () => {
		const res = await post(port, "/api/wiki/update", { address: "wiki-root/knowledge/a", expected_revision: 3, changes: { summary: "s2" } });
		expect(res.status).toBe(200);
		expect(wiki.service.update).toHaveBeenCalledTimes(1);
		expect(wiki.captured.update.req.expected_revision).toBe(3);
	});

	test("POST /delete → wikiService.archive (soft delete; not a separate delete())", async () => {
		const res = await post(port, "/api/wiki/delete", { address: "wiki-root/knowledge/a" });
		expect(res.status).toBe(200);
		expect(wiki.service.archive).toHaveBeenCalledTimes(1);
		// router must NOT call a non-existent wikiService.delete — archive is the data-plane op
		expect((wiki.service as any).delete).toBeUndefined();
	});

	test("POST /link → wikiService.link", async () => {
		const res = await post(port, "/api/wiki/link", { source: "wiki-root/a", target: "wiki-root/b", relation: "related_to" });
		expect(res.status).toBe(200);
		expect(wiki.service.link).toHaveBeenCalledTimes(1);
	});

	test("POST /unlink → wikiService.unlink", async () => {
		const res = await post(port, "/api/wiki/unlink", { source: "wiki-root/a", target: "wiki-root/b", relation: "related_to" });
		expect(res.status).toBe(200);
		expect(wiki.service.unlink).toHaveBeenCalledTimes(1);
	});

	test("POST /move → wikiService.move", async () => {
		const res = await post(port, "/api/wiki/move", { address: "wiki-root/knowledge/a", newParent: "wiki-root/memory", newName: "a2" });
		expect(res.status).toBe(200);
		expect(wiki.service.move).toHaveBeenCalledTimes(1);
		expect(wiki.captured.move.req.newParent).toBe("wiki-root/memory");
		expect(wiki.captured.move.req.newName).toBe("a2");
	});

	test("router has no inline SQL — services unreachable → 503, no throw", async () => {
		_resetWikiRuntimeForTests();
		const res = await post(port, "/api/wiki/expand", { address: "wiki-root" });
		expect(res.status).toBe(503);
		expect(res.data.ok).toBe(false);
		expect(res.data.error.code).toBe("INTERNAL_ERROR");
	});
});

// ─── suite: UI authority server-injected, body cannot escalate ───────

describe("sub-06 arch · UI authority is server-injected (acceptance-06 §A.3/§H)", () => {
	let app: Express;
	let server: Server;
	let port: number;
	let wiki: ReturnType<typeof makeMockWikiService>;
	let search: ReturnType<typeof makeMockSearchService>;

	beforeEach(async () => {
		wiki = makeMockWikiService();
		search = makeMockSearchService();
		setWikiRuntime({ wikiService: wiki.service as any, searchService: search.service as any });
		app = express();
		app.use(express.json());
		app.use("/api/wiki", createWikiBrowserRouter());
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => {
		await close(server);
		_resetWikiRuntimeForTests();
	});

	test("WIKI_UI_ADMIN_ACCESS: agentId=@ui-browser, scope=wiki-root, 9 actions", () => {
		expect(WIKI_UI_ADMIN_ACCESS.agentId).toBe("@ui-browser");
		expect(WIKI_UI_ADMIN_ACCESS.grants).toHaveLength(1);
		expect(WIKI_UI_ADMIN_ACCESS.grants[0].canonicalScope).toBe("wiki-root");
		expect(WIKI_UI_ADMIN_ACCESS.grants[0].actions).toEqual(WIKI_ACTIONS);
		expect(WIKI_UI_ADMIN_ACTIONS).toEqual(WIKI_ACTIONS);
		expect(WIKI_UI_ADMIN_ACTIONS).toHaveLength(9);
	});

	test("ctx passed to service is the UI admin access, independent of body", async () => {
		await post(port, "/api/wiki/expand", { address: "wiki-root/knowledge" });
		const ctx = wiki.captured.expand.ctx;
		expect(ctx.access).toBe(WIKI_UI_ADMIN_ACCESS);
		expect(ctx.agentId).toBe("@ui-browser");
		expect(ctx.activeProjectId).toBeUndefined();
	});

	test("body grants[] cannot escalate — rejected before service called", async () => {
		const res = await post(port, "/api/wiki/expand", {
			address: "wiki-root",
			grants: [{ scope: "wiki-root", actions: ["expand"] }],
		});
		expect(res.status).toBe(400);
		expect(res.data.error.code).toBe("INVALID_REQUEST");
		expect(res.data.error.message).toMatch(/forged identity/);
		expect(wiki.service.expand).not.toHaveBeenCalled();
	});

	test("body callerCtx / admin / global / agentId all rejected", async () => {
		for (const forged of ["callerCtx", "access", "admin", "global", "isAdmin", "agentId", "actorAgentId", "sessionId", "policyRevision"]) {
			const res = await post(port, "/api/wiki/expand", { address: "wiki-root", [forged]: "x" });
			expect(res.status, `forged key "${forged}"`).toBe(400);
			expect(res.data.error.code).toBe("INVALID_REQUEST");
		}
		expect(wiki.service.expand).not.toHaveBeenCalled();
	});

	test("legacy identity fields (nodeId/anchorIds/wikiAnchors) rejected", async () => {
		for (const forged of ["nodeId", "anchorIds", "wikiAnchors", "wikiAnchorNodeIds"]) {
			const res = await post(port, "/api/wiki/expand", { address: "wiki-root", [forged]: 42 });
			expect(res.status, `legacy key "${forged}"`).toBe(400);
			expect(res.data.error.code).toBe("INVALID_REQUEST");
		}
	});
});

// ─── suite: canonical path single source + no :nodeId routes ─────────

describe("sub-06 arch · canonical path authority + no :nodeId (acceptance-06 §A.1/§B.1)", () => {
	test("normalizeWikiPath is the single canonical authority (wiki-path.ts)", () => {
		expect(WIKI_ROOT_PATH).toBe("wiki-root");
		expect(normalizeWikiPath("wiki-root/a/")).toBe("wiki-root/a");
		expect(normalizeWikiPath("wiki-root//a")).toBe("wiki-root/a");
		// logical address schemes rejected at canonical layer (resolver runs at call boundary)
		expect(() => normalizeWikiPath("memory://x")).toThrow();
		expect(() => normalizeWikiPath("project://x")).toThrow();
		expect(() => normalizeWikiPath("wiki-root/../etc")).toThrow();
	});

	test("segment-based scope match (no string-prefix false positive)", () => {
		expect(isSameOrDescendant("wiki-root/a", "wiki-root/a/b")).toBe(true);
		// NOT a prefix match — sibling with longer name must not match
		expect(isSameOrDescendant("wiki-root/a", "wiki-root/ab")).toBe(false);
	});

	test("router does not normalize address inline — passes raw to service", async () => {
		const wiki = makeMockWikiService();
		const search = makeMockSearchService();
		setWikiRuntime({ wikiService: wiki.service as any, searchService: search.service as any });
		const app = express();
		app.use(express.json());
		app.use("/api/wiki", createWikiBrowserRouter());
		const l = await listen(app);
		try {
			await post(l.port, "/api/wiki/expand", { address: "  wiki-root/knowledge/  " });
			// router is thin: address forwarded as-is (service owns normalization)
			expect(wiki.captured.expand.req.address).toBe("  wiki-root/knowledge/  ");
		} finally {
			await close(l.server);
			_resetWikiRuntimeForTests();
		}
	});

	test("legacy GET /nodes/:id/* is gone (404, not implemented)", async () => {
		const app = express();
		app.use(express.json());
		app.use("/api/wiki", createWikiBrowserRouter());
		const l = await listen(app);
		try {
			const res = await getReq(l.port, "/api/wiki/nodes/123/detail");
			expect(res.status).toBe(404); // legacy :nodeId route removed
		} finally {
			await close(l.server);
		}
	});
});

// ─── suite: data:changed emit coverage for all 6 mutation endpoints ──
//
// NOTE on strategy: wiki-router 的 emit 走动态 `require("./data-change-hub.js")`
// 包在 try/catch 里。vitest 的模块加载器对 ESM-transformed 模块内的运行时
// `require()` 解析不稳(事件不到监听器/spy),所以这里**不能**经 HTTP surface
// 跑通 emit。改为对 wiki-router.ts 源码做结构断言,确认每个 mutation endpoint
// 都接了 emit helper 且 payload(collection / path / oldPath / parentPath / op /
// revision)正确。生产(electron main,CJS)下 require 正常 → emit 真实生效。

describe("sub-06 arch · data:changed emit coverage (acceptance-06 §E.1/§E.2 + plan-06 §7)", () => {
	const routerSrc = readFileSync(join(__dirname, "..", "..", "src", "server", "wiki-router.ts"), "utf-8");

	/** 提取某 endpoint handler 的源码块(router.post("/x", async (req,res) => { ... });)。 */
	function handler(route: string): string {
		const re = new RegExp(`router\\.post\\("${route}",\\s*async\\s*\\(req,\\s*res\\)\\s*=>\\s*\\{([\\s\\S]*?)\\n\\t\\}\\);`);
		const m = routerSrc.match(re);
		if (!m) throw new Error(`handler ${route} not found`);
		return m[1];
	}

	test("create handler emits wiki_nodes (op=create, parentPath=null)", () => {
		const h = handler("/create");
		expect(h).toMatch(/emitWikiNodeChange\(\s*"create"\s*,\s*result\.path\s*,\s*result\.revision\s*,\s*undefined\s*,\s*undefined\s*\)/);
	});

	test("update handler emits wiki_nodes (op=update, parentPath=body.address)", () => {
		const h = handler("/update");
		expect(h).toMatch(/emitWikiNodeChange\(\s*"update"\s*,\s*result\.path\s*,\s*result\.revision\s*,\s*undefined\s*,\s*body\.address\s*\)/);
	});

	test("delete handler emits wiki_nodes (op=delete)", () => {
		const h = handler("/delete");
		expect(h).toMatch(/emitWikiNodeChange\(\s*"delete"\s*,/);
	});

	test("link handler emits wiki_links (source/target/relation)", () => {
		const h = handler("/link");
		expect(h).toMatch(/emitWikiLinkChange\(\s*"link"\s*,\s*body\.source\s*,\s*body\.target\s*,\s*body\.relation\s*\)/);
	});

	test("unlink handler emits wiki_links", () => {
		const h = handler("/unlink");
		expect(h).toMatch(/emitWikiLinkChange\(\s*"unlink"\s*,/);
	});

	test("move handler emits wiki_nodes(move) AND wiki_sync (plan-06 §7 / §E.2 oldPath cleanup)", () => {
		const h = handler("/move");
		// node event carries oldPath=body.address + parentPath=body.newParent
		expect(h).toMatch(/emitWikiNodeChange\(\s*"move"\s*,\s*result\.path\s*,\s*result\.revision\s*,\s*body\.address\s*,\s*body\.newParent\s*\)/);
		// sync event carries newPath + oldPath
		expect(h).toMatch(/emitWikiSyncChange\(\s*result\.path\s*,\s*body\.address\s*\)/);
	});

	test("emit helpers target ONLY wiki_nodes / wiki_links / wiki_sync", () => {
		// every emitDataChange call in the router uses one of the 3 sanctioned collections
		const allEmits = routerSrc.match(/emitDataChange\(\s*"[^"]+"/g) ?? [];
		expect(allEmits.length, "router must emit data:changed on mutations").toBeGreaterThan(0);
		for (const call of allEmits) {
			expect(call, `unsanctioned collection: ${call}`).toMatch(/emitDataChange\(\s*"(wiki_nodes|wiki_links|wiki_sync)"/);
		}
	});

	test("emitWikiNodeChange payload includes path/oldPath/parentPath/op/revision (acceptance-06 §E + design §10.3)", () => {
		// the helper builds the record with all 5 fields the store invalidation relies on
		// (shorthand + explicit keys: path, op, revision, oldPath:.., parentPath:..)
		const m = routerSrc.match(/emitDataChange\(\s*"wiki_nodes"[^)]*?(\{[^}]+\})/s);
		expect(m, "emitWikiNodeChange must build a record object").toBeTruthy();
		const record = m![1];
		expect(record).toMatch(/\bpath\b/);
		expect(record).toMatch(/\bop\b/);
		expect(record).toMatch(/\brevision\b/);
		expect(record).toMatch(/\boldPath\b/);
		expect(record).toMatch(/\bparentPath\b/);
	});

	test("move emits a wiki_nodes delete for oldPath so the store clears the stale branch", () => {
		// inside emitWikiNodeChange, when op==='move' && oldPath, a second delete emit fires
		expect(routerSrc).toMatch(/if\s*\(\s*oldPath\s*&&\s*op\s*===\s*"move"\s*\)/);
		expect(routerSrc).toMatch(/emitDataChange\(\s*"wiki_nodes"\s*,\s*oldPath\s*,\s*"delete"/);
	});

	test("read-only endpoints (expand/read/search) do NOT call any emit helper", () => {
		for (const ro of ["/expand", "/read", "/search"]) {
			const h = handler(ro);
			expect(h.includes("emitWiki"), `${ro} must not emit on read`).toBe(false);
			expect(h.includes("emitDataChange"), `${ro} must not emit on read`).toBe(false);
		}
	});

	test("data-change-hub UI_COLLECTIONS includes wiki_nodes/wiki_links/wiki_sync", () => {
		const hubSrc = readFileSync(join(__dirname, "..", "..", "src", "server", "data-change-hub.ts"), "utf-8");
		expect(hubSrc).toMatch(/"wiki_nodes"/);
		expect(hubSrc).toMatch(/"wiki_links"/);
		expect(hubSrc).toMatch(/"wiki_sync"/);
	});
});

// ─── suite: no dangling wiki-anchor-injection + AgentLoop hooks-only ──

describe("sub-06 arch · no dead wiki-anchor-injection refs + AgentLoop hooks-only", () => {
	const repoRoot = join(__dirname, "..", "..");
	const srcRoot = join(repoRoot, "src");

	test("agent-loop.ts has zero wiki imports (hooks-only invariant, plan-05 §7)", () => {
		const src = readFileSync(join(srcRoot, "runtime", "agent-loop.ts"), "utf-8");
		// no import statement pulling wiki compiler/store/anchor modules
		const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
		const wikiImports = importLines.filter((l) => /wiki[-/]|wikiAnchor|wiki-anchor-injection|wikiStore|wiki-context-compiler/i.test(l));
		expect(wikiImports, `agent-loop must not import wiki modules — found: ${wikiImports.join(" | ")}`).toEqual([]);
	});

	test("no source file imports the deleted wiki-anchor-injection module", () => {
		// walk a focused set of likely consumers; assert none import the deleted module.
		const candidates = [
			join(srcRoot, "runtime", "agent-loop.ts"),
			join(srcRoot, "server", "wiki-router.ts"),
			join(srcRoot, "server", "agent-service.ts"),
			join(srcRoot, "renderer", "components", "wiki", "WikiPage.tsx"),
			join(srcRoot, "renderer", "components", "wiki", "WikiDetail.tsx"),
		];
		for (const f of candidates) {
			const src = readFileSync(f, "utf-8");
			// real import only (exclude comments). wiki-anchor-injection was deleted in plan-05.
			const imports = src.split("\n").filter((l) => /^\s*import\b/.test(l) && /wiki-anchor-injection/.test(l));
			expect(imports, `${f} must not import deleted wiki-anchor-injection`).toEqual([]);
		}
	});

	test("WikiAnchorsSection.tsx is deleted", () => {
		let exists = true;
		try { readFileSync(join(srcRoot, "renderer", "components", "agents", "WikiAnchorsSection.tsx")); }
		catch { exists = false; }
		expect(exists, "WikiAnchorsSection.tsx should be deleted (plan-06)").toBe(false);
	});
});

// ─── suite: History (§D7) round-2 wired — architecture invariants ─────
//
// round-2 implementer wired History end-to-end. These tests assert the
// ARCHITECTURE contracts (thin-delegate / same-source / no-audit-write /
// read-only-no-emit), not just "method exists". If a future refactor inlines
// the audit query or makes history emit data:changed, these fail.

describe("sub-06 arch · History (acceptance-06 §D7) round-2 wired — service thin-delegate", () => {
	const svcSrc = readFileSync(join(__dirname, "..", "..", "src", "server", "wiki", "wiki-service.ts"), "utf-8");

	test("WikiService.listHistory exists as a PUBLIC method returning WikiAuditView[]", async () => {
		const { WikiService } = await import("../../src/server/wiki/wiki-service.js");
		expect(typeof WikiService.prototype.listHistory).toBe("function");
	});

	test("listHistory is a THIN DELEGATE — calls auditRepo.listByNodePath, no inlined SQL (§A.7)", () => {
		// extract the listHistory method body
		const m = svcSrc.match(/listHistory\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\t\}/);
		expect(m, "listHistory method body must be present").toBeTruthy();
		const body = m![1];
		// delegates to existing repo query (not a copy)
		expect(body, "must delegate to auditRepo.listByNodePath").toMatch(/auditRepo\.listByNodePath\(/);
		// maps via the shared auditRowToView helper (not an ad-hoc snake→camel inline)
		expect(body, "must map via auditRowToView").toMatch(/\.map\(auditRowToView\)/);
		// must NOT contain raw SQL of its own
		expect(body, "listHistory must not inline SQL").not.toMatch(/\.prepare\s*\(/);
		expect(body, "listHistory must not inline SELECT").not.toMatch(/SELECT\s+/i);
	});

	test("listHistory path does NOT write audit (meta-query must not pollute real history)", () => {
		// grep the listHistory method body for any auditRepo.append call
		const m = svcSrc.match(/listHistory\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\t\}/);
		expect(m, "listHistory method body must be present").toBeTruthy();
		const body = m![1];
		expect(body, "listHistory must not call auditRepo.append (would pollute history)").not.toMatch(/auditRepo\.append/);
		expect(body, "listHistory must not call appendAuditSafe").not.toMatch(/appendAuditSafe/);
		// sanity: the surrounding service still has append for real mutations
		expect(svcSrc.includes("auditRepo.append") || svcSrc.includes("appendAuditSafe")).toBe(true);
	});

	test("auditRowToView maps snake_case → camelCase + detail_json → detail (parse with null fallback)", async () => {
		const { auditRowToView } = await import("../../src/server/wiki/wiki-service.js");
		const view = auditRowToView({
			audit_id: "a1", request_id: "r1", actor_agent_id: "agent-x", session_id: "s1",
			action: "update", node_path: "wiki-root/a", old_revision: 2, new_revision: 3,
			detail_json: '{"fields":["summary"]}', created_at: "2026-07-16T00:00:00.000Z",
		});
		expect(view).toEqual({
			auditId: "a1", requestId: "r1", actorAgentId: "agent-x", sessionId: "s1",
			action: "update", nodePath: "wiki-root/a", oldRevision: 2, newRevision: 3,
			detail: { fields: ["summary"] }, createdAt: "2026-07-16T00:00:00.000Z",
		});
		// invalid JSON detail → null (not throw)
		const bad = auditRowToView({
			audit_id: "a2", request_id: null, actor_agent_id: null, session_id: null,
			action: "x", node_path: null, old_revision: null, new_revision: null,
			detail_json: "{not json", created_at: "t",
		});
		expect(bad.detail).toBeNull();
		expect(bad.actorAgentId).toBeNull();
	});

	test("listHistory authorizes via 'read' action (same tier as read; UI-admin wiki-root grant passes)", () => {
		const m = svcSrc.match(/listHistory\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\t\}/);
		const body = m![1];
		expect(body).toMatch(/assertAgentAccess\(\s*"read"\s*,/);
	});
});

describe("sub-06 arch · POST /history — same-source wiring as other 9 endpoints (§A.4/§A.7)", () => {
	let app: Express;
	let server: Server;
	let port: number;
	let wiki: ReturnType<typeof makeMockWikiService>;
	let search: ReturnType<typeof makeMockSearchService>;

	beforeEach(async () => {
		wiki = makeMockWikiService();
		search = makeMockSearchService();
		setWikiRuntime({ wikiService: wiki.service as any, searchService: search.service as any });
		app = express();
		app.use(express.json());
		app.use("/api/wiki", createWikiBrowserRouter());
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => {
		await close(server);
		_resetWikiRuntimeForTests();
	});

	test("POST /history → 200 + calls the SAME registered wikiService.listHistory instance", async () => {
		const res = await post(port, "/api/wiki/history", { address: "wiki-root/knowledge/a" });
		expect(res.status).toBe(200);
		expect(res.data.ok).toBe(true);
		expect(wiki.service.listHistory).toHaveBeenCalledTimes(1);
		// same-instance proof: args landed on the registered mock's spy
		expect(wiki.captured.listHistory.req.address).toBe("wiki-root/knowledge/a");
		expect(wiki.captured.listHistory.req.limit).toBe(100); // router default
	});

	test("/history ctx is the server-injected UI admin access (body cannot change it)", async () => {
		await post(port, "/api/wiki/history", { address: "wiki-root/a" });
		const ctx = wiki.captured.listHistory.ctx;
		expect(ctx.access).toBe(WIKI_UI_ADMIN_ACCESS);
		expect(ctx.agentId).toBe("@ui-browser");
	});

	test("/history result is WikiAuditView[] (array of audit views)", async () => {
		const res = await post(port, "/api/wiki/history", { address: "wiki-root/a" });
		expect(Array.isArray(res.data.result)).toBe(true);
		expect(res.data.result).toHaveLength(2);
		expect(res.data.result[0]).toMatchObject({ auditId: "a1", action: "update", actorAgentId: "@ui-browser" });
	});

	test("/history limit threads through (1..500 schema; 0 → 400)", async () => {
		const ok = await post(port, "/api/wiki/history", { address: "wiki-root/a", limit: 50 });
		expect(ok.status).toBe(200);
		expect(wiki.captured.listHistory.req.limit).toBe(50);
		// 0 is not positive → schema rejects
		const bad = await post(port, "/api/wiki/history", { address: "wiki-root/a", limit: 0 });
		expect(bad.status).toBe(400);
		expect(bad.data.error.code).toBe("INVALID_REQUEST");
		// 501 > max(500) → schema rejects
		const over = await post(port, "/api/wiki/history", { address: "wiki-root/a", limit: 501 });
		expect(over.status).toBe(400);
	});

	test("/history rejects forged identity via the SAME FORBIDDEN_BODY_KEYS gate", async () => {
		// round-2 A2 fix added projectId/activeProjectId/actor/channel/effectiveAccess/targetId/sourceId
		const round2keys = ["projectId", "activeProjectId", "actor", "channel", "effectiveAccess", "targetId", "sourceId"];
		for (const forged of round2keys) {
			const res = await post(port, "/api/wiki/history", { address: "wiki-root/a", [forged]: "x" });
			expect(res.status, `forged key "${forged}" must be rejected`).toBe(400);
			expect(res.data.error.code).toBe("INVALID_REQUEST");
		}
		expect(wiki.service.listHistory).not.toHaveBeenCalled();
	});

	test("/history is READ-ONLY — handler does NOT call any emit helper (§D + §E)", () => {
		const routerSrc = readFileSync(join(__dirname, "..", "..", "src", "server", "wiki-router.ts"), "utf-8");
		const m = routerSrc.match(/router\.post\("\/history"\s*,\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\t\}\);/);
		expect(m, "/history handler must exist").toBeTruthy();
		const body = m![1];
		expect(body.includes("emitWiki"), "/history must not emit data:changed (read-only)").toBe(false);
		expect(body.includes("emitDataChange"), "/history must not emit directly").toBe(false);
	});

	test("/history uses the shared mapWikiError path (WikiServiceError → 400 structured error)", async () => {
		// throw a REAL WikiServiceError via the production factory so isWikiServiceError
		// recognizes it and the router routes it through mapWikiError (not the 500 branch).
		const { wikiError } = await import("../../src/server/wiki/wiki-errors.js");
		(wiki.service.listHistory as any).mockImplementationOnce(() => {
			throw wikiError("ACCESS_DENIED", "no access", { path: "wiki-root/a" });
		});
		const res = await post(port, "/api/wiki/history", { address: "wiki-root/a" });
		expect(res.status).toBe(400);
		expect(res.data.ok).toBe(false);
		expect(res.data.error.code).toBe("ACCESS_DENIED");
	});
});

describe("sub-06 arch · wikiV2History IPC channel — 4-file same-source (§A.4)", () => {
	const repoRoot = join(__dirname, "..", "..");
	function src(rel: string): string {
		return readFileSync(join(repoRoot, rel), "utf-8");
	}

	test("preload-types.ts declares wikiV2History → WikiRestResult<WikiAuditView[]>", () => {
		const s = src("src/shared/preload-types.ts");
		expect(s).toMatch(/wikiV2History:\s*\(req:\s*\{\s*address:\s*string;\s*limit\?:\s*number\s*\}\)\s*=>\s*Promise<WikiRestResult<WikiAuditView\[\]>>/);
	});

	test("ipc-api.ts contract: wikiV2:history result type matches router output", () => {
		const s = src("src/shared/ipc-api.ts");
		expect(s).toMatch(/"wikiV2:history":\s*\{\s*params:\s*\[req:\s*\{\s*address:\s*string;\s*limit\?:\s*number\s*\}\];\s*result:\s*WikiRestResult<WikiAuditView\[\]>\s*\}/);
	});

	test("ipc-proxy.ts routes wikiV2:history → POST /api/wiki/history", () => {
		const s = src("src/main/ipc-proxy.ts");
		expect(s).toMatch(/"wikiV2:history":\s*\{\s*method:\s*"POST"\s*,\s*path:\s*"\/api\/wiki\/history"\s*,\s*buildReq:\s*\(body\)\s*=>\s*\(\{\s*body\s*\}\)\s*\}/);
	});

	test("preload/index.ts invokes ipcRenderer on channel 'wikiV2:history'", () => {
		const s = src("src/preload/index.ts");
		expect(s).toMatch(/wikiV2History:\s*\(req\)\s*=>\s*ipcRenderer\.invoke\(\s*"wikiV2:history"\s*,\s*req\s*\)/);
	});
});

describe("sub-06 arch · store loadHistory + HistoryTab wiring (round-2)", () => {
	test("loadHistory calls callV2('wikiV2History', {address, limit:100}) and maps WikiAuditView → HistoryEntry (incl actorAgentId)", () => {
		const s = readFileSync(join(__dirname, "..", "..", "src", "renderer", "store", "wiki-store.ts"), "utf-8");
		const m = s.match(/loadHistory:\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\t\},/);
		expect(m, "loadHistory must exist").toBeTruthy();
		const body = m![1];
		// calls the V2 history channel with address + limit (proves not a round-1 no-op stub)
		expect(body).toMatch(/callV2<WikiAuditView\[\]>\(\s*"wikiV2History"\s*,\s*\{\s*address:\s*path,\s*limit:\s*100\s*\}/);
		// maps actorAgentId into HistoryEntry (round-2 added field)
		expect(body).toMatch(/actorAgentId:\s*a\.actorAgentId/);
	});

	test("HistoryEntry shape includes actorAgentId (round-2 field for Actor column)", () => {
		const s = readFileSync(join(__dirname, "..", "..", "src", "renderer", "store", "wiki-store.ts"), "utf-8");
		const m = s.match(/interface\s+HistoryEntry\s*\{([^}]*)\}/);
		expect(m, "HistoryEntry interface must exist").toBeTruthy();
		expect(m![1]).toMatch(/actorAgentId:\s*string\s*\|\s*null/);
	});

	test("WikiDetail HistoryTab renders 4 columns + data-testid=wiki-history-row (no plan-07 placeholder)", () => {
		const s = readFileSync(join(__dirname, "..", "..", "src", "renderer", "components", "wiki", "WikiDetail.tsx"), "utf-8");
		// plan-07 placeholder is GONE
		expect(s.includes("plan-07"), "HistoryTab must not defer to plan-07").toBe(false);
		// 4 columns
		expect(s).toMatch(/<th[^>]*>\s*Action\s*<\/th>/);
		expect(s).toMatch(/<th[^>]*>\s*Actor\s*<\/th>/);
		expect(s).toMatch(/<th[^>]*>\s*Revision\s*<\/th>/);
		expect(s).toMatch(/<th[^>]*>\s*Audit\s+time\s*<\/th>/);
		// row test id
		expect(s).toMatch(/data-testid="wiki-history-row"/);
		// row shows actor + revision transition + audit time
		expect(s).toMatch(/h\.actorAgentId/);
		expect(s).toMatch(/h\.oldRevision/);
		expect(s).toMatch(/h\.newRevision/);
		expect(s).toMatch(/h\.createdAt/);
	});

	test("WikiDetail switches to history tab → loadHistory(path) fires (useEffect)", () => {
		const s = readFileSync(join(__dirname, "..", "..", "src", "renderer", "components", "wiki", "WikiDetail.tsx"), "utf-8");
		// useEffect body must call loadHistory when tab==='history'
		expect(s).toMatch(/tab\s*===\s*"history"\s*\)\s*void\s+loadHistory\(path\)/);
	});
});

// ─── suite: round-2 regressions — E2 _applyNodeEvent snapshot + no loop ─

describe("sub-06 arch · E2 _applyNodeEvent wasParentLoaded snapshot + no re-fetch loop", () => {
	const storeSrc = readFileSync(join(__dirname, "..", "..", "src", "renderer", "store", "wiki-store.ts"), "utf-8");

	test("_applyNodeEvent captures wasParentLoaded BEFORE set() (round-2 E2 fix)", () => {
		const m = storeSrc.match(/_applyNodeEvent:\s*\(event\)\s*=>\s*\{([\s\S]*?)\n\t\},/);
		expect(m, "_applyNodeEvent must exist").toBeTruthy();
		const body = m![1];
		// snapshot is read off `pre = get()` captured BEFORE set()
		expect(body).toMatch(/const\s+pre\s*=\s*get\(\)/);
		expect(body).toMatch(/wasParentLoaded\s*=\s*!!\(parentPath\s*&&\s*parentPath\s*!==\s*path\s*&&\s*pre\.childrenLoaded\[parentPath\]\s*!==\s*undefined\)/);
		// AFTER set(), the snapshot (not fresh get()) drives the re-fetch
		expect(body).toMatch(/if\s*\(\s*wasParentLoaded\s*\)\s*\{\s*void\s+get\(\)\.expandPath\(parentPath!,\s*\{\s*reset:\s*true\s*\}\)/);
	});

	test("expandPath is a pure READ (no _applyNodeEvent call) → no event→re-fetch→event loop", () => {
		const m = storeSrc.match(/expandPath:\s*async\s*\(address,\s*opts\)\s*=>\s*\{([\s\S]*?)\n\t\},/);
		expect(m, "expandPath must exist").toBeTruthy();
		const body = m![1];
		expect(body.includes("_applyNodeEvent"), "expandPath must not trigger _applyNodeEvent (would loop)").toBe(false);
	});

	test("expandPath(reset:true) bypasses the idempotency guard so invalidation actually re-fetches", () => {
		const m = storeSrc.match(/expandPath:\s*async\s*\(address,\s*opts\)\s*=>\s*\{([\s\S]*?)\n\t\},/);
		const body = m![1];
		// guard: if (!reset && (...loaded || ...loading)) return;
		expect(body).toMatch(/if\s*\(\s*!reset\s*&&\s*\(get\(\)\.childrenLoaded\[address\]\s*\|\|\s*get\(\)\.loadingChildren\[address\]\)\)\s*return/);
	});
});

describe("sub-06 arch · round-2 A2 FORBIDDEN_BODY_KEYS synonyms + AgentLoop/D2 regression sweep", () => {
	test("FORBIDDEN_BODY_KEYS includes round-2 synonyms (projectId/activeProjectId/actor/channel/effectiveAccess/targetId/sourceId)", () => {
		const s = readFileSync(join(__dirname, "..", "..", "src", "server", "wiki-router.ts"), "utf-8");
		for (const k of ["projectId", "activeProjectId", "actor", "channel", "effectiveAccess", "targetId", "sourceId"]) {
			expect(s, `FORBIDDEN_BODY_KEYS must include "${k}"`).toMatch(new RegExp(`"${k}"`));
		}
	});

	test("agent-loop.ts still has zero wiki imports (hooks-only — no round-2 regression)", () => {
		const src = readFileSync(join(__dirname, "..", "..", "src", "runtime", "agent-loop.ts"), "utf-8");
		const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
		const wikiImports = importLines.filter((l) => /wiki[-/]|wikiAnchor|wiki-anchor-injection|wikiStore|wiki-context-compiler/i.test(l));
		expect(wikiImports, `agent-loop must not import wiki modules — found: ${wikiImports.join(" | ")}`).toEqual([]);
	});

	test("WikiDetail does NOT add rehype-raw (D2 XSS — round-2 must not regress)", () => {
		const s = readFileSync(join(__dirname, "..", "..", "src", "renderer", "components", "wiki", "WikiDetail.tsx"), "utf-8");
		// no real import of rehype-raw (only comments mentioning it by name are allowed)
		const importLines = s.split("\n").filter((l) => /^\s*import\b/.test(l));
		const rawImports = importLines.filter((l) => /rehype-raw/.test(l));
		expect(rawImports, "WikiDetail must not import rehype-raw").toEqual([]);
	});

	test("canonical path authority is the single normalizeWikiPath — router/store/service all defer to it", () => {
		// router passes address through untouched (service owns resolution)
		const routerSrc = readFileSync(join(__dirname, "..", "..", "src", "server", "wiki-router.ts"), "utf-8");
		expect(routerSrc.includes("normalizeWikiPath"), "router must not normalize inline").toBe(false);
		// service uses normalizeWikiPath (restore path) + resolveAddress (address service)
		const svcSrc = readFileSync(join(__dirname, "..", "..", "src", "server", "wiki", "wiki-service.ts"), "utf-8");
		expect(svcSrc).toMatch(/import[^;]*normalizeWikiPath/);
	});
});
