// P9 验收:补回 p8-wiki-browser.test.ts 删除丢失的生产路径覆盖
//
// # 文件说明书
//
// ## 核心功能
// P9 删除了 tests/unit/p8-wiki-browser.test.ts —— 它驱动的是 dead path
// `src/main/ipc/wiki-handlers.ts`(从未挂进 ROUTE_MAP)。删除合理,但该测试
// 同时覆盖了 wiki:readWorkspaceDoc 的 FS 沙箱(`../` 逃逸防护),而**生产路径**
// 上同样沙箱检查位于 `src/server/wiki-router.ts:createWorkspaceDocHandler`
// (GET /api/projects/:projectId/workspace-doc)。生产沙箱之前没有任何专属单测,
// 只有 e2e smoke —— 安全回归缺保障。
//
// 本测试直接驱动 createWorkspaceDocHandler(纯 Express RequestHandler,不依赖
// electron / ipcMain),把生产沙箱覆盖回来。同款 `../` 逃逸 / 绝对路径 / 空
// workspace / 不存在 project 四类场景。
//
// 也顺带覆盖 createWikiRouter(list-by-anchors / readDetail / search)的生产
// 路径,使 P8 wiki 浏览器在 P9 后仍有完整的 REST-layer 单元覆盖。
//
// ## 输入
// 真实 ProjectStore(临时 SessionDB) + 真实 WikiStore + Express 临时 server。
//
// ## 输出
// Vitest 用例。
//
// ## 定位
// tests/unit/ — REST 层契约 + 安全沙箱。
//
// ## 维护规则
//   - wiki-router.ts 的沙箱逻辑变更(松绑 / 重写)需同步本测试
//   - 新增 query 参数(relPath 以外)需补 case
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Express } from "express";
import { createServer, type Server } from "http";

import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { WikiStore, WIKI_GLOBAL_ROOT_ID, projectSubtreeRootId } from "../../src/server/wiki-node-store.js";
import { createWikiRouter, createWorkspaceDocHandler } from "../../src/server/wiki-router.js";

// ─── Helpers ─────────────────────────────────────────────────────────

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

async function get(port: number, path: string): Promise<{ status: number; data: any }> {
	const resp = await fetch(`http://localhost:${port}${path}`);
	const text = await resp.text();
	try {
		return { status: resp.status, data: JSON.parse(text) };
	} catch {
		return { status: resp.status, data: text };
	}
}

