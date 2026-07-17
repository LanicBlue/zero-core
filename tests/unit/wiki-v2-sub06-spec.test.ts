// wiki-system-redesign sub-06 acceptance — 规约 (spec) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-06 §A-F (Data API + Browser UI)。本文件从**规约**
// 视角逐条断言 plan-06 的数据面契约,所有断言基于:
//   - **真 REST router + 真 WikiService/WikiSearchService**(临时 wiki.db)验
//     §A.1-§A.7/§C.4/§D.3 的 endpoint 结构、伪造身份拒绝、服务复用、regex 错误、
//     expected_revision。
//   - **mocked window.api** 验 §B.1/§B.4/§B.6/§C.1/§E.1/§E.2/§E.3 的 store 行为
//     (canonical-path key / expand 幂等 / archived 默认隐藏 / 搜索参数透传 /
//      move 增量失效)。
//   - **结构/静态断言** 验 §A.4(IPC 类型同源)/§A.6/§A.7(legacy 引用归零)/
//     §D.2(Markdown 不配 rehype-raw)/§D.7(History 缺口)/§D.8(Source-bound 解释)。
//
// ## 独立判定
//   - **§D.7 History**:round-1 FAIL finding(implementer scope-narrowing 把
//     History tab 当 plan-07 stub)。round-2 implementer 修了:
//       (1) WikiService.listHistory 委托 auditRepo.listByNodePath + auditRowToView
//           返回 WikiAuditView[],走 read 授权,不 append audit。
//       (2) POST /api/wiki/history endpoint(historySchema = {address, limit?})。
//       (3) IPC wikiV2History channel + preload/ipc-api 类型同源。
//       (4) store.loadHistory 调 wikiV2History,映射 HistoryEntry,写 historyByPath。
//       (5) WikiDetail HistoryTab 删 plan-07 placeholder,新实现 4 状态 + 4 列表
//           (Action/Actor/Revision/Audit time) + data-testid=wiki-history-row。
//     本文件用 REST 端到端 + 静态结构断言确认修复合规(原 FAIL 测试已过时改写)。
//
// ## 输入
//   - vi.hoisted 唯一 temp ZERO_CORE_DIR(sub-00 教训)。
//   - 每 REST 用例开自己的 mkdtemp 子目录 + wiki.db。
//
// ## 维护规则
//   - 不改实现源;FAIL finding 由 test 文档化,不修 src/。
//   - 只跑本文件(npx vitest run tests/unit/wiki-v2-sub06-spec.test.ts)避免
//     Windows better-sqlite3 teardown crash。
//   - 跨 lens 隔离:文件名 wiki-v2-sub06-spec,不碰 adversarial/arch 文件。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Express } from "express";
import { createServer, type Server } from "http";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-sub06-spec-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import {
	setWikiRuntime,
	_resetWikiRuntimeForTests,
	getWikiService,
	getWikiSearchService,
} from "../../src/server/wiki/wiki-runtime.js";
import { createWikiBrowserRouter } from "../../src/server/wiki-router.js";

// Static imports — pulled in only to assert the IPC surface compiles against
// the SAME shared request/result types the router uses (acceptance-06 §A.4).
import type {
	WikiExpandRequest, WikiExpandResult,
	WikiMutationResult,
} from "../../src/shared/wiki-types.js";
import type { WikiSearchRequest, WikiSearchResult } from "../../src/shared/wiki-search-types.js";
import type { IpcChannelDefs, WikiRestResult } from "../../src/shared/ipc-api.js";

// Compile-time same-source check (§A.4): every wikiV2:* channel result is the
// shared WikiRestResult-wrapped view type the REST adapter returns. If the
// preload/ipc-api shape ever drifts from the router result type, these
// assignments fail to compile.
const _a4Expand: IpcChannelDefs["wikiV2:expand"]["result"] = null as unknown as WikiRestResult<WikiExpandResult>;
const _a4Search: IpcChannelDefs["wikiV2:search"]["result"] = null as unknown as WikiRestResult<WikiSearchResult>;
const _a4Update: IpcChannelDefs["wikiV2:update"]["result"] = null as unknown as WikiRestResult<WikiMutationResult>;
const _a4Move: IpcChannelDefs["wikiV2:move"]["result"] = null as unknown as WikiRestResult<WikiMutationResult>;
void _a4Expand; void _a4Search; void _a4Update; void _a4Move;

