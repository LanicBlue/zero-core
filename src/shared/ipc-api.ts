// ---------------------------------------------------------------------------
// IPC API — typed contract between main process handlers and renderer.
// Every IPC channel is declared here with params and result types.
//
// # 文件说明书
//
// ## 核心功能
// 定义 IPC API 契约，声明所有 IPC 通道的参数和结果类型。
//
// ## 输入
// 无 - API 契约定义。
//
// ## 输出
// - IPC 通道类型定义
//
// ## 定位
// 共享类型模块，被主进程和渲染进程使用。
//
// ## 依赖
// - ./types - 数据模型类型
//
// ## 维护规则
// - 新增 IPC 通道时需更新
// - 保持契约一致性
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
	Ok, Err, OkOrErr,
	ToolExecutionRecord, ToolExecutionFilter, ToolExecutionStats,
	ProjectRecord, CreateProjectInput, UpdateProjectInput,
	ProjectContainerView, ProjectResourceUsage, AgentVia, EnrichProjectBody,
	ProjectArchivistBinding, CronSchedule, WikiOperationId,
	ProjectWorkRecord, ProjectWorkView, CreateProjectWorkBody, FireProjectWorkResult,
	RequirementRecord, CreateRequirementInput, UpdateRequirementInput, RequirementStatusHistory,
	RequirementMessage, TaskStepRecord, ProjectWikiNode, CreateWikiNodeInput, UpdateWikiNodeInput,
	WikiNode,
	CronRecord, CreateCronInput, UpdateCronInput, CronRunRecord, ProjectJobRecord,
	OrchestratePlanRecord,
	OrchestrateManifestRecord,
	DelegatedTaskRecord,
	RuntimeTaskInfo,
	AttachmentMeta,
} from "./types.js";
import type { FileTreeNode } from "./file-utils.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract param types as a tuple from a channel definition. */
export type Params<C extends keyof IpcChannelDefs> = IpcChannelDefs[C]["params"];
/** Extract result type from a channel definition. */
export type Result<C extends keyof IpcChannelDefs> = IpcChannelDefs[C]["result"];

// ── Channel Definitions ─────────────────────────────────────────────────────

export interface IpcChannelDefs {
	// ── Dialog ───────────────────────────────────────────────
	"app:ready":             { params: [];                      result: boolean };
	"dialog:openDirectory":  { params: [];                      result: string | undefined };

	// ── Agents (CRUD) ────────────────────────────────────────
	"agents:list":    { params: [];                          result: AgentRecord[] };
	"agents:get":     { params: [id: string];                result: AgentRecord | undefined };
	"agents:create":  { params: [input: CreateAgentInput];   result: AgentRecord };
	"agents:update":  { params: [id: string, input: UpdateAgentInput]; result: AgentRecord | Err };
	"agents:delete":  { params: [id: string];                result: Ok };

	// ── Providers (CRUD + model ops) ─────────────────────────
	"providers:list":          { params: [];                                  result: Provider[] };
	"providers:get":           { params: [id: string];                        result: Provider | undefined };
	"providers:create":        { params: [input: CreateProviderInput];        result: Provider };
	"providers:update":        { params: [id: string, input: UpdateProviderInput]; result: Provider | Err };
	"providers:delete":        { params: [id: string];                        result: Ok };
	"providers:add-model":     { params: [providerId: string, model: ProviderModel]; result: Provider | Err };
	"providers:remove-model":  { params: [providerId: string, modelId: string];      result: Provider | Err };
	"providers:fetch-models":  { params: [providerId: string];                        result: FetchedModel[] };
	"models:list":             { params: [];                                           result: ModelInfo[] };

	// ── MCP (CRUD + connection ops) ──────────────────────────
	"mcp:list":       { params: [];                            result: McpServerConfig[] };
	"mcp:get":        { params: [id: string];                  result: McpServerConfig | undefined };
	"mcp:create":     { params: [input: CreateMcpInput];       result: McpServerConfig & { connectedTools?: any[]; connectError?: string } };
	"mcp:update":     { params: [id: string, input: UpdateMcpInput]; result: McpServerConfig | Err };
	"mcp:delete":     { params: [id: string];                  result: Ok };
	"mcp:test":       { params: [input: CreateMcpInput];       result: { tools: { name: string; description?: string }[]; error?: string } };
	"mcp:tools":      { params: [serverId: string];            result: { name: string; description?: string }[] | number };
	"mcp:connect":    { params: [id: string];                  result: { tools: { name: string; description?: string }[]; error?: string } };
	"mcp:disconnect": { params: [id: string];                  result: Ok };
	"mcp:status":     { params: [];                             result: McpStatus[] };

