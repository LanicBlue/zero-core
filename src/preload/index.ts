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
	toolConfigGet: () => ipcRenderer.invoke("tool-config:get"),
	toolConfigSave: (config: Record<string, Record<string, any>>) => ipcRenderer.invoke("tool-config:save", config),

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
		messagesEdit: (agentId: string, msgSeq: number, newText: string) => ipcRenderer.invoke("messages:edit", agentId, msgSeq, newText),
		messagesDelete: (agentId: string, msgSeq: number) => ipcRenderer.invoke("messages:delete", agentId, msgSeq),

	// ─── Files ───────────────────────────────────────
	filesTree: (root?: string) => ipcRenderer.invoke("files:tree", root),
	filesContent: (path: string, root?: string) => ipcRenderer.invoke("files:content", path, root),
		filesResolvePath: (path: string, root?: string) => ipcRenderer.invoke("files:resolve-path", path, root),
		filesSave: (path: string, content: string, root?: string) => ipcRenderer.invoke("files:save", path, content, root),

	// ─── Chat ────────────────────────────────────────
	chatSend: (text: string, agentId?: string) => ipcRenderer.invoke("chat:send", text, agentId),
	chatAbort: (agentId?: string) => ipcRenderer.invoke("chat:abort", agentId),
	chatState: (agentId?: string) => ipcRenderer.invoke("chat:state", agentId),

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

	// ─── Tools change notification ───────────────
	onToolsChanged: (callback: () => void) => {
		const handler = () => { callback(); };
		ipcRenderer.on("tools:changed", handler);
		return () => { ipcRenderer.removeListener("tools:changed", handler); };
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

		// ─── Agent Tools ──────────────────────────────────
		agentToolsList: () => ipcRenderer.invoke("agent-tools:list"),
		agentToolsGet: (id: string) => ipcRenderer.invoke("agent-tools:get", id),
		agentToolsGetByAgent: (agentId: string) => ipcRenderer.invoke("agent-tools:get-by-agent", agentId),
		agentToolsCreate: (input: unknown) => ipcRenderer.invoke("agent-tools:create", input),
		agentToolsUpdate: (id: string, input: unknown) => ipcRenderer.invoke("agent-tools:update", id, input),
		agentToolsDelete: (id: string) => ipcRenderer.invoke("agent-tools:delete", id),

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
			templatesGithubPreview: (url: string, subdir?: string) => ipcRenderer.invoke("templates:github-preview", url, subdir),
			templatesImportGithub: (url: string, selectedPaths: string[]) => ipcRenderer.invoke("templates:import-github", url, selectedPaths),
			onGithubImportProgress: (callback: (progress: { current: number; total: number }) => void) => {
				const handler = (_e: any, data: any) => callback(data);
				ipcRenderer.on("github-import:progress", handler);
				return () => { ipcRenderer.removeListener("github-import:progress", handler); };
			},
			onGithubPreviewProgress: (callback: (progress: { current: number; total: number }) => void) => {
				const handler = (_e: any, data: any) => callback(data);
				ipcRenderer.on("github-preview:progress", handler);
				return () => { ipcRenderer.removeListener("github-preview:progress", handler); };
			},

		// ─── Theme ───────────────────────────────────────
		configGetTheme: () => ipcRenderer.invoke("config:get-theme"),
		configSetTheme: (data) => ipcRenderer.invoke("config:set-theme", data),

		// ─── Ask User / Todos / Search ──────────────────
		askUserRespond: (requestId: string, answers: Record<string, string>) => ipcRenderer.invoke("ask-user:respond", requestId, answers),
		getTodos: (agentId: string) => ipcRenderer.invoke("todos:get", agentId),
		getSearchProvider: () => ipcRenderer.invoke("search-provider:get"),
		setSearchProvider: (config: { type: string; searxngUrl?: string; serpApiKey?: string }) => ipcRenderer.invoke("search-provider:set", config),

		// ─── Device Context ─────────────────────────────
		deviceContextGet: () => ipcRenderer.invoke("device-context:get"),
		deviceContextGenerate: () => ipcRenderer.invoke("device-context:generate"),
		deviceContextSave: (content: string) => ipcRenderer.invoke("device-context:save", content),

		// ─── Guidelines ─────────────────────────────────
		guidelinesGet: () => ipcRenderer.invoke("guidelines:get"),
		guidelinesSave: (guidelines: string[]) => ipcRenderer.invoke("guidelines:save", guidelines),};

contextBridge.exposeInMainWorld("api", api);
