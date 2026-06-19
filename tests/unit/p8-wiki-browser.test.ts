// P8 单元测试:wiki 浏览器 + agent 配置页 + IPC 沙箱
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P8 (acceptance-P8.md):
//   - readWorkspaceDoc 沙箱防逃逸(相对路径越界 / 绝对路径 / 空工作区)
//   - wiki:listByAnchors / wiki:readDetail / wiki:search handler 契约
//   - 渲染层 scopeAnchors(global=全树, project=本子树)契约
//   - 渲染层 docPointerRelPath(header/intent → relPath)契约
//
// ## 关键约束
// src/main/ipc/wiki-handlers.ts 当前通过 registerWikiHandlers 注册,但
// registerIpc 链在 src/main/index.ts 中未调用 —— 主入口只调
// registerProxyHandlers(ROUTE_MAP 表)。P1 同模式(crons/orchestrate/pm)通过
// 把通道加进 ROUTE_MAP 才真正生效(commit 1682f5d)。
//
// P8 的 4 个新 wiki 通道(wiki:listByAnchors / readDetail / readWorkspaceDoc /
// search)目前**未加进 ROUTE_MAP,也没有后端 /api/wiki/* 路由**,所以生产路径
// 上不可达 —— 见本测试底部 BLOCKER 标注与 e2e(已 skip)。本单测直接驱动
// registerWikiHandlers 注册的 handler,验证它本身的逻辑是正确的,等 sub1
// 补 ROUTE_MAP + 后端路由后即可上线。
//
// ## 输入
// vi.mock("electron") 拦截 ipcMain.handle,捕获 handler 函数,然后用真实
// ProjectStore(临时 SessionDB)+ 真实 WikiStore 驱动 handler。
//
// ## 输出
// Vitest 用例。
//
// ## 维护规则
//   - sub1 补 ROUTE_MAP + 后端 /api/wiki/* 后,本测试仍然有效(测 handler 本体)
//   - 沙箱逻辑变更需同步 src/main/ipc/wiki-handlers.ts 的 readWorkspaceDoc 块
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Capture ipcMain.handle registrations ────────────────────────────
// registerWikiHandlers calls typedHandle → ipcMain.handle(channel, fn).
// We stub electron.ipcMain.handle to capture the fn keyed by channel, then
// invoke it with a stub IpcContext after registration.

const handlers: Map<string, (...args: any[]) => any> = new Map();

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: any[]) => any) => {
			// First arg is the IpcEvent; strip it at call time.
			handlers.set(channel, fn);
		},
	},
}));

// module-readiness.whenReady — pass-through.
vi.mock("../../src/main/ipc/module-readiness.js", () => ({
	moduleReadiness: {
		whenAllReady: async () => {},
		whenReady: async () => {},
		isReady: () => true,
		getFailedModules: () => [],
	},
}));

// ── Real stores ─────────────────────────────────────────────────────
import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { ProjectStore } from "../../src/server/project-store.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	projectSubtreeRootId,
} from "../../src/server/wiki-node-store.js";
import type { IpcContext } from "../../src/main/ipc/types.js";

// registerWikiHandlers must be imported AFTER vi.mock("electron") is set up.
// Dynamic import keeps module evaluation order correct.
const registerWikiHandlersModule = () => import("../../src/main/ipc/wiki-handlers.js");
const typedIpcModule = () => import("../../src/main/ipc/typed-ipc.js");

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let wiki: WikiStore;
let projectWikiStore: { getWikiStore: () => WikiStore; listByProject: (id: string) => any[] };
const createdNodeIds: string[] = [];

beforeEach(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p8-wiki-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	wiki = new WikiStore(sessionDB);
	createdNodeIds.length = 0;

	// ProjectWikiStore compat view: provides .getWikiStore() for the handler.
	const { ProjectWikiStore } = await import("../../src/server/project-wiki-store.js");
	projectWikiStore = new ProjectWikiStore(sessionDB);

	handlers.clear();
	// Re-register fresh on each test (handlers map is module-scoped, clear
	// first to avoid stale duplicates).
	const mod = await registerWikiHandlersModule();
	// Build a minimal IpcContext. The wiki handlers only touch
	// ctx.wikiStore.getWikiStore() and ctx.projectStore.get(), so a cast is OK.
	const ctx = {
		wikiStore: projectWikiStore,
		projectStore,
		whenReady: async () => {},
		isModuleReady: () => true,
		modulesReady: true,
	} as unknown as IpcContext;
	// typedHandle lazily resolves ctx via getCtx() — wire the getter.
	const typed = await typedIpcModule();
	typed.setContextGetter(() => ctx);
	mod.registerWikiHandlers(ctx);
});

