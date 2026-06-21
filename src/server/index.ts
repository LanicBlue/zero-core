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
import { ProviderStore } from "./provider-store.js";
import { TemplateStore } from "./template-store.js";
import { McpStore } from "./mcp-store.js";
import { KbStore } from "./kb-store.js";
import { KbDB } from "./kb-db.js";
import { createAgentService } from "./agent-service.js";
import { SessionDB } from "./session-db.js";
import { runMigrations } from "./db-migration.js";
import { loadWorkspaceConfig } from "./workspace-config.js";
import { buildDefaultPrompt } from "../core/default-prompt.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { MCPManager } from "./mcp-manager.js";
import { createAgentRouter } from "./agent-router.js";
import { createProviderRouter } from "./provider-router.js";
import { createTemplateRouter } from "./template-router.js";
import { createMcpRouter } from "./mcp-router.js";
import { createKbRouter } from "./kb-router.js";
import { createConfigRouter } from "./config-router.js";
import { createChatRouter } from "./chat-router.js";
import { createSessionRouter } from "./session-router.js";
import { createLogRouter } from "./log-router.js";
import { createFileRouter } from "./file-router.js";
import { createToolExecutionRouter } from "./tool-execution-router.js";
import { createSkillRouter } from "./skill-router.js";
import { createMemoryNodeRouter } from "./memory-node-router.js";
import { ProjectStore } from "./project-store.js";
import { RequirementStore } from "./requirement-store.js";
import { ProjectWikiStore } from "./project-wiki-store.js";
// v0.8 (M2): global wiki memory tree + archivist.
import { WikiStore } from "./wiki-node-store.js";
import { WikiScanCursorStore } from "./wiki-scan-cursor-store.js";
import { ArchivistGit } from "./archivist-git.js";
import { ArchivistService } from "./archivist-service.js";
import { TaskStepStore } from "./task-step-store.js";
import { createProjectRouter } from "./project-router.js";
import { createRequirementRouter } from "./requirement-router.js";
import { createWikiRouter } from "./project-wiki-router.js";
// v0.8 (P8 §10.9): global wiki memory-tree browser endpoints
// (list-by-anchors / nodes/:id/detail / search + project-scoped workspace-doc).
// Mirrors wiki-handlers.ts; production route is ipc-proxy ROUTE_MAP → these.
import { createWikiRouter as createWikiBrowserRouter, createWorkspaceDocHandler } from "./wiki-router.js";
import { AnalystService } from "./analyst-service.js";
import { registerWorkflowContextHook } from "./workflow-context-hook.js";
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

	// v0.8 (M2): single global WikiStore (the memory tree) — created EARLY so
	// the M5 extraction hooks (registered below) can point at it. The
	// back-compat ProjectWikiStore view is created alongside; legacy
	// IPC/router/renderer keep using it.
	const wikiStoreGlobal = new WikiStore(sessionDB);

	// Initialize hook system + durable execution
	const { registerDurableHooks } = await import("./durable-hooks.js");
	const { registerToolExecutionHooks } = await import("./tool-execution-hooks.js");
	registerDurableHooks(sessionDB);
	registerToolExecutionHooks(sessionDB);

	// v0.8 (M5): extractor cursor + telemetry stores live on SessionDB (lazy
	// accessors). The extraction hook deps are wired here so PostTurnComplete
	// can build extractor A/B with the global WikiStore as writer target.
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
	const { registerAllRuntimeHooks } = await import("../runtime/hooks/index.js");
	registerAllRuntimeHooks(sessionDB, extractionDeps);

	const registry = new ToolRegistry(sessionDB.getKVStore());
	registerRuntimeTools(registry);
	const mcp = new MCPManager(registry);
	const agentStore = new AgentStore(sessionDB);
	const providerStore = new ProviderStore(sessionDB);
	const templateStore = new TemplateStore(sessionDB);
	const mcpStore = new McpStore(sessionDB);
	const kbStore = new KbStore(sessionDB);
	const kbDb = new KbDB();

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

	// Register workflow context hook (T2 context injection via PreLLMCall)
	registerWorkflowContextHook({ projectStore, requirementStore, wikiStore, taskStepStore });

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

	const agentService = createAgentService(workspaceConfig.workspaceDir, sessionDB, undefined, registry, mcp);
	agentService.setAgentStore(agentStore);

	// v0.8 (P3): ManagementService (renamed from ZeroAdminService) —
	// capability backend for the Project/Agent/Cron action tools.
	// v0.8 (P5 §8.4 / §8.5): also carries the Project container-view +
	// resource-usage aggregation backends. Late-bound deps (archivistService)
	// are wired below after their constructor runs.
	const { ManagementService } = await import("./management-service.js");
	const management = new ManagementService({
		agentStore, projectStore, cronStore,
		requirementStore, sessionDB, wikiStore: wikiStoreGlobal,
	});
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
	const { seedFreshDbDefaults } = await import("./fresh-db-seed.js");
	seedFreshDbDefaults({ agentStore, wikiStore: wikiStoreGlobal, management });

	agentService.subscribe((event: any) => {
		// Forward all agent events to WebSocket clients
		const msg = JSON.stringify(event);
		for (const ws of wss.clients) {
			if (ws.readyState === ws.OPEN) {
				ws.send(msg);
			}
		}
	});


	// Load providers from DB for backend-spawn mode.
	// In IPC mode, main process calls setProviders later via Phase 5 — notifyReady deduplicates.
	{
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
	}

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
	const archivistService = new ArchivistService({
		wikiStore: wikiStoreGlobal,
		cursorStore: wikiScanCursorStore,
		git: archivistGit,
		projectStore,
		requirementStore,
	});
	// v0.8 (P5 §8.3): ManagementService.createProject kicks the archivist
	// background scan; wire it now that archivistService exists.
	management.setArchivistService(archivistService);

	// ─── LeadService + Requirement Hooks (M3) ────────────────────────
	const { LeadService } = await import("./lead-service.js");
	const { registerRequirementHooks } = await import("./requirement-hooks.js");
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
	const notificationService = new NotificationService({ wss, requirementStore });
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
	});

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

	registerRequirementHooks({
		requirementStore,
		taskStepStore,
		leadService,
	});

	// v0.8 P7 (§1.5): no projectNotificationRouter — pull model.
	// Run workflow state recovery (cron schedules + plan/build/verify reqs).
	recoverWorkflowState({ projectStore, requirementStore, taskStepStore, cronManager, agentService });

	// ─── Mount API routers ───────────────────────────────────────

	app.use("/api/config", createConfigRouter({
		sessionDB,
		registry,
		buildDefaultPrompt,
	}));

	app.use("/api/agents", createAgentRouter({ agentStore, agentService, sessionDB }));
	app.use("/api/providers", createProviderRouter(providerStore));
	app.use("/api/templates", createTemplateRouter(templateStore, sessionDB));
	app.use("/api/mcp", createMcpRouter(mcpStore, mcp));
	app.use("/api/kb", createKbRouter(kbStore, kbDb, providerStore));
	app.use("/api/skills", createSkillRouter());
	app.use("/api/memory-nodes", createMemoryNodeRouter(sessionDB.getMemoryNodeStore()));

	// New routers
	app.use("/api/chat", createChatRouter({ agentService, agentStore, providerStore, workspaceConfig }));
	app.use("/api/sessions", createSessionRouter({ agentService, agentStore }));
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
	app.use("/api/wiki", createWikiBrowserRouter({ wikiStore: wikiStoreGlobal }));
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
			const result = await archivistService.scanProject(req.params.projectId);
			res.json(result);
		} catch (err) { res.status(500).json({ error: (err as Error).message }); }
	});
	archivistRouter.post("/:projectId/rescan-full", async (req, res) => {
		try {
			const result = await archivistService.rescanProjectFull(req.params.projectId);
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

	// v0.8 (M0/P6): role templates — list + one-click instantiate
	// (P6 renamed from preset-router / /api/presets; RFC §7.2)
	const { createRoleTemplateRouter } = await import("./role-template-router.js");
	app.use("/api/role-templates", createRoleTemplateRouter(management));

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
