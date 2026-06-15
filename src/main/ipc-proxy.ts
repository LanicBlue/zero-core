// IPC → HTTP/WS 桥接层
//
// 将 Electron IPC 通道映射到后端子进程的 HTTP API。
// 49 个 IPC 通道中 47 个走 HTTP 代理，2 个（dialog, webfetch:login）在本地处理。

import { ipcMain, type BrowserWindow } from "electron";
import WebSocket from "ws";
import { log } from "../core/logger.js";

// ─── IPC → HTTP 映射表 ─────────────────────────────────────

interface RouteMapping {
	method: "GET" | "POST" | "PUT" | "DELETE";
	path: string;
	/** Extract path params and body from IPC args */
	buildReq: (...args: any[]) => { params?: Record<string, string>; body?: any; query?: Record<string, string> };
}

const R: Record<string, RouteMapping> = {
	// Config
	"config:get":              { method: "GET",  path: "/api/config", buildReq: () => ({}) },
	"config:update":           { method: "PUT",  path: "/api/config", buildReq: (data) => ({ body: data }) },
	"config:get-theme":        { method: "GET",  path: "/api/config/theme", buildReq: () => ({}) },
	"config:set-theme":        { method: "PUT",  path: "/api/config/theme", buildReq: (data) => ({ body: data }) },
	"device-context:get":      { method: "GET",  path: "/api/config/device-context", buildReq: () => ({}) },
	"device-context:generate": { method: "POST", path: "/api/config/device-context/generate", buildReq: () => ({}) },
	"device-context:save":     { method: "PUT",  path: "/api/config/device-context", buildReq: (content) => ({ body: { content } }) },
	"guidelines:get":          { method: "GET",  path: "/api/config/guidelines", buildReq: () => ({}) },
	"guidelines:save":         { method: "PUT",  path: "/api/config/guidelines", buildReq: (guidelines) => ({ body: guidelines }) },

	// Agents
	"agents:list":    { method: "GET",  path: "/api/agents", buildReq: () => ({}) },
	"agents:get":     { method: "GET",  path: "/api/agents/:id", buildReq: (id) => ({ params: { id } }) },
	"agents:create":  { method: "POST", path: "/api/agents", buildReq: (input) => ({ body: input }) },
	"agents:update":  { method: "PUT",  path: "/api/agents/:id", buildReq: (id, input) => ({ params: { id }, body: input }) },
	"agents:delete":  { method: "DELETE", path: "/api/agents/:id", buildReq: (id) => ({ params: { id } }) },

	// Agent Tools
	"agent-tools:list":         { method: "GET", path: "/api/agent-tools", buildReq: () => ({}) },
	"agent-tools:get":          { method: "GET", path: "/api/agent-tools/:id", buildReq: (id) => ({ params: { id } }) },
	"agent-tools:get-by-agent": { method: "GET", path: "/api/agent-tools", buildReq: (agentId) => ({ query: { agentId } }) },
	"agent-tools:create":       { method: "POST", path: "/api/agent-tools", buildReq: (input) => ({ body: input }) },
	"agent-tools:update":       { method: "PUT", path: "/api/agent-tools/:id", buildReq: (id, input) => ({ params: { id }, body: input }) },
	"agent-tools:delete":       { method: "DELETE", path: "/api/agent-tools/:id", buildReq: (id) => ({ params: { id } }) },

	// Providers
	"providers:list":          { method: "GET", path: "/api/providers", buildReq: () => ({}) },
	"providers:get":           { method: "GET", path: "/api/providers/:id", buildReq: (id) => ({ params: { id } }) },
	"providers:create":        { method: "POST", path: "/api/providers", buildReq: (input) => ({ body: input }) },
	"providers:update":        { method: "PUT", path: "/api/providers/:id", buildReq: (id, input) => ({ params: { id }, body: input }) },
	"providers:delete":        { method: "DELETE", path: "/api/providers/:id", buildReq: (id) => ({ params: { id } }) },
	"providers:add-model":     { method: "POST", path: "/api/providers/:id/models", buildReq: (providerId, model) => ({ params: { id: providerId }, body: model }) },
	"providers:remove-model":  { method: "DELETE", path: "/api/providers/:id/models/:modelId", buildReq: (providerId, modelId) => ({ params: { id: providerId, modelId } }) },
	"providers:fetch-models":  { method: "GET", path: "/api/providers/:id/fetch-models", buildReq: (providerId) => ({ params: { id: providerId } }) },
	"models:list":             { method: "GET", path: "/api/models", buildReq: () => ({}) },

	// MCP
	"mcp:list":       { method: "GET", path: "/api/mcp", buildReq: () => ({}) },
	"mcp:get":        { method: "GET", path: "/api/mcp/:id", buildReq: (id) => ({ params: { id } }) },
	"mcp:create":     { method: "POST", path: "/api/mcp", buildReq: (input) => ({ body: input }) },
	"mcp:update":     { method: "PUT", path: "/api/mcp/:id", buildReq: (id, input) => ({ params: { id }, body: input }) },
	"mcp:delete":     { method: "DELETE", path: "/api/mcp/:id", buildReq: (id) => ({ params: { id } }) },
	"mcp:test":       { method: "POST", path: "/api/mcp/test", buildReq: (input) => ({ body: input }) },
	"mcp:tools":      { method: "GET", path: "/api/mcp/:id/tools", buildReq: (serverId) => ({ params: { id: serverId } }) },
	"mcp:connect":    { method: "POST", path: "/api/mcp/:id/connect", buildReq: (id) => ({ params: { id } }) },
	"mcp:disconnect": { method: "POST", path: "/api/mcp/:id/disconnect", buildReq: (id) => ({ params: { id } }) },
	"mcp:status":     { method: "GET", path: "/api/mcp/status", buildReq: () => ({}) },
	"mcp:scan":       { method: "POST", path: "/api/mcp/scan", buildReq: () => ({}) },
	"mcp:presets":    { method: "GET", path: "/api/mcp/presets", buildReq: () => ({}) },
	"mcp:add-preset": { method: "POST", path: "/api/mcp/add-preset", buildReq: (presetId, envValues) => ({ body: { presetId, envValues } }) },

	// Knowledge Base
	"kb:list":        { method: "GET", path: "/api/kb", buildReq: () => ({}) },
	"kb:get":         { method: "GET", path: "/api/kb/:id", buildReq: (id) => ({ params: { id } }) },
	"kb:create":      { method: "POST", path: "/api/kb", buildReq: (input) => ({ body: input }) },
	"kb:update":      { method: "PUT", path: "/api/kb/:id", buildReq: (id, input) => ({ params: { id }, body: input }) },
	"kb:delete":      { method: "DELETE", path: "/api/kb/:id", buildReq: (id) => ({ params: { id } }) },
	"kb:add-files":   { method: "POST", path: "/api/kb/:id/files", buildReq: (kbId, filePaths) => ({ params: { id: kbId }, body: { filePaths } }) },
	"kb:remove-file": { method: "DELETE", path: "/api/kb/:id/files", buildReq: (kbId, filePath) => ({ params: { id: kbId }, body: { filePath } }) },
	"kb:search":      { method: "POST", path: "/api/kb/search", buildReq: (kbIds, query) => ({ body: { kbIds, query } }) },
	"kb:chunk-count": { method: "GET", path: "/api/kb/:id/chunks", buildReq: (kbId) => ({ params: { id: kbId } }) },

	// Templates
	"templates:list":   { method: "GET", path: "/api/templates", buildReq: () => ({}) },
	"templates:get":    { method: "GET", path: "/api/templates/:id", buildReq: (id) => ({ params: { id } }) },
	"templates:create": { method: "POST", path: "/api/templates", buildReq: (input) => ({ body: input }) },
	"templates:update": { method: "PUT", path: "/api/templates/:id", buildReq: (id, input) => ({ params: { id }, body: input }) },
	"templates:delete": { method: "DELETE", path: "/api/templates/:id", buildReq: (id) => ({ params: { id } }) },
	"templates:export": { method: "POST", path: "/api/templates/:id/export", buildReq: (id) => ({ params: { id } }) },
	"templates:import": { method: "POST", path: "/api/templates/import", buildReq: (json) => ({ body: { json } }) },

	// Tools (list + config already in /api/config/tools)
	"tools:list":       { method: "GET", path: "/api/config/tools", buildReq: () => ({}) },
	"tool-config:get":  { method: "GET", path: "/api/config/tool-config", buildReq: () => ({}) },
	"tool-config:save": { method: "PUT", path: "/api/config/tool-config", buildReq: (config) => ({ body: config }) },
	"tool:execute":     { method: "POST", path: "/api/tool-execute", buildReq: ({ toolName, input }) => ({ body: { toolName, input } }) },

	// Sessions
	"sessions:list":    { method: "GET", path: "/api/sessions/:agentId", buildReq: (agentId) => ({ params: { agentId } }) },
	"sessions:new":     { method: "POST", path: "/api/sessions/:agentId/new", buildReq: (agentId) => ({ params: { agentId } }) },
	"sessions:switch":  { method: "PUT", path: "/api/sessions/:agentId/switch/:sessionId", buildReq: (agentId, sessionId) => ({ params: { agentId, sessionId } }) },
	"sessions:activate": { method: "POST", path: "/api/sessions/:agentId/activate", buildReq: (agentId, sessionId?) => ({ params: { agentId }, body: { sessionId } }) },
	"sessions:current": { method: "GET", path: "/api/sessions/:agentId/current", buildReq: (agentId) => ({ params: { agentId } }) },
	"sessions:delete":  { method: "DELETE", path: "/api/sessions/:agentId/:sessionId", buildReq: (agentId, sessionId) => ({ params: { agentId, sessionId } }) },
	"sessions:metrics": { method: "GET", path: "/api/sessions/metrics", buildReq: () => ({}) },

	// Messages
	"messages:clear":  { method: "DELETE", path: "/api/sessions/:agentId/messages", buildReq: (agentId) => ({ params: { agentId } }) },
	"messages:edit":   { method: "PUT", path: "/api/sessions/:agentId/messages/:seq", buildReq: (agentId, msgSeq, newText) => ({ params: { agentId, seq: String(msgSeq) }, body: { newText } }) },
	"messages:delete": { method: "DELETE", path: "/api/sessions/:agentId/messages/:seq", buildReq: (agentId, msgSeq) => ({ params: { agentId, seq: String(msgSeq) } }) },

	// Chat
	"chat:send":  { method: "POST", path: "/api/chat/send", buildReq: (text, agentId?, sessionId?) => ({ body: { text, agentId, sessionId } }) },
	"chat:abort": { method: "POST", path: "/api/chat/abort", buildReq: () => ({}) },

	// Files
	"files:tree":         { method: "GET", path: "/api/files/tree", buildReq: (root?) => ({ query: root ? { root } : {} }) },
	"files:content":      { method: "GET", path: "/api/files/content", buildReq: (filePath, root?) => ({ query: { path: filePath, ...(root ? { root } : {}) } }) },
	"files:resolve-path": { method: "GET", path: "/api/files/resolve-path", buildReq: (filePath, root?) => ({ query: { path: filePath, ...(root ? { root } : {}) } }) },
	"files:save":         { method: "PUT", path: "/api/files/save", buildReq: (filePath, content, root?) => ({ body: { filePath, content, root } }) },

	// Logs
	"logs:list-files": { method: "GET", path: "/api/logs/files", buildReq: () => ({}) },
	"logs:read":       { method: "GET", path: "/api/logs/read", buildReq: (filename, opts?) => ({ query: { filename, ...(opts?.level ? { level: opts.level } : {}), ...(opts?.lines ? { lines: String(opts.lines) } : {}) } }) },
	"logs:get-config": { method: "GET", path: "/api/logs/config", buildReq: () => ({}) },
	"logs:set-config": { method: "PUT", path: "/api/logs/config", buildReq: (config) => ({ body: config }) },

	// Tool Executions
	"tool-executions:query":   { method: "POST", path: "/api/tool-executions/query", buildReq: (filter) => ({ body: filter }) },
	"tool-executions:stats":   { method: "GET", path: "/api/tool-executions/stats", buildReq: (agentId?) => ({ query: agentId ? { agentId } : {} }) },
	"tool-executions:cleanup": { method: "POST", path: "/api/tool-executions/cleanup", buildReq: (maxAgeMs) => ({ body: { maxAgeMs } }) },
	"tool-executions:analyze": { method: "POST", path: "/api/tool-executions/analyze", buildReq: (agentId?) => ({ body: { agentId } }) },

	// WebFetch (login stays in Electron, cookies go to backend)
	"webfetch:cookies":       { method: "GET", path: "/api/webfetch/cookies", buildReq: () => ({}) },
	"webfetch:clear-cookies": { method: "DELETE", path: "/api/webfetch/cookies", buildReq: (domain?) => ({ query: domain ? { domain } : {} }) },

	// Skills
	"skills:list":    { method: "GET", path: "/api/skills", buildReq: () => ({}) },

		// Memory Nodes
		"memory-nodes:nodes":          { method: "GET", path: "/api/memory-nodes/nodes", buildReq: (limit?) => ({ query: limit ? { limit: String(limit) } : {} }) },
		"memory-nodes:subjects":       { method: "GET", path: "/api/memory-nodes/subjects", buildReq: () => ({}) },
		"memory-nodes:subject-nodes":  { method: "GET", path: "/api/memory-nodes/subject/:name", buildReq: (name) => ({ params: { name } }) },
		"memory-nodes:search":         { method: "GET", path: "/api/memory-nodes/search", buildReq: (q, limit?) => ({ query: { q, ...(limit ? { limit: String(limit) } : {}) } }) },
		"memory-nodes:delete":         { method: "DELETE", path: "/api/memory-nodes/nodes/:id", buildReq: (id) => ({ params: { id } }) },

		// Memory Config
		"config:memory-get":    { method: "GET", path: "/api/config/memory-config", buildReq: () => ({}) },
		"config:memory-update": { method: "PUT", path: "/api/config/memory-config", buildReq: (data) => ({ body: data }) },
	// Misc

		// ─── Projects (M1) ─────────────────────────────────
		"projects:list":           { method: "GET",    path: "/api/projects",                 buildReq: (filter?) => ({ query: filter ?? {} }) },
		"projects:get":            { method: "GET",    path: "/api/projects/:id",             buildReq: (id) => ({ params: { id } }) },
		"projects:create":         { method: "POST",   path: "/api/projects",                 buildReq: (input) => ({ body: input }) },
		"projects:update":         { method: "PUT",    path: "/api/projects/:id",             buildReq: (id, input) => ({ params: { id }, body: input }) },
		"projects:delete":         { method: "DELETE", path: "/api/projects/:id",             buildReq: (id) => ({ params: { id } }) },
		"projects:updateInterval": { method: "PUT",    path: "/api/projects/:id/interval",    buildReq: (id, interval) => ({ params: { id }, body: { interval } }) },
		"projects:pause":          { method: "POST",   path: "/api/projects/:id/pause",       buildReq: (id) => ({ params: { id } }) },
		"projects:resume":         { method: "POST",   path: "/api/projects/:id/resume",      buildReq: (id) => ({ params: { id } }) },

		// ─── Requirements (M1) ──────────────────────────────
		"requirements:list":       { method: "GET",    path: "/api/requirements",              buildReq: (filter?) => ({ query: filter ?? {} }) },
		"requirements:get":        { method: "GET",    path: "/api/requirements/:id",           buildReq: (id) => ({ params: { id } }) },
		"requirements:create":     { method: "POST",   path: "/api/requirements",              buildReq: (input) => ({ body: input }) },
		"requirements:update":     { method: "PUT",    path: "/api/requirements/:id",           buildReq: (id, input) => ({ params: { id }, body: input }) },
		"requirements:transition": { method: "PUT",    path: "/api/requirements/:id/status",   buildReq: (id, toStatus, triggeredBy, comment?) => ({ params: { id }, body: { toStatus, triggeredBy, comment } }) },
		"requirements:history":    { method: "GET",    path: "/api/requirements/:id/history",  buildReq: (id) => ({ params: { id } }) },
		"requirements:messages":   { method: "GET",    path: "/api/requirements/:id/messages", buildReq: (id) => ({ params: { id } }) },
		"requirements:addMessage": { method: "POST",   path: "/api/requirements/:id/messages", buildReq: (id, sender, content, messageType?) => ({ params: { id }, body: { sender, content, messageType } }) },
		"requirements:steps":      { method: "GET",    path: "/api/requirements/:id/steps",    buildReq: (id) => ({ params: { id } }) },

		// ─── Requirements M5 ────────────────────────────────
		"requirements:verify":     { method: "POST",   path: "/api/requirements/:id/verify",   buildReq: (id) => ({ params: { id } }) },
		"requirements:archive":    { method: "POST",   path: "/api/requirements/:id/archive",  buildReq: (id) => ({ params: { id } }) },
		"requirements:report":     { method: "GET",    path: "/api/requirements/:id/report",   buildReq: (id) => ({ params: { id } }) },

		// ─── Wiki (M1) ──────────────────────────────────────
		"wiki:listByProject":      { method: "GET",    path: "/api/project-wiki/:projectId/nodes", buildReq: (projectId) => ({ params: { projectId } }) },
		"wiki:getNode":            { method: "GET",    path: "/api/project-wiki/node/:id",         buildReq: (id) => ({ params: { id } }) },
		"wiki:createNode":         { method: "POST",   path: "/api/project-wiki/:projectId/nodes", buildReq: (projectId, input) => ({ params: { projectId }, body: input }) },
		"wiki:updateNode":         { method: "PUT",    path: "/api/project-wiki/node/:id",         buildReq: (id, input) => ({ params: { id }, body: input }) },
		"wiki:deleteNode":         { method: "DELETE", path: "/api/project-wiki/node/:id",         buildReq: (id) => ({ params: { id } }) },

		// ─── Lead (M3) ──────────────────────────────────────
		"lead:pickup":             { method: "POST",   path: "/api/requirements/:id/pickup",   buildReq: (requirementId) => ({ params: { id: requirementId } }) },
		"lead:progress":           { method: "GET",    path: "/api/requirements/:id/progress", buildReq: (requirementId) => ({ params: { id: requirementId } }) },
};

