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
	 * v0.8 (P0 §2.2 / §11.9): subagents this agent may delegate to. Each entry
	 * references a global agent by id (soft ref — no cascade). name/description
	 * are optional display overrides; the canonical name lives on the target
	 * AgentRecord. JSON-stored as a single TEXT column (see AGENT_COLUMNS).
	 */
	subagents?: Array<{ agentId: string; name?: string; description?: string }>;
	/**
	 * v0.8 (P0 §2.2 / §11.9): wiki nodes this agent anchors into its context.
	 * `inject` controls how the node enters the prompt — `system` (always in
	 * system prompt), `context` (in the turn context bundle), or `off` (stored
	 * but not injected). `depth` = how many levels of children to pull in.
	 * JSON-stored as a single TEXT column.
	 */
	wikiAnchors?: Array<{
		nodeId: string;
		inject: "system" | "context" | "off";
		depth?: number;
	}>;
	/**
	 * v0.8 (P0 §1.4 / §2.2): roleTag was REMOVED from the type. Identity in
	 * v0.8 = name + systemPrompt (RFC §1.4); UI grouping / preset entry now
	 * flows through subagents + wikiAnchors + toolPolicy, not a string tag.
	 *
	 * The physical `role_tag` column is KEPT on the agents table (legacy —
	 * dropping it would risk data loss / rollback pain, see plan-P0.md §1.4
	 * + acceptance-P0.md). AgentStore no longer reads or writes it. Runtime/
	 * service code that still references `.roleTag` is left intact with
	 * `@ts-expect-error` and slated for P2/P7 cleanup. Field intentionally
	 * absent here.
	 */
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
	// v0.8 (M4): discuss-as-document. docPath points at the requirement doc
	// inside the repo ({workspace}/.zero/requirements/{projectId}/…); the doc
	// is also an intent leaf node in the project wiki tree (RFC §2.10 / §4.5 /
	// decision 12/14). The agent fields carry the global role agent ids.
	docPath?: string;
	/** PM (global role agent) that created this requirement (discuss routing key = projectId + role). */
	createdByAgentId?: string;
	/** Lead (global role agent) that picked this up. */
	assignedAgentId?: string;
	/**
	 * Coverage-judgement party (decision 34). v0.7+ semantics = the agent that
	 * judges whether changes+tests cover the original intent — defaults to the
	 * PM that created the requirement. NOT a technical accept (that lives in
	 * the Orchestrate flow). No productionReady multi-gate aggregation.
	 */
	reviewerAgentId?: string;
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

/**
 * v0.8 (M2): the node type on the global wiki memory tree. RFC §4.6 / §2.19.
 *
 * - `project`  — root of one project's subtree (one per project; the session
 *                `wikiRootNodeId` for project-role sessions points here).
 * - `header`   — describes one code file; `docPointer` → file path.
 * - `intent`   — describes one requirement doc; `docPointer` → doc path.
 * - `structure`— module / subsystem / convention node (aggregated).
 * - `memory`   — cross-project memory written by extractor A (M5); hangs
 *                under a global type node, NOT under any `project` subtree.
 *
 * Legacy renderer still references the old `nodeType` ("directory"/"file"/…)
 * and `path` fields; ProjectWikiNode below is kept as a back-compat view so
 * the renderer keeps compiling. New code uses `type` + `docPointer`.
 */
export type WikiNodeTypeGlobal =
	| "header" | "intent" | "structure" | "project" | "memory" | (string & {});

/**
 * v0.8 (M2): one node on the single global wiki memory tree (RFC §4.6 / §2.19).
 *
 * The tree lives in the zero-core database, NOT in any project workspace.
 * Leaf nodes carry `docPointer` to the actual doc on disk (code file,
 * requirement doc, ADR); the actual doc is NOT duplicated into the tree.
 *
 * Two disjoint writer scopes (RFC §2.16 N2):
 *   - archivist writes the `project` subtree structure nodes only;
 *   - extractor A (M5) writes global `memory` nodes outside any project
 *     subtree.
 */
