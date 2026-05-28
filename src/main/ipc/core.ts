import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "node:fs";
import { log } from "../../core/logger.js";
import type { IpcContext } from "./types.js";
import type { BrowserWindow } from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));
const toFileURL = (p: string) => { const { pathToFileURL: p2u } = require("url"); return p2u(p).href; };

// ─── Module-level state ────────────────────────────────────

let _agentStore: any;
let _agentService: any;
let _distCore: string;
let _distServer: string;
let _createAgentServiceFn: any;
let _providerStore: any;
let _templateStore: any;
let _mcpStore: any;
let _mcpManager: any;
let _kbStore: any;
let _kbDb: any;
let _sessionDb: any;
let _workspaceConfig: any;
let _saveWorkspaceConfigFn: any;
let _buildDefaultPromptFn: any;
let _registry: any;
let _toolRegistry: any;
let _agentToolStore: any;
let _mainWindow: BrowserWindow;
let _modulesReady = false;
let _registerAgentTools: ((store: any, registry: any) => void) | null = null;

// ─── Expose current state as IpcContext (reactive) ──────────

// Create a single reactive context object with getters that read live module state.
// This way, IPC handlers always see the latest values even though they're registered
// before loadCoreModules() populates the state.
const _ctx: IpcContext = {
	get win() { return _mainWindow; },
	get sessionDb() { return _sessionDb; },
	get agentStore() { return _agentStore; },
	get agentToolStore() { return _agentToolStore; },
	get providerStore() { return _providerStore; },
	get templateStore() { return _templateStore; },
	get mcpStore() { return _mcpStore; },
	get kbStore() { return _kbStore; },
	get kbDb() { return _kbDb; },
	get registry() { return _registry; },
	get mcpManager() { return _mcpManager; },
	get agentService() { return _agentService; },
	get workspaceConfig() { return _workspaceConfig; },
	get toolRegistry() { return _toolRegistry; },
	get buildDefaultPrompt() { return _buildDefaultPromptFn; },
	get saveWorkspaceConfig() { return _saveWorkspaceConfigFn; },
	get createAgentService() { return _createAgentServiceFn; },
	get modulesReady() { return _modulesReady; },
	set modulesReady(v: boolean) { _modulesReady = v; },
	toFileURL,
	get distServer() { return _distServer; },
	get distCore() { return _distCore; },
};

export function getModuleState(): IpcContext {
	return _ctx;
}

export function setMainWindow(win: BrowserWindow): void {
	_mainWindow = win;
}

export function getMainWindow(): BrowserWindow {
	return _mainWindow;
}

// ─── refreshAgentTools ─────────────────────────────────────

export function refreshAgentTools(): void {
	if (!_registerAgentTools || !_agentToolStore) return;
	_registerAgentTools(_agentToolStore, _registry);
	if (_mainWindow && !_mainWindow.isDestroyed()) {
		_mainWindow.webContents.send("tools:changed");
	}
}

// ─── ensureAgentService ────────────────────────────────────

export async function ensureAgentService(): Promise<any> {
	if (_agentService) return _agentService;
	// Fallback: should not happen since we eagerly init in loadCoreModules
	_agentService = _createAgentServiceFn(_workspaceConfig.workspaceDir, _sessionDb, _kbStore, _toolRegistry, _mcpManager);
	_agentService.subscribe((event: any) => {
		if (_mainWindow && !_mainWindow.isDestroyed()) {
			_mainWindow.webContents.send("agent:event", event);
		}
	});
	return _agentService;
}

// ─── Dynamic ESM loader (core modules) ─────────────────────

