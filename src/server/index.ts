import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { join, dirname, extname, resolve } from "path";
import { fileURLToPath } from "url";
import { readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { IGNORED_DIRS, TEXT_EXTS, buildTree } from "../shared/file-utils.js";
import { AgentStore } from "./agent-store.js";
import { AgentToolStore } from "./agent-tool-store.js";
import { ProviderStore } from "./provider-store.js";
import { TemplateStore } from "./template-store.js";
import { McpStore } from "./mcp-store.js";
import { KbStore } from "./kb-store.js";
import { KbDB } from "./kb-db.js";
import { createAgentService } from "./agent-service.js";
import { SessionDB } from "./session-db.js";
import { runMigrations } from "./db-migration.js";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "./workspace-config.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3210", 10);
const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export async function startServer() {
	const app = express();
	app.use(express.json());

	const server = createServer(app);
	const wss = new WebSocketServer({ server, path: "/ws" });

	// ─── Initialize stores and services ──────────────────────────

	const sessionDB = new SessionDB();
	runMigrations(sessionDB);

	const registry = new ToolRegistry(sessionDB.getKVStore());
	const mcp = new MCPManager(registry);
	const agentStore = new AgentStore(sessionDB);
	const agentToolStore = new AgentToolStore(sessionDB);
	const providerStore = new ProviderStore(sessionDB);
	const templateStore = new TemplateStore(sessionDB);
	const mcpStore = new McpStore(sessionDB);
	const kbStore = new KbStore(sessionDB);
	const kbDb = new KbDB();

	let workspaceConfig = loadWorkspaceConfig(sessionDB);

	if (!existsSync(workspaceConfig.workspaceDir)) {
		mkdirSync(workspaceConfig.workspaceDir, { recursive: true });
	}

	console.log("[server] Workspace:", workspaceConfig.workspaceDir);

	const agentService = createAgentService(workspaceConfig.workspaceDir, sessionDB, undefined, registry, mcp);
	agentService.setAgentStore(agentStore);
	agentService.setAgentToolStore(agentToolStore);

	agentService.subscribe(() => {
		// Events forwarded to WebSocket clients below
	});

	// ─── Mount API routers ───────────────────────────────────────

	app.use("/api/config", createConfigRouter({
		sessionDB,
		registry,
		buildDefaultPrompt,
	}));

	app.use("/api/agents", createAgentRouter({ agentStore, agentService, sessionDB }));
	app.use("/api/agent-tools", createAgentToolRouter(agentToolStore));
	app.use("/api/providers", createProviderRouter(providerStore));
	app.use("/api/templates", createTemplateRouter(templateStore));
	app.use("/api/mcp", createMcpRouter(mcpStore, mcp));
	app.use("/api/kb", createKbRouter(kbStore, kbDb, providerStore));

	// Models — aggregated from all providers
	app.get("/api/models", (_req, res) => {
		try {
			const models: {
				providerId: string;
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

	// ─── File Tree API ──────────────────────────────────────────

	app.get("/api/files", (req, res) => {
		const dir = expandHome((req.query.root as string) || workspaceConfig.workspaceDir);
		try {
			const stat = statSync(dir);
			if (!stat.isDirectory()) return res.status(400).json({ error: "not a directory" });
		} catch {
			return res.status(404).json({ error: "directory not found" });
		}
		res.json(buildTree(dir, ""));
	});

	app.get("/api/files/content", (req, res) => {
		const filePath = req.query.path as string;
		if (!filePath) return res.status(400).json({ error: "path required" });
		const ext = extname(filePath);
		if (!TEXT_EXTS.has(ext) && ext !== "") {
			return res.json({ content: "(binary file)" });
		}
		const root = expandHome((req.query.root as string) || workspaceConfig.workspaceDir);
		const full = resolve(root, filePath);
		if (!full.startsWith(resolve(root))) {
			return res.status(403).json({ error: "access denied" });
		}
		try {
			const stat = statSync(full);
			if (stat.size > 500_000) {
				return res.json({ content: "(file too large, > 500KB)" });
			}
			res.json({ content: readFileSync(full, "utf-8") });
		} catch {
			res.status(404).json({ error: "file not found" });
		}
	});

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

		const unsubscribe = agentService.subscribe((event) => {
			if (ws.readyState === ws.OPEN) {
				ws.send(JSON.stringify(event));
			}
		});

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

		ws.on("close", () => {
			unsubscribe();
		});
	});

	// ─── Static files (renderer) ──────────────────────────────

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

	// ─── Start ────────────────────────────────────────────────

	server.listen(PORT, () => {
		console.log(`Zero-Core server running at http://localhost:${PORT}`);
		console.log(`Workspace: ${workspaceConfig.workspaceDir}`);
	});
}
