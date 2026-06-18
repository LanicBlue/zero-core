// IPC 核心注册
//
// # 文件说明书
//
// ## 核心功能
// IPC 模块的核心，负责注册所有 IPC 处理器和初始化上下文。
//
// ## 输入
// - BrowserWindow - 主窗口
// - 服务实例（agentStore, agentService 等）
//
// ## 输出
// - 注册的 IPC 处理器
// - IpcContext 实例
//
// ## 定位
// IPC 模块入口，被 main/index.ts 调用。
//
// ## 依赖
// - electron - Electron 主进程
// - ../../core/logger - 日志
// - ./types - 类型定义
// - ./module-readiness - 模块就绪检查
//
// ## 维护规则
// - 新增处理器模块时需注册
// - 保持初始化顺序正确
//
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
let _projectStore: any;
let _requirementStore: any;
let _wikiStore: any;
let _taskStepStore: any;
let _analystService: any;
let _leadService: any;
// v0.8 (M1): cron store — first-class cron entity.
let _cronStore: any = null;
// M5 services
let _cronManager: any = null;
let _gitIntegration: any = null;
let _notificationService: any = null;
// v0.8 (M3): Orchestrate plan store.
let _orchestratePlanStore: any = null;
// v0.8 P7 (§1.5): ProjectNotificationRouter deleted — pull model.
// v0.8 (M4): PM service + supporting stores (requirement doc repo store,
// shared manifest store for coverage evidence, wiki-node store for PM
// read-only project context).
let _pmService: any = null;
let _requirementDocStore: any = null;
let _manifestStore: any = null;
let _wikiNodeStore: any = null;

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
	set workspaceConfig(v) { _workspaceConfig = v; },
	get toolRegistry() { return _toolRegistry; },
	get buildDefaultPrompt() { return _buildDefaultPromptFn; },
	get saveWorkspaceConfig() { return _saveWorkspaceConfigFn; },
	get createAgentService() { return _createAgentServiceFn; },
	get projectStore() { return _projectStore; },
	get requirementStore() { return _requirementStore; },
	get wikiStore() { return _wikiStore; },
	get taskStepStore() { return _taskStepStore; },
	get analystService() { return _analystService; },
	get leadService() { return _leadService; },
	// v0.8 (M1): cron store
	get cronStore() { return _cronStore; },
	// M5 services
	get cronManager() { return _cronManager; },
	get gitIntegration() { return _gitIntegration; },
	get notificationService() { return _notificationService; },
	// v0.8 (M3): Orchestrate plan store.
	get orchestratePlanStore() { return _orchestratePlanStore; },
	// v0.8 P7 (§1.5): ProjectNotificationRouter deleted — pull model.
	// v0.8 (M4): PM service + supporting stores.
	get pmService() { return _pmService; },
	get requirementDocStore() { return _requirementDocStore; },
	get manifestStore() { return _manifestStore; },
	get wikiNodeStore() { return _wikiNodeStore; },
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
		durableHooksMod, toolExecHooksMod, kbStoreMod, kbDbMod, agentToolStoreMod,
		runtimeToolsMod, trMod, recoveryMod,
		projectStoreMod, requirementStoreMod, wikiStoreMod, taskStepStoreMod,
		analystSvcMod, leadSvcMod, reqHooksMod, wfCtxHookMod,
		gitIntegMod, notifSvcMod, cronAnalysisMod, cronStoreMod,
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
		import(toFileURL(join(_distServer, "tool-execution-hooks.js"))),
		import(toFileURL(join(_distServer, "kb-store.js"))),
		import(toFileURL(join(_distServer, "kb-db.js"))),
		import(toFileURL(join(_distServer, "agent-tool-store.js"))),
		import(toFileURL(join(__dirname, "../../dist/runtime/tools/index.js"))),
		import(toFileURL(join(_distCore, "tool-registry.js"))),
		import(toFileURL(join(_distServer, "recovery.js"))),
		import(toFileURL(join(_distServer, "project-store.js"))),
		import(toFileURL(join(_distServer, "requirement-store.js"))),
		import(toFileURL(join(_distServer, "project-wiki-store.js"))),
		import(toFileURL(join(_distServer, "task-step-store.js"))),
		import(toFileURL(join(_distServer, "analyst-service.js"))),
		import(toFileURL(join(_distServer, "lead-service.js"))),
		import(toFileURL(join(_distServer, "requirement-hooks.js"))),
		import(toFileURL(join(_distServer, "workflow-context-hook.js"))),
		// M5 modules
		import(toFileURL(join(_distServer, "git-integration.js"))),
		import(toFileURL(join(_distServer, "notification-service.js"))),
		import(toFileURL(join(_distServer, "cron-analysis.js"))),
		// M1 module
		import(toFileURL(join(_distServer, "cron-store.js"))),
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
	toolExecHooksMod.registerToolExecutionHooks(_sessionDb);
	const { registerAllRuntimeHooks } = await import(toFileURL(join(__dirname, "../../dist/runtime/hooks/index.js")));
	registerAllRuntimeHooks(_sessionDb);
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

			// Multi-Agent Workflow stores
			_projectStore = new projectStoreMod.ProjectStore(_sessionDb);
			_requirementStore = new requirementStoreMod.RequirementStore(_sessionDb);
			_wikiStore = new wikiStoreMod.ProjectWikiStore(_sessionDb);
			_taskStepStore = new taskStepStoreMod.TaskStepStore(_sessionDb);
			// v0.8 (M1): cron store — first-class cron entity.
			_cronStore = new cronStoreMod.CronStore(_sessionDb);

			console.log("[startup] workspaceConfig:", JSON.stringify(_workspaceConfig));
			// Apply proxy config
			try {
				const proxyMod = await import(toFileURL(join(__dirname, "../../dist/runtime/proxy-manager.js")));
				proxyMod.applyProxy(_workspaceConfig.proxy);
			} catch (e) { log.error("ipc", "Proxy init failed:", (e as Error).message); }


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

			// Restore all sessions from DB into this AgentService instance
			await _agentService.restoreAllSessions();
			_agentService.recoverIncompleteSessions();
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

	// ─── Phase 5c: Workflow services + hooks (M2/M3/M5) ────────────
	try {
		// Register workflow context hook (T2 context injection via PreLLMCall)
		wfCtxHookMod.registerWorkflowContextHook({
			projectStore: _projectStore,
			requirementStore: _requirementStore,
			wikiStore: _wikiStore,
			taskStepStore: _taskStepStore,
		});

		// AnalystService (M2) — now includes taskStepStore for M5
		_analystService = new analystSvcMod.AnalystService({
			agentService: _agentService,
			agentStore: _agentStore,
			projectStore: _projectStore,
			wikiStore: _wikiStore,
			requirementStore: _requirementStore,
			taskStepStore: _taskStepStore,
			templateStore: _templateStore,
		});

		// LeadService (M3)
		_leadService = new leadSvcMod.LeadService({
			agentService: _agentService,
			agentStore: _agentStore,
			requirementStore: _requirementStore,
			taskStepStore: _taskStepStore,
			wikiStore: _wikiStore,
			projectStore: _projectStore,
			templateStore: _templateStore,
		});

		// M5: Git Integration, Notification, Cron
		_gitIntegration = new gitIntegMod.GitIntegration();
		_notificationService = new notifSvcMod.NotificationService({
			wss: null,  // WebSocket not available in IPC mode; notifications go to requirement_messages only
			requirementStore: _requirementStore,
		});
		_cronManager = new cronAnalysisMod.CronAnalysisManager({
			agentService: _agentService,
			agentStore: _agentStore,
			projectStore: _projectStore,
			sessionDB: _sessionDb,
			cronStore: _cronStore,
		});

		// v0.8 (M3): Orchestrate plan store. Plan store backs the kanban
		// plan-gate pending entry + confirm/reject IPC channels.
		// v0.8 P7 (§1.5): ProjectNotificationRouter deleted — pull model.
		// ready→lead pickup is driven by LeadService.autoPickupIfIdle + lead
		// cron fallback; verify is lead's explicit verify tool call; PM
		// verdicts drive ArchivistService directly via PmService.
		const orchStoreMod = await import(toFileURL(join(_distServer, "orchestrate-store.js")));
		// v0.8 (M4): single shared manifest store — PM reads it for coverage
		// evidence.
		_manifestStore = new orchStoreMod.OrchestrateManifestStore(_sessionDb);
		_orchestratePlanStore = new orchStoreMod.OrchestratePlanStore(_sessionDb);
		_leadService.setOrchestrateStores(_orchestratePlanStore, _manifestStore);

		// v0.8 P7 (§4.6): construct ArchivistService so PM coverage verdicts
		// can drive archivist mergeFeatureToMain + 增量扫描 → status closed.
		// Mirrors the server/index.ts wiring (wikiScanCursorStore +
		// archivistGit).
		const archivistSvcMod = await import(toFileURL(join(_distServer, "archivist-service.js")));
		const archivistGitMod = await import(toFileURL(join(_distServer, "archivist-git.js")));
		const wikiScanCursorMod = await import(toFileURL(join(_distServer, "wiki-scan-cursor-store.js")));
		const archivistService = new archivistSvcMod.ArchivistService({
			wikiStore: _wikiNodeStore,
			cursorStore: new wikiScanCursorMod.WikiScanCursorStore(_sessionDb),
			git: new archivistGitMod.ArchivistGit(),
			projectStore: _projectStore,
			requirementStore: _requirementStore,
		});

		// v0.8 (M4): PM service (RFC §2.5 / §2.10 / §2.17b). RequirementDocStore
		// writes repo docs under {workspace}/.zero/requirements/{projectId}/;
		// wiki node store gives PM read-only project context.
		// v0.8 P7: PmService.submitCoverageVerdict drives ArchivistService
		// directly (covered=true → mergeFeatureToMain → closed). No router.
		const pmSvcMod = await import(toFileURL(join(_distServer, "pm-service.js")));
		const reqDocStoreMod = await import(toFileURL(join(_distServer, "requirement-doc-store.js")));
		_requirementDocStore = new reqDocStoreMod.RequirementDocStore({
			getWorkspaceDir: (projectId: string) => _projectStore.get(projectId)?.workspaceDir,
		});
		_pmService = new pmSvcMod.PmService({
			agentService: _agentService,
			agentStore: _agentStore,
			projectStore: _projectStore,
			requirementStore: _requirementStore,
			requirementDocStore: _requirementDocStore,
			wikiNodeStore: _wikiNodeStore,
			manifestStore: _manifestStore,
			archivistService,
			sessionDB: _sessionDb,
		});

		// Inject GitIntegration into AnalystService + LeadService
		_analystService.setGitIntegration(_gitIntegration);
		_leadService.setGitIntegration(_gitIntegration);

		// Register requirement hooks (v0.8 P7 — pull-model slimmed version:
		// plan→build PostToolUse + lead autoPickupIfIdle chain PostTurnComplete;
		// no auto build→verify, no notify pushes).
		reqHooksMod.registerRequirementHooks({
			requirementStore: _requirementStore,
			taskStepStore: _taskStepStore,
			leadService: _leadService,
		});

		log.ipc("Workflow services initialized (M2/M3/M5; P7 pull-model)");
	} catch (err) {
		log.error("ipc", "Phase 5c failed (workflow services):", (err as Error).message);
	}

	// ─── Phase 6: Recovery ───────────────────────────────────────
		try {
			const interrupted = recoveryMod.scanIncompleteTurns(_sessionDb);
			if (interrupted.length > 0) {
				await _agentService.recoverIncompleteSessions();
			}

			// M5: Workflow state recovery (build/plan/verify requirements)
			if (_cronManager && _requirementStore && _taskStepStore) {
				recoveryMod.recoverWorkflowState({
					projectStore: _projectStore,
					requirementStore: _requirementStore,
					taskStepStore: _taskStepStore,
					cronManager: _cronManager,
					agentService: _agentService,
				});
			}

			moduleReadiness.resolveModule("recovery");
		} catch (err) {
			log.error("ipc", "Phase 6 failed (recovery):", (err as Error).message);
			moduleReadiness.rejectModule("recovery", err as Error);
		}

		log.ipc("All modules ready", `+${Date.now() - t0}ms`);
	}
