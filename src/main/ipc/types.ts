import type { BrowserWindow } from "electron";
import type { ModuleName } from "./module-readiness.js";

export interface IpcContext {
	win: BrowserWindow;
	sessionDb: any;
	agentStore: any;
	agentToolStore: any;
	providerStore: any;
	templateStore: any;
	mcpStore: any;
	kbStore: any;
	kbDb: any;
	registry: any;
	mcpManager: any;
	agentService: any;
	workspaceConfig: any;
	toolRegistry: any;
	buildDefaultPrompt: any;
	saveWorkspaceConfig: any;
	createAgentService: any;
	modulesReady: boolean;
	whenReady: (name: ModuleName) => Promise<void>;
	isModuleReady: (name: ModuleName) => boolean;
	// Dynamic import helpers
	toFileURL: (p: string) => string;
	distServer: string;
	distCore: string;
}
