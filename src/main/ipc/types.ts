// IPC 上下文类型定义
//
// # 文件说明书
//
// ## 核心功能
// 定义 IPC handler 的共享上下文类型，聚合所有 Store 和服务实例
//
// ## 输入
// 各 Store 和服务的类型引用
//
// ## 输出
// IpcContext 接口，包含所有 IPC handler 可访问的依赖
//
// ## 定位
// src/main/ipc/ — 主进程 IPC 层类型定义
//
// ## 依赖
// Electron、server 层各 Store 类型
//
// ## 维护规则
// 新增 Store 时需在 IpcContext 中添加对应字段
//
import type { BrowserWindow } from "electron";
import type { ModuleName } from "./module-readiness.js";
import type { SessionDB } from "../../server/session-db.js";
import type { AgentStore } from "../../server/agent-store.js";
import type { AgentToolStore } from "../../server/agent-tool-store.js";
import type { ProviderStore } from "../../server/provider-store.js";
import type { TemplateStore } from "../../server/template-store.js";
import type { McpStore } from "../../server/mcp-store.js";
import type { KbStore } from "../../server/kb-store.js";
import type { KbDB } from "../../server/kb-db.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { MCPManager } from "../../server/mcp-manager.js";
import type { AgentService } from "../../server/agent-service.js";
import type { WorkspaceConfig, loadWorkspaceConfig as LoadWorkspaceConfig, saveWorkspaceConfig as SaveWorkspaceConfig } from "../../server/workspace-config.js";
import type { buildDefaultPrompt as BuildDefaultPrompt } from "../../core/default-prompt.js";
import type { createAgentService as CreateAgentService } from "../../server/agent-service.js";
import type { ProjectStore } from "../../server/project-store.js";
import type { RequirementStore } from "../../server/requirement-store.js";
import type { ProjectWikiStore } from "../../server/project-wiki-store.js";
import type { TaskStepStore } from "../../server/task-step-store.js";
import type { AnalystService } from "../../server/analyst-service.js";
import type { LeadService } from "../../server/lead-service.js";
import type { CronAnalysisManager } from "../../server/cron-analysis.js";
import type { CronStore } from "../../server/cron-store.js";
import type { GitIntegration } from "../../server/git-integration.js";
import type { NotificationService } from "../../server/notification-service.js";
import type { OrchestratePlanStore } from "../../server/orchestrate-store.js";
import type { ProjectNotificationRouter } from "../../server/project-notification-router.js";
import type { PmService } from "../../server/pm-service.js";
import type { RequirementDocStore } from "../../server/requirement-doc-store.js";
import type { OrchestrateManifestStore } from "../../server/orchestrate-store.js";
import type { WikiStore } from "../../server/wiki-node-store.js";

export interface IpcContext {
	win: BrowserWindow;
	sessionDb: SessionDB;
	agentStore: AgentStore;
	agentToolStore: AgentToolStore;
	providerStore: ProviderStore;
	templateStore: TemplateStore;
	mcpStore: McpStore;
	kbStore: KbStore;
	kbDb: KbDB;
	registry: ToolRegistry;
	mcpManager: MCPManager;
	agentService: AgentService;
	workspaceConfig: WorkspaceConfig;
	toolRegistry: ToolRegistry;
	buildDefaultPrompt: typeof BuildDefaultPrompt;
	saveWorkspaceConfig: typeof SaveWorkspaceConfig;
	createAgentService: typeof CreateAgentService;
	projectStore: ProjectStore;
	requirementStore: RequirementStore;
	wikiStore: ProjectWikiStore;
	taskStepStore: TaskStepStore;
	analystService: AnalystService;
	leadService: LeadService;
	cronStore: CronStore | null;
	cronManager: CronAnalysisManager | null;
	gitIntegration: GitIntegration | null;
	notificationService: NotificationService | null;
	// v0.8 (M3): Orchestrate plan store — for the kanban plan-gate pending
	// entry + confirm/reject IPC channels.
	orchestratePlanStore: OrchestratePlanStore | null;
	// v0.8 (M3): project-scoped cross-role notification router (accept→archivist
	// and friends). Wired into requirement-hooks so verify PASSED fires the
	// archivist merge notification (acceptance-M3 item 6).
	projectNotificationRouter: ProjectNotificationRouter | null;
	// v0.8 (M4): PM service + supporting stores.
	pmService: PmService | null;
	requirementDocStore: RequirementDocStore | null;
	manifestStore: OrchestrateManifestStore | null;
	wikiNodeStore: WikiStore | null;
	modulesReady: boolean;
	whenReady: (name: ModuleName) => Promise<void>;
	isModuleReady: (name: ModuleName) => boolean;
	// Dynamic import helpers
	toFileURL: (p: string) => string;
	distServer: string;
	distCore: string;
}