// ---------------------------------------------------------------------------
// REST harness helpers
// ---------------------------------------------------------------------------

function buildRt(wikiDb: WikiDatabase) {
	const wikiSvc = WikiService.fromDatabase(wikiDb);
	const wdb = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(wdb);
	const repositoryStore = new WikiRepositoryStore(wdb);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const searchSvc = new WikiSearchService({
		db: wdb, nodeRepo, repositoryStore, addressService, authorizationService,
	});
	setWikiRuntime({ wikiService: wikiSvc, searchService: searchSvc });
	return { wikiSvc, searchSvc };
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
async function post(port: number, path: string, body: unknown): Promise<{ status: number; data: any }> {
	const resp = await fetch(`http://localhost:${port}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	try { return { status: resp.status, data: JSON.parse(text) }; }
	catch { return { status: resp.status, data: text }; }
}

// =============================================================================
// §A — API/IPC (REST-level, real services)
// =============================================================================

describe("sub-06 §A API/IPC [spec]", () => {
	let tempDir: string;
	let wiki: WikiDatabase;
	let app: Express;
	let server: Server;
	let port: number;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(UNIQUE_DIR, `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-`));
		wiki = new WikiDatabase(join(tempDir, "wiki.db"));
		buildRt(wiki);
		app = express();
		app.use(express.json());
		app.use("/api/wiki", createWikiBrowserRouter());
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => {
		await close(server);
		_resetWikiRuntimeForTests();
		try { wiki.close(); } catch { /* idempotent */ }
		rmSync(tempDir, { recursive: true, force: true });
	});

	// ── §A.1 九 endpoint 结构化 body/result;路径在 body;无 :nodeId ─────────
	test("A.1 nine endpoints take structured body with address in body, return {ok,result}", async () => {
		// Seed two children under knowledge so expand has something to return.
		await post(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge", name: "alpha", kind: "knowledge", summary: "alpha",
		});
		await post(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge", name: "beta", kind: "knowledge", summary: "beta",
		});

		// expand: path (knowledge root) lives in body.address — NOT a URL segment.
		const expand = await post(port, "/api/wiki/expand", { address: "wiki-root/knowledge" });
		expect(expand.status).toBe(200);
		expect(expand.data.ok).toBe(true);
		expect(Array.isArray(expand.data.result.children.items)).toBe(true);
		expect(expand.data.result.children.items.length).toBe(2);
		// read returns structured view, not a flat string.
		const read = await post(port, "/api/wiki/read", { address: "wiki-root/knowledge/alpha", view: "summary" });
		expect(read.status).toBe(200);
		expect(read.data.ok).toBe(true);
		expect(read.data.result.node.path).toBe("wiki-root/knowledge/alpha");
		// search structured.
		const search = await post(port, "/api/wiki/search", { query: "alpha", target: "wiki" });
		expect(search.status).toBe(200);
		expect(search.data.ok).toBe(true);
	});

	test("A.1 endpoints reject :nodeId-style URL segment routing (only POST body accepted)", async () => {
		// Legacy surface used GET /api/wiki/nodes/:id/detail — that must be gone.
		// A GET to a path-shaped segment under /api/wiki should not be handled by
		// the data-plane router (404, not a wiki result).
		const resp = await fetch(`http://localhost:${port}/api/wiki/nodes/wiki-root%2Fknowledge/detail`);
		expect(resp.status).toBe(404);
	});

	// ── §A.2 伪造身份字段被拒 ───────────────────────────────────────────────
	test("A.2 forged identity fields (callerCtx/grants/agentId/admin/global/nodeId) → 400 INVALID_REQUEST", async () => {
		const forged: Record<string, unknown>[] = [
			{ address: "wiki-root", grants: [{ scope: "wiki-root", actions: ["*"] }] },
			{ address: "wiki-root", callerCtx: { agentId: "evil" } },
			{ address: "wiki-root", agentId: "evil-agent" },
			{ address: "wiki-root", admin: true },
			{ address: "wiki-root", global: true },
			{ address: "wiki-root", isAdmin: true },
			{ address: "wiki-root", nodeId: "12345" },
			{ address: "wiki-root", wikiAnchorNodeIds: ["abc"] },
			{ address: "wiki-root", policyRevision: 999 },
			// round-2 (A2 fix):WikiRequestContext / CompiledWikiAccess 同义词也禁。
			// 这些字段是 host 注入身份的载体,renderer 自报一律 INVALID_REQUEST。
			{ address: "wiki-root", projectId: "p1" },
			{ address: "wiki-root", activeProjectId: "p1" },
			{ address: "wiki-root", actor: "@attacker" },
			{ address: "wiki-root", channel: "system" },
			{ address: "wiki-root", effectiveAccess: { agentId: "x" } },
			{ address: "wiki-root", targetId: "42" },
			{ address: "wiki-root", sourceId: "42" },
		];
		for (const body of forged) {
			const res = await post(port, "/api/wiki/expand", body);
			expect(res.status).toBe(400);
			expect(res.data.ok).toBe(false);
			expect(res.data.error.code).toBe("INVALID_REQUEST");
			expect(res.data.error.message).toMatch(/forged identity/i);
		}
	});

	// ── §A.3 server 注入 UI authority;renderer 不能扩权 ───────────────────
	test("A.3 UI authority is server-injected and not overridable from body", async () => {
		// Even if the renderer sends admin:true, the body key is REJECTED before
		// the service is reached (forged-identity guard). The server-side
		// constant covers wiki-root with all 9 actions.
		const { WIKI_UI_ADMIN_ACCESS, WIKI_UI_ADMIN_ACTIONS } = await import("../../src/server/wiki-router.js");
		expect(WIKI_UI_ADMIN_ACCESS.agentId).toBe("@ui-browser");
		expect(WIKI_UI_ADMIN_ACCESS.grants[0].canonicalScope).toBe("wiki-root");
		expect(WIKI_UI_ADMIN_ACTIONS).toEqual([
			"expand", "read", "search", "create", "update", "delete", "link", "unlink", "move",
		]);
		// Attempt to self-grant via body is rejected.
		const res = await post(port, "/api/wiki/expand", {
			address: "wiki-root", admin: true, grants: [{ scope: "wiki-root", actions: ["*"] }],
		});
		expect(res.status).toBe(400);
		expect(res.data.error.code).toBe("INVALID_REQUEST");
	});

	// ── §A.5 REST adapter calls the SAME service singleton (no logic copy) ─
	test("A.5 router resolves the registered service singleton — REST mutation lands in the shared DB", async () => {
		const registered = getWikiService();
		const registeredSearch = getWikiSearchService();
		expect(registered).toBeDefined();
		expect(registeredSearch).toBeDefined();
		// A create via REST must be observable on the SAME wiki.db the registered
		// service owns — proving the router did not spin up a parallel service
		// with copied logic. The shared DB now has one extra node row + audit row.
		const { WikiAuditRepository } = await import("../../src/server/wiki/wiki-audit-repository.js");
		const auditRepo = new WikiAuditRepository(wiki.getDb());
		const auditBefore = auditRepo.count();
		const res = await post(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge", name: "a5-probe", kind: "knowledge",
		});
		expect(res.data.ok).toBe(true);
		// Audit row written through the SAME service the router resolved.
		expect(auditRepo.count()).toBe(auditBefore + 1);
		const auditRows = auditRepo.listByNodePath("wiki-root/knowledge/a5-probe", 10);
		expect(auditRows.some((r) => r.action === "create")).toBe(true);
	});

	// ── §D.3 content edit 必带 expected_revision ────────────────────────────
	test("D.3 update without expected_revision → 400 INVALID_REQUEST (optimistic concurrency enforced at schema)", async () => {
		await post(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge", name: "d3", kind: "knowledge",
		});
		const res = await post(port, "/api/wiki/update", {
			address: "wiki-root/knowledge/d3",
			// expected_revision intentionally OMITTED
			changes: { summary: "new" },
		});
		expect(res.status).toBe(400);
		expect(res.data.ok).toBe(false);
		expect(res.data.error.code).toBe("INVALID_REQUEST");
		expect(res.data.error.message).toMatch(/expected_revision/);
	});

	test("D.3 update with wrong expected_revision → WRITE_CONFLICT (structured error, not silent overwrite)", async () => {
		await post(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge", name: "d3c", kind: "knowledge",
		});
		const res = await post(port, "/api/wiki/update", {
			address: "wiki-root/knowledge/d3c",
			expected_revision: 999, // wrong — fresh node is revision 1
			changes: { summary: "new" },
		});
		expect(res.status).toBe(400);
		expect(res.data.ok).toBe(false);
		expect(res.data.error.code).toBe("WRITE_CONFLICT");
	});

	// ── §C.4 regex invalid → 具体 error,不退化 substring ──────────────────
	test("C.4 invalid regex → REGEX_INVALID (not silently downgraded to substring)", async () => {
		const res = await post(port, "/api/wiki/search", {
			query: "x", mode: "regex", target: "wiki",
		});
		// "x" is a valid regex, so this should succeed. Use an INVALID regex:
		const resBad = await post(port, "/api/wiki/search", {
			query: "(unclosed", mode: "regex", target: "wiki",
		});
		expect(resBad.status).toBe(400);
		expect(resBad.data.ok).toBe(false);
		// Must be a regex-specific code, NOT a quiet substring success.
		expect(["REGEX_INVALID", "REGEX_LIMIT_EXCEEDED", "REGEX_TIMEOUT"]).toContain(resBad.data.error.code);
	});

	// ── §B.7 expand pagination (limit/cursor) ──────────────────────────────
	test("B.7 expand honors limit and returns a cursor for further pages (no unbounded fetch)", async () => {
		// Seed 3 children.
		for (const n of ["p1", "p2", "p3"]) {
			await post(port, "/api/wiki/create", {
				parent: "wiki-root/knowledge", name: n, kind: "knowledge",
			});
		}
		const page1 = await post(port, "/api/wiki/expand", { address: "wiki-root/knowledge", limit: 1 });
		expect(page1.data.ok).toBe(true);
		expect(page1.data.result.children.items.length).toBe(1);
		// hasMore must be true (more siblings exist) — proves the fetch is bounded.
		expect(page1.data.result.children.hasMore).toBe(true);
		expect(page1.data.result.children.cursor).toBeTruthy();
	});

	// ── §A.6/A.7 verify legacy endpoint surface is gone at the router ───────
	test("A.6/A.7 legacy anchor endpoints (/list-by-anchors, /nodes/:id/detail, GET /search) are not mounted", async () => {
		const lb = await post(port, "/api/wiki/list-by-anchors", { anchorIds: ["root"] });
		expect(lb.status).toBe(404);
		const srch = await fetch(`http://localhost:${port}/api/wiki/search?query=x`);
		expect(srch.status).toBe(404); // GET /search removed; search is POST-only now
	});

	// ── §D.7 History end-to-end through the real REST router + service ──────
	// round-2 D7 fix:the strongest proof is the data path itself. expand →
	// create → POST /history must surface the create audit row. This exercises
	// WikiService.listHistory → auditRepo.listByNodePath → auditRowToView end
	// to end through the same router the renderer hits.
	test("D.7 PASS: POST /api/wiki/history returns WikiAuditView[] with action=create row for a freshly-created node", async () => {
		// expand root (proves the parent exists; not strictly required but mirrors
		// the canonical expand → create → read-history user flow).
		const expand = await post(port, "/api/wiki/expand", { address: "wiki-root/knowledge" });
		expect(expand.data.ok).toBe(true);

		// create a node under knowledge.
		const created = await post(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge", name: "d7-e2e", kind: "knowledge", summary: "d7",
		});
		expect(created.data.ok).toBe(true);
		const newPath = "wiki-root/knowledge/d7-e2e";

		// read history for the new node — must include the create audit row.
		const hist = await post(port, "/api/wiki/history", { address: newPath });
		expect(hist.status).toBe(200);
		expect(hist.data.ok).toBe(true);
		expect(Array.isArray(hist.data.result)).toBe(true);
		const rows = hist.data.result as Array<Record<string, unknown>>;
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const createRow = rows.find((r) => r.action === "create");
		expect(createRow).toBeDefined();
		// WikiAuditView shape:auditId / actorAgentId / action / nodePath /
		// oldRevision / newRevision / createdAt — all camelCase from auditRowToView.
		expect(typeof createRow!.auditId).toBe("string");
		expect(createRow!.nodePath).toBe(newPath);
		expect(createRow!.newRevision).toBe(1);

		// history endpoint is read-only:it must NOT itself append an audit row
		// (otherwise the History tab would pollute the very log it displays).
		const hist2 = await post(port, "/api/wiki/history", { address: newPath });
		expect((hist2.data.result as unknown[]).length).toBe(rows.length);

		// history endpoint is read-only in another sense:no data:changed emit
		// (it never subscribes — but more importantly it must not be wired to
		// emitWikiNodeChange; this is asserted structurally elsewhere).
		// limit is honored.
		const histLim = await post(port, "/api/wiki/history", { address: newPath, limit: 1 });
		expect(histLim.data.ok).toBe(true);
		expect((histLim.data.result as unknown[]).length).toBe(1);
	});
});