export interface WikiNode {
	id: string;
	/** Tree parent. Undefined only on the synthetic global root. */
	parentId?: string;
	/** Node type on the global tree (RFC §4.6). */
	type: WikiNodeTypeGlobal;
	/**
	 * Stable path used as upsert key within a parent scope, e.g.
	 *   "project:<projectId>"                  (project subtree root)
	 *   "header:src/runtime/agent-loop.ts"     (code-file header)
	 *   "intent:docs/req-foo.md"               (requirement-doc intent)
	 *   "memory:global/dev/notes"              (M5 cross-project memory)
	 * Legacy renderer code reads `path` directly; ProjectWikiNode view maps it.
	 */
	path: string;
	title: string;
	summary?: string;
	detail?: string;
	/**
	 * Leaf pointer to the actual document on disk (code file / requirement
	 * doc / ADR). The doc itself is NOT stored in the wiki tree.
	 */
	docPointer?: string;
	/**
	 * Provenance tag for structural assertions — archivist's own confidence
	 * marker, not a workflow-wide labeling scheme (RFC §2.17a, decision 33).
	 * - `structure` — inferred from code structure (what).
	 * - `derived`   — aggregated from commit message / ADR / design doc /
	 *                  comments (why, may lag).
	 * - `confirmed` — confirmed from user discuss or PM requirement doc.
	 */
	provenance?: "structure" | "derived" | "confirmed";
	/**
	 * Traceability: requirement IDs this node relates to (req→module both
	 * directions). RFC §4.6 / §2.13.
	 */
	requirementIds?: string[];
	/**
	 * Project ID this node belongs to (only set on `project` subtree nodes;
	 * undefined on global memory nodes). Used as the project-scoping key.
	 */
	projectId?: string;
	/** Free-form relations (module contains / depends-on / implements). */
	relations?: Array<{ kind: string; targetId: string }>;
	/**
	 * v0.8 (P0 §3.3 / §10.1): undirected sibling links — array of nodeIds this
	 * node is connected to (no direction / no kind, unlike `relations`). Used
	 * by the cross-cutting graph view (e.g. "this header is also referenced by
	 * these intent nodes"). JSON-stored as a TEXT column; NULL/coalesce to `[]`
	 * on read. type/detail columns stay in this phase (P1 moves detail → disk).
	 */
	links?: string[];
	/**
	 * Flag set when archivist detected a divergence it couldn't auto-resolve
	 * (e.g. "no recorded intent for this code capability" / "intent with no
	 * implementation"). PM/lead reads this to surface to the user.
	 */
	flags?: string[];
	/**
	 * Legacy back-compat: single requirement id this node originated from.
	 * Pre-M2 rows carry this; new code uses requirementIds[]. Kept on the
	 * type so the back-compat ProjectWikiStore view round-trips through it.
	 */
	sourceReqId?: string;
	lastUpdatedBy?: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * v0.8 (M2): ProjectWikiNode is the back-compat view over the global WikiNode
 * tree. The legacy renderer (WikiTree.tsx / WikiDetail.tsx) and the existing
 * IPC handlers consume this shape. New server code should use WikiNode.
 *
 * A project-subtree WikiNode projects to a ProjectWikiNode as:
 *   nodeType = (type === "header" ? "file"
 *              : type === "structure" ? "directory"
 *              : type === "intent" ? "file"
 *              : "section")
 *   path     = node.path (already includes a leading scope prefix the
 *              renderer strips; legacy behavior preserved)
 */
export interface ProjectWikiNode {
	id: string;
	projectId: string;
	parentId?: string;
	/** Legacy type discriminator; mapped from WikiNode.type (see above). */
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

// ── Cron (v0.8 M1 — cron becomes a first-class entity; P0 §3.4 schedule JSON) ──

/**
 * v0.8 (P0 §3.4 / §9.1 / §9.3): the structured schedule for a cron entry.
 *
 * Three modes (the scheduler reads `mode` to pick the firing rule):
 *  - `interval` — fire every `everyMs` milliseconds (e.g. hourly = 3_600_000).
 *  - `alarm`    — fire daily at `time` (HH:MM, local zone) on the listed
 *                 ISO weekday numbers in `days` (1=Mon … 7=Sun; empty = every
 *                 day). `tz` is the IANA timezone the alarm is expressed in.
 *  - `once`     — fire exactly once at `at` (ISO timestamp); after firing the
 *                 scheduler marks the cron disabled.
 *
 * The `enabled` flag on the CronRecord (NOT inside the schedule) gates
 * firing — `schedule = { mode: "interval", everyMs: 0 }` is just an inert
 * shape; enabled=false is the real "off".
 *
 * Migration (plan-P0 §11) maps the legacy string cadences:
 *   "off"     → enabled=false (schedule = { mode:"interval", everyMs:0 })
 *   "hourly"  → { mode:"interval", everyMs:3_600_000 }
 *   "daily"   → { mode:"alarm", time:"09:00", days:[], tz:<local> }
 *   "weekly"  → { mode:"alarm", time:"09:00", days:[<today>], tz:<local> }
 *   "<digits>"→ { mode:"interval", everyMs:<n> }
 */
export type CronScheduleMode = "once" | "alarm" | "interval";

export interface CronScheduleOnce {
	mode: "once";
	/** ISO 8601 timestamp the cron should fire once at. */
	at: string;
}

export interface CronScheduleAlarm {
	mode: "alarm";
	/** Local-time-of-day "HH:MM". */
	time: string;
	/** ISO weekday numbers 1=Mon … 7=Sun. Empty array = every day. */
	days: number[];
	/** IANA timezone, e.g. "Asia/Shanghai". Required so alarm survives host TZ drift. */
	tz: string;
}

export interface CronScheduleInterval {
	mode: "interval";
	/** Firing period in milliseconds. 0 = inert (rely on `enabled=false` for real off). */
	everyMs: number;
}

export type CronSchedule = CronScheduleOnce | CronScheduleAlarm | CronScheduleInterval;

/** Last-run outcome for a cron entry, mirrored onto the crons row for fast reads. */
export type CronLastStatus = "ok" | "failed" | "missed";

/**
 * v0.8 (M1): a CronRecord is one scheduled recurring run of a *global* agent
 * against a *working scope* (RFC §4.3). One agent can carry N cron entries —
 * one per scope (e.g. a global PM serving project A hourly and project B
 * daily). The cron entry owns its own session bundle (`workingScope`); on
 * trigger it routes to a session via resolveSessionByRoleProject (or, for
 * observation cron with no projectId, a session keyed by agentId).
 *
 * P0 §3.4: `schedule` is now the structured `CronSchedule` union (JSON column),
 * NOT the legacy string cadence. The three new columns (`triggerMode`,
 * `lastRunAt`, `lastStatus`, `lastError`, `nextRunAt`) are scheduler telemetry
 * — populated by the P4 scheduler; this phase only carries the columns.
 */
export interface CronRecord {
	id: string;
	agentId: string;
	/** Session-context bundle the cron resolves to on each trigger. */
	workingScope: SessionContextBundle;
	/** Structured schedule (three-mode JSON). See CronSchedule. */
	schedule: CronSchedule;
	/**
	 * Redundant copy of `schedule.mode` for cheap WHERE filtering without
	 * JSON parsing. Kept in sync by the store on every schedule write.
	 */
	triggerMode?: CronScheduleMode;
	/** Telemetry: last fire timestamp (ISO). Set by P4 scheduler. */
	lastRunAt?: string;
	/** Telemetry: outcome of the last fire. */
	lastStatus?: CronLastStatus;
	/** Telemetry: error string from the last failed fire. */
	lastError?: string;
	/** Telemetry: next fire timestamp the scheduler computed (ISO). */
	nextRunAt?: string;
	prompt?: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export type CreateCronInput = Omit<CronRecord, "id" | "createdAt" | "updatedAt">;
export type UpdateCronInput = Partial<Omit<CronRecord, "id" | "createdAt" | "updatedAt">>;

// ── cron_runs (P0 §3.4 / §9.3 — execution audit log) ───────────────

/**
 * v0.8 (P0 §9.3): one row per actual cron fire. Written by the P4 scheduler
 * after each run; this phase only carries the table + types. PK id is a uuid.
 * `success` mirrors `lastStatus` but as a boolean for cheap filtering.
 */
export interface CronRunRecord {
	id: string;
	cronId: string;
	/** ISO timestamp the fire actually happened (scheduler wake time). */
	firedAt: string;
	/** Agent the cron routed to (denormalized from CronRecord.agentId). */
	agentId?: string;
	/** Session the cron ran in (resolved by workingScope routing). */
	sessionId?: string;
	success: boolean;
	error?: string;
	/** Wall-clock duration of the run, milliseconds. */
	durationMs?: number;
	/** Token usage of the run (input+output summed). */
	tokens?: number;
	/** Estimated USD cost of the run. */
	cost?: number;
	/**
	 * SqliteStore parity fields (the generic store requires createdAt/
	 * updatedAt). For cron_runs these mirror firedAt on insert; updated_at
	 * bumps if the row is ever patched (error correction / cost revision).
	 */
	createdAt: string;
	updatedAt: string;
}

export type CreateCronRunInput = Omit<CronRunRecord, "id">;

// ── tool_configs / tool_usage (P0 §7.7 — per-tool config + call log) ──

/**
 * v0.8 (P0 §7.7 #4): per-tool default-parameters config. One row per tool
 * name; `config` is a JSON blob the tool reads at call time to fill its
 * defaults. Distinct from sessions-level token usage (§8.5) — this table is
 * the tool's static default config, not a call log.
 */
export interface ToolConfigRecord {
	toolName: string;
	config: unknown;
	updatedAt: string;
}

/**
 * v0.8 (P0 §7.7 #4): one row per tool invocation (the tool-call log). Used
 * by the telemetry consumer to compute per-tool usage stats. Note this is
 * the *call log*, separate from the per-session token-resource accounting
 * that lives on the sessions table (RFC §8.5).
 */
export interface ToolUsageRecord {
	id: string;
	toolName: string;
	agentId?: string;
	sessionId?: string;
	/** ISO timestamp the call was made. */
	calledAt: string;
	/** JSON-serialized parameter summary (input redacted/truncated as needed). */
	params?: unknown;
	success: boolean;
	/** Wall-clock duration of the call, milliseconds. */
	durationMs?: number;
}

export type CreateToolUsageInput = Omit<ToolUsageRecord, "id">;

// ── M3: Orchestrate DSL + lead delivery pipeline (RFC §2.6/§2.9/§2.15) ────

/**
 * One node in an Orchestrate DSL flow (RFC §2.9 / §4.5; decision 48). The DSL
 * is authored by lead (lead picks which agent each node dispatches to); the
 * Orchestrate tool is the execution engine. Each node references an agent-tool
 * by the name exposed in lead's toolPolicy.
 *
 * Minimum subset (acceptance M3): parallel + pipeline + confirm. if/for/barrier
 * are also defined as node kinds so the engine can recognize them; full
 * conditional/iteration semantics are out of M3 scope.
 */
export type OrchestrateNodeKind =
	| "task"
	| "parallel"
	| "pipeline"
	| "if"
	| "for"
	| "barrier"
	| "verify";

/** A single dispatch of one agent-tool with a task description. */
export interface OrchestrateTaskNode {
	kind: "task";
	id: string;
	/** Name of the agent-tool to dispatch (must be enabled in lead's toolPolicy). */
	agentTool: string;
	task: string;
	wikiNodes?: string[];
	relatedFiles?: string[];
}

/** Run children concurrently, wait for all. */
export interface OrchestrateParallelNode {
	kind: "parallel";
	id: string;
	children: OrchestrateNode[];
}

/** Run children in order, piping each result into the next. */
export interface OrchestratePipelineNode {
	kind: "pipeline";
	id: string;
	children: OrchestrateNode[];
}

/** Conditional branch (M3: structure present; full predicate eval is stubbed). */
export interface OrchestrateIfNode {
	kind: "if";
	id: string;
	condition: string;
	then: OrchestrateNode[];
	else?: OrchestrateNode[];
}

/** Iterate over a list (M3: structure present; iteration semantics stubbed). */
export interface OrchestrateForNode {
	kind: "for";
	id: string;
	over: string;
	as: string;
	body: OrchestrateNode[];
}

/** Synchronization point — no-op marker; M3 passes through. */
export interface OrchestrateBarrierNode {
	kind: "barrier";
	id: string;
}

/** Verification work — runs unit/smoke/review, produces manifest entries. */
export interface OrchestrateVerifyNode {
	kind: "verify";
	id: string;
	/** Commands to run (e.g. "npm test"). Empty = just collect touched files. */
	commands?: string[];
	/** Reviewer agent-tool name to dispatch for code review. */
	reviewerAgentTool?: string;
}

export type OrchestrateNode =
	| OrchestrateTaskNode
	| OrchestrateParallelNode
	| OrchestratePipelineNode
	| OrchestrateIfNode
	| OrchestrateForNode
	| OrchestrateBarrierNode
	| OrchestrateVerifyNode;

/** Top-level Orchestrate flow submitted by lead. */
export interface OrchestrateFlow {
	requirementId: string;
	title: string;
	root: OrchestrateNode;
}

/** Lifecycle state of a submitted Orchestrate flow (decision 11). */
export type OrchestrateConfirmState =
	| "pending"    // submitted, waiting for user confirm
	| "confirmed"  // user confirmed → engine runs
	| "rejected"   // user rejected → returns false + reason
	| "running"    // engine is executing
	| "completed"  // finished successfully
	| "failed";    // finished with failure

/**
 * Persisted record of a submitted Orchestrate flow + its confirm gate state.
 * Created when lead submits the flow; mutated by the IPC confirm/reject path
 * and by the engine as it executes.
 */
export interface OrchestratePlanRecord {
	id: string;
	requirementId: string;
	projectId: string;
	leadAgentId: string;
	leadSessionId: string;
	flow: string;           // JSON-serialized OrchestrateFlow
	state: OrchestrateConfirmState;
	rejectionReason?: string;
	manifestId?: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * Manifest produced by an Orchestrate run (decision 34). PM reads it to judge
 * coverage; archivist reads it for traceability. Captures the files touched,
 * tests run, and reviewer verdict.
 */
export interface OrchestrateManifestRecord {
	id: string;
	requirementId: string;
	planId: string;
	projectId: string;
	touchedFiles: string[];
	tests: Array<{ command: string; ok: boolean; output?: string }>;
	review?: { verdict: "approved" | "rejected"; comment?: string };
	summary: string;
	createdAt: string;
	updatedAt: string;
}
