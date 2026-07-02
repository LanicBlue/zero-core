// HTTP/WebSocket 服务入口
//
// # 文件说明书
//
// ## 核心功能
// 创建 Express HTTP 和 WebSocket 服务器，注册所有 REST API 路由
//
// ## 输入
// 各 Store 和 Manager 实例
//
// ## 输出
// HTTP Server 和 WebSocket Server 实例
//
// ## 定位
// src/server/ — 服务层入口，为外部客户端提供 API 服务
//
// ## 依赖
// express、ws、所有 router 和 store 模块
//
// ## 维护规则
// 新增路由模块需在此注册
//

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { AgentStore } from "./agent-store.js";
import { onDataChange } from "./data-change-hub.js";
import { ProviderStore } from "./provider-store.js";
import { TemplateStore } from "./template-store.js";
import { McpStore } from "./mcp-store.js";
import { createAgentService } from "./agent-service.js";
import { SessionDB } from "./session-db.js";
import { runMigrations } from "./db-migration.js";
import { loadWorkspaceConfig } from "./workspace-config.js";
import { applyProxy } from "../runtime/proxy-manager.js";
import { buildDefaultPrompt } from "../core/default-prompt.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { MCPManager } from "./mcp-manager.js";
import { createAgentRouter } from "./agent-router.js";
import { createProviderRouter } from "./provider-router.js";
import { createTemplateRouter } from "./template-router.js";
import { createMcpRouter } from "./mcp-router.js";
import { createConfigRouter } from "./config-router.js";
import { createChatRouter } from "./chat-router.js";
import { createSessionRouter } from "./session-router.js";
import { createDelegatedTaskRouter } from "./delegated-task-router.js";
import { createInputQueueRouter } from "./input-queue-router.js";
import { createLogRouter } from "./log-router.js";
import { createFileRouter } from "./file-router.js";
import { createToolExecutionRouter } from "./tool-execution-router.js";
import { createSkillRouter } from "./skill-router.js";
import { ProjectStore } from "./project-store.js";
import { RequirementStore } from "./requirement-store.js";
import { ProjectWikiStore } from "./project-wiki-store.js";
// v0.8 (M2): global wiki memory tree + archivist.
import { WikiStore } from "./wiki-node-store.js";
import { WikiScanCursorStore } from "./wiki-scan-cursor-store.js";
import { ArchivistGit } from "./archivist-git.js";
import { WikiSkeletonService } from "./wiki-skeleton-service.js";
import { TaskStepStore } from "./task-step-store.js";
import { createProjectRouter } from "./project-router.js";
import { createRequirementRouter } from "./requirement-router.js";
import { createWikiRouter } from "./project-wiki-router.js";
// v0.8 (P8 §10.9): global wiki memory-tree browser endpoints
// (list-by-anchors / nodes/:id/detail / search + project-scoped workspace-doc).
// Mirrors wiki-handlers.ts; production route is ipc-proxy ROUTE_MAP → these.
import { createWikiRouter as createWikiBrowserRouter, createWorkspaceDocHandler } from "./wiki-router.js";
import { AnalystService } from "./analyst-service.js";
import { scanExternalMcpConfigs, mergeDetectedServers } from "./mcp-scanner.js";
import { ALL_TOOLS, registerRuntimeTools } from "../runtime/tools/index.js";
import { getToolExecute } from "../runtime/tools/tool-factory.js";
import type { ToolExecutionContext } from "../runtime/types.js";
import { getCookieCount, clearCookies } from "../runtime/mcp-tools/fetch-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

process.on("unhandledRejection", (reason) => {
	const msg = reason instanceof Error ? reason.message : String(reason);
	const stack = reason instanceof Error ? reason.stack : "";
	console.error(`[server] Unhandled rejection: ${msg}`);
	if (stack) console.error(stack);
});

process.on("uncaughtException", (err) => {
	console.error(`[server] Uncaught exception: ${err.message}`);
	if (err.stack) console.error(err.stack);
});

export interface StartServerOptions {
	port?: number;
	serveStatic?: boolean;
}

