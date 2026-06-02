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

	// ─── Agent Tools ─────────────────────────────────
	agentToolsList: () => ipcRenderer.invoke("agent-tools:list"),
	agentToolsGet: (id) => ipcRenderer.invoke("agent-tools:get", id),
	agentToolsGetByAgent: (agentId) => ipcRenderer.invoke("agent-tools:get-by-agent", agentId),
	agentToolsCreate: (input) => ipcRenderer.invoke("agent-tools:create", input),
	agentToolsUpdate: (id, input) => ipcRenderer.invoke("agent-tools:update", id, input),
	agentToolsDelete: (id) => ipcRenderer.invoke("agent-tools:delete", id),

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

	// ─── Ask User / Todos / Search ──────────────────
	askUserRespond: (requestId, answers) => ipcRenderer.invoke("ask-user:respond", requestId, answers),
	getTodos: (agentId) => ipcRenderer.invoke("todos:get", agentId),
	getSearchProvider: () => ipcRenderer.invoke("search-provider:get"),
	setSearchProvider: (config) => ipcRenderer.invoke("search-provider:set", config),
};

contextBridge.exposeInMainWorld("api", api);
