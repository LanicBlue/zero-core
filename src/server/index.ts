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
import { AgentToolStore } from "./agent-tool-store.js";
import { ProviderStore } from "./provider-store.js";
import { TemplateStore } from "./template-store.js";
import { McpStore } from "./mcp-store.js";
import { KbStore } from "./kb-store.js";
import { KbDB } from "./kb-db.js";
import { createAgentService, registerAgentToolEntries } from "./agent-service.js";
import { SessionDB } from "./session-db.js";
import { runMigrations } from "./db-migration.js";
import { loadWorkspaceConfig } from "./workspace-config.js";
import { buildDefaultPrompt } from "../core/default-prompt.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { MCPManager } from "./mcp-manager.js";
import { createAgentRouter } from "./agent-router.js";
import { createAgentToolRouter } from "./agent-tool-router.js";
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
import { TaskStepStore } from "./task-step-store.js";
import { createProjectRouter } from "./project-router.js";
import { createRequirementRouter } from "./requirement-router.js";
import { createWikiRouter } from "./project-wiki-router.js";
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

	// Initialize hook system + durable execution
	const { registerDurableHooks } = await import("./durable-hooks.js");
	const { registerToolExecutionHooks } = await import("./tool-execution-hooks.js");
	registerDurableHooks(sessionDB);
	registerToolExecutionHooks(sessionDB);
	const { registerAllRuntimeHooks } = await import("../runtime/hooks/index.js");
	registerAllRuntimeHooks(sessionDB);

	const registry = new ToolRegistry(sessionDB.getKVStore());
	registerRuntimeTools(registry);
	const mcp = new MCPManager(registry);
	const agentStore = new AgentStore(sessionDB);
	const agentToolStore = new AgentToolStore(sessionDB);
	agentToolStore.cleanupOrphans();
	registerAgentToolEntries(agentToolStore, registry);
	const providerStore = new ProviderStore(sessionDB);
	const templateStore = new TemplateStore(sessionDB);
	const mcpStore = new McpStore(sessionDB);
	const kbStore = new KbStore(sessionDB);
	const kbDb = new KbDB();

	// Multi-Agent Workflow stores
	const projectStore = new ProjectStore(sessionDB);
	const requirementStore = new RequirementStore(sessionDB);
	const wikiStore = new ProjectWikiStore(sessionDB);
	const taskStepStore = new TaskStepStore(sessionDB);

	// Register workflow context hook (T2 context injection via PreLLMCall)
	registerWorkflowContextHook({ projectStore, requirementStore, wikiStore, taskStepStore });

	let workspaceConfig = loadWorkspaceConfig(sessionDB);

	// Test-mode seed — populate mock provider + agent when ZERO_CORE_TEST_FIXTURE is set
	if (process.env.ZERO_CORE_TEST_FIXTURE) {
		const { seedTestEnvironment } = await import("../core/test-seed.js");
		seedTestEnvironment(sessionDB, agentStore, providerStore);
		workspaceConfig = loadWorkspaceConfig(sessionDB);
	}

	if (!existsSync(workspaceConfig.workspaceDir)) {
		mkdirSync(workspaceConfig.workspaceDir, { recursive: true });
	}

	console.log("[server] Workspace:", workspaceConfig.workspaceDir);

	const agentService = createAgentService(workspaceConfig.workspaceDir, sessionDB, undefined, registry, mcp);
	agentService.setAgentStore(agentStore);
	agentService.setAgentToolStore(agentToolStore);

	// v0.8 (M0): ZeroAdminService — zero global-management role's tool backend.
	const { ZeroAdminService } = await import("./zero-admin-service.js");
	const zeroAdmin = new ZeroAdminService({ agentStore, projectStore, agentToolStore });
	agentService.setZeroAdmin(zeroAdmin);

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

	// ─── LeadService + Requirement Hooks (M3) ────────────────────────
	const { LeadService } = await import("./lead-service.js");
	const { registerRequirementHooks } = await import("./requirement-hooks.js");
	const leadService = new LeadService({
		agentService,
		agentStore,
		requirementStore,
		taskStepStore,
		wikiStore,
		projectStore,
		templateStore,
	});

	// ─── M5: Git, Notifications, Cron ────────────────────────────
	const { GitIntegration } = await import("./git-integration.js");
	const { NotificationService } = await import("./notification-service.js");
	const { CronAnalysisManager } = await import("./cron-analysis.js");
	const { recoverWorkflowState } = await import("./recovery.js");

	const gitIntegration = new GitIntegration();
	const notificationService = new NotificationService({ wss, requirementStore });
	const cronManager = new CronAnalysisManager({ analystService, projectStore });

	analystService.setGitIntegration(gitIntegration);

	registerRequirementHooks({
		requirementStore,
		taskStepStore,
		leadService,
		analystService,
		notificationService,
	});

	// M5: Run workflow state recovery
	recoverWorkflowState({ projectStore, requirementStore, taskStepStore, cronManager, agentService });

	// ─── Mount API routers ───────────────────────────────────────

	app.use("/api/config", createConfigRouter({
		sessionDB,
		registry,
		buildDefaultPrompt,
	}));

	app.use("/api/agents", createAgentRouter({ agentStore, agentToolStore, agentService, sessionDB }));
	app.use("/api/agent-tools", createAgentToolRouter(agentToolStore));
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

	// Projects — with M5 interval/pause/resume + cron wiring
	const projectRouter = createProjectRouter({ projectStore, requirementStore, wikiStore, taskStepStore, analystService });
	// M5: Cron registration on project lifecycle
	projectRouter.post("/", (req, res, next) => {
		// Intercept original POST response to register cron after creation
		const origJson = res.json.bind(res);
		res.json = (body: any) => {
			if (res.statusCode === 201 && body?.id) {
				// v0.8 (M0): analysisInterval removed from ProjectRecord (cron
				// becomes first-class in M1). Default to daily until then.
				cronManager.scheduleProject(body.id, "daily");
			}
			return origJson(body);
		};
		next();
	});
	projectRouter.put("/:id/interval", (req, res) => {
		const { interval } = req.body;
		// v0.8 (M0): analysisInterval no longer on ProjectRecord; just reschedule
		cronManager.rescheduleProject(req.params.id, interval);
		res.json({ ok: true });
	});
	projectRouter.post("/:id/pause", (req, res) => {
		// v0.8 (M0): status removed from ProjectRecord; just unschedule
		cronManager.unscheduleProject(req.params.id);
		res.json({ ok: true });
	});
	projectRouter.post("/:id/resume", (req, res) => {
		// v0.8 (M0): status / analysisInterval removed; default to daily
		cronManager.scheduleProject(req.params.id, "daily");
		res.json({ ok: true });
	});
	app.use("/api/projects", projectRouter);

	// Requirements — with M5 verify/archive/report + notifications
	const requirementRouter = createRequirementRouter({ requirementStore, taskStepStore, notificationService });
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

	app.use("/api/project-wiki", createWikiRouter({ wikiStore }));

	// v0.8 (M0): role presets — list + one-click instantiate
	const { createPresetRouter } = await import("./preset-router.js");
	app.use("/api/presets", createPresetRouter(zeroAdmin));

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
