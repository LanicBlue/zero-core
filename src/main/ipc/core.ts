import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "node:fs";
import { log } from "../../core/logger.js";
import type { IpcContext } from "./types.js";
import type { BrowserWindow } from "electron";
import { moduleReadiness, type ModuleName } from "./module-readiness.js";
import { isTestMode, seedTestEnvironment } from "../test-setup.js";

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
	whenReady: (name: ModuleName) => moduleReadiness.whenReady(name),
	isModuleReady: (name: ModuleName) => moduleReadiness.isReady(name),
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
	log.ipc("loadCoreModules entered");
	_distServer = join(__dirname, "../../dist/server");
	_distCore = join(__dirname, "../../dist/core");

	// Initialize per-module readiness slots
	moduleReadiness.initAllSlots([
		"sessionDb", "agentStore", "providerStore", "templateStore",
		"mcpStore", "kbStore", "kbDb", "agentToolStore", "workspaceConfig",
		"registry", "toolRegistry", "agentService", "mcpManager", "recovery",
	]);

	// ─── Phase 0: All dynamic imports in parallel ────────────────
	log.ipc("Loading core modules...");
	const [
		agentStoreMod, providerStoreMod, agentSvcMod, wsMod, promptMod,
		tmplMod, mcpMod, mcpMgrMod, sessionDbMod, migrationMod,
		durableHooksMod, kbStoreMod, kbDbMod, agentToolStoreMod,
		runtimeToolsMod, trMod, recoveryMod,
	] = await Promise.all([
		import(toFileURL(join(_distServer, "agent-store.js"))),
		import(toFileURL(join(_distServer, "provider-store.js"))),
		import(toFileURL(join(_distServer, "agent-service.js"))),
		import(toFileURL(join(_distServer, "workspace-config.js"))),
		import(toFileURL(join(_distCore, "default-prompt.js"))),
		import(toFileURL(join(_distServer, "template-store.js"))),
		import(toFileURL(join(_distServer, "mcp-store.js"))),
		import(toFileURL(join(_distServer, "mcp-manager.js"))),
		import(toFileURL(join(_distServer, "session-db.js"))),
		import(toFileURL(join(_distServer, "db-migration.js"))),
		import(toFileURL(join(_distServer, "durable-hooks.js"))),
		import(toFileURL(join(_distServer, "kb-store.js"))),
		import(toFileURL(join(_distServer, "kb-db.js"))),
		import(toFileURL(join(_distServer, "agent-tool-store.js"))),
		import(toFileURL(join(__dirname, "../../dist/runtime/tools/index.js"))),
		import(toFileURL(join(_distCore, "tool-registry.js"))),
		import(toFileURL(join(_distServer, "recovery.js"))),
	]);
	log.ipc("All imports done", `+${Date.now() - t0}ms`);

	_createAgentServiceFn = agentSvcMod.createAgentService;
	_buildDefaultPromptFn = promptMod.buildDefaultPrompt;
	_saveWorkspaceConfigFn = wsMod.saveWorkspaceConfig;

	// ─── Phase 1: SessionDB + migrations ─────────────────────────
		try {
			_sessionDb = new sessionDbMod.SessionDB();
			migrationMod.runMigrations(_sessionDb);
			moduleReadiness.resolveModule("sessionDb");
			log.ipc("Phase 1 done");
		} catch (err) {
			log.error("ipc", "Phase 1 failed (sessionDb):", (err as Error).message);
			moduleReadiness.rejectModule("sessionDb", err as Error);
			moduleReadiness.rejectModules(
				["agentStore", "providerStore", "templateStore", "mcpStore", "kbStore", "kbDb", "agentToolStore", "workspaceConfig", "registry", "toolRegistry", "agentService", "mcpManager", "recovery"],
				new Error("skipped: sessionDb failed"),
			);
			return;
		}

	// ─── Phase 1b: Hooks + file logging (depend on sessionDb) ────
	durableHooksMod.registerDurableHooks(_sessionDb);
	try {
		const logConfig = _sessionDb.getKVStore().getJson("log_config");
		const { configureLogging } = await import(toFileURL(join(_distCore, "logger.js")));
		configureLogging(logConfig ?? { enabled: true, retentionDays: 7, globalLevel: "debug" });
	} catch { /* use defaults */ }

	// ─── Phase 2: All stores + config (depend on sessionDb) ──────
		try {
			_agentStore = new agentStoreMod.AgentStore(_sessionDb);
			_providerStore = new providerStoreMod.ProviderStore(_sessionDb);
			_templateStore = new tmplMod.TemplateStore(_sessionDb);
			_mcpStore = new mcpMod.McpStore(_sessionDb);
			_kbStore = new kbStoreMod.KbStore(_sessionDb);
			_kbDb = new kbDbMod.KbDB();
			_agentToolStore = new agentToolStoreMod.AgentToolStore(_sessionDb);
			_workspaceConfig = wsMod.loadWorkspaceConfig(_sessionDb);

			if (!existsSync(_workspaceConfig.workspaceDir)) {
				mkdirSync(_workspaceConfig.workspaceDir, { recursive: true });
			}

			moduleReadiness.resolveModules([
				"agentStore", "providerStore", "templateStore", "mcpStore",
				"kbStore", "kbDb", "agentToolStore", "workspaceConfig",
			]);
		} catch (err) {
			log.error("ipc", "Phase 2 failed (stores):", (err as Error).message);
			moduleReadiness.rejectModules(
				["agentStore", "providerStore", "templateStore", "mcpStore", "kbStore", "kbDb", "agentToolStore", "workspaceConfig"],
				err as Error,
			);
			moduleReadiness.rejectModules(
				["registry", "toolRegistry", "agentService", "mcpManager", "recovery"],
				new Error("skipped: stores failed"),
			);
			return;
		}

	// ─── Phase 2b: Test-mode seed (before setProviders reads provider list) ──
	log.ipc("Test mode check:", isTestMode());
	if (isTestMode()) {
		seedTestEnvironment(_sessionDb, _agentStore, _providerStore);
		_workspaceConfig = wsMod.loadWorkspaceConfig(_sessionDb);
		log.ipc("Test seed applied");
	}

	// ─── Phase 3: ToolRegistry (depends on sessionDb) ────────────
		try {
			_registry = new trMod.ToolRegistry(_sessionDb.getKVStore());
			_toolRegistry = _registry;
			runtimeToolsMod.registerRuntimeTools(_registry);
			moduleReadiness.resolveModules(["registry", "toolRegistry"]);
		} catch (err) {
			log.error("ipc", "Phase 3 failed (toolRegistry):", (err as Error).message);
			moduleReadiness.rejectModules(["registry", "toolRegistry"], err as Error);
			moduleReadiness.rejectModules(
				["agentService", "mcpManager", "recovery"],
				new Error("skipped: toolRegistry failed"),
			);
			return;
		}

	// ─── Phase 3b: Initialize search provider from saved config ──
	try {
		const spCfg = _workspaceConfig.searchProvider;
		if (spCfg && spCfg.type !== "duckduckgo") {
			const { createSearchProvider, setSearchProvider } = await import(
				toFileURL(join(__dirname, "../../dist/runtime/tools/web-search.js"))
			);
			setSearchProvider(createSearchProvider(spCfg));
		}
	} catch (err) {
		log.ipc("Failed to init search provider:", (err as Error).message);
	}

	// ─── Phase 4: MCPManager (depends on registry) ───────────────
		try {
			_mcpManager = new mcpMgrMod.MCPManager(_registry);
			moduleReadiness.resolveModule("mcpManager");
		} catch (err) {
			log.error("ipc", "Phase 4 failed (mcpManager):", (err as Error).message);
			moduleReadiness.rejectModule("mcpManager", err as Error);
		}

	// ─── Phase 5: AgentService (depends on all above) ────────────
	try {
	_agentService = _createAgentServiceFn(
		_workspaceConfig.workspaceDir, _sessionDb, _kbStore, _registry, _mcpManager,
	);
	_agentService.setAgentStore(_agentStore);
	_agentService.setAgentToolStore(_agentToolStore);

	const providerConfigs = _providerStore.list()
		.filter((p: any) => p.enabled)
		.map((p: any) => ({
			name: p.name, type: p.type, apiKey: p.apiKey, baseUrl: p.baseUrl,
			models: p.models.map((m: any) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
			enabled: p.enabled,
			enableConcurrencyLimit: p.enableConcurrencyLimit ?? false,
			maxConcurrency: p.maxConcurrency ?? 1,
		}));
	_agentService.setProviders(providerConfigs, _workspaceConfig.defaultModel, _workspaceConfig.defaultProvider);
	_agentService.subscribe((event: any) => {
		if (_mainWindow && !_mainWindow.isDestroyed()) {
			_mainWindow.webContents.send("agent:event", event);
		}
	});
	moduleReadiness.resolveModule("agentService");
	} catch (err) {
		log.error("ipc", "Phase 5 failed (agentService):", (err as Error).message);
		moduleReadiness.rejectModule("agentService", err as Error);
		moduleReadiness.rejectModule("recovery", new Error("skipped: agentService failed"));
		return;
	}

	// ─── Phase 5b: SessionManager + metrics hooks ────────────────
	try {
		const { SessionManager } = await import(toFileURL(join(_distServer, "session-manager.js")));
		const { registerMetricsHooks } = await import(toFileURL(join(_distServer, "metrics-hooks.js")));
		const sm = new SessionManager(_agentService, {
			onStateChange: (sessionId: string, from: string, to: string) => {
				if (_mainWindow && !_mainWindow.isDestroyed()) {
					_mainWindow.webContents.send("session:lifecycle", { sessionId, from, to });
				}
			},
		});
		_agentService.setSessionManager(sm);
			sm.setSessionDb(_agentService.getDB());
		registerMetricsHooks(sm);
		sm.startTtlCleanup();
	} catch (err) {
		log.warn("ipc", "SessionManager init skipped:", (err as Error).message);
	}

	// MCP reconnect + agent tool entries
	_mcpManager.reconnectEnabled(_mcpStore.list()).catch((err: any) => {
		log.warn("mcp", "Reconnect failed:", err?.message ?? err);
	});
	_registerAgentTools = agentSvcMod.registerAgentToolEntries;
	agentSvcMod.registerAgentToolEntries(_agentToolStore, _registry);

	// ─── Phase 6: Recovery ───────────────────────────────────────
		try {
			const interrupted = recoveryMod.scanIncompleteTurns(_sessionDb);
			if (interrupted.length > 0) {
				await _agentService.recoverIncompleteSessions();
			}
			moduleReadiness.resolveModule("recovery");
		} catch (err) {
			log.error("ipc", "Phase 6 failed (recovery):", (err as Error).message);
			moduleReadiness.rejectModule("recovery", err as Error);
		}

		log.ipc("All modules ready", `+${Date.now() - t0}ms`);
	}