// =============================================================================
// §B / §C / §E — store behavior (mocked window.api)
// =============================================================================

describe("sub-06 §B/§C/§E store behavior [spec]", () => {
	type ApiCall = { endpoint: string; body: unknown };
	let calls: ApiCall[];
	let notifyErrors: string[];

	beforeEach(() => {
		calls = [];
		notifyErrors = [];
		// Store reads `(window as any).api` and subscribes via
		// `if (typeof window !== "undefined")` at module load. Node test env has
		// no `window` — expose globalThis as window so the store can attach.
		(globalThis as any).window = globalThis;
		const handlers: Record<string, (body: unknown) => Promise<unknown>> = {
			wikiV2Expand: async (body) => {
				const b = body as WikiExpandRequest;
				return {
					ok: true,
					result: {
						path: b.address,
						displayTitle: b.address, kind: "namespace", summary: "",
						children: {
							items: [
								{ path: `${b.address}/child-a`, displayTitle: "A", kind: "knowledge", summary: "", archived: false },
								{ path: `${b.address}/child-b`, displayTitle: "B", kind: "knowledge", summary: "", archived: false },
							],
							cursor: "cur-1", hasMore: true,
						},
					},
				};
			},
			wikiV2Search: async (body) => {
				calls.push({ endpoint: "wikiV2Search", body });
				return { ok: true, result: { wikiHits: [], sourceHits: [], cursor: null, hasMore: false, truncated: false } };
			},
			wikiV2Read: async () => ({ ok: true, result: { node: { path: "x", kind: "node", revision: 1 } } }),
			wikiV2Create: async () => ({ ok: true, result: { success: true, path: "x", revision: 1, auditId: "a" } }),
			wikiV2Update: async () => ({ ok: true, result: { success: true, path: "x", revision: 2, auditId: "a" } }),
			wikiV2Delete: async () => ({ ok: true, result: { success: true, path: "x", revision: 2, auditId: "a" } }),
			wikiV2Link: async () => ({ ok: true, result: { success: true, path: "x", revision: 1, auditId: "a" } }),
			wikiV2Unlink: async () => ({ ok: true, result: { success: true, path: "x", revision: 1, auditId: "a" } }),
			wikiV2Move: async () => ({ ok: true, result: { success: true, path: "x", revision: 1, auditId: "a" } }),
		};
		(window as any).api = new Proxy({}, {
			get: (_t, prop) => {
				if (prop === "onDataChanged") return () => () => { /* unsubscribe noop */ };
				const fn = handlers[prop as string];
				if (!fn) return undefined;
				return fn;
			},
		});
	});

	afterEach(() => {
		delete (globalThis as any).api;
		delete (globalThis as any).window;
	});

	// ── §B.6 archived 默认隐藏 ──────────────────────────────────────────────
	test("B.6 store.showArchived defaults to false", async () => {
		const { useWikiStore } = await import("../../src/renderer/store/wiki-store.js");
		expect(useWikiStore.getState().showArchived).toBe(false);
		useWikiStore.getState().setShowArchived(true);
		expect(useWikiStore.getState().showArchived).toBe(true);
		// reset
		useWikiStore.setState({ showArchived: false });
	});

	// ── §B.1 canonical path is the only key;no DB id flows into state ─────
	test("B.1 expand stores children keyed by canonical path only (no DB id)", async () => {
		const { useWikiStore } = await import("../../src/renderer/store/wiki-store.js");
		await useWikiStore.getState().expandPath("wiki-root/knowledge");
		const s = useWikiStore.getState();
		expect(s.childrenByPath["wiki-root/knowledge"]).toBeDefined();
		expect(s.childrenLoaded["wiki-root/knowledge"]).toBe(true);
		// children items carry path, never a numeric id field surfaced as the key.
		const items = s.childrenByPath["wiki-root/knowledge"].items as any[];
		expect(items.every((i) => typeof i.path === "string")).toBe(true);
	});

	// ── §B.4 expand 幂等:重复展开不重复请求 ─────────────────────────────────
	test("B.4 second expandPath (no reset) does NOT trigger a second IPC call", async () => {
		const { useWikiStore } = await import("../../src/renderer/store/wiki-store.js");
		await useWikiStore.getState().expandPath("wiki-root/knowledge");
		// Replace the handler to count.
		let expandCount = 0;
		const orig = (window as any).api;
		(window as any).api = new Proxy({}, {
			get: (_t, prop) => {
				if (prop === "onDataChanged") return () => () => {};
				if (prop === "wikiV2Expand") return async (b: unknown) => { expandCount++; return orig.wikiV2Expand(b); };
				return (orig as any)[prop];
			},
		});
		await useWikiStore.getState().expandPath("wiki-root/knowledge"); // no reset
		expect(expandCount).toBe(0);
		// reset:true DOES re-fetch.
		await useWikiStore.getState().expandPath("wiki-root/knowledge", { reset: true });
		expect(expandCount).toBe(1);
	});

	// ── §C.1 search controls 实传后端 ───────────────────────────────────────
	test("C.1 runSearch forwards mode/target/caseSensitive/fields/kinds/limit to the backend", async () => {
		const { useWikiStore } = await import("../../src/renderer/store/wiki-store.js");
		await useWikiStore.getState().runSearch({
			query: "AgentLoop",
			mode: "regex",
			target: "both",
			caseSensitive: true,
			fields: ["name", "content"],
			kinds: ["source_file"],
			limit: 50,
			cursor: null,
			scope: null,
		} as WikiSearchRequest);
		expect(calls.length).toBe(1);
		const sent = calls[0].body as WikiSearchRequest;
		expect(sent.mode).toBe("regex");
		expect(sent.target).toBe("both");
		expect(sent.caseSensitive).toBe(true);
		expect(sent.fields).toEqual(["name", "content"]);
		expect(sent.kinds).toEqual(["source_file"]);
		expect(sent.limit).toBe(50);
	});

	// ── §E.1/§E.2 move invalidates oldPath + both parents ─────────────────
	test("E.1/E.2 _applyNodeEvent(move) clears oldPath subtree cache and invalidates old + new parent", async () => {
		const { useWikiStore } = await import("../../src/renderer/store/wiki-store.js");
		// Simulate loaded state for old subtree + both parents.
		useWikiStore.setState({
			childrenLoaded: {
				"wiki-root/projects/p": true,
				"wiki-root/projects/p/src": true,
				"wiki-root/projects/p/src/old": true,
				"wiki-root/projects/p/tests": true,
			},
			childrenByPath: {
				"wiki-root/projects/p/src": { items: [], cursor: null, hasMore: false },
				"wiki-root/projects/p/src/old": { items: [], cursor: null, hasMore: false },
				"wiki-root/projects/p/tests": { items: [], cursor: null, hasMore: false },
			},
			summaryByPath: {
				"wiki-root/projects/p/src/old": { displayTitle: "old", kind: "directory", summary: "" },
			},
			detailByPath: { "wiki-root/projects/p/src/old": { node: { path: "x", kind: "node", revision: 1 } } },
		});
		// move: oldPath = wiki-root/projects/p/src/old, newPath = wiki-root/projects/p/tests/old,
		//        new parent = wiki-root/projects/p/tests, old parent = wiki-root/projects/p/src.
		// router emits parentPath = new parent (body.newParent).
		useWikiStore.getState()._applyNodeEvent({
			path: "wiki-root/projects/p/tests/old",
			op: "move",
			oldPath: "wiki-root/projects/p/src/old",
			parentPath: "wiki-root/projects/p/tests",
		});
		const s = useWikiStore.getState();
		// oldPath subtree cache cleared.
		expect(s.childrenByPath["wiki-root/projects/p/src/old"]).toBeUndefined();
		expect(s.summaryByPath["wiki-root/projects/p/src/old"]).toBeUndefined();
		expect(s.detailByPath["wiki-root/projects/p/src/old"]).toBeUndefined();
		// OLD parent invalidated (key removed → falsy;tree re-fetches on render).
		expect(s.childrenLoaded["wiki-root/projects/p/src"]).toBeFalsy();
		expect(s.childrenByPath["wiki-root/projects/p/src"]).toBeUndefined();
		// NEW parent invalidated.
		expect(s.childrenLoaded["wiki-root/projects/p/tests"]).toBeFalsy();
		expect(s.childrenByPath["wiki-root/projects/p/tests"]).toBeUndefined();
	});

	// ── §E.3 未展开 branch 收 event 不 fetch ────────────────────────────────
	test("E.3 _applyNodeEvent for an unloaded parent does not schedule a fetch (no auto-pull)", async () => {
		const { useWikiStore } = await import("../../src/renderer/store/wiki-store.js");
		// parent never loaded → childrenLoaded[parent] === undefined
		let expandCount = 0;
		const orig = (window as any).api;
		(window as any).api = new Proxy({}, {
			get: (_t, prop) => {
				if (prop === "onDataChanged") return () => () => {};
				if (prop === "wikiV2Expand") return async (b: unknown) => { expandCount++; return orig.wikiV2Expand(b); };
				return (orig as any)[prop];
			},
		});
		useWikiStore.getState()._applyNodeEvent({
			path: "wiki-root/knowledge/never-loaded-child",
			op: "update",
			oldPath: null,
			parentPath: "wiki-root/knowledge/never-loaded-parent",
		});
		expect(expandCount).toBe(0);
	});
});

