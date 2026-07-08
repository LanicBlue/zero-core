// ---------------------------------------------------------------------------
// Preload API — type definition for the bridge between main and renderer.
// The preload script implements this interface; the renderer consumes it.
//
// # 文件说明书
//
// ## 核心功能
// 定义预加载 API 类型，连接主进程和渲染进程。
//
// ## 输入
// 无 - 类型定义文件。
//
// ## 输出
// - WindowApi 接口
//
// ## 定位
// 共享类型模块，被 preload 和 renderer 使用。
//
// ## 依赖
// - ./types - 数据模型类型
//
// ## 维护规则
// - 新增 API 时需更新
// - 保持类型安全
//
// ---------------------------------------------------------------------------

import type {
	AgentRecord, CreateAgentInput, UpdateAgentInput,
	Provider, CreateProviderInput, UpdateProviderInput, ProviderModel, FetchedModel,
	McpServerConfig, CreateMcpInput, UpdateMcpInput, McpStatus,
	PromptTemplate, CreateTemplateInput, UpdateTemplateInput,
	SessionRecord,
	LogEntry, LogFileSummary, FileLogConfig,
	WorkspaceConfig, ToolInfo, ModelInfo,
	ToolExecutionRecord, ToolExecutionFilter, ToolExecutionStats,
	DiscoveredSkill,
	ProjectRecord, CreateProjectInput, UpdateProjectInput,
	ProjectContainerView, ProjectResourceUsage, AgentVia, EnrichProjectBody,
	ProjectArchivistBinding, CronSchedule, WikiOperationId,
	ProjectWorkRecord, ProjectWorkView, CreateProjectWorkBody, FireProjectWorkResult,
	RequirementRecord, CreateRequirementInput, UpdateRequirementInput, RequirementStatusHistory,
	RequirementMessage, TaskStepRecord, ProjectWikiNode, CreateWikiNodeInput, UpdateWikiNodeInput,
	WikiNode, ResolvedAnchorView,
	CronRecord, CreateCronInput, UpdateCronInput, CronRunRecord, ProjectJobRecord,
	OrchestratePlanRecord,
	OrchestrateManifestRecord,
	DelegatedTaskRecord,
	RuntimeTaskInfo,
} from "./types.js";

export interface WindowApi {
	// ── Config ──
	configGet: () => Promise<WorkspaceConfig & { defaultPrompt: string }>;
	configUpdate: (data: Partial<Pick<WorkspaceConfig, "workspaceDir" | "defaultModel" | "defaultProvider" | "proxy">>) => Promise<WorkspaceConfig>;
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
	toolExecute: (toolName: string, input: Record<string, any>) => Promise<{ ok: boolean; result?: string; error?: string; elapsedMs: number }>;
	/**
	 * tool-decoupling sub-5(决策 4):UI 统一 dispatcher。取代 UI 用 REST ——
	 * toolRun({tool, input, scope?, workingDir?}) → 后端 dispatchTool →
	 * getToolExecute(tool)(input, {caller:"ui", ...}) → JSON。
	 * 全工具暴露(无可见性策略);错误结构化返(UI 不崩)。
	 */
	toolRun: (
		tool: string,
		input: Record<string, any>,
		opts?: { scope?: { projectId: string; readOnly?: boolean; allowedTools?: string[] }; workingDir?: string },
	) => Promise<{ ok: boolean; result?: unknown; error?: string; elapsedMs: number }>;

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
	messagesClear: (agentId: string) => Promise<{ success: true }>;
	messagesEdit: (agentId: string, msgSeq: number, newText: string) => Promise<{ success: true } | { error: string }>;
	messagesDelete: (agentId: string, msgSeq: number) => Promise<{ success: true } | { error: string }>;

	// ── Files ──
	filesTree: (root?: string) => Promise<any | { error: string }>;
	filesContent: (path: string, root?: string) => Promise<{ content: string } | { error: string }>;
	filesResolvePath: (path: string, root?: string) => Promise<{ path: string } | { error: string }>;
	filesSave: (path: string, content: string, root?: string) => Promise<{ success: true } | { error: string }>;

	// ── Chat ──
	chatSend: (text: string, agentId?: string, sessionId?: string) => Promise<{ success: true }>;
	chatAbort: (sessionId?: string) => Promise<{ success: true }>;