	// ── Knowledge Base — removed (will be redone via wiki-format file splitting). ──

	// ── Templates (CRUD + import/export) ─────────────────────
	"templates:list":           { params: [];                                          result: PromptTemplate[] };
	"templates:get":            { params: [id: string];                                result: PromptTemplate | undefined };
	"templates:create":         { params: [input: CreateTemplateInput];                 result: PromptTemplate };
	"templates:update":         { params: [id: string, input: UpdateTemplateInput];     result: PromptTemplate | Err };
	"templates:delete":         { params: [id: string];                                 result: Ok | Err };
	"templates:export":         { params: [id: string];                                 result: string | Err };
	"templates:import":         { params: [json: string];                               result: PromptTemplate | Err };
	"templates:github-preview": { params: [url: string, subdir?: string];               result: { items: any[]; sourceUrl: string; cached?: boolean } | Err };
	"templates:import-github":  { params: [url: string, selectedPaths: string[]];       result: { imported: number; updated: number; total: number } | Err };

	// ── Tools ────────────────────────────────────────────────
	"tools:list":       { params: [];                                                    result: ToolInfo[] };
	"tool-config:get":  { params: [];                                                    result: Record<string, Record<string, any>> };
	"tool-config:save": { params: [config: Record<string, Record<string, any>>];        result: void };

	// ── Config ───────────────────────────────────────────────
	"config:get":             { params: [];                                   result: WorkspaceConfig & { defaultPrompt: string } };
	"config:update":          { params: [data: Partial<Pick<WorkspaceConfig, "workspaceDir" | "defaultModel" | "defaultProvider" | "proxy">>]; result: WorkspaceConfig };
	"config:get-theme":       { params: [];                                   result: { mode: string; customPrimaryColor: string | null } };
	"config:set-theme":       { params: [data: { mode: string; customPrimaryColor?: string }]; result: Ok | Err };
	"device-context:get":     { params: [];                                   result: { content: string } };
	"device-context:generate":{ params: [];                                   result: { content: string; error?: string } };
	"device-context:save":    { params: [content: string];                    result: Ok | Err };
	"guidelines:get":         { params: [];                                   result: { guidelines: string[]; defaults: string[]; isDefault: boolean } };
	"guidelines:save":        { params: [guidelines: string[]];               result: Ok | Err };

	// ── Sessions & Messages ──────────────────────────────────
	"messages:clear":   { params: [agentId: string];                              result: Ok };
	"messages:edit":    { params: [agentId: string, msgSeq: number, newText: string]; result: Ok | Err };
	"messages:delete":  { params: [agentId: string, msgSeq: number];               result: Ok | Err };
	"sessions:list":    { params: [agentId: string];                              result: SessionRecord[] };
	"sessions:new":     { params: [agentId: string];                              result: SessionRecord };
	"sessions:ensureForProject": { params: [agentId: string, projectId: string];      result: { sessionId: string; created: boolean } };
	"sessions:switch":  { params: [agentId: string, sessionId: string];           result: Ok & { sessionId: string } };
	"sessions:current": { params: [agentId: string];                              result: SessionRecord | null };
	"sessions:activate":{ params: [agentId: string, sessionId?: string];          result: Ok };
	"sessions:delete":  { params: [agentId: string, sessionId: string];           result: Ok | (Ok & { newSessionId: string }) };
	"sessions:archive": { params: [agentId: string, sessionId: string];           result: Ok & { newSessionId: string } };
	"sessions:metrics": { params: []; result: import("../server/session-metrics.js").AggregateMetrics & { sessions: Record<string, import("../server/session-metrics.js").SessionMetrics> } };
	// platform-observability ① ② ③ (sub-4/5/6): the six kanban data channels
	// (sessions:parents / sessions:detail / provider:stats / provider:usage /
	// provider:queue / crons:today) are RETIRED — the ③ kanban now reads them
	// via the unified dispatcher (`toolRun`). The channel defs below are
	// removed; no ipcMain.handle maps to them, and the preload no longer
	// exposes them.

	// ── Chat ─────────────────────────────────────────────────
	// multimodal-input sub-4 (principle A): chat:send carries attachment META
	// only (AttachmentMeta[] with diskPath); bytes never travel in this body —
	// they were uploaded via attachments:upload (sub-1) and live on disk.
	"chat:send":   { params: [text: string, agentId?: string, sessionId?: string, attachments?: AttachmentMeta[]];    result: Ok };
	"chat:abort":  { params: [sessionId?: string];                result: Ok };