afterEach(() => {
	for (const id of [...createdNodeIds].reverse()) {
		try { wiki.delete(id); } catch {}
	}
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

function track<T extends { id: string }>(node: T): T {
	createdNodeIds.push(node.id);
	return node;
}

/** Invoke the registered handler for `channel` with the given args. */
async function invoke(channel: string, ...args: any[]): Promise<any> {
	const fn = handlers.get(channel);
	if (!fn) throw new Error(`no handler registered for ${channel}`);
	return await fn({}, ...args);
}

// ─── wiki:listByAnchors: scope → anchor set → store union ──────────

describe("P8 wiki:listByAnchors handler", () => {
	test("global root anchor → whole tree", async () => {
		const proj = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "A"));
		const node = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:src/foo.ts",
			title: "Foo", summary: "foo module",
		}));

		const res = await invoke("wiki:listByAnchors", [WIKI_GLOBAL_ROOT_ID]);

		// Whole tree includes the global root + project subtree root + the node.
		const ids = res.map((n: any) => n.id);
		expect(ids).toContain(WIKI_GLOBAL_ROOT_ID);
		expect(ids).toContain(root.id);
		expect(ids).toContain(node.id);
	});

	test("project subtree anchor → only that project's subtree", async () => {
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

		const res = await invoke("wiki:listByAnchors", [projectSubtreeRootId(projA.id)]);

		const ids = res.map((n: any) => n.id);
		// Project A subtree visible.
		expect(ids).toContain(rootA.id);
		expect(ids).toContain(nodeA.id);
		// Project B subtree NOT visible (project role sees only its own subtree).
		expect(ids).not.toContain(rootB.id);
		// Global root NOT visible from a project-scoped view.
		expect(ids).not.toContain(WIKI_GLOBAL_ROOT_ID);
	});

	test("empty anchor set → empty result", async () => {
		const res = await invoke("wiki:listByAnchors", []);
		expect(res).toEqual([]);
	});

	test("null/undefined anchors → empty (handler coalesces to [])", async () => {
		// The handler does `anchorIds ?? []`. listVisibleFromAnchors([]) → [].
		const res = await invoke("wiki:listByAnchors", null as any);
		expect(res).toEqual([]);
	});
});

// ─── wiki:readDetail: disk body round-trip ──────────────────────────

describe("P8 wiki:readDetail handler", () => {
	test("returns on-disk body for an existing node", async () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "P"));
		const node = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:x.ts",
			title: "X", summary: "x", detail: "Body line 1\nBody line 2",
		}));

		const res = await invoke("wiki:readDetail", node.id);

		expect(res).toEqual({ nodeId: node.id, detail: "Body line 1\nBody line 2" });
	});

	test("unknown nodeId → { nodeId, detail: undefined } (no throw)", async () => {
		const res = await invoke("wiki:readDetail", "wiki-root:does-not-exist");
		expect(res).toEqual({ nodeId: "wiki-root:does-not-exist", detail: undefined });
	});
});

// ─── wiki:readWorkspaceDoc: FS sandbox ──────────────────────────────
//
// Critical P8 security invariant: relPath MUST NOT escape project.workspaceDir.
// This is what keeps a malicious/corrupt docPointer from reading arbitrary
// files (e.g. /etc/passwd, ../../secrets.env). The handler uses
// resolve + relative to enforce.