// ─── Proxy Registration ─────────────────────────────────────

export function registerProxyHandlers(port: number): void {
	const baseUrl = `http://localhost:${port}`;

	// app:ready — simple health check (not a REST route)
	ipcMain.handle("app:ready", async () => {
		try {
			const resp = await fetch(`${baseUrl}/api/ready`);
			const data = await resp.json();
			return !!data.ready;
		} catch {
			return false;
		}
	});

	for (const [channel, route] of Object.entries(R)) {
		ipcMain.handle(channel, async (_e, ...args) => {
			try {
				const { params, body, query } = route.buildReq(...args);

				let path = route.path;
				if (params) {
					for (const [key, val] of Object.entries(params)) {
						path = path.replace(`:${key}`, encodeURIComponent(val));
					}
				}

				let url = `${baseUrl}${path}`;
				if (query && Object.keys(query).length > 0) {
					const qs = new URLSearchParams(query).toString();
					url += `?${qs}`;
				}

				const fetchOpts: RequestInit = { method: route.method };
				if (body !== undefined) {
					fetchOpts.headers = { "Content-Type": "application/json" };
					fetchOpts.body = JSON.stringify(body);
				}

				const resp = await fetch(url, fetchOpts);
				const text = await resp.text();
				try {
					return JSON.parse(text);
				} catch {
					return text;
				}
			} catch (err: any) {
				log.error("ipc-proxy", `${channel} failed:`, err.message);
				return { error: err.message };
			}
		});
	}
}