// =============================================================================
// §A.6/§A.7/§D.2/§D.7/§D.8 — structural/static assertions
// =============================================================================

describe("sub-06 structural assertions [spec]", () => {
	// ── §A.6/§A.7 legacy renderer references = 0 ───────────────────────────
	test("A.6/A.7 wiki-store subscribes only to wiki_nodes/wiki_links/wiki_sync (project_wiki dropped)", async () => {
		const src = readFileSync(join(process.cwd(), "src/renderer/store/wiki-store.ts"), "utf-8");
		// production subscription filter only allows the 3 new collections.
		expect(src).toMatch(/collection !== "wiki_nodes" && collection !== "wiki_links" && collection !== "wiki_sync"/);
		// no legacy wiki IPC channel producers remain in the store.
		expect(src).not.toMatch(/wikiGetChildren|wikiReadDetail|wiki:listByProject|wiki:getNode|wiki:readDetail/);
		expect(src).not.toMatch(/\/api\/project-wiki/);
	});

	test("A.6 createWikiRouter (legacy factory) is gone; new export is createWikiBrowserRouter", async () => {
		const routerModule = await import("../../src/server/wiki-router.js");
		expect(typeof routerModule.createWikiBrowserRouter).toBe("function");
		expect((routerModule as any).createWikiRouter).toBeUndefined();
	});

	test("A.6 wiki-anchor-injection.ts + WikiAnchorsSection.tsx deleted", async () => {
		let anchorInjectionExists = true;
		let anchorsSectionExists = true;
		try { await import("../../src/runtime/wiki-anchor-injection.js"); } catch { anchorInjectionExists = false; }
		try { await import("../../src/renderer/components/agents/WikiAnchorsSection.js"); } catch { anchorsSectionExists = false; }
		expect(anchorInjectionExists).toBe(false);
		expect(anchorsSectionExists).toBe(false);
	});

	// ── §D.2 Markdown XSS — no rehype-raw wired ─────────────────────────────
	test("D.2 WikiDetail renders via react-markdown+remark-gfm WITHOUT wiring rehype-raw (XSS-safe default)", async () => {
		const src = readFileSync(join(process.cwd(), "src/renderer/components/wiki/WikiDetail.tsx"), "utf-8");
		expect(src).toMatch(/react-markdown/);
		// remark-gfm IS imported and wired.
		expect(src).toMatch(/import remarkGfm from "remark-gfm"/);
		expect(src).toMatch(/remarkPlugins=\{\[remarkGfm\]\}/);
		// rehype-raw must NOT be imported or passed as a plugin (it would let raw
		// HTML into the DOM). The word appears only in an explanatory comment.
		expect(src).not.toMatch(/import[^\n]*rehype-raw/);
		expect(src).not.toMatch(/rehypePlugins/);
	});

	// ── §D.7 History — round-2 fix verified (was round-1 FAIL: scope-narrowing) ──
	// D7 landed: WikiService.listHistory + POST /history + wikiV2History IPC +
	// store.loadHistory + WikiDetail HistoryTab. These tests assert the fixed
	// behavior (PASS), replacing the round-1 FAIL documentation.
	test("D.7 PASS: WikiService exposes public listHistory(nodePath, limit, ctx) returning WikiAuditView[]", async () => {
		const svcProto = WikiService.prototype as any;
		expect(typeof svcProto.listHistory).toBe("function");
		// listHistory is a synchronous read (no async — direct auditRepo.listByNodePath).
		// It must return an array of audit views (caller maps to WikiAuditView[]).
		const wiki = new WikiDatabase(join(UNIQUE_DIR, `d7-svc-${Date.now()}.db`));
		try {
			const svc = WikiService.fromDatabase(wiki);
			const out = svc.listHistory("wiki-root", 10, {
				access: {
					agentId: "@ui-browser",
					activeProjectId: undefined,
					grants: [{ canonicalScope: "wiki-root", actions: ["read"] }],
					policyRevision: 1,
				},
				agentId: "@ui-browser",
				activeProjectId: undefined,
				sessionId: null,
				requestId: null,
			});
			expect(Array.isArray(out)).toBe(true);
		} finally {
			wiki.close();
		}
	});

	test("D.7 PASS: WikiDetail HistoryTab renders actor/action/revision/audit-time rows (not plan-07 placeholder)", async () => {
		const src = readFileSync(join(process.cwd(), "src/renderer/components/wiki/WikiDetail.tsx"), "utf-8");
		// The plan-07 placeholder text is GONE.
		expect(src).not.toMatch(/management audit-query API lands \(plan-07\)/);
		// HistoryTab renders a 4-column table with data-testid row + actor/revision.
		expect(src).toMatch(/data-testid="wiki-history-row"/);
		expect(src).toMatch(/Audit time/);
		expect(src).toMatch(/h\.actorAgentId/);
		expect(src).toMatch(/h\.oldRevision/);
		expect(src).toMatch(/h\.newRevision/);
	});

	// ── §D.8 Source-bound explanation present ──────────────────────────────
	test("D.8 WikiDetail Source tab explains Git ownership for source-bound nodes", async () => {
		const src = readFileSync(join(process.cwd(), "src/renderer/components/wiki/WikiDetail.tsx"), "utf-8");
		expect(src).toMatch(/Source-bound/);
		expect(src).toMatch(/Git mirror indexer/);
	});

	// ── §C.2 matchedField actually rendered in WikiPage result cards ───────
	// round-1 minor:WikiSearchHit.matchedField was returned by the backend but
	// never rendered in the result cards. round-2 C2 fix renders it on BOTH
	// the wiki hit card and the source hit card. ≥ 2 occurrences proves both
	// card types render it (not just stored state).
	test("C.2 PASS: WikiPage renders h.matchedField on both wiki and source result cards", async () => {
		const src = readFileSync(join(process.cwd(), "src/renderer/components/wiki/WikiPage.tsx"), "utf-8");
		const matches = src.match(/h\.matchedField/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(2);
	});
});