export async function loadCoreModules(): Promise<void> {
	const t0 = Date.now();
	_distServer = join(__dirname, "../../dist/server");
	_distCore = join(__dirname, "../../dist/core");

	log.ipc("Loading core modules...");
	const { AgentStore } = await import(toFileURL(join(_distServer, "agent-store.js")));
	log.ipc("agent-store loaded", `+${Date.now() - t0}ms`);
	const { ProviderStore } = await import(toFileURL(join(_distServer, "provider-store.js")));
	log.ipc("provider-store loaded", `+${Date.now() - t0}ms`);
	const agentSvcMod = await import(toFileURL(join(_distServer, "agent-service.js")));
	_createAgentServiceFn = agentSvcMod.createAgentService;
	const wsMod = await import(toFileURL(join(_distServer, "workspace-config.js")));
	const mod = await import(toFileURL(join(_distCore, "default-prompt.js")));
	log.ipc("core imports done", `+${Date.now() - t0}ms`);

	const tmplMod = await import(toFileURL(join(_distServer, "template-store.js")));
	const mcpMod = await import(toFileURL(join(_distServer, "mcp-store.js")));
	const mcpMgrMod = await import(toFileURL(join(_distServer, "mcp-manager.js")));

	// Create shared SessionDB — all stores share the same SQLite connection
	const { SessionDB } = await import(toFileURL(join(_distServer, "session-db.js")));
	_sessionDb = new SessionDB();

	// Run all JSON→SQLite migrations before creating stores
	const { runMigrations } = await import(toFileURL(join(_distServer, "db-migration.js")));
	runMigrations(_sessionDb);

	_agentStore = new AgentStore(_sessionDb);
	_providerStore = new ProviderStore(_sessionDb);
	_templateStore = new tmplMod.TemplateStore(_sessionDb);
	_mcpStore = new mcpMod.McpStore(_sessionDb);
	const { KbStore } = await import(toFileURL(join(_distServer, "kb-store.js")));
	const { KbDB } = await import(toFileURL(join(_distServer, "kb-db.js")));
	_kbStore = new KbStore(_sessionDb);
	_kbDb = new KbDB();
	_buildDefaultPromptFn = mod.buildDefaultPrompt;
	_saveWorkspaceConfigFn = wsMod.saveWorkspaceConfig;

	_workspaceConfig = wsMod.loadWorkspaceConfig(_sessionDb);

	if (!existsSync(_workspaceConfig.workspaceDir)) {
		mkdirSync(_workspaceConfig.workspaceDir, { recursive: true });
	}

	// Eagerly init agent-service so session/message queries work before first chat
	_agentService = _createAgentServiceFn(_workspaceConfig.workspaceDir, _sessionDb, _kbStore, _registry, _mcpManager);
	_agentService.setAgentStore(_agentStore);

	// Load AgentToolStore
	const atMod = await import(toFileURL(join(_distServer, "agent-tool-store.js")));
	_agentToolStore = new atMod.AgentToolStore(_sessionDb);
	_agentService.setAgentToolStore(_agentToolStore);
	_agentService.subscribe((event: any) => {
		if (_mainWindow && !_mainWindow.isDestroyed()) {
			_mainWindow.webContents.send("agent:event", event);
		}
	});

	log.ipc("Core modules ready, workspace:", _workspaceConfig.workspaceDir);

	// Register all tools into ToolRegistry
	const { registerRuntimeTools } = await import(toFileURL(join(__dirname, "../../dist/runtime/tools/index.js")));
	const trMod = await import(toFileURL(join(_distCore, "tool-registry.js")));
	_registry = new trMod.ToolRegistry(_sessionDb.getKVStore());
	_toolRegistry = _registry;
	registerRuntimeTools(_registry);
	_mcpManager = new mcpMgrMod.MCPManager(_registry);
	_mcpManager.reconnectEnabled(_mcpStore.list()).catch(() => {});
	const { registerAgentToolEntries } = await import(toFileURL(join(_distServer, "agent-service.js")));
	_registerAgentTools = registerAgentToolEntries;
	registerAgentToolEntries(_agentToolStore, _registry);
	log.ipc("Tool registry populated");
}
