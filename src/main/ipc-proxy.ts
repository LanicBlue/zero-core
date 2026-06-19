// IPC → HTTP/WS 桥接层：把 Electron IPC 通道代理到后端子进程。
//
// # 文件说明书
//
// ## 核心功能
// 维护一份 `IPC 通道 → REST 路由` 映射表 R，统一注册 ipcMain.handle：
//   - 将渲染层 ipcRenderer.invoke 调用翻译成对 `http://localhost:<backendPort>`
//     的 fetch（GET/POST/PUT/DELETE），自动拼 path 参数、query 和 JSON body；
//   - connectEventBridge 反向建立 WebSocket，把后端 agent 事件转发回渲染层
//     `agent:event` 通道；并轮询 `/api/ready` 在后端就绪时通知主窗口。
//
// ## 输入
// - 后端端口号（来自 backend-spawn.getBackendPort）
// - 渲染层每个通道的 IPC 调用参数（args 透传给 buildReq）
// - 后端 WS 事件 / REST 响应文本
//
// ## 输出
// - 注册到 ipcMain 的若干 handle 回调
// - 经 BrowserWindow.webContents.send 转发的事件流
// - app:ready 状态推送
//
// ## 定位
// 主进程桥接层；被 src/main/index.ts 在窗口创建后调用 registerProxyHandlers 与
// connectEventBridge。本地不处理的通道（dialog、webfetch:login 等）由
// src/main/ipc/*-handlers.ts 接管。
//
// ## 依赖
// - electron：ipcMain、BrowserWindow
// - ws：WebSocket 客户端
// - ../core/logger.js：log
// - 后端 REST/WS API（路径与通道名同源定义在映射表 R）
//
// ## 维护规则
// - 新增后端 REST 接口需在 R 表补对应通道与 buildReq，并同步 preload 暴露
// - 仅当调用必须在 Electron 内完成（弹窗、登录 cookie 等）才不放此表
// - WebSocket 事件类型一旦扩展需同步渲染层订阅与 agent:event 转发

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

	// Role Templates (v0.8 P6 — RFC §7.2; distinct from the DB TemplateStore
	// /api/templates above. These are the role identity templates.)
	"role-templates:list":         { method: "GET", path: "/api/role-templates", buildReq: (roleTag?) => ({ query: roleTag ? { roleTag } : {} }) },
	"role-templates:get":          { method: "GET", path: "/api/role-templates/:id", buildReq: (id) => ({ params: { id } }) },
	"role-templates:instantiate":  { method: "POST", path: "/api/role-templates/:id/instantiate", buildReq: (id, input) => ({ params: { id }, body: input ?? {} }) },

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
		// v0.8 (P4 §8.6): projects pause/resume/updateInterval removed (dead
		// project schedule channels — cron is agent-scoped now).
		// v0.8 (P5 §8.4 / §8.5): projects:get now takes includeContext (boolean)
		// → maps to ?includeContext=1 on the REST side; new projects:getResourceUsage
		// channel for the dashboard's resource-consumption card.
		"projects:list":             { method: "GET",    path: "/api/projects",                 buildReq: (filter?) => ({ query: filter ?? {} }) },
		"projects:get":              { method: "GET",    path: "/api/projects/:id",             buildReq: (id, includeContext?) => ({ params: { id }, query: includeContext ? { includeContext: "1" } : {} }) },
		"projects:create":           { method: "POST",   path: "/api/projects",                 buildReq: (input) => ({ body: input }) },
		"projects:update":           { method: "PUT",    path: "/api/projects/:id",             buildReq: (id, input) => ({ params: { id }, body: input }) },
		"projects:delete":           { method: "DELETE", path: "/api/projects/:id",             buildReq: (id) => ({ params: { id } }) },
		"projects:getResourceUsage": { method: "GET",    path: "/api/projects/:id/resource-usage", buildReq: (id) => ({ params: { id } }) },

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

		// ─── Wiki (v0.8 P8 §10.9) — global-tree browser surface ───────
		// backend /api/wiki/* (wiki-router.ts) against the global WikiStore.
		// These are NOT the legacy project-wiki CRUD above; they drive the new
		// wiki browser (multi-anchor scope + disk body detail + workspace-doc
		// jump-to-original + substring search). Preload arg order is authoritative.
		"wiki:listByAnchors":    { method: "POST", path: "/api/wiki/list-by-anchors",                       buildReq: (anchorIds) => ({ body: { anchorIds: anchorIds ?? [] } }) },
		"wiki:readDetail":       { method: "GET",  path: "/api/wiki/nodes/:nodeId/detail",                  buildReq: (nodeId) => ({ params: { nodeId } }) },
		"wiki:readWorkspaceDoc": { method: "GET",  path: "/api/projects/:projectId/workspace-doc",          buildReq: (projectId, relPath) => ({ params: { projectId }, query: { relPath } }) },
		"wiki:search":           { method: "GET",  path: "/api/wiki/search",                                buildReq: (query, anchorIds?) => ({ query: { query, ...(anchorIds?.length ? { anchorIds: anchorIds.join(",") } : {}) } }) },

		// ─── Lead (M3) ──────────────────────────────────────
		"lead:pickup":             { method: "POST",   path: "/api/requirements/:id/pickup",   buildReq: (requirementId) => ({ params: { id: requirementId } }) },
		"lead:progress":           { method: "GET",    path: "/api/requirements/:id/progress", buildReq: (requirementId) => ({ params: { id: requirementId } }) },

		// ─── Crons (M1; P4 list filter + runs) ──────────────
		// backend /api/crons (cron-router.ts). list reads ?agentId/?projectId/
		// ?enabled from filter; trigger fires a manual run via cronManager.
		"crons:list":     { method: "GET",    path: "/api/crons",            buildReq: (filter?) => ({ query: filter ?? {} }) },
		"crons:get":      { method: "GET",    path: "/api/crons/:id",        buildReq: (id) => ({ params: { id } }) },
		"crons:listRuns": { method: "GET",    path: "/api/crons/:id/runs",   buildReq: (cronId, limit?) => ({ params: { id: cronId }, query: limit ? { limit } : {} }) },
		"crons:create":   { method: "POST",   path: "/api/crons",            buildReq: (input) => ({ body: input }) },
		"crons:update":   { method: "PUT",    path: "/api/crons/:id",        buildReq: (id, input) => ({ params: { id }, body: input }) },
		"crons:delete":   { method: "DELETE", path: "/api/crons/:id",        buildReq: (id) => ({ params: { id } }) },
		"crons:trigger":  { method: "POST",   path: "/api/crons/:id/trigger",buildReq: (id) => ({ params: { id } }) },

		// ─── Orchestrate (M3) ────────────────────────────────
		// backend /api/orchestrate (orchestrate-router.ts). pending is the
		// kanban entry: plans currently in confirm-gate pending state.
		"orchestrate:pending": { method: "GET",  path: "/api/orchestrate/pending",            buildReq: (filter?) => ({ query: filter ?? {} }) },
		"orchestrate:plan":    { method: "GET",  path: "/api/orchestrate/plans/:id",          buildReq: (planId) => ({ params: { id: planId } }) },
		"orchestrate:confirm": { method: "POST", path: "/api/orchestrate/plans/:id/confirm",  buildReq: (planId) => ({ params: { id: planId } }) },
		"orchestrate:reject":  { method: "POST", path: "/api/orchestrate/plans/:id/reject",   buildReq: (planId, reason) => ({ params: { id: planId }, body: { reason } }) },

		// ─── Requirements doc + PM (M4) ──────────────────────
		// backend /api/pm (pmRouter in server/index.ts). doc = repo markdown
		// read/write/list; coverageView = intent doc + latest manifest; verdict
		// drives ArchivistService merge (covered=true) / feedback (covered=false).
		"requirements:doc:read":  { method: "GET",    path: "/api/pm/:projectId/requirements/:requirementId/doc", buildReq: (projectId, requirementId) => ({ params: { projectId, requirementId } }) },
		"requirements:doc:write": { method: "PUT",    path: "/api/pm/:projectId/requirements/:requirementId/doc", buildReq: (projectId, requirementId, content) => ({ params: { projectId, requirementId }, body: { content } }) },
		"requirements:doc:list":  { method: "GET",    path: "/api/pm/:projectId/requirements",                   buildReq: (projectId) => ({ params: { projectId } }) },
		"pm:createRequirement":   { method: "POST",   path: "/api/pm/:projectId/requirements",                   buildReq: (input) => ({ params: { projectId: input?.projectId }, body: { title: input?.title, summary: input?.summary, body: input?.body, priority: input?.priority, source: input?.source } }) },
		"pm:coverageView":        { method: "GET",    path: "/api/pm/:requirementId/coverage-view",              buildReq: (requirementId) => ({ params: { requirementId } }) },
		"pm:coverageVerdict":     { method: "POST",   path: "/api/pm/:requirementId/coverage-verdict",           buildReq: (requirementId, covered, reason) => ({ params: { requirementId }, body: { covered, reason } }) },

		// ─── pm:openDiscuss (v0.8 P7 §4.2) ──────────────────────
		// backend POST /api/pm/:requirementId/discuss reads the requirement +
		// resolves the {PM, projectId} session via PmService.openDiscussSession
		// (routes by req.createdByAgentId, NOT by roleTag scan). Returns
		// { agentId, sessionId, created }; renderer then setActiveAgent/Page
		// + opens the requirement doc (decision 13/14).
		"pm:openDiscuss":         { method: "POST",   path: "/api/pm/:requirementId/discuss",                    buildReq: (requirementId) => ({ params: { requirementId } }) },
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