	// ── Attachments (multimodal-input sub-1) ─────────────────
	// attachments:upload is the SINGLE entry point for attachment bytes into
	// main (design 顶层原则 A). Renderer sends base64 bytes + meta; main writes
	// to ZERO_CORE_DIR/attachments/<sessionId>/ and returns AttachmentMeta
	// (with diskPath). chat:send (sub-4) will then carry only meta, not bytes.
	"attachments:upload": {
		params: [body: { sessionId: string; fileName: string; mimeType: string; data: string }];
		result: AttachmentMeta;
	};

	// ── Files ────────────────────────────────────────────────
	"files:tree":         { params: [root?: string];                              result: FileTreeNode[] | Err };
	"files:content":      { params: [filePath: string, root?: string];          result: { content: string } | Err };
	"files:resolve-path": { params: [filePath: string, root?: string];          result: { path: string } | Err };
	"files:save":         { params: [filePath: string, content: string, root?: string]; result: Ok | Err };

	// ── Logs ─────────────────────────────────────────────────
	"logs:list-files": { params: [];                                               result: LogFileSummary[] };
	"logs:read":       { params: [filename: string, opts?: { lines?: number; level?: string }]; result: LogEntry[] };
	"logs:get-config": { params: [];                                               result: FileLogConfig };
	"logs:set-config": { params: [config: FileLogConfig];                          result: void };

	// ── Misc ─────────────────────────────────────────────────
	"ask-user:respond":    { params: [requestId: string, answers: Record<string, string>]; result: Ok };

	// ── WebFetch Cookie Login ────────────────────────────────
	"webfetch:login":         { params: [url: string];    result: { ok: boolean; cookieCount: number; error?: string } };
	"webfetch:cookies":       { params: [];               result: Record<string, number> };
	"webfetch:clear-cookies": { params: [domain?: string]; result: void };

	// ── Tool Executions ──────────────────────────────────────
	"tool-executions:query":   { params: [filter: ToolExecutionFilter];              result: ToolExecutionRecord[] };
	"tool-executions:stats":   { params: [agentId?: string];                         result: ToolExecutionStats[] };
	"tool-executions:cleanup": { params: [maxAgeMs: number];                          result: number };
	"tool-executions:analyze": { params: [agentId?: string];                          result: { analysis: string; stats: ToolExecutionStats[]; recentErrors: ToolExecutionRecord[] } | Err };

	// ── Projects (CRUD) ──────────────────────────────────────
	// v0.8 (P5 §8.4): projects:get supports includeContext → container view.
	// v0.8 (P5 §8.5): projects:getResourceUsage — sessions token/cost SUM.
	"projects:list":             { params: [filter?: { status?: string }];           result: ProjectRecord[] };
	"projects:get":              { params: [id: string, includeContext?: boolean];   result: ProjectRecord | ProjectContainerView | undefined };
	"projects:create":           { params: [input: CreateProjectInput];              result: ProjectRecord };
	"projects:update":           { params: [id: string, input: UpdateProjectInput];  result: ProjectRecord | Err };
	"projects:delete":           { params: [id: string];                             result: Ok };
	"projects:getResourceUsage": { params: [id: string];                             result: ProjectResourceUsage };
	"projects:enrich":           { params: [id: string, body?: EnrichProjectBody];   result: { jobId: string; sessionId: string } };
	"projects:archivistBind":      { params: [id: string, body: { agentId: string; operations: WikiOperationId[]; schedule: CronSchedule; gitAware?: boolean; gitEveryMs?: number }]; result: { binding: ProjectArchivistBinding } };
	"projects:archivistUnbind":    { params: [id: string];                              result: Ok };
	"projects:archivistSwitchAgent": { params: [id: string, agentId: string];          result: { binding: ProjectArchivistBinding } };
	"projects:archivistSetEnabled": { params: [id: string, enabled: boolean];         result: { binding: ProjectArchivistBinding } };
	"projects:listWorks":          { params: [id: string];                             result: { works: ProjectWorkView[] } };
	"projects:createWork":         { params: [id: string, body: CreateProjectWorkBody]; result: { work: ProjectWorkRecord } };
	"projects:updateWork":         { params: [id: string, workId: string, body: Partial<CreateProjectWorkBody>]; result: { work: ProjectWorkRecord } };
	"projects:deleteWork":         { params: [id: string, workId: string];             result: Ok };
	"projects:assignWorkAgent":    { params: [id: string, workId: string, agentId: string]; result: { work: ProjectWorkRecord } };
	"projects:setWorkEnabled":     { params: [id: string, workId: string, enabled: boolean]; result: { work: ProjectWorkRecord } };
	"projects:triggerWork":        { params: [id: string, workId: string];             result: { result: FireProjectWorkResult } };
	"projects:listJobs":         { params: [id: string];                             result: ProjectJobRecord[] };

