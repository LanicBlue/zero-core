import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { join, dirname, extname, resolve } from "path";
import { fileURLToPath } from "url";
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { AgentStore } from "./agent-store.js";
import { ProviderStore } from "./provider-store.js";
import { createAgentService } from "./agent-service.js";
import { SessionDB } from "./session-db.js";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "./workspace-config.js";
import { buildDefaultPrompt } from "../core/default-prompt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3210", 10);
const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export async function startServer() {
	const app = express();
	app.use(express.json());

	const server = createServer(app);
	const wss = new WebSocketServer({ server, path: "/ws" });
	const sessionDB = new SessionDB();
	const db = sessionDB.getDb();
	const agentStore = new AgentStore(db);
	const providerStore = new ProviderStore(db);
	let workspaceConfig = loadWorkspaceConfig();

	// Ensure workspace dir exists
	if (!existsSync(workspaceConfig.workspaceDir)) {
		mkdirSync(workspaceConfig.workspaceDir, { recursive: true });
	}

	console.log("[server] Workspace:", workspaceConfig.workspaceDir);

	// ─── Server-level Agent Service (survives UI disconnect) ──────

	const agentService = createAgentService(workspaceConfig.workspaceDir, sessionDB);

	agentService.subscribe((event) => {
		// Events are forwarded to WebSocket clients; persistence handled internally by agent-loop
	});

	// ─── Config API ─────────────────────────────────────────────

	app.get("/api/config", (_req, res) => {
		res.json({ ...workspaceConfig, defaultPrompt: buildDefaultPrompt("Agent") });
	});

	app.put("/api/config", (req, res) => {
		const { workspaceDir } = req.body;
		if (typeof workspaceDir === "string") {
			const abs = resolve(workspaceDir);
			if (!existsSync(abs)) {
				try { mkdirSync(abs, { recursive: true }); } catch {
					return res.status(400).json({ error: "Cannot create directory" });
				}
			}
			workspaceConfig = saveWorkspaceConfig({ workspaceDir: abs });
			agentService.setWorkspaceDir(abs);
		}
		res.json(workspaceConfig);
	});

	// ─── Agent REST API ──────────────────────────────────────────

	app.get("/api/agents", (_req, res) => {
		res.json(agentStore.list());
	});

	app.get("/api/agents/:id", (req, res) => {
		const a = agentStore.get(req.params.id);
		if (!a) return res.status(404).json({ error: "Not found" });
		res.json(a);
	});

	app.post("/api/agents", (req, res) => {
		const a = agentStore.create(req.body);
		res.status(201).json(a);
	});

	app.put("/api/agents/:id", (req, res) => {
		try {
			const a = agentStore.update(req.params.id, req.body);
			res.json(a);
		} catch (e) {
			res.status(404).json({ error: (e as Error).message });
		}
	});

	app.delete("/api/agents/:id", (req, res) => {
		agentStore.delete(req.params.id);
		res.json({ success: true });
	});

	// ─── Models API ──────────────────────────────────────────────

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


	app.get("/api/tools", (_req, res) => {
		res.json([
			{ name: "bash", description: "在环境中执行 Shell 命令" },
			{ name: "read", description: "读取文件内容" },
			{ name: "edit", description: "精确编辑文件" },
			{ name: "write", description: "创建或覆盖文件" },
			{ name: "grep", description: "搜索文件内容" },
			{ name: "find", description: "按模式查找文件" },
			{ name: "ls", description: "列出目录内容" },
		]);
	});


	app.get("/api/messages/:agentId", (req, res) => {
		const session = sessionDB.getMainSession(req.params.agentId);
		if (!session) return res.json([]);
		const msgs = sessionDB.getMessages(session.id);
		const result: { id: string; role: "user" | "assistant"; text: string; timestamp: number }[] = [];
		for (const msg of msgs) {
			const role = msg.role as string;
			if (role !== "user" && role !== "assistant") continue;
			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (typeof part === "object" && "text" in part && typeof part.text === "string") {
						text += part.text;
					}
				}
			}
			if (text) {
				result.push({ id: `s${result.length}`, role: role as "user" | "assistant", text, timestamp: Date.now() });
			}
		}
		res.json(result);
	});

	app.delete("/api/messages/:agentId", (req, res) => {
		const session = sessionDB.createSession(req.params.agentId);
		sessionDB.setMainSession(req.params.agentId, session.id);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json({ success: true });
	});

	// ─── Session API ────────────────────────────────────────────

	app.get("/api/sessions/:agentId", (req, res) => {
		res.json(sessionDB.listSessions(req.params.agentId));
	});

	app.post("/api/sessions/:agentId/new", (req, res) => {
		const session = sessionDB.createSession(req.params.agentId);
		sessionDB.setMainSession(req.params.agentId, session.id);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json(session);
	});

	app.put("/api/sessions/:agentId/switch/:sessionId", (req, res) => {
		sessionDB.setMainSession(req.params.agentId, req.params.sessionId);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, req.params.sessionId, agent);
		res.json({ success: true, sessionId: req.params.sessionId });
	});

	app.get("/api/sessions/:agentId/current", (req, res) => {
		res.json(sessionDB.getMainSession(req.params.agentId) ?? null);
	});

	// ─── File Tree API ──────────────────────────────────────────

	const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache"]);
	const TEXT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html", ".yaml", ".yml", ".toml", ".py", ".rs", ".go", ".java", ".txt", ".sh", ".bash", ".env", ".gitignore", ".sql"]);

	function buildTree(dir: string, basePath: string): unknown[] {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			return entries
				.filter((e) => !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
				.sort((a, b) => {
					if (a.isDirectory() && !b.isDirectory()) return -1;
					if (!a.isDirectory() && b.isDirectory()) return 1;
					return a.name.localeCompare(b.name);
				})
				.map((e) => {
					const fullPath = join(dir, e.name);
					const relPath = join(basePath, e.name);
					if (e.isDirectory()) {
						return {
							name: e.name,
							path: relPath,
							type: "dir",
							children: buildTree(fullPath, relPath),
						};
					}
					return { name: e.name, path: relPath, type: "file" };
				});
		} catch {
			return [];
		}
	}

	app.get("/api/files", (req, res) => {
		const dir = expandHome((req.query.root as string) || workspaceConfig.workspaceDir);
		try {
			const stat = statSync(dir);
			if (!stat.isDirectory()) return res.status(400).json({ error: "not a directory" });
		} catch {
			return res.status(404).json({ error: "directory not found" });
		}
		const tree = buildTree(dir, "");
		res.json(tree);
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
			const content = readFileSync(full, "utf-8");
			res.json({ content });
		} catch {
			res.status(404).json({ error: "file not found" });
		}
	});

	// ─── WebSocket: UI connection (just subscribes, doesn't own agent) ──

	wss.on("connection", (ws) => {
		// Send current agent state on connect
		const state = agentService.getState();
		if (state.isBusy) {
			ws.send(JSON.stringify({
				type: "reconnect",
				isBusy: true,
				streamingText: state.streamingText,
				toolCalls: state.toolCalls,
			}));
		}

		// Subscribe this WS to agent events
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


					// Use agent-specific workspace or fall back to global
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
			// Only unsubscribe — agent keeps running
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
