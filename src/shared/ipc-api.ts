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
	AgentToolEntry, CreateAgentToolInput, UpdateAgentToolInput,
	KnowledgeBase, CreateKbInput, UpdateKbInput, KbSearchResult, KbFileIngestResult,
	McpServerConfig, CreateMcpInput, UpdateMcpInput, McpStatus,
	PromptTemplate, CreateTemplateInput, UpdateTemplateInput,
	SessionRecord,
	LogEntry, LogFileSummary, FileLogConfig,
	WorkspaceConfig, ToolInfo, ModelInfo,
	Ok, Err, OkOrErr,
	ToolExecutionRecord, ToolExecutionFilter, ToolExecutionStats,
	ProjectRecord, CreateProjectInput, UpdateProjectInput,
	RequirementRecord, CreateRequirementInput, UpdateRequirementInput, RequirementStatusHistory,
	RequirementMessage, TaskStepRecord, ProjectWikiNode, CreateWikiNodeInput, UpdateWikiNodeInput,
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

	// ── Agent Tools (CRUD + get-by-agent) ────────────────────
	"agent-tools:list":         { params: [];                                  result: AgentToolEntry[] };
	"agent-tools:get":          { params: [id: string];                        result: AgentToolEntry | undefined };
	"agent-tools:get-by-agent": { params: [agentId: string];                   result: AgentToolEntry | undefined };
	"agent-tools:create":       { params: [input: CreateAgentToolInput];       result: AgentToolEntry };
	"agent-tools:update":       { params: [id: string, input: UpdateAgentToolInput]; result: AgentToolEntry | Err };
	"agent-tools:delete":       { params: [id: string];                        result: Ok };

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

	// ── Knowledge Base (CRUD + file ops) ─────────────────────
	"kb:list":         { params: [];                                     result: KnowledgeBase[] };
	"kb:get":          { params: [id: string];                           result: KnowledgeBase | undefined };
	"kb:create":       { params: [input: CreateKbInput];                 result: KnowledgeBase };
	"kb:update":       { params: [id: string, input: UpdateKbInput];     result: KnowledgeBase | Err };
	"kb:delete":       { params: [id: string];                           result: Ok };
	"kb:add-files":    { params: [kbId: string, filePaths: string[]];    result: KbFileIngestResult[] };
	"kb:remove-file":  { params: [kbId: string, filePath: string];       result: Ok };
	"kb:search":       { params: [kbIds: string[], query: string];       result: KbSearchResult[] };
	"kb:chunk-count":  { params: [kbId: string];                         result: number };

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
	"sessions:switch":  { params: [agentId: string, sessionId: string];           result: Ok & { sessionId: string } };
	"sessions:current": { params: [agentId: string];                              result: SessionRecord | null };
	"sessions:activate":{ params: [agentId: string, sessionId?: string];          result: Ok };
	"sessions:delete":  { params: [agentId: string, sessionId: string];           result: Ok | (Ok & { newSessionId: string }) };
	"sessions:metrics": { params: []; result: import("../server/session-metrics.js").AggregateMetrics & { sessions: Record<string, import("../server/session-metrics.js").SessionMetrics> } };

	// ── Chat ─────────────────────────────────────────────────
	"chat:send":   { params: [text: string, agentId?: string, sessionId?: string];    result: Ok };
	"chat:abort":  { params: [agentId?: string];                  result: Ok };

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
	"projects:list":   { params: [filter?: { status?: string }];                     result: ProjectRecord[] };
	"projects:get":    { params: [id: string];                                       result: ProjectRecord | undefined };
	"projects:create": { params: [input: CreateProjectInput];                        result: ProjectRecord };
	"projects:update": { params: [id: string, input: UpdateProjectInput];            result: ProjectRecord | Err };
	"projects:delete": { params: [id: string];                                       result: Ok };

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

	// ── Wiki ─────────────────────────────────────────────────
	"wiki:listByProject": { params: [projectId: string];                            result: ProjectWikiNode[] };
	"wiki:getNode":       { params: [id: string];                                  result: ProjectWikiNode | undefined };
	"wiki:createNode":    { params: [projectId: string, input: CreateWikiNodeInput]; result: ProjectWikiNode };
	"wiki:updateNode":    { params: [id: string, input: UpdateWikiNodeInput];       result: ProjectWikiNode | Err };
	"wiki:deleteNode":    { params: [id: string];                                  result: Ok };
}