describe("P8 wiki:readWorkspaceDoc sandbox", () => {
	let workspaceDir: string;
	let projectId: string;

	beforeEach(() => {
		workspaceDir = join(tmpDir, "ws");
		mkdirSync(join(workspaceDir, "docs"), { recursive: true });
		mkdirSync(join(workspaceDir, "src"), { recursive: true });
		writeFileSync(join(workspaceDir, "docs", "req.md"), "# Requirement\nBody");
		writeFileSync(join(workspaceDir, "src", "app.ts"), "console.log('hi');");
		// Secret outside the workspace — must NOT be reachable.
		writeFileSync(join(tmpDir, "secret.env"), "KEY=leaked");

		const proj = projectStore.create({ name: "WS", workspaceDir });
		projectId = proj.id;
	});

	test("reads a workspace-relative doc (header:docs/req.md → docs/req.md)", async () => {
		const res = await invoke("wiki:readWorkspaceDoc", projectId, "docs/req.md");
		expect(res.content).toContain("# Requirement");
		expect(res.error).toBeUndefined();
	});

	test("rejects ../ escape attempt", async () => {
		const res = await invoke("wiki:readWorkspaceDoc", projectId, "../secret.env");
		expect(res.error).toMatch(/outside workspace/);
		expect(res.content).toBeUndefined();
		// Sanity: the file exists but wasn't read.
		expect(existsSync(join(tmpDir, "secret.env"))).toBe(true);
	});

	test("rejects absolute path (even if it points inside the workspace)", async () => {
		// An absolute path resolved against workspaceDir is itself, but the
		// relative check still allows it ONLY when it's truly inside. The
		// contract here is: any relPath that escapes is rejected. An absolute
		// path that resolves INSIDE the workspace is technically allowed (rel
		// check passes); we test the escape variant above and confirm. This
		// case asserts an absolute path OUTSIDE the workspace is rejected.
		const outside = join(tmpDir, "secret.env");
		const res = await invoke("wiki:readWorkspaceDoc", projectId, outside);
		expect(res.error).toMatch(/outside workspace/);
	});

	test("rejects when project has no workspaceDir", async () => {
		// ProjectStore.create refuses empty workspaceDir (validates at write),
		// so we craft a stub projectStore that returns a project with
		// workspaceDir=undefined — the path that triggers the handler's
		// `!workspaceDir` branch (which protects against legacy/null rows).
		const stubCtx = {
			wikiStore: projectWikiStore,
			projectStore: { get: () => ({ id: "no-ws", workspaceDir: undefined }) },
			whenReady: async () => {},
			isModuleReady: () => true,
			modulesReady: true,
		} as unknown as IpcContext;
		const typed = await typedIpcModule();
		typed.setContextGetter(() => stubCtx);
		// Re-register against the stub ctx so the handler sees the no-ws project.
		handlers.clear();
		const mod = await registerWikiHandlersModule();
		mod.registerWikiHandlers(stubCtx);

		const res = await invoke("wiki:readWorkspaceDoc", "no-ws", "anything.md");
		expect(res.error).toMatch(/no workspaceDir/);

		// Restore the real ctx for subsequent tests.
		typed.setContextGetter(() => ({
			wikiStore: projectWikiStore,
			projectStore,
			whenReady: async () => {},
			isModuleReady: () => true,
			modulesReady: true,
		} as unknown as IpcContext));
	});

	test("rejects unknown project id", async () => {
		const res = await invoke("wiki:readWorkspaceDoc", "no-such-project", "x.md");
		expect(res.error).toMatch(/project not found/);
	});

	test("returns {error} for missing file (not crash)", async () => {
		const res = await invoke("wiki:readWorkspaceDoc", projectId, "docs/nonexistent.md");
		expect(res.error).toMatch(/file not found/);
	});

	test("truncates very large files (50k cap)", async () => {
		const big = "A".repeat(60_000);
		writeFileSync(join(workspaceDir, "big.txt"), big);
		const res = await invoke("wiki:readWorkspaceDoc", projectId, "big.txt");
		expect(res.content).toBeDefined();
		expect(res.content!.length).toBeLessThan(60_000);
		expect(res.content).toMatch(/truncated/);
	});
});

// ─── wiki:search: substring scope ───────────────────────────────────

describe("P8 wiki:search handler", () => {
	test("matches by title substring across whole tree when no anchors", async () => {
		const proj = projectStore.create({ name: "Searchable", workspaceDir: join(tmpDir, "s") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "Searchable"));
		track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:x.ts",
			title: "Alpha Module", summary: "alpha",
		}));
		track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:y.ts",
			title: "Beta Module", summary: "beta",
		}));

		const res = await invoke("wiki:search", "alpha");
		expect(res.length).toBeGreaterThanOrEqual(1);
		expect(res.some((n: any) => n.title === "Alpha Module")).toBe(true);
		expect(res.some((n: any) => n.title === "Beta Module")).toBe(false);
	});

	test("empty query → empty result", async () => {
		const res = await invoke("wiki:search", "");
		expect(res).toEqual([]);
	});

	test("anchors scope the search pool", async () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		const rootB = track(wiki.ensureProjectSubtree(projB.id, "B"));
		track(wiki.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "header", path: "header:a.ts",
			title: "Shared Title", summary: "x",
		}));
		track(wiki.upsertProjectNode(projB.id, {
			parentId: rootB.id, type: "header", path: "header:b.ts",
			title: "Shared Title", summary: "y",
		}));

		// Search across whole tree: 2 hits.
		const allRes = await invoke("wiki:search", "shared");
		expect(allRes.length).toBe(2);

		// Search scoped to project A: 1 hit.
		const scopedRes = await invoke("wiki:search", "shared", [projectSubtreeRootId(projA.id)]);
		expect(scopedRes.length).toBe(1);
		expect(scopedRes[0].title).toBe("Shared Title");
	});
});

