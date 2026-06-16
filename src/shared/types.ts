// ---------------------------------------------------------------------------
// Shared types — used by both server (main process) and renderer (UI)
// Single source of truth for all data model interfaces.
//
// # 文件说明书
//
// ## 核心功能
// 定义共享类型，供主进程和渲染进程使用。
//
// ## 输入
// 无 - 类型定义文件。
//
// ## 输出
// - TypeScript 类型定义
//
// ## 定位
// 共享类型模块，被整个项目使用。
//
// ## 依赖
// 无
//
// ## 维护规则
// - 新增类型时需更新
// - 保持类型命名一致
//
// ---------------------------------------------------------------------------

// ── Data Models ─────────────────────────────────────────────────────────────

export interface AgentRecord {
	id: string;
	name: string;
	workspaceDir?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	contextConfig?: {
		useDeviceContext?: boolean;
		useGuidelines?: boolean;
		useMemoryContext?: boolean;
	};
	systemPrompt?: string;
	toolPolicy?: {
		autoApprove?: string[];
		blockedTools?: string[];
		tools?: Record<string, { enabled: boolean }>;
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
		readScope?: "filesystem" | "workspace";
	};
	skillPolicy?: {
		enabledSkills?: string[];
	};
	knowledgeBaseIds?: string[];
	/**
	 * v0.8 (M0): optional role tag for UI grouping and preset entry points.
	 * Not a runtime type — workflow emerges from prompt + toolPolicy + caller
	 * context, not from this field. Common values: lead | pm | archivist |
	 * analyzer | planner | developer | reviewer | qa | zero.
	 */
	roleTag?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ProviderModel {
	id: string;
	name: string;
	group?: string;
	contextWindow?: number;
	maxTokens?: number;
	multimodal?: boolean;
}

export interface Provider {
	id: string;
	name: string;
	type: "openai" | "anthropic" | "gemini" | "openai-compatible" | "ollama" | "mock";
	apiKey: string;
	baseUrl: string;
	models: ProviderModel[];
	enabled: boolean;
	isSystem?: boolean;
	enableConcurrencyLimit?: boolean;
	maxConcurrency?: number;
	createdAt: string;
	updatedAt: string;
}

export interface AgentToolEntry {
	id: string;
	name: string;
	description?: string;
	type: "internal" | "external";
	enabled: boolean;
	agentId?: string;
	transport?: "cli" | "http";
	command?: string;
	argsTemplate?: string;
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	bodyTemplate?: string;
	responsePath?: string;
	timeout?: number;
	blocking?: boolean;
	auto_background_timeout?: number;
	createdAt: string;
	updatedAt: string;
}

export interface KbFileInfo {
	path: string;
	name: string;
	size: number;
	chunks: number;
	ingestedAt: string;
}

export interface KnowledgeBase {
	id: string;
	name: string;
	description: string;
	embeddingProvider: string;
	embeddingModel: string;
	agentIds: string[];
	files: KbFileInfo[];
	createdAt: string;
	updatedAt: string;
}

export interface McpServerConfig {
	id: string;
	name: string;
	transport: "stdio" | "sse" | "streamable-http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	enabled: boolean;
	agentIds?: string[];
	sourceApp?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PromptTemplate {
	id: string;
	name: string;
	description: string;
	icon?: string;
	systemPrompt: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	toolPolicy?: {
		autoApprove?: string[];
		blockedTools?: string[];
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
		readScope?: "filesystem" | "workspace";
	};
	tags: string[];
	sourceUrl?: string;
	color?: string;
	recommendedTools?: string[];
	isBuiltIn: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SessionRecord {
	id: string;
	agentId: string;
	isMain: boolean;
	title: string | null;
	createdAt: string;
	updatedAt: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	estimatedCostUsd?: number;
	/**
	 * v0.8 (M0): session context bundle (D-B).
	 * Carries the project/workspace/wiki-root context the global role is
	 * currently serving. Sub-agents inherit caller bundle; cron/notification
	 * provide scope via this field. `{agentId, context.projectId}` is the
	 * find-or-create routing key for discuss/notification/cron.
	 */
	context?: SessionContextBundle;
}

/**
 * v0.8 (M0): the context bundle a session carries. projectId is optional
 * (global/observation sessions have none); workspaceDir and wikiRootNodeId
 * are required so every session has a concrete work location and wiki view.
 */
export interface SessionContextBundle {
	projectId?: string;
	workspaceDir: string;
	wikiRootNodeId: string;
}

export interface LogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	module: string;
	message: string;
}

export interface LogFileSummary {
	filename: string;
	size: number;
	date: string;
}

// ── Input Types (derived from data models) ──────────────────────────────────

export type CreateAgentInput = Omit<AgentRecord, "id" | "createdAt" | "updatedAt">;
export type UpdateAgentInput = Partial<Omit<AgentRecord, "id" | "createdAt" | "updatedAt">>;

export type CreateProviderInput = Omit<Provider, "id" | "createdAt" | "updatedAt">;
export type UpdateProviderInput = Partial<Omit<Provider, "id" | "createdAt" | "updatedAt">>;

export type CreateAgentToolInput = Omit<AgentToolEntry, "id" | "createdAt" | "updatedAt">;
export type UpdateAgentToolInput = Partial<Omit<AgentToolEntry, "id" | "createdAt" | "updatedAt">>;

export type CreateKbInput = Omit<KnowledgeBase, "id" | "createdAt" | "updatedAt">;
export type UpdateKbInput = Partial<Omit<KnowledgeBase, "id" | "createdAt" | "updatedAt">>;

export type CreateMcpInput = Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">;
export type UpdateMcpInput = Partial<Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">>;

export type CreateTemplateInput = Omit<PromptTemplate, "id" | "createdAt" | "updatedAt">;
export type UpdateTemplateInput = Partial<Omit<PromptTemplate, "id" | "createdAt" | "updatedAt">>;

// ── Result Types ────────────────────────────────────────────────────────────

export type Ok = { success: true };
export type Err = { error: string };
export type OkOrErr = Ok | Err;

// ── Workspace Config ────────────────────────────────────────────────────────

export type SearchProviderType = "duckduckgo" | "searxng" | "serpapi" | "brave";

export interface SearchProviderConfig {
	type: SearchProviderType;
	searxngUrl?: string;
	serpApiKey?: string;
	braveApiKey?: string;
}

export interface ProxyConfig {
	enabled: boolean;
	url: string;
	bypass?: string[];
}

export interface WorkspaceConfig {
	workspaceDir: string;
	defaultModel?: string;
	defaultProvider?: string;
	searchProvider?: SearchProviderConfig;
	proxy?: ProxyConfig;
	readScope?: "filesystem" | "workspace";
}

// ── File Log Config ─────────────────────────────────────────────────────────

export interface FileLogConfig {
	enabled: boolean;
	retentionDays: number;
	globalLevel: "debug" | "info" | "warn" | "error";
}

// ── Tool Info ───────────────────────────────────────────────────────────────

export interface ToolInfo {
	name: string;
	description: string;
	prompt: string;
	group: string;
	source: string;
	mcpServerName?: string;
	/**
	 * v0.8 (M0): for agent-tools (source === "agent"), the stable
	 * AgentToolEntry.id used as the toolPolicy key. UI displays `name` but
	 * toggles resolve against this id (decision 2). Undefined for built-in
	 * tools (which remain name-keyed).
	 */
	agentToolId?: string;
	configSchema?: any[];
	inputFields?: Array<{ key: string; type: string; required: boolean; description?: string; enum?: string[] }>;
	meta?: any;
}

// ── Model Info ──────────────────────────────────────────────────────────────

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
}

// ── Runtime State ───────────────────────────────────────────────────────────

export interface RuntimeState {
	isBusy: boolean;
	streamingText: string;
	toolCalls: { name: string; status: string }[];
	agentId?: string;
}

// ── Message Types ───────────────────────────────────────────────────────────

export interface MessageTurn {
	id: string;
	role: "user" | "assistant";
	text: string;
	blocks?: any[];
	timestamp: string;
}

// ── KB Search ───────────────────────────────────────────────────────────────

export interface KbSearchResult {
	chunkId: number;
	filePath: string;
	content: string;
	score: number;
}

export interface KbFileIngestResult {
	path: string;
	chunks: number;
	error?: string;
}

// ── MCP Status ──────────────────────────────────────────────────────────────

export interface McpStatus {
	id: string;
	name: string;
	connected: boolean;
	toolCount: number;
}

// ── Tool Execution Tracking ────────────────────────────────────────────────

export interface ToolExecutionRecord {
	id: number;
	sessionId: string;
	agentId: string;
	toolName: string;
	success: boolean;
	errorMessage?: string;
	inputPreview?: string;
	outputPreview?: string;
	durationMs: number;
	turnSeq?: number;
	createdAt: string;
}

export interface ToolExecutionFilter {
	agentId?: string;
	sessionId?: string;
	toolName?: string;
	success?: boolean;
	limit?: number;
	offset?: number;
}

export interface ToolExecutionStats {
	toolName: string;
	totalCalls: number;
	errorCount: number;
	errorRate: number;
	avgDurationMs: number;
	lastErrorAt?: string;
}

// ── Fetched Model (from provider API) ───────────────────────────────────────

export interface FetchedModel {
	id: string;
	name: string;
	group?: string;
}

// ── Skills ──────────────────────────────────────────────────────────────────

export interface DiscoveredSkill {
	id: string;
	name: string;
	description: string;
	source: "user" | "app";
	filePath: string;
	baseDir: string;
}

// ── Multi-Agent Workflow Types ─────────────────────────────────

/**
 * v0.8 (M0): Project slimmed to pure metadata + notification hub + ownership
 * key. All cron runtime state moved out (cron is now a first-class entity,
 * M1). workspaceDir is normalized (resolve + realpath), unique, immutable
 * after creation.
 */
export interface ProjectRecord {
	id: string;
	name: string;
	workspaceDir: string;
	createdAt: string;
	updatedAt: string;
}

export type RequirementStatus =
	| "found" | "discuss" | "ready" | "plan"
	| "build" | "verify" | "closed" | "cancelled";
export type RequirementPriority = "low" | "normal" | "high" | "critical";
export type RequirementSource = "analyst" | "user";

export interface RequirementRecord {
	id: string;
	projectId: string;
	title: string;
	description?: string;
	status: RequirementStatus;
	source: RequirementSource;
	priority: RequirementPriority;
	impactScope?: string;
	context?: string;               // JSON
	assignedLeadSessionId?: string;
	discussionSessionId?: string;
	reviewer: "analyst" | "user";
	closedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface RequirementStatusHistory {
	id: string;
	requirementId: string;
	fromStatus?: RequirementStatus;
	toStatus: RequirementStatus;
	triggeredBy: "analyst" | "user" | "lead" | "system";
	comment?: string;
	createdAt: string;
}

export type TaskStepRole = "developer" | "reviewer" | "qa";
export type TaskStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface TaskStepRecord {
	id: string;
	requirementId: string;
	stepOrder: number;
	role: TaskStepRole;
	title: string;
	description?: string;
	agentConfig?: string;           // JSON
	status: TaskStepStatus;
	input?: string;                 // JSON
	output?: string;                // JSON
	reviewResult?: "approved" | "rejected";
	reviewComment?: string;
	retryCount: number;
	maxRetries: number;
	sessionId?: string;
	startedAt?: string;
	completedAt?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
}

export type WikiNodeType = "directory" | "file" | "function" | "class" | "section";

export interface ProjectWikiNode {
	id: string;
	projectId: string;
	parentId?: string;
	nodeType: WikiNodeType;
	path: string;
	title: string;
	summary?: string;
	detail?: string;
	lastUpdatedBy: "analyst" | "user";
	sourceReqId?: string;
	createdAt: string;
	updatedAt: string;
}

export type RequirementMessageSender =
	| "user" | "analyst" | "lead" | "developer" | "reviewer" | "qa";
export type RequirementMessageType =
	| "text" | "status_change" | "approval_request" | "notification";

export interface RequirementMessage {
	id: string;
	requirementId: string;
	sender: RequirementMessageSender;
	content: string;
	messageType: RequirementMessageType;
	metadata?: string;              // JSON
	createdAt: string;
}

// ── Multi-Agent Workflow Input Types ──────────────────────────

export type CreateProjectInput = Omit<ProjectRecord, "id" | "createdAt" | "updatedAt">;
export type UpdateProjectInput = Partial<Omit<ProjectRecord, "id" | "createdAt" | "updatedAt">>;

export type CreateRequirementInput = Omit<RequirementRecord, "id" | "createdAt" | "updatedAt">;
export type UpdateRequirementInput = Partial<Omit<RequirementRecord, "id" | "createdAt" | "updatedAt">>;

export type CreateWikiNodeInput = Omit<ProjectWikiNode, "id" | "createdAt" | "updatedAt">;
export type UpdateWikiNodeInput = Partial<Omit<ProjectWikiNode, "id" | "createdAt" | "updatedAt">>;

// ── Cron (v0.8 M1 — cron becomes a first-class entity) ────────

/**
 * v0.8 (M1): a CronRecord is one scheduled recurring run of a *global* agent
 * against a *working scope* (RFC §4.3). One agent can carry N cron entries —
 * one per scope (e.g. a global PM serving project A hourly and project B
 * daily). The cron entry owns its own session bundle (`workingScope`); on
 * trigger it routes to a session via resolveSessionByRoleProject (or, for
 * observation cron with no projectId, a session keyed by agentId).
 *
 * schedule is one of the named cadences or a custom cron/interval string
 * (kept opaque here; CronAnalysisManager parses it).
 */
export interface CronRecord {
	id: string;
	agentId: string;
	/** Session-context bundle the cron resolves to on each trigger. */
	workingScope: SessionContextBundle;
	/** "off" disables the cron but keeps the row. */
	schedule: CronSchedule;
	prompt?: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

/** Named cadence presets; arbitrary cron/interval strings also allowed. */
export type CronSchedule = "off" | "hourly" | "daily" | "weekly" | (string & {});

export type CreateCronInput = Omit<CronRecord, "id" | "createdAt" | "updatedAt">;
export type UpdateCronInput = Partial<Omit<CronRecord, "id" | "createdAt" | "updatedAt">>;