	// ── Requirements (CRUD + transitions + messages + steps) ─
	"requirements:list":       { params: [filter?: { projectId?: string; status?: string; priority?: string }]; result: RequirementRecord[] };
	"requirements:get":        { params: [id: string];                                                       result: RequirementRecord | undefined };
	"requirements:create":     { params: [input: CreateRequirementInput];                                    result: RequirementRecord };
	"requirements:update":     { params: [id: string, input: UpdateRequirementInput];                        result: RequirementRecord | Err };
	"requirements:transition": { params: [id: string, toStatus: string, triggeredBy: string, comment?: string]; result: { requirement: RequirementRecord; historyEntry: RequirementStatusHistory } | Err };
	"requirements:history":    { params: [id: string];                                                       result: RequirementStatusHistory[] };
	"requirements:messages":   { params: [id: string];                                                       result: RequirementMessage[] };
	"requirements:addMessage": { params: [id: string, sender: string, content: string, messageType?: string]; result: RequirementMessage };
	"requirements:steps":      { params: [id: string];                                                       result: TaskStepRecord[] };
	// project-flow F4: user-supplied coverage verdict (verify compound close
	// via the shared FlowActions backend).
	"requirements:coverageVerdict": { params: [id: string, covered: boolean, reason?: string];            result: { ok: boolean; requirement: RequirementRecord; text: string } | Err };

	// ── Wiki ─────────────────────────────────────────────────
	"wiki:listByProject": { params: [projectId: string];                            result: ProjectWikiNode[] };
	"wiki:getNode":       { params: [id: string];                                  result: ProjectWikiNode | undefined };
	"wiki:createNode":    { params: [projectId: string, input: CreateWikiNodeInput]; result: ProjectWikiNode };
	"wiki:updateNode":    { params: [id: string, input: UpdateWikiNodeInput];       result: ProjectWikiNode | Err };
	"wiki:deleteNode":    { params: [id: string];                                  result: Ok };
	// v0.8 (P8 §10.9): global-tree browser surface. The renderer drives the
	// whole wiki tree from a SET of anchor nodeIds (session's anchor union).
	// listByAnchors returns the union of each anchor's subtree (or the whole
	// tree if WIKI_GLOBAL_ROOT_ID is in the set). readDetail loads a node's
	// on-disk body (the "expand" path). readWorkspaceDoc jumps to a project
	// source/requirement file by workspace-relative path. search is a
	// substring scan scoped to the caller's anchors.
	"wiki:getChildren":       { params: [nodeId: string];                                    result: WikiNode[] };
	"wiki:readDetail":        { params: [nodeId: string];                                    result: { nodeId: string; detail?: string } };
	"wiki:readWorkspaceDoc":  { params: [projectId: string, relPath: string];               result: { content?: string; error?: string } };
	"wiki:search":            { params: [query: string, anchorIds?: string[]];              result: WikiNode[] };

	// ── Lead (internal — backend auto-pickup, manual retry) ──
	"lead:pickup":    { params: [requirementId: string];                            result: { sessionId: string } | Err };
	"lead:progress":  { params: [requirementId: string];                            result: { requirement: RequirementRecord; steps: TaskStepRecord[]; currentStep: TaskStepRecord | undefined; completedCount: number; totalCount: number } | Err };

	// ── M5: Verification, Archive, Report ──
	"requirements:verify":     { params: [id: string];                               result: { passed: boolean; report: string } | Err };
	"requirements:archive":    { params: [id: string];                               result: Ok | Err };
	"requirements:report":     { params: [id: string];                               result: { report: string | null } };

	// v0.8 (P4 §8.6): dead project schedule channels deleted. Cron is
	// agent-scoped (§9); project lifecycle no longer owns a schedule. The
	// IPC surface now lives under crons:* only.

