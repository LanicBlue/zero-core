// 预加载脚本
//
// # 文件说明书
//
// ## 核心功能
// Electron 预加载脚本，通过 contextBridge 暴露安全的 IPC API。
//
// ## 输入
// - IPC 调用
//
// ## 输出
// - window.api 对象
//
// ## 定位
// 预加载脚本，被 Electron 主进程加载。
//
// ## 依赖
// - electron - Electron 框架
// - ../shared/preload-types - 类型定义
//
// ## 维护规则
// - 新增 IPC 通道时需同步添加
// - 保持类型安全
//
import { contextBridge, ipcRenderer } from "electron";
import type { WindowApi } from "../shared/preload-types.js";

const api: WindowApi = {
	// ─── Config ──────────────────────────────────────
	configGet: () => ipcRenderer.invoke("config:get"),
	configUpdate: (data) => ipcRenderer.invoke("config:update", data),
	dialogOpenDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
	configGetTheme: () => ipcRenderer.invoke("config:get-theme"),
	configSetTheme: (data) => ipcRenderer.invoke("config:set-theme", data),

	// ─── Agents ──────────────────────────────────────
	agentsList: () => ipcRenderer.invoke("agents:list"),
	agentsGet: (id) => ipcRenderer.invoke("agents:get", id),
	agentsCreate: (input) => ipcRenderer.invoke("agents:create", input),
	agentsUpdate: (id, input) => ipcRenderer.invoke("agents:update", id, input),
	agentsDelete: (id) => ipcRenderer.invoke("agents:delete", id),

	// ─── Models & Tools ──────────────────────────────
	modelsList: () => ipcRenderer.invoke("models:list"),
	toolsList: () => ipcRenderer.invoke("tools:list"),
	toolConfigGet: () => ipcRenderer.invoke("tool-config:get"),
	toolConfigSave: (config) => ipcRenderer.invoke("tool-config:save", config),
	toolExecute: (toolName, input) => ipcRenderer.invoke("tool:execute", { toolName, input }),

	// ─── Providers ───────────────────────────────────
	providersList: () => ipcRenderer.invoke("providers:list"),
	providersGet: (id) => ipcRenderer.invoke("providers:get", id),
	providersCreate: (input) => ipcRenderer.invoke("providers:create", input),
	providersUpdate: (id, input) => ipcRenderer.invoke("providers:update", id, input),
	providersDelete: (id) => ipcRenderer.invoke("providers:delete", id),
	providersAddModel: (providerId, model) => ipcRenderer.invoke("providers:add-model", providerId, model),
	providersRemoveModel: (providerId, modelId) => ipcRenderer.invoke("providers:remove-model", providerId, modelId),
	providersFetchModels: (providerId) => ipcRenderer.invoke("providers:fetch-models", providerId),

	// ─── Messages ────────────────────────────────────
	messagesClear: (agentId) => ipcRenderer.invoke("messages:clear", agentId),
	messagesEdit: (agentId, msgSeq, newText) => ipcRenderer.invoke("messages:edit", agentId, msgSeq, newText),
	messagesDelete: (agentId, msgSeq) => ipcRenderer.invoke("messages:delete", agentId, msgSeq),

	// ─── Files ───────────────────────────────────────
	filesTree: (root) => ipcRenderer.invoke("files:tree", root),
	filesContent: (path, root) => ipcRenderer.invoke("files:content", path, root),
	filesResolvePath: (path, root) => ipcRenderer.invoke("files:resolve-path", path, root),
	filesSave: (path, content, root) => ipcRenderer.invoke("files:save", path, content, root),

	// ─── Chat ────────────────────────────────────────
	chatSend: (text, agentId, sessionId?) => ipcRenderer.invoke("chat:send", text, agentId, sessionId),
	chatAbort: (agentId) => ipcRenderer.invoke("chat:abort", agentId),

	// ─── Sessions ────────────────────────────────────
	sessionsList: (agentId) => ipcRenderer.invoke("sessions:list", agentId),
	sessionsNew: (agentId) => ipcRenderer.invoke("sessions:new", agentId),
	sessionsSwitch: (agentId, sessionId) => ipcRenderer.invoke("sessions:switch", agentId, sessionId),
	sessionsCurrent: (agentId) => ipcRenderer.invoke("sessions:current", agentId),
	sessionsActivate: (agentId, sessionId?) => ipcRenderer.invoke("sessions:activate", agentId, sessionId),
	sessionsDelete: (agentId, sessionId) => ipcRenderer.invoke("sessions:delete", agentId, sessionId),
	sessionsMetrics: () => ipcRenderer.invoke("sessions:metrics"),

	// ─── Streaming events ────────────────────────────
	onAgentEvent: (callback) => {
		const handler = (_e: any, data: any) => callback(data);
		ipcRenderer.on("agent:event", handler);
		return () => { ipcRenderer.removeListener("agent:event", handler); };
	},
	onToolsChanged: (callback) => {
		const handler = () => { callback(); };
		ipcRenderer.on("tools:changed", handler);
		return () => { ipcRenderer.removeListener("tools:changed", handler); };
	},
	// Unified UI-sync channel. The server emits { collection } whenever a
	// whitelisted table changes; subscribe and filter by the collections you
	// care about (agents/projects/crons/requirements/project_wiki).
	onDataChanged: (callback) => {
		const handler = (_e: any, data: { collection: string }) => { callback(data); };
		ipcRenderer.on("data:changed", handler);
		return () => { ipcRenderer.removeListener("data:changed", handler); };
	},
	onSessionLifecycle: (callback) => {
		const handler = (_e: any, data: any) => callback(data);
		ipcRenderer.on("session:lifecycle", handler);
		return () => { ipcRenderer.removeListener("session:lifecycle", handler); };
	},
	onAppReady: (callback) => {
		const handler = () => { callback(); };
		ipcRenderer.on("app:ready", handler);
		ipcRenderer.invoke("app:ready").then((ready) => { if (ready) callback(); });
		return () => { ipcRenderer.removeListener("app:ready", handler); };
	},
	onGithubImportProgress: (callback) => {
		const handler = (_e: any, data: any) => callback(data);
		ipcRenderer.on("github-import:progress", handler);
		return () => { ipcRenderer.removeListener("github-import:progress", handler); };
	},
	onGithubPreviewProgress: (callback) => {
		const handler = (_e: any, data: any) => callback(data);
		ipcRenderer.on("github-preview:progress", handler);
		return () => { ipcRenderer.removeListener("github-preview:progress", handler); };
	},

	// ─── Platform ────────────────────────────────────
	platform: process.platform,

	// ─── Window Controls ────────────────────────────────
	windowMinimize: () => ipcRenderer.invoke("window:minimize"),
	windowMaximize: () => ipcRenderer.invoke("window:maximize"),
	windowClose: () => ipcRenderer.invoke("window:close"),

	// ─── Skills
	skillsList: () => ipcRenderer.invoke("skills:list"),

	// ─── Knowledge Base ──────────────────────────────
	kbList: () => ipcRenderer.invoke("kb:list"),
	kbGet: (id) => ipcRenderer.invoke("kb:get", id),
	kbCreate: (input) => ipcRenderer.invoke("kb:create", input),
	kbUpdate: (id, input) => ipcRenderer.invoke("kb:update", id, input),
	kbDelete: (id) => ipcRenderer.invoke("kb:delete", id),
	kbAddFiles: (kbId, filePaths) => ipcRenderer.invoke("kb:add-files", kbId, filePaths),
	kbRemoveFile: (kbId, filePath) => ipcRenderer.invoke("kb:remove-file", kbId, filePath),
	kbSearch: (kbIds, query) => ipcRenderer.invoke("kb:search", kbIds, query),
	kbChunkCount: (kbId) => ipcRenderer.invoke("kb:chunk-count", kbId),

	// ─── MCP ─────────────────────────────────────────
	mcpList: () => ipcRenderer.invoke("mcp:list"),
	mcpGet: (id) => ipcRenderer.invoke("mcp:get", id),
	mcpCreate: (input) => ipcRenderer.invoke("mcp:create", input),
	mcpUpdate: (id, input) => ipcRenderer.invoke("mcp:update", id, input),
	mcpDelete: (id) => ipcRenderer.invoke("mcp:delete", id),
	mcpTest: (input) => ipcRenderer.invoke("mcp:test", input),
	mcpTools: (serverId) => ipcRenderer.invoke("mcp:tools", serverId),
	mcpConnect: (id) => ipcRenderer.invoke("mcp:connect", id),
	mcpDisconnect: (id) => ipcRenderer.invoke("mcp:disconnect", id),
	mcpStatus: () => ipcRenderer.invoke("mcp:status"),
	mcpScan: () => ipcRenderer.invoke("mcp:scan"),
	mcpPresets: () => ipcRenderer.invoke("mcp:presets"),
	mcpAddPreset: (presetId, envValues) => ipcRenderer.invoke("mcp:add-preset", presetId, envValues),

	// ─── Templates ───────────────────────────────────
	templatesList: () => ipcRenderer.invoke("templates:list"),
	templatesGet: (id) => ipcRenderer.invoke("templates:get", id),
	templatesCreate: (input) => ipcRenderer.invoke("templates:create", input),
	templatesUpdate: (id, input) => ipcRenderer.invoke("templates:update", id, input),
	templatesDelete: (id) => ipcRenderer.invoke("templates:delete", id),
	templatesExport: (id) => ipcRenderer.invoke("templates:export", id),
	templatesImport: (json) => ipcRenderer.invoke("templates:import", json),

	templatesGithubPreview: (url, subdir) => ipcRenderer.invoke("templates:github-preview", url, subdir),
	templatesImportGithub: (url, selectedPaths) => ipcRenderer.invoke("templates:import-github", url, selectedPaths),

	// ─── Device Context ─────────────────────────────
	deviceContextGet: () => ipcRenderer.invoke("device-context:get"),
	deviceContextGenerate: () => ipcRenderer.invoke("device-context:generate"),
	deviceContextSave: (content) => ipcRenderer.invoke("device-context:save", content),

	// ─── Guidelines ─────────────────────────────────
	guidelinesGet: () => ipcRenderer.invoke("guidelines:get"),
	guidelinesSave: (guidelines) => ipcRenderer.invoke("guidelines:save", guidelines),

	// ─── Logs ───────────────────────────────────────
	logsListFiles: () => ipcRenderer.invoke("logs:list-files"),
	logsRead: (filename, opts) => ipcRenderer.invoke("logs:read", filename, opts),
	logsGetConfig: () => ipcRenderer.invoke("logs:get-config"),
	logsSetConfig: (config) => ipcRenderer.invoke("logs:set-config", config),

	// ─── Ask User / Search ──────────────────────────
	askUserRespond: (requestId, answers) => ipcRenderer.invoke("ask-user:respond", requestId, answers),
	getSearchProvider: () => ipcRenderer.invoke("search-provider:get"),
	setSearchProvider: (config) => ipcRenderer.invoke("search-provider:set", config),

	// ── Tool Executions ──
	toolExecutionsQuery: (filter) => ipcRenderer.invoke("tool-executions:query", filter),
	toolExecutionsStats: (agentId?) => ipcRenderer.invoke("tool-executions:stats", agentId),
	toolExecutionsCleanup: (maxAgeMs) => ipcRenderer.invoke("tool-executions:cleanup", maxAgeMs),
	toolExecutionsAnalyze: (agentId?) => ipcRenderer.invoke("tool-executions:analyze", agentId),

	// WebFetch
	webfetchLogin: (url) => ipcRenderer.invoke("webfetch:login", url),
	webfetchCookies: () => ipcRenderer.invoke("webfetch:cookies"),
	webfetchClearCookies: (domain?) => ipcRenderer.invoke("webfetch:clear-cookies", domain),

	// ── Memory Nodes ──
	memoryNodeList: (limit?) => ipcRenderer.invoke("memory-nodes:nodes", limit),
	memoryNodeSubjects: () => ipcRenderer.invoke("memory-nodes:subjects"),
	memoryNodeSubjectNodes: (name) => ipcRenderer.invoke("memory-nodes:subject-nodes", name),
	memoryNodeSearch: (q, limit?) => ipcRenderer.invoke("memory-nodes:search", q, limit),
	memoryNodeDelete: (id) => ipcRenderer.invoke("memory-nodes:delete", id),

	// ── Memory Config ──
	memoryConfigGet: () => ipcRenderer.invoke("config:memory-get"),
	memoryConfigUpdate: (data) => ipcRenderer.invoke("config:memory-update", data),

	// ── Projects ──
	projectsList: (filter?) => ipcRenderer.invoke("projects:list", filter),
	projectsGet: (id, includeContext?) => ipcRenderer.invoke("projects:get", id, includeContext),
	projectsCreate: (input) => ipcRenderer.invoke("projects:create", input),
	projectsUpdate: (id, input) => ipcRenderer.invoke("projects:update", id, input),
	projectsDelete: (id) => ipcRenderer.invoke("projects:delete", id),
	// v0.8 (P5 §8.5): sessions token/cost SUM by projectId.
	projectsGetResourceUsage: (id) => ipcRenderer.invoke("projects:getResourceUsage", id),

	// ── Requirements ──
	requirementsList: (filter?) => ipcRenderer.invoke("requirements:list", filter),
	requirementsGet: (id) => ipcRenderer.invoke("requirements:get", id),
	requirementsCreate: (input) => ipcRenderer.invoke("requirements:create", input),
	requirementsUpdate: (id, input) => ipcRenderer.invoke("requirements:update", id, input),
	requirementsTransition: (id, toStatus, triggeredBy, comment?) => ipcRenderer.invoke("requirements:transition", id, toStatus, triggeredBy, comment),
	requirementsHistory: (id) => ipcRenderer.invoke("requirements:history", id),
	requirementsMessages: (id) => ipcRenderer.invoke("requirements:messages", id),
	requirementsAddMessage: (id, sender, content, messageType?) => ipcRenderer.invoke("requirements:addMessage", id, sender, content, messageType),
	requirementsSteps: (id) => ipcRenderer.invoke("requirements:steps", id),

	// ── Wiki ──
	wikiListByProject: (projectId) => ipcRenderer.invoke("wiki:listByProject", projectId),
	wikiGetNode: (id) => ipcRenderer.invoke("wiki:getNode", id),
	wikiCreateNode: (projectId, input) => ipcRenderer.invoke("wiki:createNode", projectId, input),
	wikiUpdateNode: (id, input) => ipcRenderer.invoke("wiki:updateNode", id, input),
	wikiDeleteNode: (id) => ipcRenderer.invoke("wiki:deleteNode", id),
	// v0.8 (P8 §10.9): global-tree browser surface.
	wikiListByAnchors: (anchorIds) => ipcRenderer.invoke("wiki:listByAnchors", anchorIds),
	wikiReadDetail: (nodeId) => ipcRenderer.invoke("wiki:readDetail", nodeId),
	wikiReadWorkspaceDoc: (projectId, relPath) => ipcRenderer.invoke("wiki:readWorkspaceDoc", projectId, relPath),
	wikiSearch: (query, anchorIds?) => ipcRenderer.invoke("wiki:search", query, anchorIds),

	// ── Lead ──
	leadPickup: (requirementId) => ipcRenderer.invoke("lead:pickup", requirementId),
	leadProgress: (requirementId) => ipcRenderer.invoke("lead:progress", requirementId),

	// ── M5: Verification, Archive, Report ──
	requirementsVerify: (id) => ipcRenderer.invoke("requirements:verify", id),
	requirementsArchive: (id) => ipcRenderer.invoke("requirements:archive", id),
	requirementsReport: (id) => ipcRenderer.invoke("requirements:report", id),

	// v0.8 (P4 §8.6): projects pause/resume/updateInterval removed — dead
	// project schedule channels (cron is agent-scoped now). The cron surface
	// under crons:* is the single source of scheduling truth.

	// ── M1: Cron (first-class cron entity; P4 §9.4 list filter + runs) ──
	cronsList: (filter?) => ipcRenderer.invoke("crons:list", filter),
	cronsGet: (id) => ipcRenderer.invoke("crons:get", id),
	cronsCreate: (input) => ipcRenderer.invoke("crons:create", input),
	cronsUpdate: (id, input) => ipcRenderer.invoke("crons:update", id, input),
	cronsDelete: (id) => ipcRenderer.invoke("crons:delete", id),
	cronsTrigger: (id) => ipcRenderer.invoke("crons:trigger", id),
	// §9.3: cron_runs audit log (newest-first, default 50).
	cronsListRuns: (cronId, limit?) => ipcRenderer.invoke("crons:listRuns", cronId, limit),

	// ── M3: Orchestrate plan-gate (kanban pending entry + confirm/reject) ──
	orchestratePending: (filter?) => ipcRenderer.invoke("orchestrate:pending", filter),
	orchestratePlan: (planId) => ipcRenderer.invoke("orchestrate:plan", planId),
	orchestrateConfirm: (planId) => ipcRenderer.invoke("orchestrate:confirm", planId),
	orchestrateReject: (planId, reason) => ipcRenderer.invoke("orchestrate:reject", planId, reason),

	// ── M4: PM discuss-as-document + coverage judgement ──
	requirementsDocRead: (projectId, requirementId) => ipcRenderer.invoke("requirements:doc:read", projectId, requirementId),
	requirementsDocWrite: (projectId, requirementId, content) => ipcRenderer.invoke("requirements:doc:write", projectId, requirementId, content),
	requirementsDocList: (projectId) => ipcRenderer.invoke("requirements:doc:list", projectId),
	pmCreateRequirement: (input) => ipcRenderer.invoke("pm:createRequirement", input),
	pmOpenDiscuss: (requirementId) => ipcRenderer.invoke("pm:openDiscuss", requirementId),
	pmCoverageView: (requirementId) => ipcRenderer.invoke("pm:coverageView", requirementId),
	pmCoverageVerdict: (requirementId, covered, reason) => ipcRenderer.invoke("pm:coverageVerdict", requirementId, covered, reason),
};

contextBridge.exposeInMainWorld("api", api);

// Test-only flag: lets the renderer expose its internal stores (e.g. the chat
// zustand store) so E2E tests can assert on state directly. Absent in normal
// production runs — ZERO_CORE_TEST_FIXTURE is set only by the Playwright
// launcher (helpers/test-app.ts launchApp).
if (process.env.ZERO_CORE_TEST_FIXTURE) {
	contextBridge.exposeInMainWorld("__ZC_TEST__", true);
}