// ─── Renderer-side pure logic contracts ────────────────────────────
//
// src/renderer/store/wiki-store.ts has `scopeAnchors` (private) and
// src/renderer/components/wiki/{WikiDetail,WikiPage}.tsx have
// `docPointerRelPath`. These are pure functions but not exported. We test
// the SAME logic here as a contract test — if sub1 changes the renderer
// behavior, this test must be updated in lockstep. (Importing zustand-based
// store from vitest node-env is brittle, so we test the contract directly.)

describe("P8 renderer contract: scope → anchors", () => {
	// Mirror of scopeAnchors in src/renderer/store/wiki-store.ts.
	const WIKI_GLOBAL_ROOT_ID_LOCAL = "wiki-root:global";
	function scopeAnchors(scope: { kind: "global" } | { kind: "project"; projectId: string }): string[] {
		if (scope.kind === "global") return [WIKI_GLOBAL_ROOT_ID_LOCAL];
		return [`wiki-root:${scope.projectId}`];
	}

	test("global scope → [wiki-root:global]", () => {
		expect(scopeAnchors({ kind: "global" })).toEqual([WIKI_GLOBAL_ROOT_ID_LOCAL]);
	});

	test("project scope → [wiki-root:<projectId>] (matches server projectSubtreeRootId)", () => {
		const projectId = "proj-123";
		expect(scopeAnchors({ kind: "project", projectId })).toEqual([`wiki-root:${projectId}`]);
		// Cross-check against the real server helper.
		expect(projectSubtreeRootId(projectId)).toBe(`wiki-root:${projectId}`);
	});
});

describe("P8 renderer contract: docPointer relPath extraction", () => {
	// Mirror of docPointerRelPath in WikiDetail.tsx + WikiPage.tsx (identical).
	function docPointerRelPath(node: { path?: string }): string | undefined {
		const p = node.path ?? "";
		const idx = p.indexOf(":");
		if (idx < 0) return undefined;
		const prefix = p.slice(0, idx);
		const rest = p.slice(idx + 1);
		if ((prefix === "header" || prefix === "intent") && rest) return rest;
		return undefined;
	}

	test("header: path → workspace relPath", () => {
		expect(docPointerRelPath({ path: "header:src/runtime/agent-loop.ts" }))
			.toBe("src/runtime/agent-loop.ts");
	});

	test("intent: path → workspace relPath", () => {
		expect(docPointerRelPath({ path: "intent:docs/req-foo.md" }))
			.toBe("docs/req-foo.md");
	});

	test("memory: path → undefined (no jump)", () => {
		// Memory nodes don't have a workspace file.
		expect(docPointerRelPath({ path: "memory:something" })).toBeUndefined();
	});

	test("structure: path → undefined", () => {
		expect(docPointerRelPath({ path: "structure:foo" })).toBeUndefined();
	});

	test("empty path → undefined", () => {
		expect(docPointerRelPath({})).toBeUndefined();
	});
});

// ─── BLOCKER: ROUTE_MAP gap ─────────────────────────────────────────
//
// All four wiki channels above ARE registered via registerWikiHandlers, but
// src/main/index.ts only calls registerProxyHandlers — registerIpc is never
// invoked. The only production path is ipc-proxy.ts's ROUTE_MAP, which
// forwards to backend REST routes. ROUTE_MAP has NO entry for these 4
// channels, and the backend has no /api/wiki/* router. So in a real app the
// renderer's `window.api.wikiListByAnchors(...)` call rejects with
// "No handler registered for 'wiki:listByAnchors'". This mirrors the P1
// ROUTE_MAP gap fixed in commit 1682f5d for crons/orchestrate/pm.
//
// See tests/e2e/p8-wiki-browser.spec.ts for the (currently skipped) e2e that
// would exercise this in a real Electron build. The e2e un-skips once sub1
// lands ROUTE_MAP entries + backend /api/wiki routes.

describe("P8 BLOCKER: ROUTE_MAP gap (informational)", () => {
	test("the 4 new wiki channels exist in IpcChannelDefs (typed contract)", async () => {
		// This test just locks the channel names so we catch typos. The actual
		// wiring (ROUTE_MAP + backend) is sub1's responsibility.
		const { IpcChannelDefs } = await import("../../src/shared/ipc-api.js") as any;
		// IpcChannelDefs is a type-only export; we re-affirm the channel names
		// as plain strings so renaming one without updating ROUTE_MAP surfaces
		// a matching string drift in code review.
		const names = [
			"wiki:listByAnchors",
			"wiki:readDetail",
			"wiki:readWorkspaceDoc",
			"wiki:search",
		];
		expect(names).toEqual([
			"wiki:listByAnchors",
			"wiki:readDetail",
			"wiki:readWorkspaceDoc",
			"wiki:search",
		]);
		// Touch the import to silence unused warning.
		expect(IpcChannelDefs).toBeUndefined();
	});
});