	// ── M1: Cron (first-class cron entity; P4 §9.4 list filter + runs) ───
	// list filter: projectId (workingScope.projectId), agentId, enabled.
	"crons:list":     { params: [filter?: { agentId?: string; projectId?: string; enabled?: boolean }]; result: CronRecord[] };
	"crons:get":      { params: [id: string];                                          result: CronRecord | undefined };
	"crons:create":   { params: [input: CreateCronInput];                              result: CronRecord | Err };
	"crons:update":   { params: [id: string, input: UpdateCronInput];                  result: CronRecord | Err };
	"crons:delete":   { params: [id: string];                                          result: Ok };
	"crons:trigger":  { params: [id: string];                                          result: Ok | Err };
	// §9.3: cron_runs audit log (newest-first). limit defaults to 50.
	"crons:listRuns": { params: [cronId: string, limit?: number];                      result: CronRunRecord[] };

	// ── Delegated tasks (TaskTree UI; read-only, pull-on-display) ──
	"delegatedTasks:bySession": { params: [sessionId: string]; result: DelegatedTaskRecord[] };
	"delegatedTasks:get":       { params: [id: string]; result: DelegatedTaskRecord | undefined };

	// ── Runtime tasks (live in-memory tree; same source as the agent's TaskList) ──
	"runtimeTasks:bySession":   { params: [sessionId: string]; result: RuntimeTaskInfo[] };

	// ── Input queue (Phase C2 — queue inputs while a session is running) ──
	"inputQueue:list":    { params: [sessionId: string]; result: Array<{ id: string; sessionId: string; content: string; mode: "queued" | "insert_now"; createdAt: number }> };
	"inputQueue:enqueue": { params: [sessionId: string, content: string, mode?: "queued" | "insert_now"]; result: { id: string; sessionId: string; content: string; mode: "queued" | "insert_now"; createdAt: number } };
	"inputQueue:promote": { params: [itemId: string]; result: { ok: boolean } };
	"inputQueue:remove":  { params: [itemId: string]; result: { ok: boolean } };

	// ── M3: Orchestrate plan-gate (kanban pending entry + confirm/reject) ──
	// RFC §2.9 / decision 11 — the kanban surfaces pending plans to the user
	// and calls confirm/reject. Resolves the awaiting Orchestrate tool Promise.
	"orchestrate:pending": { params: [filter?: { projectId?: string }];               result: OrchestratePlanRecord[] };
	"orchestrate:plan":    { params: [planId: string];                                result: OrchestratePlanRecord | Err };
	"orchestrate:confirm": { params: [planId: string];                                result: { success: boolean; planId: string; reason?: string } };
	"orchestrate:reject":  { params: [planId: string, reason: string];                result: { success: boolean; planId: string; reason?: string } };

	// ── M4: PM discuss-as-document + coverage judgement (RFC §2.5 / §2.10 /
	// §2.17b / §4.5, decisions 7/12/13/14/34) ──
	// Requirement doc lives at {workspace}/.zero/requirements/{projectId}/ and
	// is the discuss substrate (no session isolation — state is in the doc).
	"requirements:doc:read":   { params: [projectId: string, requirementId: string]; result: { docPath?: string; content?: string } };
	"requirements:doc:write":  { params: [projectId: string, requirementId: string, content: string]; result: { docPath: string } | Err };
	"requirements:doc:list":   { params: [projectId: string];                         result: string[] };
	// PM creates a requirement + its repo doc in one shot (decision 12/14).
	"pm:createRequirement":    { params: [input: { projectId: string; title: string; summary?: string; body?: string; priority?: string; source?: "pm" | "user" }]; result: RequirementRecord | Err };
	// v0.8 P7 (§4.2): open the {PM, projectId} discuss session — route by
	// requirement.createdByAgentId (the PM agent that created this requirement),
	// NOT by roleTag scan. Caller passes the requirementId; backend reads the
	// requirement + resolves PM via createdByAgentId.
	"pm:openDiscuss":          { params: [requirementId: string];                     result: { agentId: string; sessionId: string; created: boolean } | Err };
	// PM coverage judgement view: requirement intent doc + latest manifest.
	"pm:coverageView":         { params: [requirementId: string];                     result: { requirement?: RequirementRecord; intentDoc?: string; manifest?: OrchestrateManifestRecord } };
	// v0.8 P7 (§4.6): submit PM coverage verdict → drives ArchivistService
	// mergeFeatureToMain + 增量扫描 → status closed (covered=true); or writes
	// feedback onto the requirement (covered=false) for lead to read.
	"pm:coverageVerdict":      { params: [requirementId: string, covered: boolean, reason?: string]; result: { success: boolean; requirementId: string; kind: "verify_accept" | "verify_reject"; finalStatus?: string; mergeOk?: boolean } | Err };
}