// ─── WebSocket Event Bridge ─────────────────────────────────

let _ws: WebSocket | null = null;

export function connectEventBridge(win: BrowserWindow, port: number): void {
	const url = `ws://localhost:${port}/ws`;

	function connect() {
		_ws = new WebSocket(url);

		_ws.on("message", (data: WebSocket.Data) => {
			try {
				const event = JSON.parse(data.toString());
				if (win && !win.isDestroyed()) {
					// Map WS events back to Electron IPC events
					const eventType = event.type;
					if (eventType === "reconnect") {
						win.webContents.send("agent:event", event);
					} else {
						win.webContents.send("agent:event", event);
					}
				}
			} catch { /* ignore parse errors */ }
		});

		_ws.on("close", () => {
			log.debug("ipc-proxy", "WebSocket closed, reconnecting in 2s...");
			setTimeout(connect, 2000);
		});

		_ws.on("error", (err) => {
			log.debug("ipc-proxy", "WebSocket error:", (err as Error).message);
		});
	}

	connect();

	// Check if backend is ready
	async function pollReady() {
		try {
			const resp = await fetch(`http://localhost:${port}/api/ready`);
			const data = await resp.json();
			if (data.ready && win && !win.isDestroyed()) {
				win.webContents.send("app:ready", true);
			}
		} catch {
			// Backend not ready yet, retry
			setTimeout(pollReady, 500);
		}
	}
	pollReady();
}