export async function startServer(options?: StartServerOptions) {
	const port = options?.port ?? parseInt(process.env.PORT ?? "3210", 10);
	const serveStatic = options?.serveStatic ?? true;

	const app = express();
	app.use(express.json());

	const server = createServer(app);
	const wss = new WebSocketServer({ server, path: "/ws" });

	// ─── Initialize stores and services ──────────────────────────

	const sessionDB = new SessionDB();
	runMigrations(sessionDB);

	// Crash recovery: any delegated tasks still marked running/finishing were
	// interrupted by the previous exit. Mark them interrupted (inspect-only;
	// not auto-resumed). Decision: human/parent re-triggers.
	const interruptedDelegatedTasks = sessionDB.markRunningDelegatedTasksInterrupted();
	if (interruptedDelegatedTasks > 0) {
		console.error(`[server] Interrupted delegated tasks on startup: ${interruptedDelegatedTasks}`);
	}

	// v0.8 (M2): single global WikiStore (the memory tree) — created EARLY so
	// the M5 extraction hooks (registered per-loop below via setHookDeps) can
	// point at it. The back-compat ProjectWikiStore view is created alongside;
	// legacy IPC/router/renderer keep using it.
	const wikiStoreGlobal = new WikiStore(sessionDB);

	// v0.8 (M5): extractor cursor + telemetry stores live on SessionDB (lazy
	// accessors). The extraction hook deps are assembled here; they're handed
	// to agent-service.setHookDeps below so registerHooksForLoop wires them
	// onto each loop's own registry.
	const { ExtractorAService } = await import("./extractor-a-service.js");
	const { ExtractorBService } = await import("./extractor-b-service.js");
	const extractionDeps = {
		cursorStore: sessionDB.getExtractionCursorStore(),
		buildExtractorA: (providers: any[], providerName: string, modelId: string) =>
			new ExtractorAService({ providers, providerName, modelId, wiki: wikiStoreGlobal }),
		buildExtractorB: (providers: any[], providerName: string, modelId: string) =>
			new ExtractorBService({
				providers, providerName, modelId,
				telemetry: sessionDB.getTelemetryStore(),
			}),
	};
	// Note: Step 1B retired the global registerAllRuntimeHooks / durable /
	// tool-execution registration here — every loop now registers its own hook
	// set on its own HookRegistry (agent-service.createLoopForSession +
	// sendProjectPrompt + subagent-delegator delegated sub-loops).

	const registry = new ToolRegistry(sessionDB.getKVStore());
	registerRuntimeTools(registry);
	const mcp = new MCPManager(registry);
	const agentStore = new AgentStore(sessionDB);
	const providerStore = new ProviderStore(sessionDB);
	const templateStore = new TemplateStore(sessionDB);
	const mcpStore = new McpStore(sessionDB);

	// Multi-Agent Workflow stores
	const projectStore = new ProjectStore(sessionDB);
	const requirementStore = new RequirementStore(sessionDB);
	// ProjectWikiStore back-compat view over the same rows as wikiStoreGlobal.
	const wikiStore = new ProjectWikiStore(wikiStoreGlobal);
	// v0.8 (M2): per-(archivist, project) git scan cursor.
	const wikiScanCursorStore = new WikiScanCursorStore(sessionDB);
	const taskStepStore = new TaskStepStore(sessionDB);
	// v0.8 (M1): cron store — first-class cron entity (one agent → N cron).
	// v0.8 (P4 §9.3): cron_runs audit sink — one row per actual cron fire.
	const cronStore = new (await import("./cron-store.js")).CronStore(sessionDB);
	const cronRunStore = new (await import("./cron-store.js")).CronRunStore(sessionDB);
	// 项目级后台 agent 任务(wiki 充实等)的 run 记录。
	const projectJobStore = new (await import("./project-job-store.js")).ProjectJobStore(sessionDB);
	// v0.8 project-work(取代工作流角色的"工位"系统):早构造,T2 hook + 后续 cron/runner 共用。
	const projectWorkStore = new (await import("./project-work-store.js")).ProjectWorkStore(sessionDB);

	// Step 1B: workflow-context hook (T2 PreLLMCall injection) is no longer
	// registered globally — it rides the per-loop registry via the deps handed
	// to agent-service.setHookDeps below.

	let workspaceConfig = loadWorkspaceConfig(sessionDB);

	// Test-mode seed — populate mock provider + agent when ZERO_CORE_TEST_FIXTURE is set
	if (process.env.ZERO_CORE_TEST_FIXTURE) {
		const { seedTestEnvironment } = await import("../core/test-seed.js");
		seedTestEnvironment(sessionDB, agentStore, providerStore, wikiStoreGlobal, projectStore);
		workspaceConfig = loadWorkspaceConfig(sessionDB);
	}

	if (!existsSync(workspaceConfig.workspaceDir)) {
		mkdirSync(workspaceConfig.workspaceDir, { recursive: true });
	}

	console.log("[server] Workspace:", workspaceConfig.workspaceDir);

	// Apply persisted proxy config at startup. Without this, the proxy saved in
	// Settings only takes effect reactively (config-router on save) and is LOST
	// on every backend restart — so Brave Search / provider calls go direct and
	// fail behind a firewall. Fall back to *_PROXY env vars so a system-level
	// proxy also works (Node's fetch ignores both system proxy and these env
	// vars by default; undici's global dispatcher is the only lever).
	{
		const persisted = workspaceConfig.proxy;
		const envUrl =
			process.env.HTTPS_PROXY || process.env.https_proxy ||
			process.env.HTTP_PROXY || process.env.http_proxy;
		if (persisted?.enabled && persisted.url) {
			applyProxy(persisted);
		} else if (envUrl) {
			applyProxy({ enabled: true, url: envUrl });
		}
	}

	const agentService = createAgentService(workspaceConfig.workspaceDir, sessionDB, registry, mcp);
	agentService.setAgentStore(agentStore);

	// Step 1B: inject per-loop hook wiring deps. The service merges its own
	// always-available handles (db / sessionManager / inputQueue) on top at
	// buildHookDeps() time. Each loop built by agent-service registers the
	// main hook set from these; delegated sub-loops inherit them via
	// config.hookWiringDeps. This retires the former global
	// registerAllRuntimeHooks / registerDurableHooks / registerToolExecutionHooks
	// / registerWorkflowContextHook / registerInputQueueHooks calls.
	agentService.setHookDeps({
		extractionDeps,
		workflowContext: { projectStore, requirementStore, wikiStore, taskStepStore, projectWorkStore },
	});

	// v0.8 (P3): ManagementService (renamed from ZeroAdminService) —
	// capability backend for the Project/Agent/Cron action tools.
	// v0.8 (P5 §8.4 / §8.5): also carries the Project container-view +
	// resource-usage aggregation backends. Late-bound deps (archivistService)
	// are wired below after their constructor runs.
	const { ManagementService } = await import("./management-service.js");
	const management = new ManagementService({
		agentStore, projectStore, cronStore,
		templateStore,
		requirementStore, sessionDB, wikiStore: wikiStoreGlobal,
	});
	management.setTaskStepStore(taskStepStore);
	management.setProjectJobStore(projectJobStore);
	agentService.setManagement(management);

	// v0.8 (P6 §7.1): fresh-DB seed — zero agent + software-dev wiki node.
	// Both are protected (cannot be deleted). Runs at startup, after all
	// stores are ready and before restoreAllSessions. RFC §7.1 / §7.5.
	//
	// Trigger: `agentStore.list().length === 0` (strict fresh-only). v0.8 P7
	// retired AgentStore's legacy "Zero" constructor seed, so this condition
	// is now true exactly on a truly-empty DB. fresh-db-seed.ts re-checks the
	// condition internally and no-ops on any non-empty table, so a re-seed
	// can never duplicate.
	const { seedFreshDbDefaults, ensureWikiSkeleton } = await import("./fresh-db-seed.js");
	seedFreshDbDefaults({ agentStore, wikiStore: wikiStoreGlobal, management });
	// Unconditionally ensure the wiki skeleton on every startup (idempotent).
	// seedFreshDbDefaults above is fresh-only; this reaches EXISTING DBs so
	// structural seed changes (e.g. knowledge/workflow/software-dev reorg,
	// legacy-position migration) apply without a re-seed.
	ensureWikiSkeleton(wikiStoreGlobal);

	agentService.subscribe((event: any) => {
		// Forward all agent events to WebSocket clients
		const msg = JSON.stringify(event);
		for (const ws of wss.clients) {
			if (ws.readyState === ws.OPEN) {
				ws.send(msg);
			}
		}
	});

	// v0.8: broadcast a single unified `data:changed` ping whenever any UI-
	// synced collection is mutated. The data-change-hub listens at the
	// SqliteStore primitive layer (insertRow/updateRow/delete), so EVERY store
	// derived from it — agents / projects / crons / requirements / project_wiki —
	// is covered with zero per-store wiring, regardless of which surface mutated
	// it (management tools, REST routers, archivist, extractors). The hub
	// whitelists UI collections (so high-frequency tables like messages/turns
	// don't flood) and coalesces bursts into one refresh per collection.
	const broadcast = (event: any) => {
		const msg = JSON.stringify(event);
		for (const ws of wss.clients) {
			if (ws.readyState === ws.OPEN) ws.send(msg);
		}
	};
	onDataChange((e) => broadcast({ type: "data:changed", collection: e.collection }));
	// AgentStore.onChange is retained SEPARATELY for agent-service's live
	// config hot-reload (agent-service.ts) — that is an internal consumer, not
	// UI sync. UI sync for agents rides the unified data:changed channel above.


	// Load providers from DB for backend-spawn mode.
	// In IPC mode, main process calls setProviders later via Phase 5 — notifyReady deduplicates.
	// reloadProviders 复用于 provider 增删改后即时生效(并发 reconfigure + 清缓存 + 失效 loop),
	// 否则改了 provider 配置(尤其并发限制)运行时一直用启动时旧值。
	const reloadProviders = () => {
		const providerConfigs = providerStore.list()
			.filter((p) => p.enabled)
			.map((p) => ({
				name: p.name, type: p.type, apiKey: p.apiKey, baseUrl: p.baseUrl,
				models: p.models.map((m: any) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
				enabled: p.enabled,
				enableConcurrencyLimit: p.enableConcurrencyLimit ?? false,
				maxConcurrency: p.maxConcurrency ?? 1,
			}));
		agentService.setProviders(providerConfigs as any, workspaceConfig.defaultModel, workspaceConfig.defaultProvider);
	};
	reloadProviders();

	// Restore all sessions from DB into runtime (no provider dependency)
	console.error("[server] Restoring all sessions from DB into runtime...");
	await agentService.restoreAllSessions();

	// Resume any sessions that were actively executing when the process died.
	// This defers until providers and agentStore are ready (via whenReady).
	const { scanIncompleteTurns } = await import("./recovery.js");
	const interrupted = scanIncompleteTurns(sessionDB);
	console.error("[server] Interrupted turns: " + interrupted.length + ", scheduling recovery...");
	if (interrupted.length > 0) {
		agentService.recoverIncompleteSessions();
	}

	// ─── Auto-detect MCP servers from external tools ────────────────
	try {
		const detected = await scanExternalMcpConfigs(workspaceConfig.workspaceDir);
		if (detected.length > 0) {
			const existing = mcpStore.list();
			const added = mergeDetectedServers(existing, (input) => mcpStore.create(input), detected);
			if (added.length > 0) {
				console.log(`[server] Auto-detected ${added.length} MCP servers from external tools`);
				for (const server of added) {
					if (server.enabled && (server.transport === "sse" || server.transport === "streamable-http") && server.url) {
						mcp.connect(server).catch(() => {});
					}
				}
			}
		}
	} catch (err) {
		console.error("[server] MCP auto-detect failed:", (err as Error).message);
	}

	// ─── AnalystService (M2) ─────────────────────────────────────────
	const analystService = new AnalystService({
		agentService,
		agentStore,
		projectStore,
		wikiStore,
		requirementStore,
		templateStore,
	});

	// ─── ArchivistService (v0.8 M2) ─────────────────────────────────
	// archivist owns the project wiki subtree structure (RFC §2.7/§2.13/
	// §2.16). Fed by main-branch git scans; writes only to its project
	// subtree (store-layer enforced). Manages main-branch git (commit PM
	// docs / merge feature→main / non-repo auto-init / worktree cleanup).
	const archivistGit = new ArchivistGit();
	const archivistService = new WikiSkeletonService({
		wikiStore: wikiStoreGlobal,
		cursorStore: wikiScanCursorStore,
		git: archivistGit,
		projectStore,
		requirementStore,
	});
	// v0.8 (P5 §8.3): ManagementService.createProject kicks the archivist
	// background scan; wire it now that archivistService exists.
	management.setArchivistService(archivistService);
	// wiki 充实 runner —— 把 archivist agent 后台拉起来深度充实 wiki 树。
	// management.enrichProject(create 的 enrich 选项 / "Run archivist" 按钮)走这里。
	const { EnrichmentRunner } = await import("./enrichment-runner.js");
	const enrichmentRunner = new EnrichmentRunner({
		agentService,
		agentStore,
		templateStore,
		sessionDB,
		projectStore,
		wikiStore: wikiStoreGlobal,
		projectJobStore,
	});
	management.setEnrichmentRunner((projectId, opts) => enrichmentRunner.runProjectEnrichment(projectId, opts));
	// v0.8 §8.6 (bugfix): purge orphan wiki subtrees left by pre-fix project
	// deletes (tool path used to skip the cascade). Idempotent — no-op once
	// clean. Runs after wikiStore + management are fully wired.
	const purged = management.purgeOrphanProjectSubtrees();
	if (purged > 0) console.error(`[server] Purged ${purged} orphan project wiki subtree(s)`);

	// ─── LeadService + Requirement Hooks (M3) ────────────────────────
	const { LeadService } = await import("./lead-service.js");
	const { OrchestratePlanStore, OrchestrateManifestStore } = await import("./orchestrate-store.js");

	// v0.8 (M3): Orchestrate plan/manifest stores — confirm gate persistence
	// (decision 11) + per-run manifest (decision 34).
	const orchestratePlanStore = new OrchestratePlanStore(sessionDB);
	const orchestrateManifestStore = new OrchestrateManifestStore(sessionDB);

	const leadService = new LeadService({
		agentService,
		agentStore,
		requirementStore,
		taskStepStore,
		wikiStore,
		projectStore,
		templateStore,
		orchestratePlanStore,
		orchestrateManifestStore,
	});

	// ─── M5: Git, Notifications, Cron ────────────────────────────
	const { GitIntegration } = await import("./git-integration.js");
	const { NotificationService } = await import("./notification-service.js");
	const { CronAnalysisManager } = await import("./cron-analysis.js");
	const { recoverWorkflowState } = await import("./recovery.js");

	const gitIntegration = new GitIntegration();
	// v0.8 (M3): inject git into LeadService so it can create feature worktrees
	// and commit steps with the [req-<shortId>] reference (decision 21/25).
	leadService.setGitIntegration(gitIntegration);
	// v0.8 project-work(去-role):LeadService 从"需求管理"工位取 agent+prompt。
	leadService.setProjectWorkStore(projectWorkStore);
	const notificationService = new NotificationService({ wss, requirementStore });
	// v0.8 project-work 系统(取代工作流角色):project_work 表 + 触发执行器 +
	// hook 管理器。cron 触发由 CronAnalysisManager 内联解析 work;手动/hook 触发
	// 走 ProjectWorkRunner。projectWorkStore 早构造(供 T2 hook),此处复用。
	management.setProjectWorkStore(projectWorkStore);
	// 存量 project(Phase-1 前创建)补 seed 默认工位(幂等:已有 work 跳过)。
	for (const p of projectStore.list()) {
		try { management.seedDefaultProjectWorks(p.id); } catch (e) { console.warn(`[server] seed works for ${p.id}:`, (e as Error).message); }
	}
	// v0.8 (M1): cron manager now scans the cron table (one agent → N cron),
	// routes triggers via resolveSessionByRoleProject + sendPrompt. P4: mode-
	// aware firing + cron_runs audit (cronRunStore injected).
	const cronManager = new CronAnalysisManager({
		agentService,
		agentStore,
		projectStore,
		sessionDB,
		cronStore,
		cronRunStore,
		wikiStore: wikiStoreGlobal,
		archivistGit,
		projectWorkStore,
	});
	// project-work 触发执行器(手动/hook 触发共享路径)+ hook 管理器(订阅
	// data-change-hub,domain 事件 → 命中的 work)。会话期内常驻。
	const { ProjectWorkRunner } = await import("./project-work-runner.js");
	const projectWorkRunner = new ProjectWorkRunner({
		agentService,
		agentStore,
		projectStore,
		projectWorkStore,
		sessionDB,
		wikiStore: wikiStoreGlobal,
	});
	management.setProjectWorkRunner(projectWorkRunner);
	management.setAgentService(agentService);
	const { ProjectWorkHookManager } = await import("./project-work-hook-manager.js");
	const projectWorkHookManager = new ProjectWorkHookManager({ projectWorkStore, projectWorkRunner });
	projectWorkHookManager.start();

	// v0.8 P7 (RFC §1.5): NO ProjectNotificationRouter — cross-role reactions
	// are pull-model. ready → lead autoPickupIfIdle + cron fallback;
	// verify → lead's verify tool calls PM via delegateTask + PmService.
	// .submitCoverageVerdict drives archivist merge directly (§4.6).

	// v0.8 (M4): PM service + requirement doc store (RFC §2.5 / §2.10 / §2.17b).
	// PM cron-driven discovery + discuss-as-document + coverage judgement.
	// v0.8 P7: PmService.submitCoverageVerdict drives ArchivistService
	// directly (covered=true → mergeFeatureToMain + 增量扫描 → closed).
	const { PmService } = await import("./pm-service.js");
	const { RequirementDocStore } = await import("./requirement-doc-store.js");
	const requirementDocStore = new RequirementDocStore({
		getWorkspaceDir: (pid: string) => projectStore.get(pid)?.workspaceDir,
	});
	const pmService = new PmService({
		agentService,
		agentStore,
		projectStore,
		requirementStore,
		requirementDocStore,
		wikiNodeStore: wikiStoreGlobal,
		manifestStore: orchestrateManifestStore,
		archivistService,
		sessionDB,
	});
	// v0.8 (M4): surface PmService + RequirementStore + wikiStore onto PM
	// session tool contexts so the CreateRequirementWithDoc tool can call
	// PmService.createRequirementWithDoc, and PM can read the project wiki
	// (ListWikiTree / ReadDoc), from a cron-triggered sendPrompt loop.
	agentService.setPmService(pmService, requirementStore, wikiStore);
	// v0.8 (M5): surface the global WikiStore onto every session so extractor
	// A can write global memory nodes (decision 46 N2) and recall
	// (memory-hooks) can read them back. Extractor enable flags +
	// checkpointThresholds are read from this.config.extractors inside
	// AgentService (loaded via loadConfig in its constructor).
	agentService.setWikiStoreGlobal(wikiStoreGlobal);

	// v0.8 (P3 §7.7 #4): tool-call usage log — one row per tool invocation,
	// surfaced onto every session so tool-factory can record it. Best-effort.
	const { ToolUsageStore } = await import("./tool-usage-store.js");
	agentService.setToolUsageStore(new ToolUsageStore(sessionDB));

	analystService.setGitIntegration(gitIntegration);
	// v0.8 project-work(去-role):AnalystService 从"技术调研"工位取 agent。
	analystService.setProjectWorkStore(projectWorkStore);

	// Step 1B (hook-redesign §5.5): requirement-hooks is retired — its
	// plan→build + autoPickupIfIdle logic is workflow-domain and now rides
	// cron + project-work + the pull model, not session hooks. The import
	// stays in case other code paths still reference the module, but it is no
	// longer registered. requirement-hooks.ts is marked legacy.

	// v0.8 P7 (§1.5): no projectNotificationRouter — pull model.
	// Run workflow state recovery (cron schedules + plan/build/verify reqs).
	recoverWorkflowState({ projectStore, requirementStore, taskStepStore, cronManager, agentService });

	// v0.8 §2.13 (structure rework): the archivist now builds a directory-
	// mirror tree (every dir = structure node) instead of the old flat
	// top-level-module grouping. Detect project subtrees still on the OLD
	// layout (a header node whose `path` nests deeper than its parent
	// structure node's dir) and rebuild them once. Idempotent — a no-op once
	// every subtree is on the new layout. Runs after archivistService is wired.
	void rebuildStaleStructureLayouts(archivistService, projectStore, wikiStoreGlobal);

	// ─── Mount API routers ───────────────────────────────────────

	app.use("/api/config", createConfigRouter({
		sessionDB,
		registry,
		buildDefaultPrompt,
	}));

	app.use("/api/agents", createAgentRouter({ agentStore, agentService, sessionDB }));
	app.use("/api/providers", createProviderRouter(providerStore, reloadProviders));
	app.use("/api/templates", createTemplateRouter(templateStore, sessionDB));
	app.use("/api/mcp", createMcpRouter(mcpStore, mcp));
	app.use("/api/skills", createSkillRouter());

	// New routers
	app.use("/api/chat", createChatRouter({ agentService, agentStore, providerStore, workspaceConfig }));
	app.use("/api/sessions", createSessionRouter({ agentService, agentStore, management }));
	app.use("/api/delegated-tasks", createDelegatedTaskRouter(sessionDB));
	app.use("/api/input-queue", createInputQueueRouter(agentService));
	app.use("/api/logs", createLogRouter({ sessionDb: sessionDB }));
	app.use("/api/files", createFileRouter({ workspaceConfig }));
	app.use("/api/tool-executions", createToolExecutionRouter({ sessionDb: sessionDB, agentService, providerStore, workspaceConfig }));

	// Multi-Agent Workflow routers

	// Projects — v0.8 M1: cron is agent-scoped, not project-scoped, so the
	// project lifecycle no longer auto-registers a per-project cron. v0.8 P4
	// (§8.6): the dead /interval /pause /resume compat shims are deleted;
	// scheduling lives entirely under /api/crons (cron entries are managed
	// via the cron tools / cron editor / /api/crons).
	// v0.8 P5 (§8.4/§8.5): router now consumes the cron store (cascade-delete
	// crons on project delete) and ManagementService (container view + create
	// side-effects + resource usage).
	const projectRouter = createProjectRouter({
		projectStore, requirementStore, wikiStore, taskStepStore,
		cronStore, management,
	});
	app.use("/api/projects", projectRouter);

	// v0.8 (M1): cron REST router — create/update/delete/list cron entries.
	// v0.8 (P4): also exposes GET /:id/runs for cron_runs audit history.
	const { createCronRouter } = await import("./cron-router.js");
	app.use("/api/crons", createCronRouter({ management, cronManager, cronRunStore }));

	// Requirements — with M5 verify/archive/report + notifications
	const requirementRouter = createRequirementRouter({ requirementStore, taskStepStore, notificationService });
	// v0.8 (M3): Orchestrate confirm-gate + manifest REST surface.
	const { createOrchestrateRouter } = await import("./orchestrate-router.js");
	const orchestrateRouter = createOrchestrateRouter({
		planStore: orchestratePlanStore,
		manifestStore: orchestrateManifestStore,
	});
	requirementRouter.post("/:id/verify", async (req, res) => {
		try {
			const result = await analystService.verifyRequirement(req.params.id);
			res.json(result);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	requirementRouter.post("/:id/archive", async (req, res) => {
		try {
			await analystService.archiveRequirement(req.params.id);
			res.json({ ok: true });
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	requirementRouter.get("/:id/report", (req, res) => {
		const messages = requirementStore.getMessages(req.params.id);
		const report = messages.find(m => m.messageType === "status_change" && m.content.startsWith("##"));
		res.json({ report: report?.content || null });
	});
		// Lead REST endpoints (M3)
		requirementRouter.post("/:id/pickup", async (req, res) => {
			try {
				const sessionId = await leadService.pickupRequirement(req.params.id);
				res.json({ sessionId });
			} catch (err) { res.status(500).json({ error: (err as Error).message }); }
		});
		requirementRouter.get("/:id/progress", (req, res) => {
			try {
				const progress = leadService.getProgress(req.params.id);
				res.json(progress);
			} catch (err) { res.status(500).json({ error: (err as Error).message }); }
		});
	app.use("/api/requirements", requirementRouter);
	app.use("/api/orchestrate", orchestrateRouter);

	// v0.8 (M4): PM REST surface — discuss doc read/write + coverage verdict.
	// Mirrors the pm:* IPC channels for server/HTTP mode parity.
	const pmRouter = express.Router();
	// Requirement doc (repo markdown) read/write/list.
	pmRouter.get("/:projectId/requirements/:requirementId/doc", (req, res) => {
		const content = requirementDocStore.readRequirementDoc(req.params.projectId, req.params.requirementId);
		const req0 = requirementStore.get(req.params.requirementId);
		res.json({ docPath: req0?.docPath, content });
	});
	pmRouter.put("/:projectId/requirements/:requirementId/doc", (req, res) => {
		try {
			const docPath = requirementDocStore.updateRequirementDoc(
				req.params.projectId, req.params.requirementId, String(req.body?.content ?? ""),
			);
			res.json({ docPath });
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	pmRouter.get("/:projectId/requirements", (req, res) => {
		res.json(requirementDocStore.listRequirementDocs(req.params.projectId));
	});
	// Create requirement + repo doc.
	pmRouter.post("/:projectId/requirements", (req, res) => {
		try {
			const r = pmService.createRequirementWithDoc({
				projectId: req.params.projectId,
				title: req.body?.title,
				summary: req.body?.summary,
				body: req.body?.body,
				priority: req.body?.priority,
				source: req.body?.source,
			});
			res.status(201).json(r);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	// v0.8 P7 (§4.2): kanban 「讨论」entry — route by requirementId → read
	// req.createdByAgentId → resolve {PM, projectId} session. The renderer is
	// responsible for setActiveAgent / page navigation + opening the
	// requirement doc (see CoverageJudgementModal / KanbanPage for the doc
	// open path).
	pmRouter.post("/:requirementId/discuss", (req, res) => {
		try {
			const resolved = pmService.openDiscussSession(req.params.requirementId);
			res.json({
				agentId: resolved.agentId,
				sessionId: resolved.session.id,
				created: resolved.created,
			});
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	// Coverage verdict → notify(verify_accept | verify_reject).
	pmRouter.post("/:requirementId/coverage-verdict", async (req, res) => {
		try {
			await pmService.submitCoverageVerdict(req.params.requirementId, {
				covered: !!req.body?.covered,
				reason: req.body?.reason,
			});
			res.json({ ok: true, kind: req.body?.covered ? "verify_accept" : "verify_reject" });
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	pmRouter.get("/:requirementId/coverage-view", (_req, res) => {
		res.json(pmService.buildCoverageView(_req.params.requirementId));
	});
	app.use("/api/pm", pmRouter);

	app.use("/api/project-wiki", createWikiRouter({ wikiStore }));

	// v0.8 (P8 §10.9): wiki browser endpoints — global memory tree surface.
	// Three wiki-tree endpoints under /api/wiki (list-by-anchors / nodes/:id/
	// detail / search) + one project-scoped workspace-doc endpoint. Mirrors
	// wiki-handlers.ts (logic identical; this is the REST port the IPC proxy
	// ROUTE_MAP routes to). wikiStoreGlobal is the canonical WikiStore;
	// projectStore resolves workspaceDir for the workspace-doc sandbox.
	// Mounted AFTER /api/projects/:id so the explicit /workspace-doc segment
	// matches first (Express takes the first matching route per method+path).
	app.use("/api/wiki", createWikiBrowserRouter({ wikiStore: wikiStoreGlobal, agentStore, archivistService }));
	app.get(
		"/api/projects/:projectId/workspace-doc",
		createWorkspaceDocHandler({ projectStore }),
	);

	// v0.8 (M2): archivist endpoints — scan / rescan / divergence / git ops.
	// Routes the project-notification / cron / requirement-accept flows into
	// the archivist's wiki + main-git responsibilities (RFC §2.7 / §2.13 /
	// §2.15 / §2.16).
	const archivistRouter = express.Router();
	archivistRouter.post("/:projectId/scan", async (req, res) => {
		try {
			const result = await archivistService.buildSkeleton(req.params.projectId);
			res.json(result);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	archivistRouter.post("/:projectId/rescan-full", async (req, res) => {
		try {
			const result = await archivistService.rescanProjectFull(req.params.projectId);
			res.json(result);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	// v0.8 §2.13 (structure rework): wipe + full rescan with the current
	// directory-mirror structure logic. Use when the structure semantics
	// changed and stale flat-module nodes need clearing.
	archivistRouter.post("/:projectId/rebuild-subtree", async (req, res) => {
		try {
			const result = await archivistService.rebuildProjectSubtree(req.params.projectId);
			res.json(result);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	archivistRouter.get("/:projectId/divergence", async (req, res) => {
		try {
			const report = await archivistService.detectDivergence(req.params.projectId);
			res.json(report);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	archivistRouter.post("/:projectId/commit-requirement-doc", async (req, res) => {
		try {
			const { requirementId, title, docPaths } = req.body || {};
			const r = await archivistService.commitRequirementDoc(
				req.params.projectId, requirementId, title, docPaths ?? [],
			);
			res.json(r);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	archivistRouter.post("/:projectId/merge-feature", async (req, res) => {
		try {
			const { requirementId } = req.body || {};
			const r = await archivistService.mergeFeatureToMain(
				req.params.projectId, requirementId,
			);
			res.json(r);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	archivistRouter.post("/:projectId/cleanup-worktree", async (req, res) => {
		try {
			const { requirementId } = req.body || {};
			await archivistService.cleanupWorktree(req.params.projectId, requirementId);
			res.json({ ok: true });
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	// v0.8 (M2): read the global wiki tree from a session view root. Project-
	// role sessions pass their wikiRootNodeId; global sessions pass
	// "wiki-root:global". This is the view-truncated read (decision 38).
	archivistRouter.get("/view/:wikiRootNodeId", (req, res) => {
		try {
			const nodes = wikiStoreGlobal.listVisibleFromRoot(req.params.wikiRootNodeId);
			res.json(nodes);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	app.use("/api/archivist", archivistRouter);

	// v0.8 模板统一:role-template 通道已移除 —— role 身份模板并入 TemplateStore
	// (/api/templates),AgentRegistry 工具与 UI Templates 页面读同一张表。

	// Tool execute
	app.post("/api/tool-execute", async (req, res) => {
		const { toolName, input } = req.body;
		const toolDef = ALL_TOOLS[toolName];
		if (!toolDef) return res.json({ ok: false, error: `Tool not found: ${toolName}`, elapsedMs: 0 });

		const execute = getToolExecute(toolDef);
		if (!execute) return res.json({ ok: false, error: `Tool not testable: ${toolName}`, elapsedMs: 0 });

		const config = registry.getToolConfig();
		const toolCtx: ToolExecutionContext = {
			workingDir: workspaceConfig.workspaceDir,
			agentId: "__test__",
			emit: () => {},
			db: sessionDB,
			readScope: workspaceConfig.readScope ?? "filesystem",
			toolConfig: config,
		};

		const t0 = Date.now();
		try {
			const result = await execute(input, toolCtx);
			res.json({ ok: true, result, elapsedMs: Date.now() - t0 });
		} catch (err: any) {
			res.json({ ok: false, error: err.message, elapsedMs: Date.now() - t0 });
		}
	});

	// WebFetch cookie ops (login stays in Electron)
	app.get("/api/webfetch/cookies", (_req, res) => res.json(getCookieCount()));
	app.delete("/api/webfetch/cookies", (req, res) => {
		clearCookies(req.query.domain as string | undefined);
		res.json({ success: true });
	});

	// v0.8: ask-user response bridge. ask-user tool (runtime/tools/ask-user.ts)
	// runs in the backend-spawn process and waits on the in-process
	// pendingResponses singleton; the renderer resolves via this endpoint
	// (arch/04-tools-subsystem.md: api.askUserRespond → HTTP → server →
	// pendingResponses.resolveRequest).
	const { pendingResponses } = await import("../runtime/pending-responses.js");
	app.post("/api/ask-user/respond", (req, res) => {
		const { requestId, answers } = (req.body ?? {}) as { requestId?: string; answers?: Record<string, string> };
		if (!requestId || !answers) {
			res.status(400).json({ error: "requestId + answers required" });
			return;
		}
		pendingResponses.resolveRequest(requestId, answers);
		res.json({ success: true });
	});

	// Models — aggregated from all providers
	app.get("/api/models", (_req, res) => {
		try {
			const models: {
				providerId: string;
				provider: string;
				providerName: string;
				providerType: string;
				id: string;
				name: string;
				contextWindow?: number;
				maxTokens?: number;
			}[] = [];
			for (const p of providerStore.list()) {
				for (const m of p.models) {
					models.push({
						providerId: p.id,
					provider: p.name,
					providerName: p.name,
					providerType: p.type,
					id: m.id,
					name: m.name,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					});
				}
			}
			res.json(models);
		} catch (err) {
			console.error("[server] Failed to list models:", (err as Error).message);
			res.json([]);
		}
	});

	// Ready endpoint
	app.get("/api/ready", (_req, res) => res.json({ ready: true }));

	// ─── WebSocket ──────────────────────────────────────────────

	wss.on("connection", (ws) => {
		const state = agentService.getState();
		if (state.isBusy) {
			ws.send(JSON.stringify({
				type: "reconnect",
				isBusy: true,
				streamingText: state.streamingText,
				toolCalls: state.toolCalls,
			}));
		}

		ws.on("message", async (raw) => {
			try {
				const msg = JSON.parse(raw.toString());

				if (msg.type === "send") {
					const agent = msg.agentId
						? agentStore.get(msg.agentId)
						: undefined;
					const wsDir = expandHome(agent?.workspaceDir || workspaceConfig.workspaceDir);
					agentService.setWorkspaceDir(wsDir);
					await agentService.sendPrompt(msg.text, agent);
				} else if (msg.type === "abort") {
					await agentService.abort();
				}
			} catch (err) {
				ws.send(JSON.stringify({
					type: "error",
					error: (err as Error).message,
				}));
			}
		});
	});

	// ─── Static files (renderer) ──────────────────────────────

	if (serveStatic) {
		let rendererDir = process.env.RENDERER_DIR;
		if (!rendererDir || !existsSync(join(rendererDir, "index.html"))) {
			const candidates = [
				join(__dirname, "../../out/renderer"),
				join(__dirname, "../renderer"),
			];
			rendererDir = candidates.find((d) => existsSync(join(d, "index.html"))) || candidates[0];
		}
		console.log("[server] Renderer dir:", rendererDir);
		app.use(express.static(rendererDir));
		app.use((_req, res) => {
			res.sendFile(join(rendererDir, "index.html"));
		});
	}

	// ─── Start ────────────────────────────────────────────────

	await new Promise<void>((resolve) => {
		server.listen(port, () => {
			console.log(`Zero-Core server running at http://localhost:${(server.address() as any).port}`);
			console.log(`Workspace: ${workspaceConfig.workspaceDir}`);
			resolve();
		});
	});

	return { server, agentService };
}

/**
 * v0.8 §2.13 (structure rework): detect project subtrees still laid out
 * under the OLD archivist grouping (flat top-level module — a header node's
 * parent structure node names only the file's TOP directory, not its
 * immediate parent dir) and rebuild them with the directory-mirror logic.
 *
 * Detection: a header node `header:<dirA>/<dirB>/file` is on the OLD layout
 * if its parent is a `structure:<dirA>` node (top dir only) while the file
 * lives ≥2 dirs deep. On the new layout the parent would be
 * `structure:<dirA>/<dirB>`. Idempotent — no-op once clean.
 */
async function rebuildStaleStructureLayouts(
	archivistService: import("./wiki-skeleton-service.js").WikiSkeletonService,
	projectStore: import("./project-store.js").ProjectStore,
	wikiStore: import("./wiki-node-store.js").WikiStore,
): Promise<void> {
	try {
		for (const project of projectStore.list()) {
			const nodes = wikiStore.listByProject(project.id);
			let stale = false;
			for (const n of nodes) {
				if (n.type !== "header" || !n.path.startsWith("header:")) continue;
				const fileRel = n.path.slice("header:".length).replace(/\\/g, "/");
				const fileSegs = fileRel.split("/").filter(Boolean);
				if (fileSegs.length < 3) continue; // ≤2 deep: top-dir grouping is correct
				const parent = nodes.find((p) => p.id === n.parentId);
				if (!parent || !parent.path.startsWith("structure:")) continue;
				// New layout: parent dir = all-but-last seg. Old (flat): top seg only.
				const expectedParentDir = fileSegs.slice(0, -1).join("/");
				const actualParentDir = parent.path.slice("structure:".length).replace(/\\/g, "/");
				if (actualParentDir !== expectedParentDir) { stale = true; break; }
			}
			if (stale) {
				console.error(`[server] Rebuilding stale wiki structure for project ${project.name} (${project.id})`);
				await archivistService.rebuildProjectSubtree(project.id);
			}
		}
	} catch (err) {
		console.error("[server] structure-rebuild migration failed:", (err as Error).message);
	}
}
