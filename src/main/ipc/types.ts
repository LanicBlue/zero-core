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
	modulesReady: boolean;
	whenReady: (name: ModuleName) => Promise<void>;
	isModuleReady: (name: ModuleName) => boolean;
	// Dynamic import helpers
	toFileURL: (p: string) => string;
	distServer: string;
	distCore: string;
}
