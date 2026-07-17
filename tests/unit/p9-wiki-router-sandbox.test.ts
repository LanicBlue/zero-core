// P9/sub-06 验收:wiki-router workspace-doc 沙箱(生产路径覆盖)
//
// # 文件说明书
//
// ## 核心功能
// 驱动 `src/server/wiki-router.ts:createWorkspaceDocHandler`
// (GET /api/projects/:projectId/workspace-doc) 的 FS 沙箱:`../` 逃逸防护。
// 这是 WikiDetail Source tab 读 workspace 原文的生产路径,沙箱之前只有 e2e
// smoke 覆盖,安全回归缺保障。本测试直接驱动 createWorkspaceDocHandler(纯
// Express RequestHandler,不依赖 electron / ipcMain),覆盖 `../` 逃逸 / 绝对
// 路径 / 空 workspace / 不存在 project 四类场景。
//
// ## sub-06 迁移说明
// 原 P9 文件还含第二个 describe,驱动 `createWikiRouter` 的 legacy endpoint
// (`/list-by-anchors` / `/nodes/:id/detail` / `/search`)。wiki-system-redesign
// sub-06 把 `createWikiRouter` 重命名为 `createWikiBrowserRouter` 并删除全部
// anchor-based endpoint,第二个 describe 已失效。9 个新 `/api/wiki/*` endpoint
// 的 REST 层覆盖由 `tests/unit/wiki-v2-sub06-spec.test.ts`(spec lens)接手;
// 本文件只保留仍然有效且安全关键的 workspace-doc 沙箱套件。
//
// ## 输入
// 真实 ProjectStore(临时 CoreDatabase) + Express 临时 server。
//
// ## 输出
// Vitest 用例。
//
// ## 定位
// tests/unit/ — REST 层安全沙箱。
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

import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { createWorkspaceDocHandler } from "../../src/server/wiki-router.js";

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

// ─── Suite: workspace-doc sandbox (the security-critical surface) ────

describe("P9 wiki-router · createWorkspaceDocHandler sandbox", () => {
	let tmpDir: string;
	let sessionDB: CoreDatabase;
	let projectStore: ProjectStore;
	let app: Express;
	let server: Server;
	let port: number;
	let workspaceDir: string;
	let projectId: string;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-p9-wiki-"));
		sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
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

		// Mount ONLY the workspace-doc handler.
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
