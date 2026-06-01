// ---------------------------------------------------------------------------
// Preload API — type definition for the bridge between main and renderer.
// The preload script implements this interface; the renderer consumes it.
// ---------------------------------------------------------------------------

import type {
	AgentRecord, CreateAgentInput, UpdateAgentInput,
	Provider, CreateProviderInput, UpdateProviderInput, ProviderModel, FetchedModel,
	AgentToolEntry, CreateAgentToolInput, UpdateAgentToolInput,
	KnowledgeBase, CreateKbInput, UpdateKbInput, KbSearchResult, KbFileIngestResult,
	McpServerConfig, CreateMcpInput, UpdateMcpInput, McpStatus,
	PromptTemplate, CreateTemplateInput, UpdateTemplateInput,
	SessionRecord, MessageTurn,
	LogEntry, LogFileSummary, FileLogConfig,
	WorkspaceConfig, ToolInfo, ModelInfo, RuntimeState,
} from "./types.js";

export interface WindowApi {
	// ── Config ──
	configGet: () => Promise<WorkspaceConfig & { defaultPrompt: string }>;
	configUpdate: (data: Partial<Pick<WorkspaceConfig, "workspaceDir" | "defaultModel" | "defaultProvider">>) => Promise<WorkspaceConfig>;
	dialogOpenDirectory: () => Promise<string | undefined>;
	configGetTheme: () => Promise<{ mode: string; customPrimaryColor: string | null }>;
	configSetTheme: (data: { mode: string; customPrimaryColor?: string }) => Promise<{ success: true } | { error: string }>;

	// ── Agents ──
	agentsList: () => Promise<AgentRecord[]>;
	agentsGet: (id: string) => Promise<AgentRecord | undefined>;
	agentsCreate: (input: CreateAgentInput) => Promise<AgentRecord>;
	agentsUpdate: (id: string, input: UpdateAgentInput) => Promise<AgentRecord | { error: string }>;
	agentsDelete: (id: string) => Promise<{ success: true }>;

	// ── Models & Tools ──
	modelsList: () => Promise<ModelInfo[]>;
	toolsList: () => Promise<ToolInfo[]>;
	toolConfigGet: () => Promise<Record<string, Record<string, any>>>;
	toolConfigSave: (config: Record<string, Record<string, any>>) => Promise<void>;

	// ── Providers ──
	providersList: () => Promise<Provider[]>;
	providersGet: (id: string) => Promise<Provider | undefined>;
	providersCreate: (input: CreateProviderInput) => Promise<Provider>;
	providersUpdate: (id: string, input: UpdateProviderInput) => Promise<Provider | { error: string }>;
	providersDelete: (id: string) => Promise<{ success: true }>;
	providersAddModel: (providerId: string, model: ProviderModel) => Promise<Provider | { error: string }>;
	providersRemoveModel: (providerId: string, modelId: string) => Promise<Provider | { error: string }>;
	providersFetchModels: (providerId: string) => Promise<FetchedModel[]>;

	// ── Messages ──
	messagesList: (agentId: string) => Promise<MessageTurn[]>;
	messagesClear: (agentId: string) => Promise<{ success: true }>;
	messagesEdit: (agentId: string, msgSeq: number, newText: string) => Promise<{ success: true } | { error: string }>;
	messagesDelete: (agentId: string, msgSeq: number) => Promise<{ success: true } | { error: string }>;

	// ── Files ──
	filesTree: (root?: string) => Promise<any | { error: string }>;
	filesContent: (path: string, root?: string) => Promise<{ content: string } | { error: string }>;
	filesResolvePath: (path: string, root?: string) => Promise<{ path: string } | { error: string }>;
	filesSave: (path: string, content: string, root?: string) => Promise<{ success: true } | { error: string }>;

	// ── Chat ──
	chatSend: (text: string, agentId?: string) => Promise<{ success: true }>;
	chatAbort: (agentId?: string) => Promise<{ success: true }>;
	chatState: (agentId?: string) => Promise<RuntimeState>;

	// ── Sessions ──
	sessionsList: (agentId: string) => Promise<SessionRecord[]>;
	sessionsNew: (agentId: string) => Promise<SessionRecord>;
	sessionsSwitch: (agentId: string, sessionId: string) => Promise<{ success: true; sessionId: string }>;
	sessionsCurrent: (agentId: string) => Promise<SessionRecord | null>;
	sessionsDelete: (agentId: string, sessionId: string) => Promise<{ success: true; newSessionId?: string }>;

	// ── Streaming events ──
	onAgentEvent: (callback: (event: any) => void) => () => void;
	onToolsChanged: (callback: () => void) => () => void;
	onAppReady: (callback: () => void) => () => void;
	onGithubImportProgress: (callback: (progress: { current: number; total: number }) => void) => () => void;
	onGithubPreviewProgress: (callback: (progress: { current: number; total: number }) => void) => () => void;