	// ── Sessions ──
	sessionsList: (agentId: string) => Promise<SessionRecord[]>;
	/**
	 * pull-on-display: 切到某 session 时拉的完整 init payload。messages 是渲染端
	 * ChatMessage 形状(由后端 buildSessionInitMessages 产出);todos + pendingQuestion
	 * 让显示时一并恢复 Tasks 与未决 AskUser 卡片。
	 */
	sessionsGetInit: (sessionId: string) => Promise<{
		messages: any[];
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		contextWindow: number;
		contextUsage: number;
		model: { providerName: string; modelId: string };
		todos: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm: string }>;
		pendingQuestion: { requestId: string; questions: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }> } | null;
		isRunning: boolean;
	} | null>;
	sessionsNew: (agentId: string) => Promise<SessionRecord>;
	/** M4: find-or-create 一个 (agentId, projectId) session(project chat 入口)。 */
	sessionsEnsureForProject: (agentId: string, projectId: string) => Promise<{ sessionId: string; created: boolean }>;
	sessionsSwitch: (agentId: string, sessionId: string) => Promise<{ success: true; sessionId: string }>;
	sessionsCurrent: (agentId: string) => Promise<SessionRecord | null>;
	sessionsActivate: (agentId: string, sessionId?: string) => Promise<{ success: true; sessionId: string }>;
	sessionsDelete: (agentId: string, sessionId: string) => Promise<{ success: true; newSessionId?: string }>;
	/** Archive (soft-delete) a session; returns the replacement session id. */
	sessionsArchive: (agentId: string, sessionId: string) => Promise<{ success: true; newSessionId: string }>;
	sessionsMetrics: () => Promise<{
		sessions: Record<string, {
			sessionId: string;
			agentId: string;
			lifecycleState: string;
			lastActivityAt: number;
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
			totalTurns: number;
			errorCount: number;
		}>;
		totalSessions: number;
		activeSessions: number;
		busySessions: number;
		idleSessions: number;
		concurrencySnapshot: Record<string, { active: number; waiting: number }>;
		lastUpdatedAt: number;
	}>;
	// platform-observability ① ② ③ (sub-4/5/6): the six kanban data endpoints
	// (sessionsParents / sessionsDetail / providerStats / providerUsage /
	// providerQueue / cronsToday) now flow through the unified dispatcher
	// (`toolRun`) instead of dedicated REST/IPC channels. The dedicated
	// WindowApi members are REMOVED; DashboardPage unwraps toolRun results.

	// ── Streaming events ──
	onAgentEvent: (callback: (event: any) => void) => () => void;
	onToolsChanged: (callback: () => void) => () => void;
	/** Unified UI-sync: fires { collection, changes:[{id,op,record?}] } — create/update push the full record so the renderer patches without a round-trip. */
	onDataChanged: (callback: (event: { collection: string; changes: Array<{ id: string; op: string; record?: any }> }) => void) => () => void;
	onSessionLifecycle: (callback: (event: { sessionId: string; from: string; to: string }) => void) => () => void;
	onAppReady: (callback: () => void) => () => void;
	/** N2 reconnect resync: fires when the main↔backend WebSocket reconnected after a drop (NOT on first connect). The renderer re-pulls visible collections. */
	onWsReconnected: (callback: () => void) => () => void;
	onGithubImportProgress: (callback: (progress: { current: number; total: number }) => void) => () => void;
	onGithubPreviewProgress: (callback: (progress: { current: number; total: number }) => void) => () => void;

	// ── Platform ──
	platform: string;

	// ── Window Controls ──
	windowMinimize: () => Promise<void>;
	windowMaximize: () => Promise<void>;
	windowClose: () => Promise<void>;

	// ── Knowledge Base — removed (will be redone via wiki-format file splitting). ──

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
	mcpScan: () => Promise<{ detected: number; added: number; servers: McpServerConfig[] }>;

	// ── Skills ──
	skillsList: () => Promise<DiscoveredSkill[]>;

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
	// ── Tool Executions ──
	toolExecutionsQuery: (filter: ToolExecutionFilter) => Promise<ToolExecutionRecord[]>;
	toolExecutionsStats: (agentId?: string) => Promise<ToolExecutionStats[]>;
	toolExecutionsCleanup: (maxAgeMs: number) => Promise<number>;
	toolExecutionsAnalyze: (agentId?: string) => Promise<{ analysis: string; stats: ToolExecutionStats[]; recentErrors: ToolExecutionRecord[] } | { error: string }>;

	// ── Compression Config ──
	memoryConfigGet: () => Promise<{ compression: { enabled?: boolean; keepRecentTurns?: number; l1Threshold?: number; l2Threshold?: number } }>;
	memoryConfigUpdate: (data: { compression?: any }) => Promise<{ success: true }>;

	// ── Projects ──
	// v0.8 (P5 §8.4): projectsGet supports includeContext → ProjectContainerView.
	// v0.8 (P5 §8.5): projectsGetResourceUsage — sessions token/cost SUM.
	projectsList: (filter?: { status?: string }) => Promise<ProjectRecord[]>;
	projectsGet: (id: string, includeContext?: boolean) => Promise<ProjectRecord | ProjectContainerView | undefined>;
	projectsCreate: (input: CreateProjectInput) => Promise<ProjectRecord>;
	projectsUpdate: (id: string, input: UpdateProjectInput) => Promise<ProjectRecord | { error: string }>;
	projectsDelete: (id: string) => Promise<{ success: true }>;
	projectsGetResourceUsage: (id: string) => Promise<ProjectResourceUsage>;
	/** 手动起 archivist agent 深度充实 wiki(后台、非阻塞)。 */
	projectsEnrich: (id: string, body?: EnrichProjectBody) => Promise<{ jobId: string; sessionId: string }>;
	projectsArchivistBind: (id: string, body: { agentId: string; operations: WikiOperationId[]; schedule: CronSchedule; gitAware?: boolean; gitEveryMs?: number }) => Promise<{ binding: ProjectArchivistBinding }>;
	projectsArchivistUnbind: (id: string) => Promise<{ success: true }>;
	projectsArchivistSwitchAgent: (id: string, agentId: string) => Promise<{ binding: ProjectArchivistBinding }>;
	projectsArchivistSetEnabled: (id: string, enabled: boolean) => Promise<{ binding: ProjectArchivistBinding }>;
	/** v0.8 project-work:列出该项目的全部工位(含空岗)。 */
	projectsListWorks: (id: string) => Promise<{ works: ProjectWorkView[] }>;
	projectsCreateWork: (id: string, body: CreateProjectWorkBody) => Promise<{ work: ProjectWorkRecord }>;
	projectsUpdateWork: (id: string, workId: string, body: Partial<CreateProjectWorkBody>) => Promise<{ work: ProjectWorkRecord }>;
	projectsDeleteWork: (id: string, workId: string) => Promise<{ success: true }>;
	projectsAssignWorkAgent: (id: string, workId: string, agentId: string) => Promise<{ work: ProjectWorkRecord }>;
	projectsSetWorkEnabled: (id: string, workId: string, enabled: boolean) => Promise<{ work: ProjectWorkRecord }>;
	projectsTriggerWork: (id: string, workId: string) => Promise<{ result: FireProjectWorkResult }>;
	/** 列该项目的后台任务记录(供 chat 输入锁判断)。 */
	projectsListJobs: (id: string) => Promise<ProjectJobRecord[]>;

	// ── Requirements ──
	requirementsList: (filter?: { projectId?: string; status?: string; priority?: string }) => Promise<RequirementRecord[]>;
	requirementsGet: (id: string) => Promise<RequirementRecord | undefined>;
	requirementsCreate: (input: CreateRequirementInput) => Promise<RequirementRecord>;
	requirementsUpdate: (id: string, input: UpdateRequirementInput) => Promise<RequirementRecord | { error: string }>;
	requirementsTransition: (id: string, toStatus: string, triggeredBy: string, comment?: string) => Promise<{ requirement: RequirementRecord; historyEntry: RequirementStatusHistory } | { error: string }>;
	requirementsHistory: (id: string) => Promise<RequirementStatusHistory[]>;
	requirementsMessages: (id: string) => Promise<RequirementMessage[]>;
	requirementsAddMessage: (id: string, sender: string, content: string, messageType?: string) => Promise<RequirementMessage>;
	requirementsSteps: (id: string) => Promise<TaskStepRecord[]>;
	// project-flow F4: user-supplied coverage verdict (verify compound close).
	requirementsCoverageVerdict: (id: string, covered: boolean, reason?: string) => Promise<{ ok: boolean; requirement: RequirementRecord; text: string } | { error: string }>;

	// ── Wiki ──
	wikiListByProject: (projectId: string) => Promise<ProjectWikiNode[]>;
	wikiGetNode: (id: string) => Promise<ProjectWikiNode | undefined>;
	wikiCreateNode: (projectId: string, input: CreateWikiNodeInput) => Promise<ProjectWikiNode>;
	wikiUpdateNode: (id: string, input: UpdateWikiNodeInput) => Promise<ProjectWikiNode | { error: string }>;
	wikiDeleteNode: (id: string) => Promise<{ success: true }>;
	// v0.8 (P8 §10.9): global-tree browser surface.
	wikiGetChildren: (nodeId: string) => Promise<WikiNode[]>;
	wikiReadDetail: (nodeId: string) => Promise<{ nodeId: string; detail?: string; summary?: string }>;
	wikiReadWorkspaceDoc: (projectId: string, relPath: string) => Promise<{ content?: string; error?: string }>;
	wikiSearch: (query: string, anchorIds?: string[]) => Promise<WikiNode[]>;
	wikiResolvedAnchors: (agentId: string, projectId?: string) => Promise<ResolvedAnchorView[]>;
	wikiPreviewInjection: (body: {
		agentId: string;
		projectId?: string;
		wikiAnchors?: AgentRecord["wikiAnchors"];
	}) => Promise<{
		systemText: string;
		contextText: string;
		systemTokens: number;
		contextTokens: number;
		anchors: ResolvedAnchorView[];
	}>;

	// ── Delegated tasks (TaskTree) ──
	delegatedTasksBySession: (sessionId: string) => Promise<DelegatedTaskRecord[]>;
	delegatedTasksGet: (id: string) => Promise<DelegatedTaskRecord | undefined>;
	runtimeTasksBySession: (sessionId: string) => Promise<RuntimeTaskInfo[]>;

	// ── Input queue (C2) ──
	inputQueueList: (sessionId: string) => Promise<Array<{ id: string; sessionId: string; content: string; mode: "queued" | "insert_now"; createdAt: number }>>;
	inputQueueEnqueue: (sessionId: string, content: string, mode?: "queued" | "insert_now") => Promise<{ id: string; sessionId: string; content: string; mode: "queued" | "insert_now"; createdAt: number }>;
	inputQueuePromote: (itemId: string) => Promise<{ ok: boolean }>;
	inputQueueRemove: (itemId: string) => Promise<{ ok: boolean }>;

	// ── Lead ──
	leadPickup: (requirementId: string) => Promise<{ sessionId: string } | { error: string }>;
	leadProgress: (requirementId: string) => Promise<{ requirement: RequirementRecord; steps: TaskStepRecord[]; currentStep: TaskStepRecord | undefined; completedCount: number; totalCount: number } | { error: string }>;

	// ── M5: Verification, Archive, Report ──
	requirementsVerify: (id: string) => Promise<{ passed: boolean; report: string } | { error: string }>;
	requirementsArchive: (id: string) => Promise<{ success: true } | { error: string }>;
	requirementsReport: (id: string) => Promise<{ report: string | null }>;

	// v0.8 (P4 §8.6): projects pause/resume/updateInterval removed (dead
	// project schedule channels — cron is agent-scoped now).

	// ── M1: Cron (first-class cron entity; P4 §9.4 list filter + runs) ──
	cronsList: (filter?: { agentId?: string; projectId?: string; enabled?: boolean }) => Promise<CronRecord[]>;
	cronsGet: (id: string) => Promise<CronRecord | undefined>;
	cronsCreate: (input: CreateCronInput) => Promise<CronRecord | { error: string }>;
	cronsUpdate: (id: string, input: UpdateCronInput) => Promise<CronRecord | { error: string }>;
	cronsDelete: (id: string) => Promise<{ success: true }>;
	cronsTrigger: (id: string) => Promise<{ success: true } | { error: string }>;
	cronsListRuns: (cronId: string, limit?: number) => Promise<CronRunRecord[]>;
	// platform-observability ③ (sub-6): cronsToday REMOVED — the kanban reads
	// today's fires via toolRun({tool:"Cron", input:{action:"today"}}).

	// ── M3: Orchestrate plan-gate (kanban pending entry + confirm/reject) ──
	orchestratePending: (filter?: { projectId?: string }) => Promise<OrchestratePlanRecord[]>;
	orchestratePlan: (planId: string) => Promise<OrchestratePlanRecord | { error: string }>;
	orchestrateConfirm: (planId: string) => Promise<{ success: boolean; planId: string; reason?: string }>;
	orchestrateReject: (planId: string, reason: string) => Promise<{ success: boolean; planId: string; reason?: string }>;

	// ── M4: PM discuss-as-document + coverage judgement ──
	requirementsDocRead: (projectId: string, requirementId: string) => Promise<{ docPath?: string; content?: string }>;
	requirementsDocWrite: (projectId: string, requirementId: string, content: string) => Promise<{ docPath: string } | { error: string }>;
	requirementsDocList: (projectId: string) => Promise<string[]>;
	pmCreateRequirement: (input: { projectId: string; title: string; summary?: string; body?: string; priority?: string; source?: "pm" | "user" }) => Promise<RequirementRecord | { error: string }>;
	pmOpenDiscuss: (projectId: string) => Promise<{ agentId: string; sessionId: string; created: boolean } | { error: string }>;
	pmCoverageView: (requirementId: string) => Promise<{ requirement?: RequirementRecord; intentDoc?: string; manifest?: OrchestrateManifestRecord }>;
	pmCoverageVerdict: (requirementId: string, covered: boolean, reason?: string) => Promise<{ success: boolean; requirementId: string; kind: "verify_accept" | "verify_reject" } | { error: string }>;

	// ── MCP presets / search provider / webfetch (preload impls existed; the
	// WindowApi contract lagged — params were implicit any). Returns are loose
	// (any) where the backend shape isn't typed here. ──
	mcpPresets: () => Promise<any>;
	mcpAddPreset: (presetId: string, envValues: Record<string, string>) => Promise<any>;
	webfetchLogin: (url: string) => Promise<any>;
	webfetchCookies: () => Promise<any>;
	webfetchClearCookies: (domain?: string) => Promise<any>;
}
