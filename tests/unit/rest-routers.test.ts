// 单元测试：REST 路由集成与 IPC 代理完整性
//
// # 文件说明书
//
// ## 核心功能
// 通过 Express + Node 内置 http 启动临时 server，测试 chat/session/file/log/tool-execution/mcp/memory-node/memory-config 等 router 的端点行为；并校验 preload 中每个 ipcRenderer.invoke 通道都在 ipc-proxy.ts 与 ROUTE_MAP 中有映射、IPC 代理源码包含全部通道、backend 子进程协议（port 解析、ready/shutdown 消息格式）、session-router 路由顺序（/metrics 不被 /:agentId 捕获）、log-router 配置持久化、mcp-presets 构造
//
// ## 输入
// mock 的 sessionDb / agentService / mcpManager / store；preload 与 ipc-proxy 源码（fs.readFileSync 读取）
//
// ## 输出
// Vitest 测试用例：覆盖各 router 的成功/失败/路径穿越/参数校验场景，以及 IPC 通道与代理映射的一致性
//
// ## 定位
// tests/unit/ — 单元测试套件，验证 server 层 REST router 与 main 进程 IPC 代理的契约
//
// ## 依赖
// vitest、express、node:http、node:fs、../../src/server/*（各 router 与 mcp-presets）、src/preload/index.ts、src/main/ipc-proxy.ts（源码读取）
//
// ## 维护规则
// 新增 IPC 通道必须同步加到 ROUTE_MAP 并确保 ipc-proxy.ts 包含，否则通道映射测试失败
// 新增 router 端点需补充对应 request 测试
// 路由顺序（静态路径 vs /:param）变更需更新 route ordering 测试
// mcp-presets 数量或字段变更需更新 Z.AI preset 断言
//
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Helpers ────────────────────────────────────────────────

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

async function request(port: number, method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
	const url = `http://localhost:${port}${path}`;
	const opts: RequestInit = { method };
	if (body !== undefined) {
		opts.headers = { "Content-Type": "application/json" };
		opts.body = JSON.stringify(body);
	}
	const resp = await fetch(url, opts);
	const text = await resp.text();
	try {
		return { status: resp.status, data: JSON.parse(text) };
	} catch {
		return { status: resp.status, data: text };
	}
}

// ─── Mock Dependencies ──────────────────────────────────────

function mockSessionDb() {
	const store: Record<string, any> = {};
	return {
		getKVStore: () => ({
			getJson: vi.fn((key: string) => store[key] ?? null),
			setJson: vi.fn((key: string, val: any) => { store[key] = val; }),
		}),
		listSessions: vi.fn(() => [{ id: "s1", agentId: "a1", createdAt: Date.now() }]),
		createSession: vi.fn((agentId: string) => ({ id: "s-new", agentId, createdAt: Date.now() })),
		setMainSession: vi.fn(),
		getMainSession: vi.fn(() => ({ id: "s1", agentId: "a1" })),
		deleteSession: vi.fn(),
		updateTurnContent: vi.fn(),
		getMessagesWithSeq: vi.fn(() => []),
		updateMessageContent: vi.fn(),
		deleteTurn: vi.fn(),
		deleteMessage: vi.fn(),
		queryToolExecutions: vi.fn(() => []),
		getToolExecutionStats: vi.fn(() => []),
		cleanOldToolExecutions: vi.fn(() => 0),
		// Step-level storage methods
		hasStepSchema: vi.fn(() => true),
		getSteps: vi.fn(() => []),
		getStepGroup: vi.fn(() => []),
		appendStep: vi.fn(),
		upsertStep: vi.fn(),
		updateStepContent: vi.fn(),
		deleteStepGroup: vi.fn(),
		getTurnGroupCount: vi.fn(() => 0),
		replaceStepsFromMessages: vi.fn(),
	};
}

function mockAgentService(sessionDb: any) {
	return {
		getDB: () => sessionDb,
		abort: vi.fn(async () => {}),
		sendPrompt: vi.fn(async () => {}),
		setWorkspaceDir: vi.fn(),
		setProviders: vi.fn(),
		recreateLoop: vi.fn(),
		activateSession: vi.fn(async () => "s1"),
		getSessionManager: vi.fn(() => null),
		subscribe: vi.fn(() => () => {}),
	};
}

// ─── Chat Router Tests ──────────────────────────────────────

describe("chat-router", () => {
	const sessionDb = mockSessionDb();
	const agentService = mockAgentService(sessionDb);
	const agentStore = { get: vi.fn(() => null) } as any;
	const providerStore = { list: vi.fn(() => []) } as any;
	const workspaceConfig = { workspaceDir: "/tmp", defaultModel: "m1", defaultProvider: "p1" };

	let app: Express;
	let server: Server;
	let port: number;

	beforeEach(async () => {
		app = express();
		app.use(express.json());
		const { createChatRouter } = await import("../../src/server/chat-router.js");
		app.use("/api/chat", createChatRouter({ agentService, agentStore, providerStore, workspaceConfig }));
		const result = await listen(app);
		server = result.server;
		port = result.port;
	});

	afterEach(async () => { await close(server); });

	test("POST /send returns success", async () => {
		const res = await request(port, "POST", "/api/chat/send", { text: "hello", agentId: "a1" });
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
		expect(agentService.sendPrompt).toHaveBeenCalled();
	});

	test("POST /send without text still returns success (fire-and-forget)", async () => {
		const res = await request(port, "POST", "/api/chat/send", {});
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
	});

	test("POST /abort returns success", async () => {
		const res = await request(port, "POST", "/api/chat/abort");
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
		expect(agentService.abort).toHaveBeenCalled();
	});
});