	// ── Platform ──
	platform: string;

	// ── Knowledge Base ──
	kbList: () => Promise<KnowledgeBase[]>;
	kbGet: (id: string) => Promise<KnowledgeBase | undefined>;
	kbCreate: (input: CreateKbInput) => Promise<KnowledgeBase>;
	kbUpdate: (id: string, input: UpdateKbInput) => Promise<KnowledgeBase | { error: string }>;
	kbDelete: (id: string) => Promise<{ success: true }>;
	kbAddFiles: (kbId: string, filePaths: string[]) => Promise<KbFileIngestResult[]>;
	kbRemoveFile: (kbId: string, filePath: string) => Promise<{ success: true }>;
	kbSearch: (kbIds: string[], query: string) => Promise<KbSearchResult[]>;
	kbChunkCount: (kbId: string) => Promise<number>;

	// ── Agent Tools ──
	agentToolsList: () => Promise<AgentToolEntry[]>;
	agentToolsGet: (id: string) => Promise<AgentToolEntry | undefined>;
	agentToolsGetByAgent: (agentId: string) => Promise<AgentToolEntry | undefined>;
	agentToolsCreate: (input: CreateAgentToolInput) => Promise<AgentToolEntry>;
	agentToolsUpdate: (id: string, input: UpdateAgentToolInput) => Promise<AgentToolEntry | { error: string }>;
	agentToolsDelete: (id: string) => Promise<{ success: true }>;

	// ── MCP ──
	mcpList: () => Promise<McpServerConfig[]>;
	mcpGet: (id: string) => Promise<McpServerConfig | undefined>;
	mcpCreate: (input: CreateMcpInput) => Promise<McpServerConfig & { connectedTools?: any[]; connectError?: string }>;
	mcpUpdate: (id: string, input: UpdateMcpInput) => Promise<McpServerConfig | { error: string }>;
	mcpDelete: (id: string) => Promise<{ success: true }>;
	mcpTest: (input: CreateMcpInput) => Promise<{ tools: { name: string; description?: string }[]; error?: string }>;
	mcpTools: (serverId: string) => Promise<{ name: string; description?: string }[] | number>;
	mcpConnect: (id: string) => Promise<{ tools: { name: string; description?: string }[]; error?: string }>;
	mcpDisconnect: (id: string) => Promise<{ success: true }>;
	mcpStatus: () => Promise<McpStatus[]>;

	// ── Templates ──
	templatesList: () => Promise<PromptTemplate[]>;
	templatesGet: (id: string) => Promise<PromptTemplate | undefined>;
	templatesCreate: (input: CreateTemplateInput) => Promise<PromptTemplate>;
	templatesUpdate: (id: string, input: UpdateTemplateInput) => Promise<PromptTemplate | { error: string }>;
	templatesDelete: (id: string) => Promise<{ success: true } | { error: string }>;
	templatesExport: (id: string) => Promise<string | { error: string }>;
	templatesImport: (json: string) => Promise<PromptTemplate | { error: string }>;
	templatesGithubPreview: (url: string, subdir?: string) => Promise<{ items: any[]; sourceUrl: string; cached?: boolean } | { error: string }>;
	templatesImportGithub: (url: string, selectedPaths: string[]) => Promise<{ imported: number; updated: number; total: number } | { error: string }>;

	// ── Device Context ──
	deviceContextGet: () => Promise<{ content: string }>;
	deviceContextGenerate: () => Promise<{ content: string; error?: string }>;
	deviceContextSave: (content: string) => Promise<{ success: true } | { error: string }>;

	// ── Guidelines ──
	guidelinesGet: () => Promise<{ guidelines: string[]; defaults: string[]; isDefault: boolean }>;
	guidelinesSave: (guidelines: string[]) => Promise<{ success: true } | { error: string }>;

	// ── Logs ──
	logsListFiles: () => Promise<LogFileSummary[]>;
	logsRead: (filename: string, opts?: { lines?: number; level?: string }) => Promise<LogEntry[]>;
	logsGetConfig: () => Promise<FileLogConfig>;
	logsSetConfig: (config: FileLogConfig) => Promise<void>;

	// ── Ask User / Todos / Search ──
	askUserRespond: (requestId: string, answers: Record<string, string>) => Promise<{ success: true }>;
	getTodos: (agentId: string) => Promise<any[]>;
	getSearchProvider: () => Promise<any>;
	setSearchProvider: (config: { type: string; searxngUrl?: string; serpApiKey?: string }) => Promise<{ success: true }>;
}