async function post(port: number, path: string, body: any): Promise<{ status: number; data: any }> {
	const resp = await fetch(`http://localhost:${port}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	try {
		return { status: resp.status, data: JSON.parse(text) };
	} catch {
		return { status: resp.status, data: text };
	}
}

// ─── Suite: workspace-doc sandbox (the security-critical surface) ────

describe("P9 wiki-router · createWorkspaceDocHandler sandbox", () => {
	let tmpDir: string;
	let sessionDB: SessionDB;
	let projectStore: ProjectStore;
	let app: Express;
	let server: Server;
	let port: number;
	let workspaceDir: string;
	let projectId: string;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-p9-wiki-"));
		sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
		runMigrations(sessionDB);
		projectStore = new ProjectStore(sessionDB);

		// Build a workspace with a normal doc and a sibling secret OUTSIDE it.
		workspaceDir = join(tmpDir, "ws");
		mkdirSync(join(workspaceDir, "docs"), { recursive: true });
		mkdirSync(join(workspaceDir, "src"), { recursive: true });
		writeFileSync(join(workspaceDir, "docs", "req.md"), "# Requirement\nBody");
		writeFileSync(join(workspaceDir, "src", "app.ts"), "console.log('hi');");
		// Secret outside the workspace — must NOT be reachable.
		writeFileSync(join(tmpDir, "secret.env"), "KEY=leaked");
		// Nested outside: tmpDir/ws-evil/evil.md
		mkdirSync(join(tmpDir, "ws-evil"));
		writeFileSync(join(tmpDir, "ws-evil", "evil.md"), "should-not-leak");

		const proj = projectStore.create({ name: "WS", workspaceDir });
		projectId = proj.id;

		// Mount ONLY the workspace-doc handler. (The /api/wiki tree endpoints are
		// exercised by the second describe block below with their own app.)
		app = express();
		app.use(express.json());
		app.get("/api/projects/:projectId/workspace-doc", createWorkspaceDocHandler({ projectStore }));

		const listening = await listen(app);
		server = listening.server;
		port = listening.port;
	});

	afterEach(async () => {
		await close(server);
		try { sessionDB.close(); } catch {}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("reads a workspace-relative doc (docs/req.md)", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=${encodeURIComponent("docs/req.md")}`);
		expect(res.status).toBe(200);
		expect(res.data.content).toContain("# Requirement");
		expect(res.data.error).toBeUndefined();
	});

	test("rejects ../ escape attempt (relative path)", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=${encodeURIComponent("../secret.env")}`);
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/outside workspace/);
		expect(res.data.content).toBeUndefined();
	});

	test("rejects multi-level ../ escape", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=${encodeURIComponent("../../ws-evil/evil.md")}`);
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/outside workspace/);
	});

	test("rejects absolute path that resolves outside workspace", async () => {
		// An absolute path resolves to itself; relative(workspaceDir, abs) returns
		// an absolute path on a different root → isAbsolute check fires.
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=${encodeURIComponent(join(tmpDir, "secret.env"))}`);
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/outside workspace/);
	});

	test("400 when relPath missing", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc`);
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/relPath/);
	});

	test("404 for unknown project", async () => {
		const res = await get(port, `/api/projects/does-not-exist/workspace-doc?relPath=docs/req.md`);
		expect(res.status).toBe(404);
		expect(res.data.error).toMatch(/project not found/);
	});

	test("404 when file does not exist (but path stays inside workspace)", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=${encodeURIComponent("docs/missing.md")}`);
		expect(res.status).toBe(404);
		expect(res.data.error).toMatch(/file not found/);
	});
});

// ─── Suite: wiki-tree endpoints (list-by-anchors / readDetail / search) ──

describe("P9 wiki-router · createWikiRouter endpoints", () => {
	let tmpDir: string;
	let sessionDB: SessionDB;
	let projectStore: ProjectStore;
	let wiki: WikiStore;
	let app: Express;
	let server: Server;
	let port: number;
	const createdNodeIds: string[] = [];

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-p9-wiki-tree-"));
		sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
		runMigrations(sessionDB);
		projectStore = new ProjectStore(sessionDB);
		wiki = new WikiStore(sessionDB);
		createdNodeIds.length = 0;

		app = express();
		app.use(express.json());
		app.use("/api/wiki", createWikiRouter({ wikiStore: wiki }));

		const listening = await listen(app);
		server = listening.server;
		port = listening.port;
	});

	afterEach(async () => {
		await close(server);
		try { sessionDB.close(); } catch {}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function track<T extends { id: string }>(node: T): T {
		createdNodeIds.push(node.id);
		return node;
	}

	test("POST /list-by-anchors · global root anchor → whole tree visible", async () => {
		const proj = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "A"));
		const node = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:src/foo.ts",
			title: "Foo", summary: "foo module",
		}));

		const res = await post(port, "/api/wiki/list-by-anchors", { anchorIds: [WIKI_GLOBAL_ROOT_ID] });
		expect(res.status).toBe(200);
		const ids = (res.data as any[]).map((n) => n.id);
		expect(ids).toContain(WIKI_GLOBAL_ROOT_ID);
		expect(ids).toContain(root.id);
		expect(ids).toContain(node.id);
	});

	test("POST /list-by-anchors · project anchor → only that project subtree", async () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		const rootB = track(wiki.ensureProjectSubtree(projB.id, "B"));
		const nodeA = track(wiki.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "header", path: "header:a.ts", title: "A file",
		}));
		track(wiki.upsertProjectNode(projB.id, {
			parentId: rootB.id, type: "header", path: "header:b.ts", title: "B file",
		}));

		const res = await post(port, "/api/wiki/list-by-anchors", { anchorIds: [projectSubtreeRootId(projA.id)] });
		expect(res.status).toBe(200);
		const ids = (res.data as any[]).map((n) => n.id);
		expect(ids).toContain(rootA.id);
		expect(ids).toContain(nodeA.id);
		// Project B NOT visible; global root NOT visible from project-scoped view.
		expect(ids).not.toContain(rootB.id);
		expect(ids).not.toContain(WIKI_GLOBAL_ROOT_ID);
	});

	test("POST /list-by-anchors · empty anchors → empty result", async () => {
		const res = await post(port, "/api/wiki/list-by-anchors", { anchorIds: [] });
		expect(res.status).toBe(200);
		expect(res.data).toEqual([]);
	});

	test("POST /list-by-anchors · missing body / non-array → empty result (no throw)", async () => {
		const res = await post(port, "/api/wiki/list-by-anchors", {});
		expect(res.status).toBe(200);
		expect(res.data).toEqual([]);
	});

	test("GET /nodes/:id/detail · returns on-disk body", async () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "P"));
		const node = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:x.ts",
			title: "X", summary: "x", detail: "Body line 1\nBody line 2",
		}));

		const res = await get(port, `/api/wiki/nodes/${encodeURIComponent(node.id)}/detail`);
		expect(res.status).toBe(200);
		expect(res.data).toEqual({ nodeId: node.id, detail: "Body line 1\nBody line 2" });
	});

	test("GET /nodes/:id/detail · unknown nodeId → { detail: undefined } (no throw)", async () => {
		const res = await get(port, `/api/wiki/nodes/${encodeURIComponent("wiki-root:does-not-exist")}/detail`);
		expect(res.status).toBe(200);
		expect(res.data).toEqual({ nodeId: "wiki-root:does-not-exist", detail: undefined });
	});

	test("GET /search · substring match scoped by anchors", async () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "P"));
		track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:auth.ts", title: "Auth module",
		}));
		track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:billing.ts", title: "Billing module",
		}));

		const res = await get(port, `/api/wiki/search?query=${encodeURIComponent("auth")}`);
		expect(res.status).toBe(200);
		const titles = (res.data as any[]).map((n) => n.title);
		expect(titles).toContain("Auth module");
		expect(titles).not.toContain("Billing module");
	});

	test("GET /search · empty query → empty result", async () => {
		const res = await get(port, `/api/wiki/search?query=`);
		expect(res.status).toBe(200);
		expect(res.data).toEqual([]);
	});
});
