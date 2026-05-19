import { contextBridge, ipcRenderer } from "electron";

const api = {
	// ─── Config ──────────────────────────────────────
	configGet: () => ipcRenderer.invoke("config:get"),
	configUpdate: (data: { workspaceDir: string }) => ipcRenderer.invoke("config:update", data),

	// ─── Agents ──────────────────────────────────────
	agentsList: () => ipcRenderer.invoke("agents:list"),
	agentsGet: (id: string) => ipcRenderer.invoke("agents:get", id),
	agentsCreate: (input: unknown) => ipcRenderer.invoke("agents:create", input),
	agentsUpdate: (id: string, input: unknown) => ipcRenderer.invoke("agents:update", id, input),
	agentsDelete: (id: string) => ipcRenderer.invoke("agents:delete", id),

	// ─── Models & Tools ──────────────────────────────
	modelsList: () => ipcRenderer.invoke("models:list"),
	toolsList: () => ipcRenderer.invoke("tools:list"),

	// ─── Providers ───────────────────────────────────
	providersList: () => ipcRenderer.invoke("providers:list"),
	providersGet: (id: string) => ipcRenderer.invoke("providers:get", id),
	providersCreate: (input: unknown) => ipcRenderer.invoke("providers:create", input),
	providersUpdate: (id: string, input: unknown) => ipcRenderer.invoke("providers:update", id, input),
	providersDelete: (id: string) => ipcRenderer.invoke("providers:delete", id),
	providersAddModel: (providerId: string, model: unknown) => ipcRenderer.invoke("providers:add-model", providerId, model),
	providersRemoveModel: (providerId: string, modelId: string) => ipcRenderer.invoke("providers:remove-model", providerId, modelId),
	providersFetchModels: (providerId: string) => ipcRenderer.invoke("providers:fetch-models", providerId),

	// ─── Messages ────────────────────────────────────
	messagesList: (agentId: string) => ipcRenderer.invoke("messages:list", agentId),
	messagesClear: (agentId: string) => ipcRenderer.invoke("messages:clear", agentId),

	// ─── Files ───────────────────────────────────────
	filesTree: (root?: string) => ipcRenderer.invoke("files:tree", root),
	filesContent: (path: string, root?: string) => ipcRenderer.invoke("files:content", path, root),

	// ─── Chat ────────────────────────────────────────
	chatSend: (text: string, agentId?: string) => ipcRenderer.invoke("chat:send", text, agentId),
	chatAbort: () => ipcRenderer.invoke("chat:abort"),
	chatState: () => ipcRenderer.invoke("chat:state"),

	// ─── Sessions ────────────────────────────────────
	sessionsList: (agentId: string) => ipcRenderer.invoke("sessions:list", agentId),
	sessionsNew: (agentId: string) => ipcRenderer.invoke("sessions:new", agentId),
	sessionsSwitch: (agentId: string, sessionId: string) => ipcRenderer.invoke("sessions:switch", agentId, sessionId),
	sessionsCurrent: (agentId: string) => ipcRenderer.invoke("sessions:current", agentId),
	sessionsDelete: (agentId: string, sessionId: string) => ipcRenderer.invoke("sessions:delete", agentId, sessionId),

	// ─── Streaming events ────────────────────────────
	onAgentEvent: (callback: (event: any) => void) => {
		const handler = (_e: any, data: any) => callback(data);
		ipcRenderer.on("agent:event", handler);
		return () => { ipcRenderer.removeListener("agent:event", handler); };
	},

	// ─── App readiness ───────────────────────────────
	onAppReady: (callback: () => void) => {
		const handler = () => { callback(); };
		ipcRenderer.on("app:ready", handler);
		ipcRenderer.invoke("app:ready").then((ready) => { if (ready) callback(); });
		return () => { ipcRenderer.removeListener("app:ready", handler); };
	},

	// ─── Platform ────────────────────────────────────
	platform: process.platform,

		// ─── Knowledge Base ──────────────────────────────────
		kbList: () => ipcRenderer.invoke("kb:list"),
		kbGet: (id: string) => ipcRenderer.invoke("kb:get", id),
		kbCreate: (input: unknown) => ipcRenderer.invoke("kb:create", input),
		kbUpdate: (id: string, input: unknown) => ipcRenderer.invoke("kb:update", id, input),
		kbDelete: (id: string) => ipcRenderer.invoke("kb:delete", id),
		kbAddFiles: (kbId: string, filePaths: string[]) => ipcRenderer.invoke("kb:add-files", kbId, filePaths),
		kbRemoveFile: (kbId: string, filePath: string) => ipcRenderer.invoke("kb:remove-file", kbId, filePath),
		kbSearch: (kbIds: string[], query: string) => ipcRenderer.invoke("kb:search", kbIds, query),
		kbChunkCount: (kbId: string) => ipcRenderer.invoke("kb:chunk-count", kbId),

		// ─── MCP ──────────────────────────────────────────
		mcpList: () => ipcRenderer.invoke("mcp:list"),
		mcpGet: (id: string) => ipcRenderer.invoke("mcp:get", id),
		mcpCreate: (input: unknown) => ipcRenderer.invoke("mcp:create", input),
		mcpUpdate: (id: string, input: unknown) => ipcRenderer.invoke("mcp:update", id, input),
		mcpDelete: (id: string) => ipcRenderer.invoke("mcp:delete", id),
		mcpTest: (input: unknown) => ipcRenderer.invoke("mcp:test", input),
		mcpTools: (serverId: string) => ipcRenderer.invoke("mcp:tools", serverId),
		mcpConnect: (id: string) => ipcRenderer.invoke("mcp:connect", id),
		mcpDisconnect: (id: string) => ipcRenderer.invoke("mcp:disconnect", id),
		mcpStatus: () => ipcRenderer.invoke("mcp:status"),

		// ─── Templates ──────────────────────────────────
		templatesList: () => ipcRenderer.invoke("templates:list"),
		templatesGet: (id: string) => ipcRenderer.invoke("templates:get", id),
		templatesCreate: (input: unknown) => ipcRenderer.invoke("templates:create", input),
		templatesUpdate: (id: string, input: unknown) => ipcRenderer.invoke("templates:update", id, input),
		templatesDelete: (id: string) => ipcRenderer.invoke("templates:delete", id),
		templatesExport: (id: string) => ipcRenderer.invoke("templates:export", id),
		templatesImport: (json: string) => ipcRenderer.invoke("templates:import", json),

		// ─── Theme ───────────────────────────────────────
		configGetTheme: () => ipcRenderer.invoke("config:get-theme"),
		configSetTheme: (data) => ipcRenderer.invoke("config:set-theme", data),
};

contextBridge.exposeInMainWorld("api", api);