// ─── Session Router Tests ───────────────────────────────────

describe("session-router", () => {
	const sessionDb = mockSessionDb();
	const agentService = mockAgentService(sessionDb);
	const agentStore = { get: vi.fn(() => null) } as any;

	let app: Express;
	let server: Server;
	let port: number;

	beforeEach(async () => {
		const sessionDb2 = mockSessionDb();
		Object.assign(sessionDb, sessionDb2);
		app = express();
		app.use(express.json());
		const { createSessionRouter } = await import("../../src/server/session-router.js");
		app.use("/api/sessions", createSessionRouter({ agentService, agentStore }));
		const result = await listen(app);
		server = result.server;
		port = result.port;
	});

	afterEach(async () => { await close(server); });

	test("GET /:agentId lists sessions", async () => {
		const res = await request(port, "GET", "/api/sessions/a1");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("POST /:agentId/new creates session", async () => {
		const res = await request(port, "POST", "/api/sessions/a1/new");
		expect(res.status).toBe(200);
		expect(res.data.id).toBe("s-new");
	});

	test("GET /:agentId/current returns current session", async () => {
		const res = await request(port, "GET", "/api/sessions/a1/current");
		expect(res.status).toBe(200);
		expect(res.data.id).toBe("s1");
	});

	test("PUT /:agentId/switch/:sessionId switches session", async () => {
		const res = await request(port, "PUT", "/api/sessions/a1/switch/s2");
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
		expect(res.data.sessionId).toBe("s2");
	});

	test("POST /:agentId/activate activates session", async () => {
		const res = await request(port, "POST", "/api/sessions/a1/activate", { sessionId: "s1" });
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
	});

	test("DELETE /:agentId/:sessionId deletes session", async () => {
		const res = await request(port, "DELETE", "/api/sessions/a1/s1");
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
	});

	test("GET /metrics returns metrics", async () => {
		const res = await request(port, "GET", "/api/sessions/metrics");
		expect(res.status).toBe(200);
		expect(res.data.totalSessions).toBe(0);
	});

	test("DELETE /:agentId/messages clears messages", async () => {
		const res = await request(port, "DELETE", "/api/sessions/a1/messages");
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
	});

	test("PUT /:agentId/messages/:seq edits message", async () => {
		const res = await request(port, "PUT", "/api/sessions/a1/messages/5", { newText: "edited" });
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
	});

	test("DELETE /:agentId/messages/:seq deletes message", async () => {
		const res = await request(port, "DELETE", "/api/sessions/a1/messages/5");
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
	});
});

// ─── File Router Tests ──────────────────────────────────────

describe("file-router", () => {
	const workspaceConfig = { workspaceDir: process.cwd() };

	let app: Express;
	let server: Server;
	let port: number;

	beforeEach(async () => {
		app = express();
		app.use(express.json());
		const { createFileRouter } = await import("../../src/server/file-router.js");
		app.use("/api/files", createFileRouter({ workspaceConfig }));
		const result = await listen(app);
		server = result.server;
		port = result.port;
	});

	afterEach(async () => { await close(server); });

	test("GET /tree returns directory tree", async () => {
		const res = await request(port, "GET", "/api/files/tree");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("GET /tree with root parameter", async () => {
		const res = await request(port, "GET", "/api/files/tree?root=src");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("GET /content?path=package.json returns file content", async () => {
		const res = await request(port, "GET", "/api/files/content?path=package.json");
		expect(res.status).toBe(200);
		expect(res.data.content).toContain("name");
	});

	test("GET /content without path returns 400", async () => {
		const res = await request(port, "GET", "/api/files/content");
		expect(res.status).toBe(400);
		expect(res.data.error).toBeTruthy();
	});

	test("GET /content with path traversal returns 403", async () => {
		const res = await request(port, "GET", "/api/files/content?path=../../etc/passwd");
		expect(res.status).toBe(403);
	});

	test("GET /resolve-path resolves a path", async () => {
		const res = await request(port, "GET", "/api/files/resolve-path?path=package.json");
		expect(res.status).toBe(200);
		expect(res.data.path).toContain("package.json");
	});

	test("PUT /save writes file content", async () => {
		const tmpDir = process.env.TEMP || "/tmp";
		const testPath = `${tmpDir}/zero-core-test-save.txt`.replace(/\\/g, "/");
		const res = await request(port, "PUT", "/api/files/save", {
			filePath: testPath,
			content: "hello test",
			root: tmpDir.replace(/\\/g, "/"),
		});
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
	});

	test("PUT /save without filePath returns 400", async () => {
		const res = await request(port, "PUT", "/api/files/save", {
			content: "hello",
		});
		expect(res.status).toBe(400);
		expect(res.data.error).toBeTruthy();
	});
});

// ─── Log Router Tests ───────────────────────────────────────

describe("log-router", () => {
	const sessionDb = mockSessionDb();
	let app: Express;
	let server: Server;
	let port: number;

	beforeEach(async () => {
		app = express();
		app.use(express.json());
		const { createLogRouter } = await import("../../src/server/log-router.js");
		app.use("/api/logs", createLogRouter({ sessionDb }));
		const result = await listen(app);
		server = result.server;
		port = result.port;
	});

	afterEach(async () => { await close(server); });

	test("GET /files returns log file list", async () => {
		const res = await request(port, "GET", "/api/logs/files");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("GET /read without filename returns empty array", async () => {
		const res = await request(port, "GET", "/api/logs/read");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("GET /read with path traversal returns empty array", async () => {
		const res = await request(port, "GET", "/api/logs/read?filename=../../etc/passwd");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
		expect(res.data).toHaveLength(0);
	});

	test("GET /read with non-existent file returns empty array", async () => {
		const res = await request(port, "GET", "/api/logs/read?filename=nonexistent.log");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("GET /config returns default log config", async () => {
		const res = await request(port, "GET", "/api/logs/config");
		expect(res.status).toBe(200);
		expect(res.data.enabled).toBe(true);
	});

	test("PUT /config saves log config", async () => {
		const config = { enabled: false, retentionDays: 30, globalLevel: "info" };
		const res = await request(port, "PUT", "/api/logs/config", config);
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);

		// Verify it was saved
		const getRes = await request(port, "GET", "/api/logs/config");
		expect(getRes.data.enabled).toBe(false);
		expect(getRes.data.retentionDays).toBe(30);
	});
});

// ─── Tool Execution Router Tests ────────────────────────────

describe("tool-execution-router", () => {
	const sessionDb = mockSessionDb();
	const agentService = {} as any;
	const providerStore = { list: vi.fn(() => []) } as any;
	const workspaceConfig = { workspaceDir: "/tmp", defaultProvider: "", defaultModel: "" };

	let app: Express;
	let server: Server;
	let port: number;

	beforeEach(async () => {
		app = express();
		app.use(express.json());
		const { createToolExecutionRouter } = await import("../../src/server/tool-execution-router.js");
		app.use("/api/tool-executions", createToolExecutionRouter({ sessionDb, agentService, providerStore, workspaceConfig }));
		const result = await listen(app);
		server = result.server;
		port = result.port;
	});

	afterEach(async () => { await close(server); });

	test("POST /query returns tool execution records", async () => {
		const res = await request(port, "POST", "/api/tool-executions/query", { agentId: "a1" });
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("POST /query without body returns empty array", async () => {
		const res = await request(port, "POST", "/api/tool-executions/query", {});
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("GET /stats returns stats", async () => {
		const res = await request(port, "GET", "/api/tool-executions/stats");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("GET /stats with agentId query param", async () => {
		const res = await request(port, "GET", "/api/tool-executions/stats?agentId=a1");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("POST /cleanup cleans old records", async () => {
		const res = await request(port, "POST", "/api/tool-executions/cleanup", { maxAgeMs: 86400000 });
		expect(res.status).toBe(200);
	});

	test("POST /analyze without provider returns summary", async () => {
		const res = await request(port, "POST", "/api/tool-executions/analyze", {});
		expect(res.status).toBe(200);
		expect(res.data.analysis || res.data.error).toBeTruthy();
	});
});

// ─── IPC Proxy Route Mapping Tests ──────────────────────────
//
// Verifies that every IPC channel used by the preload script
// has a corresponding mapping in ipc-proxy.ts.

describe("ipc-proxy route mapping completeness", () => {
	// v0.8 (§11.5 cleanup): derive ROUTE_MAP from ipc-proxy.ts source so the
	// test stays in sync as channels are added/removed (previously a hand-
	// maintained literal that rotted whenever preload gained a new channel —
	// the original rest-routers failures). Each entry in ipc-proxy.ts has the
	// shape `"<channel>": { method: "GET"|"POST"|..., path: "/api/...", buildReq: ... }`.
	// We parse that with a tolerant regex.
	const ROUTE_MAP: Record<string, { method: string; path: string }> = (() => {
		const fs = require("fs") as typeof import("fs");
		const src = fs.readFileSync("src/main/ipc-proxy.ts", "utf-8");
		const out: Record<string, { method: string; path: string }> = {};
		// Match:  "<channel>":  { method: "GET", path: "/api/...",
		// Tolerant to leading whitespace / tabs (file uses tabs). Channel names
		// are kebab-case but may carry camelCase suffixes (e.g. getResourceUsage),
		// so the name char class includes uppercase.
		const re = /^\s*"([a-zA-Z][a-zA-Z0-9:-]*)":\s*\{\s*method:\s*"(GET|POST|PUT|DELETE)"\s*,\s*path:\s*"(\/[^"]+)"/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(src)) !== null) {
			out[m[1]] = { method: m[2], path: m[3] };
		}
		return out;
	})();

	// Channels handled locally by Electron (not proxied to HTTP)
	const LOCAL_CHANNELS = new Set([
		"dialog:openDirectory",
		"webfetch:login",
		"window:minimize",
		"window:maximize",
		"window:close",
		// M3: orchestrate plan-gate is handled by a dedicated IPC handler
		// (orchestrate-handlers.ts) — it owns the ConfirmRegistry singleton in
		// the main process and must not be proxied to the REST surface.
		"orchestrate:pending",
		"orchestrate:plan",
		"orchestrate:confirm",
		"orchestrate:reject",
		// M4: PM discuss-doc + coverage channels are handled by dedicated IPC
		// handlers (pm-handlers.ts); they touch PmService + RequirementDocStore
		// directly and are not proxied to the REST surface.
		"requirements:doc:read",
		"requirements:doc:write",
		"requirements:doc:list",
		"pm:createRequirement",
		"pm:openDiscuss",
		"pm:coverageView",
		"pm:coverageVerdict",
	]);

	// Channels that use ipcRenderer.invoke but are event-like (not proxied)
	const INVOKE_BUT_NOT_PROXIED = new Set([
		"app:ready",         // polled via /api/ready, not a direct proxy
		"templates:github-preview",   // WS streaming, complex
		"templates:import-github",    // WS streaming, complex
	]);

	test("every preload invoke channel has a proxy mapping or is local", async () => {
		// Extract all invoke channels from preload
		const preloadSource = await import("fs").then(fs =>
			fs.readFileSync("src/preload/index.ts", "utf-8")
		);
		const invokeChannels = [...preloadSource.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)]
			.map(m => m[1]);

		// Filter out local-only and event-like channels
		const proxiedChannels = invokeChannels.filter(ch =>
			!LOCAL_CHANNELS.has(ch) && !INVOKE_BUT_NOT_PROXIED.has(ch)
		);

		for (const channel of proxiedChannels) {
			expect(
				ROUTE_MAP[channel],
				`Channel "${channel}" from preload has no proxy mapping`
			).toBeDefined();
		}
	});

	test("every proxy mapping has a valid HTTP method and path", async () => {
		for (const [channel, route] of Object.entries(ROUTE_MAP)) {
			expect(route.method).toMatch(/^(GET|POST|PUT|DELETE)$/);
			expect(route.path).toMatch(/^\//);
		}
	});

	test("ipc-proxy source contains all ROUTE_MAP channels", async () => {
		const proxySource = await import("fs").then(fs =>
			fs.readFileSync("src/main/ipc-proxy.ts", "utf-8")
		);

		for (const channel of Object.keys(ROUTE_MAP)) {
			expect(
				proxySource.includes(`"${channel}"`),
				`Channel "${channel}" not found in ipc-proxy.ts source`
			).toBe(true);
		}
	});

	test("buildReq extracts correct params from ipc-proxy source", async () => {
		const proxySource = await import("fs").then(fs =>
			fs.readFileSync("src/main/ipc-proxy.ts", "utf-8")
		);

		// Verify key channels exist with correct method + path patterns
		expect(proxySource).toContain('"agents:get"');
		expect(proxySource).toContain('"chat:send"');
		expect(proxySource).toContain('"sessions:switch"');
		expect(proxySource).toContain('"messages:edit"');
		expect(proxySource).toContain('"tool:execute"');

		// Verify the R map has the right structure (method + path + buildReq)
		const routeCount = (proxySource.match(/buildReq:/g) || []).length;
		expect(routeCount).toBeGreaterThanOrEqual(Object.keys(ROUTE_MAP).length);
	});

	// v0.8 (sub2 fix verification): ipc-proxy MUST surface backend non-2xx as a
	// rejection (so renderer `await ipcRenderer.invoke` throws). Previously the
	// proxy always resolved, swallowing 4xx/5xx bodies — this let optimistic
	// callers (e.g. agent delete → agentStore.remove) advance on failure. The
	// fix is twofold: (a) `if (!resp.ok) throw new Error(...)` right after
	// `await fetch`, and (b) the outer `catch` rethrows instead of returning
	// `{error}`. Source-level contract since ipc-proxy.ts imports `electron`
	// (ipcMain/BrowserWindow) + `ws`, which makes a full unit harness expensive.
	test("ipc-proxy rejects on non-2xx (resp.ok check + rethrow, no {error} return)", async () => {
		const fs = await import("fs");
		const proxySource = fs.readFileSync("src/main/ipc-proxy.ts", "utf-8");

		// (a) Right after fetch + text(), check resp.ok and throw.
		expect(proxySource).toContain("resp.ok");
		expect(proxySource).toMatch(/if\s*\(\s*!\s*resp\.ok\s*\)\s*\{[\s\S]*?throw\s+new\s+Error/);

		// The thrown error must carry status so the UI can branch on it.
		expect(proxySource).toContain("resp.status");

		// (b) The outer catch block must rethrow, not return {error}.
		// Match: `} catch (err: any) { ... throw err; }` — and assert the
		// catch body does NOT `return { error` (the old swallow-the-failure
		// shape).
		expect(proxySource).toMatch(/catch\s*\(\s*err:\s*any\s*\)\s*\{[\s\S]*?throw\s+err\s*;?\s*\}/);
		expect(proxySource).not.toContain("return { error"); // legacy shape removed
	});

	// v0.8 (sub2 fix verification): agentStore.remove depends on the reject
	// contract above — the optimistic UI filter only runs if agentsDelete
	// resolves. Sanity-check the store source still awaits before mutating.
	test("agent-store.remove awaits delete before optimistic UI update", async () => {
		const fs = await import("fs");
		const store = fs.readFileSync("src/renderer/store/agent-store.ts", "utf-8");

		// remove must: (1) await agentsDelete, (2) only then set the filter.
		// If a future refactor reordered these, the fix would silently regress.
		const removeBlock = store.match(/remove:\s*async\s*\([\s\S]*?\n\t\},/);
		expect(removeBlock, "agent-store.remove block not found").not.toBeNull();
		const body = removeBlock![0];
		const awaitIdx = body.indexOf("await api().agentsDelete");
		const filterIdx = body.indexOf(".filter(");
		expect(awaitIdx, "remove must await api().agentsDelete").toBeGreaterThan(-1);
		expect(filterIdx, "remove must call .filter to drop the agent").toBeGreaterThan(-1);
		expect(awaitIdx, "agentsDelete must precede the optimistic filter").toBeLessThan(filterIdx);
	});

	// v0.8 §11.5 debt-1 contract: agent-as-tool channels MUST be absent from
	// both ROUTE_MAP (derived from ipc-proxy source) and preload. Catches any
	// accidental re-introduction of the retired /api/agent-tools surface.
	test("agent-as-tool channels are retired (not in ROUTE_MAP or preload)", async () => {
		const retired = [
			"agent-tools:list",
			"agent-tools:get",
			"agent-tools:get-by-agent",
			"agent-tools:create",
			"agent-tools:update",
			"agent-tools:delete",
		];
		for (const ch of retired) {
			expect(
				ROUTE_MAP[ch],
				`retired channel "${ch}" must not appear in ROUTE_MAP`,
			).toBeUndefined();
		}

		const preloadSource = await import("fs").then(fs =>
			fs.readFileSync("src/preload/index.ts", "utf-8")
		);
		expect(
			preloadSource,
			"preload must not reference the retired agentToolsList/Get/Create family",
		).not.toMatch(/agentTools(List|Get|GetByAgent|Create|Update|Delete)/);
	});
});

// v0.8 §11.5 debt-1 contract: the agent_tools table is dropped (idempotent)
// and the runtime never instantiates AgentToolStore. Verified by sourcing
// db-migration.ts source.
describe("agent-as-tool retirement: db-migration + ask-user endpoint", () => {
	test("db-migration drops agent_tools idempotently and has no AGENT_TOOL_COLUMNS", async () => {
		const fs = await import("fs");
		const src = fs.readFileSync("src/server/db-migration.ts", "utf-8");

		// The DROP must be present and use IF EXISTS (idempotent for fresh DBs
		// that never had the table, and for already-dropped upgraded DBs).
		expect(src).toMatch(/DROP TABLE IF EXISTS agent_tools/);

		// The retired column block must be gone.
		expect(src).not.toMatch(/AGENT_TOOL_COLUMNS/);

		// No SqliteStore instance for agent_tools survives.
		expect(src).not.toMatch(/new SqliteStore<[^>]*>\(db,\s*"agent_tools"/);
	});

	test("ask-user:respond endpoint is wired (POST /api/ask-user/respond)", async () => {
		// v0.8 §11.5 debt-2 contract: the new ask-user response bridge must
		// exist in ROUTE_MAP with the right method+path so preload's
		// askUserRespond round-trips through ipc-proxy to the server endpoint.
		const fs = await import("fs");
		const proxySrc = fs.readFileSync("src/main/ipc-proxy.ts", "utf-8");
		expect(proxySrc).toContain('"ask-user:respond"');
		expect(proxySrc).toContain('"/api/ask-user/respond"');

		const serverSrc = fs.readFileSync("src/server/index.ts", "utf-8");
		expect(
			serverSrc,
			"server must register POST /api/ask-user/respond that calls pendingResponses.resolveRequest",
		).toMatch(/app\.post\(["']\/api\/ask-user\/respond["']/);
		expect(serverSrc).toContain("pendingResponses.resolveRequest");
	});
});

// ─── Backend Spawn Protocol Tests ───────────────────────────
//
// Tests the backend subprocess protocol: port parsing,
// readiness reporting, and shutdown command.

describe("backend protocol", () => {
	test("parsePort extracts port from --port=N", async () => {
		// Test the backend module's port parsing logic by importing and checking behavior
		const { execFileSync } = await import("child_process");
		// Can't directly test backend.ts since it requires DB, but test port parsing logic
		const parseArg = (args: string[]): number => {
			const arg = args.find(a => a.startsWith("--port="));
			if (arg) return parseInt(arg.split("=")[1], 10);
			return 0;
		};
		expect(parseArg(["--port=8080"])).toBe(8080);
		expect(parseArg(["--port=0"])).toBe(0);
		expect(parseArg([])).toBe(0);
		expect(parseArg(["--other"])).toBe(0);
	});

	test("readiness message format", () => {
		const msg = { type: "ready", port: 12345, pid: 6789 };
		const line = JSON.stringify(msg);
		const parsed = JSON.parse(line);
		expect(parsed.type).toBe("ready");
		expect(parsed.port).toBe(12345);
		expect(parsed.pid).toBe(6789);
	});

	test("shutdown command format", () => {
		const msg = { type: "shutdown" };
		const line = JSON.stringify(msg);
		const parsed = JSON.parse(line);
		expect(parsed.type).toBe("shutdown");
	});
});

// ─── Session Router Route Ordering Tests ────────────────────
//
// Verifies that /metrics is not captured by /:agentId param route.

describe("session-router route ordering", () => {
	const sessionDb = mockSessionDb();
	const agentService = mockAgentService(sessionDb);
	const agentStore = { get: vi.fn(() => null) } as any;

	let app: Express;
	let server: Server;
	let port: number;

	beforeEach(async () => {
		Object.assign(sessionDb, mockSessionDb());
		app = express();
		app.use(express.json());
		const { createSessionRouter } = await import("../../src/server/session-router.js");
		app.use("/api/sessions", createSessionRouter({ agentService, agentStore }));
		const result = await listen(app);
		server = result.server;
		port = result.port;
	});

	afterEach(async () => { await close(server); });

	test("GET /metrics is not captured by /:agentId", async () => {
		const res = await request(port, "GET", "/api/sessions/metrics");
		expect(res.status).toBe(200);
		// Should return metrics object, not a session list
		expect(res.data.totalSessions).toBe(0);
		expect(Array.isArray(res.data)).toBe(false);
	});

	test("GET /metrics returns correct default structure", async () => {
		const res = await request(port, "GET", "/api/sessions/metrics");
		expect(res.data).toHaveProperty("totalSessions");
		expect(res.data).toHaveProperty("activeSessions");
		expect(res.data).toHaveProperty("busySessions");
		expect(res.data).toHaveProperty("idleSessions");
		expect(res.data).toHaveProperty("totalTurns");
		expect(res.data).toHaveProperty("totalToolCalls");
	});
});

// ─── Log Router Config Persistence Tests ────────────────────

describe("log-router config persistence", () => {
	const sessionDb = mockSessionDb();
	let app: Express;
	let server: Server;
	let port: number;

	beforeEach(async () => {
		app = express();
		app.use(express.json());
		const { createLogRouter } = await import("../../src/server/log-router.js");
		app.use("/api/logs", createLogRouter({ sessionDb }));
		const result = await listen(app);
		server = result.server;
		port = result.port;
	});

	afterEach(async () => { await close(server); });

	test("config round-trips through get/set", async () => {
		// Set config
		const config = { enabled: true, retentionDays: 14, globalLevel: "warn" };
		const setRes = await request(port, "PUT", "/api/logs/config", config);
		expect(setRes.status).toBe(200);
		expect(setRes.data.success).toBe(true);

		// Get config back
		const getRes = await request(port, "GET", "/api/logs/config");
		expect(getRes.status).toBe(200);
		expect(getRes.data.enabled).toBe(true);
		expect(getRes.data.retentionDays).toBe(14);
		expect(getRes.data.globalLevel).toBe("warn");
	});
});


// ─── MCP Presets Tests ──────────────────────────────────────

describe("mcp-presets", () => {
	test("MCP_PRESETS has 4 Z.AI presets", async () => {
		const { MCP_PRESETS } = await import("../../src/server/mcp-presets.js");
		expect(MCP_PRESETS.length).toBe(4);
		for (const p of MCP_PRESETS) {
			expect(p).toHaveProperty("id");
			expect(p).toHaveProperty("name");
			expect(p).toHaveProperty("category", "Z.AI");
			expect(p).toHaveProperty("envKeys");
			expect(p.envKeys).toContain("Z_AI_API_KEY");
		}
	});

	test("buildPresetConfig builds stdio config with env", async () => {
		const { MCP_PRESETS, buildPresetConfig } = await import("../../src/server/mcp-presets.js");
		const vision = MCP_PRESETS.find((p) => p.id === "zai-vision")!;
		const config = buildPresetConfig(vision, { Z_AI_API_KEY: "test-key-123" });
		expect(config.transport).toBe("stdio");
		expect(config.command).toBe("npx");
		expect(config.env?.Z_AI_API_KEY).toBe("test-key-123");
		expect(config.env?.Z_AI_MODE).toBe("ZHIPU");
	});

	test("buildPresetConfig builds HTTP config with auth header", async () => {
		const { MCP_PRESETS, buildPresetConfig } = await import("../../src/server/mcp-presets.js");
		const search = MCP_PRESETS.find((p) => p.id === "zai-web-search")!;
		const config = buildPresetConfig(search, { Z_AI_API_KEY: "test-key-456" });
		expect(config.transport).toBe("streamable-http");
		expect(config.url).toContain("open.bigmodel.cn");
		expect(config.headers?.Authorization).toBe("Bearer test-key-456");
	});
});

// ─── MCP Router Integration Tests ──────────────────────────

describe("mcp-router", () => {
	const servers: Server[] = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map(close));
	});

	async function setupMcpRouter(): Promise<{ port: number; mcpManager: any; store: any[] }> {
		const { createMcpRouter } = await import("../../src/server/mcp-router.js");
		const app = express();

		const store: any[] = [];
		let nextId = 1;
		const mcpStore = {
			list: () => store,
			get: (id: string) => store.find((s) => s.id === id),
			create: (input: any) => {
				const record = { id: String(nextId++), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input };
				store.push(record);
				return record;
			},
			delete: (id: string) => {
				const idx = store.findIndex((s) => s.id === id);
				if (idx >= 0) store.splice(idx, 1);
			},
			update: (id: string, input: any) => {
				const record = store.find((s) => s.id === id);
				if (record) Object.assign(record, input, { updatedAt: new Date().toISOString() });
				return record;
			},
		};
		const mcpManager = {
			connect: vi.fn().mockResolvedValue({ tools: [], error: undefined }),
			disconnect: vi.fn().mockResolvedValue(undefined),
			testConnection: vi.fn().mockResolvedValue({ tools: [{ name: "test-tool" }], error: undefined }),
			isConnected: vi.fn().mockReturnValue(false),
			getConnectedServers: vi.fn().mockReturnValue([]),
		};

		app.use(express.json());
		app.use("/api/mcp", createMcpRouter(mcpStore, mcpManager as any));
		const { server, port } = await listen(app);
		servers.push(server);
		return { port, mcpManager, store };
	}

	test("GET /presets returns preset list", async () => {
		const { port } = await setupMcpRouter();
		const res = await request(port, "GET", "/api/mcp/presets");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
		expect(res.data.length).toBe(4);
		expect(res.data[0]).toHaveProperty("id", "zai-vision");
	});

	test("POST /add-preset creates server from preset", async () => {
		const { port, store } = await setupMcpRouter();
		const res = await request(port, "POST", "/api/mcp/add-preset", {
			presetId: "zai-vision",
			envValues: { Z_AI_API_KEY: "my-test-key" },
		});
		expect(res.status).toBe(201);
		expect(res.data.name).toBe("Z.AI Vision");
		expect(res.data.transport).toBe("stdio");
		expect(store.length).toBe(1);
	});

	test("POST /add-preset returns 404 for unknown preset", async () => {
		const { port } = await setupMcpRouter();
		const res = await request(port, "POST", "/api/mcp/add-preset", {
			presetId: "nonexistent",
			envValues: {},
		});
		expect(res.status).toBe(404);
	});

	test("GET /status returns connected servers", async () => {
		const { port, mcpManager } = await setupMcpRouter();
		mcpManager.getConnectedServers.mockReturnValue([{ id: "x", name: "test", connected: true, toolCount: 3 }]);
		const res = await request(port, "GET", "/api/mcp/status");
		expect(res.status).toBe(200);
		expect(res.data.length).toBe(1);
	});

	test("POST /test tests connection config", async () => {
		const { port, mcpManager } = await setupMcpRouter();
		mcpManager.testConnection.mockResolvedValue({ tools: [{ name: "analyze" }], error: undefined });
		const res = await request(port, "POST", "/api/mcp/test", {
			name: "test",
			transport: "stdio",
			command: "npx",
		});
		expect(res.status).toBe(200);
		expect(res.data.tools.length).toBe(1);
	});

	test("GET /presets is not intercepted by /:id", async () => {
		const { port } = await setupMcpRouter();
		const res = await request(port, "GET", "/api/mcp/presets");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("GET /status is not intercepted by /:id", async () => {
		const { port } = await setupMcpRouter();
		const res = await request(port, "GET", "/api/mcp/status");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});
});

describe("memory-node-router", () => {
	const servers: Server[] = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map(close));
	});

	async function setupMemoryRouter(nodes: any[] = []) {
		const { createMemoryNodeRouter } = await import("../../src/server/memory-node-router.js");
		const app = express();

		const nodeMap = new Map(nodes.map((n) => [n.id, n]));
		const store = {
			getRecentNodes: (limit: number) => nodes.slice(0, limit),
			getNodesForSubject: (subject: string) => nodes.filter((n) => n.subject === subject),
			getSubject: (subject: string) => {
				const subjectNodes = nodes.filter((n) => n.subject === subject);
				return subjectNodes.length > 0 ? { subject, nodeCount: subjectNodes.length, kind: null, summary: null, createdAt: subjectNodes[0].createdAt, updatedAt: subjectNodes[0].updatedAt } : null;
			},
			searchNodes: (query: string, limit: number) => {
				const q = query.toLowerCase();
				return nodes
					.filter((n) => n.subject.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
					.slice(0, limit)
					.map((n) => ({ node: n, subject: null }));
			},
			deleteNode: (id: string) => { nodeMap.delete(id); const idx = nodes.findIndex((n) => n.id === id); if (idx >= 0) nodes.splice(idx, 1); },
		};

		app.use(express.json());
		app.use("/api/memory-nodes", createMemoryNodeRouter(store as any));
		const { server, port } = await listen(app);
		servers.push(server);
		return { server, port, store, nodes };
	}

	const testNode = { id: "n1", subject: "ProjectX", type: "decision", content: "Decided to use SQLite for storage.", sessionId: null, sourceSeq: null, evolvedFrom: null, createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z" };

	test("GET /nodes returns empty list initially", async () => {
		const { port } = await setupMemoryRouter();
		const res = await request(port, "GET", "/api/memory-nodes/nodes");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
		expect(res.data.length).toBe(0);
	});

	test("GET /subjects returns empty list initially", async () => {
		const { port } = await setupMemoryRouter();
		const res = await request(port, "GET", "/api/memory-nodes/subjects");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
	});

	test("GET /search returns empty without results", async () => {
		const { port } = await setupMemoryRouter();
		const res = await request(port, "GET", "/api/memory-nodes/search?q=test");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
		expect(res.data.length).toBe(0);
	});

	test("GET /nodes returns inserted nodes", async () => {
		const { port } = await setupMemoryRouter([testNode]);
		const res = await request(port, "GET", "/api/memory-nodes/nodes");
		expect(res.status).toBe(200);
		expect(res.data.length).toBe(1);
		expect(res.data[0].subject).toBe("ProjectX");
	});

	test("GET /subjects aggregates nodes by subject", async () => {
		const { port } = await setupMemoryRouter([testNode]);
		const res = await request(port, "GET", "/api/memory-nodes/subjects");
		expect(res.status).toBe(200);
		expect(res.data.length).toBe(1);
		expect(res.data[0].subject).toBe("ProjectX");
		expect(res.data[0].nodeCount).toBe(1);
	});

	test("GET /search?q= finds matching nodes", async () => {
		const { port } = await setupMemoryRouter([testNode]);
		const res = await request(port, "GET", "/api/memory-nodes/search?q=SQLite");
		expect(res.status).toBe(200);
		expect(res.data.length).toBe(1);
		expect(res.data[0].content).toContain("SQLite");
	});

	test("GET /subject/:name returns nodes for subject", async () => {
		const { port } = await setupMemoryRouter([testNode]);
		const res = await request(port, "GET", "/api/memory-nodes/subject/ProjectX");
		expect(res.status).toBe(200);
		expect(res.data.nodes.length).toBe(1);
		expect(res.data.subject).not.toBeNull();
	});

	test("DELETE /nodes/:id deletes a node", async () => {
		const { port, nodes } = await setupMemoryRouter([testNode]);
		const res = await request(port, "DELETE", "/api/memory-nodes/nodes/n1");
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
		expect(nodes.length).toBe(0);
	});
});

describe("memory-config", () => {
	const servers: Server[] = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map(close));
	});

	async function setupConfigRouter() {
		const { createConfigRouter } = await import("../../src/server/config-router.js");
		const app = express();

		const configData: Record<string, any> = {};
		const kv = {
			getJson: (key: string) => configData[key] ?? null,
			setJson: (key: string, value: any) => { configData[key] = value; },
		};

		const sessionDB = { getKVStore: () => kv } as any;
		const registry = { getAll: () => [], getToolConfig: () => ({}) } as any;

		app.use(express.json());
		app.use("/api/config", createConfigRouter({
			sessionDB,
			registry,
			buildDefaultPrompt: () => "",
		}));
		const { server, port } = await listen(app);
		servers.push(server);
		return { server, port, configData };
	}

	test("GET /memory-config returns defaults", async () => {
		const { port } = await setupConfigRouter();
		const res = await request(port, "GET", "/api/config/memory-config");
		expect(res.status).toBe(200);
		expect(res.data.compression).toBeDefined();
		expect(res.data.memory).toBeDefined();
		expect(res.data.compression.enabled).toBe(false);
	}, 15_000);

	test("PUT /memory-config saves and reads back", async () => {
		const { port } = await setupConfigRouter();

		const update = await request(port, "PUT", "/api/config/memory-config", {
			compression: { enabled: true, keepRecentTurns: 3 },
			memory: { enabled: true, autoRecall: true },
		});
		expect(update.status).toBe(200);
		expect(update.data.success).toBe(true);

		const res = await request(port, "GET", "/api/config/memory-config");
		expect(res.data.compression.enabled).toBe(true);
		expect(res.data.compression.keepRecentTurns).toBe(3);
		expect(res.data.memory.enabled).toBe(true);
	}, 15_000);
});
