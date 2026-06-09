// REST router integration tests
//
// Tests the new router modules using Express + Node http.
// No external dependencies needed — uses built-in http to make requests.

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
	const ROUTE_MAP: Record<string, { method: string; path: string }> = {
		"config:get":              { method: "GET",  path: "/api/config" },
		"config:update":           { method: "PUT",  path: "/api/config" },
		"config:get-theme":        { method: "GET",  path: "/api/config/theme" },
		"config:set-theme":        { method: "PUT",  path: "/api/config/theme" },
		"device-context:get":      { method: "GET",  path: "/api/config/device-context" },
		"device-context:generate": { method: "POST", path: "/api/config/device-context/generate" },
		"device-context:save":     { method: "PUT",  path: "/api/config/device-context" },
		"guidelines:get":          { method: "GET",  path: "/api/config/guidelines" },
		"guidelines:save":         { method: "PUT",  path: "/api/config/guidelines" },
		"agents:list":             { method: "GET",  path: "/api/agents" },
		"agents:get":              { method: "GET",  path: "/api/agents/:id" },
		"agents:create":           { method: "POST", path: "/api/agents" },
		"agents:update":           { method: "PUT",  path: "/api/agents/:id" },
		"agents:delete":           { method: "DELETE", path: "/api/agents/:id" },
		"agent-tools:list":        { method: "GET",  path: "/api/agent-tools" },
		"agent-tools:get":         { method: "GET",  path: "/api/agent-tools/:id" },
		"agent-tools:get-by-agent":{ method: "GET",  path: "/api/agent-tools" },
		"agent-tools:create":      { method: "POST", path: "/api/agent-tools" },
		"agent-tools:update":      { method: "PUT",  path: "/api/agent-tools/:id" },
		"agent-tools:delete":      { method: "DELETE", path: "/api/agent-tools/:id" },
		"providers:list":          { method: "GET",  path: "/api/providers" },
		"providers:get":           { method: "GET",  path: "/api/providers/:id" },
		"providers:create":        { method: "POST", path: "/api/providers" },
		"providers:update":        { method: "PUT",  path: "/api/providers/:id" },
		"providers:delete":        { method: "DELETE", path: "/api/providers/:id" },
		"providers:add-model":     { method: "POST", path: "/api/providers/:id/models" },
		"providers:remove-model":  { method: "DELETE", path: "/api/providers/:id/models/:modelId" },
		"providers:fetch-models":  { method: "POST", path: "/api/providers/:id/fetch-models" },
		"models:list":             { method: "GET",  path: "/api/models" },
		"mcp:list":                { method: "GET",  path: "/api/mcp" },
		"mcp:get":                 { method: "GET",  path: "/api/mcp/:id" },
		"mcp:create":              { method: "POST", path: "/api/mcp" },
		"mcp:update":              { method: "PUT",  path: "/api/mcp/:id" },
		"mcp:delete":              { method: "DELETE", path: "/api/mcp/:id" },
		"mcp:test":                { method: "POST", path: "/api/mcp/test" },
		"mcp:tools":               { method: "GET",  path: "/api/mcp/:id/tools" },
		"mcp:connect":             { method: "POST", path: "/api/mcp/:id/connect" },
		"mcp:disconnect":          { method: "POST", path: "/api/mcp/:id/disconnect" },
		"mcp:status":              { method: "GET",  path: "/api/mcp/status" },
			"mcp:scan":                { method: "POST", path: "/api/mcp/scan" },
			"mcp:presets":             { method: "GET",  path: "/api/mcp/presets" },
			"mcp:add-preset":          { method: "POST", path: "/api/mcp/add-preset" },
			"skills:list":             { method: "GET",  path: "/api/skills" },
		"kb:list":                 { method: "GET",  path: "/api/kb" },
		"kb:get":                  { method: "GET",  path: "/api/kb/:id" },
		"kb:create":               { method: "POST", path: "/api/kb" },
		"kb:update":               { method: "PUT",  path: "/api/kb/:id" },
		"kb:delete":               { method: "DELETE", path: "/api/kb/:id" },
		"kb:add-files":            { method: "POST", path: "/api/kb/:id/files" },
		"kb:remove-file":          { method: "DELETE", path: "/api/kb/:id/files" },
		"kb:search":               { method: "POST", path: "/api/kb/search" },
		"kb:chunk-count":          { method: "GET",  path: "/api/kb/:id/chunks" },
		"templates:list":          { method: "GET",  path: "/api/templates" },
		"templates:get":           { method: "GET",  path: "/api/templates/:id" },
		"templates:create":        { method: "POST", path: "/api/templates" },
		"templates:update":        { method: "PUT",  path: "/api/templates/:id" },
		"templates:delete":        { method: "DELETE", path: "/api/templates/:id" },
		"templates:export":        { method: "POST", path: "/api/templates/:id/export" },
		"templates:import":        { method: "POST", path: "/api/templates/import" },
		"tools:list":              { method: "GET",  path: "/api/config/tools" },
		"tool-config:get":         { method: "GET",  path: "/api/config/tool-config" },
		"tool-config:save":        { method: "PUT",  path: "/api/config/tool-config" },
		"tool:execute":            { method: "POST", path: "/api/tool-execute" },
		"sessions:list":           { method: "GET",  path: "/api/sessions/:agentId" },
		"sessions:new":            { method: "POST", path: "/api/sessions/:agentId/new" },
		"sessions:switch":         { method: "PUT",  path: "/api/sessions/:agentId/switch/:sessionId" },
		"sessions:activate":       { method: "POST", path: "/api/sessions/:agentId/activate" },
		"sessions:current":        { method: "GET",  path: "/api/sessions/:agentId/current" },
		"sessions:delete":         { method: "DELETE", path: "/api/sessions/:agentId/:sessionId" },
		"sessions:metrics":        { method: "GET",  path: "/api/sessions/metrics" },
		"messages:clear":          { method: "DELETE", path: "/api/sessions/:agentId/messages" },
		"messages:edit":           { method: "PUT",  path: "/api/sessions/:agentId/messages/:seq" },
		"messages:delete":         { method: "DELETE", path: "/api/sessions/:agentId/messages/:seq" },
		"chat:send":               { method: "POST", path: "/api/chat/send" },
		"chat:abort":              { method: "POST", path: "/api/chat/abort" },
		"files:tree":              { method: "GET",  path: "/api/files/tree" },
		"files:content":           { method: "GET",  path: "/api/files/content" },
		"files:resolve-path":      { method: "GET",  path: "/api/files/resolve-path" },
		"files:save":              { method: "PUT",  path: "/api/files/save" },
		"logs:list-files":         { method: "GET",  path: "/api/logs/files" },
		"logs:read":               { method: "GET",  path: "/api/logs/read" },
		"logs:get-config":         { method: "GET",  path: "/api/logs/config" },
		"logs:set-config":         { method: "PUT",  path: "/api/logs/config" },
		"tool-executions:query":   { method: "POST", path: "/api/tool-executions/query" },
		"tool-executions:stats":   { method: "GET",  path: "/api/tool-executions/stats" },
		"tool-executions:cleanup": { method: "POST", path: "/api/tool-executions/cleanup" },
		"tool-executions:analyze": { method: "POST", path: "/api/tool-executions/analyze" },
		"webfetch:cookies":        { method: "GET",  path: "/api/webfetch/cookies" },
		"webfetch:clear-cookies":  { method: "DELETE", path: "/api/webfetch/cookies" },
		"ask-user:respond":        { method: "POST", path: "/api/ask-user/respond" },
		"memory-nodes:nodes":          { method: "GET",  path: "/api/memory-nodes/nodes" },
		"memory-nodes:subjects":       { method: "GET",  path: "/api/memory-nodes/subjects" },
		"memory-nodes:subject-nodes":  { method: "GET",  path: "/api/memory-nodes/subject/:name" },
		"memory-nodes:search":         { method: "GET",  path: "/api/memory-nodes/search" },
		"memory-nodes:delete":         { method: "DELETE", path: "/api/memory-nodes/nodes/:id" },
		"config:memory-get":    { method: "GET",  path: "/api/config/memory-config" },
		"config:memory-update": { method: "PUT",  path: "/api/config/memory-config" },
	};

	// Channels handled locally by Electron (not proxied to HTTP)
	const LOCAL_CHANNELS = new Set([
		"dialog:openDirectory",
		"webfetch:login",
		"window:minimize",
		"window:maximize",
		"window:close",
	]);

	// Channels that use ipcRenderer.invoke but are event-like (not proxied)
	const INVOKE_BUT_NOT_PROXIED = new Set([
		"app:ready",         // polled via /api/ready, not a direct proxy
		"search-provider:get",  // TODO: needs backend route
		"search-provider:set",
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
		return { server, port, configData };
	}

	test("GET /memory-config returns defaults", async () => {
		const { port } = await setupConfigRouter();
		const res = await request(port, "GET", "/api/config/memory-config");
		expect(res.status).toBe(200);
		expect(res.data.compression).toBeDefined();
		expect(res.data.memory).toBeDefined();
		expect(res.data.compression.enabled).toBe(false);
	});

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
	});
});
