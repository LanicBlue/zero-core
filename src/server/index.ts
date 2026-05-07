import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { join, dirname, extname, resolve } from "path";
import { fileURLToPath } from "url";
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { PersonaStore } from "./persona-store.js";
import { createAgentService } from "./agent-service.js";
import { createMessageStore } from "./message-store.js";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "./workspace-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3210", 10);

export async function startServer() {
	const app = express();
	app.use(express.json());

	const server = createServer(app);
	const wss = new WebSocketServer({ server, path: "/ws" });
	const personaStore = new PersonaStore();
	const messageStore = createMessageStore();
	let workspaceConfig = loadWorkspaceConfig();

	// Ensure workspace dir exists
	if (!existsSync(workspaceConfig.workspaceDir)) {
		mkdirSync(workspaceConfig.workspaceDir, { recursive: true });
	}

	console.log("[server] Workspace:", workspaceConfig.workspaceDir);

	// ─── Server-level Agent Service (survives UI disconnect) ──────
	// One instance, shared across all WS connections.

	const agentService = createAgentService(workspaceConfig.workspaceDir);

	// Message persistence subscriber — always active, even without UI
	let persistencePersonaId = "__default__";
	let persistenceToolCalls: { name: string; status: "running" | "done" | "error" }[] = [];
	let persistenceLastText = "";

	agentService.subscribe((event) => {
		if (event.type === "message_end") {
			persistenceLastText = event.text as string;
		}
		if (event.type === "tool_start") {
			persistenceToolCalls.push({ name: event.toolName as string, status: "running" });
		}
		if (event.type === "tool_end") {
			const tc = persistenceToolCalls.find(t => t.name === event.toolName && t.status === "running");
			if (tc) tc.status = event.isError ? "error" : "done";
		}
		if (event.type === "agent_end") {
			const toolCalls = persistenceToolCalls.length > 0 ? persistenceToolCalls : undefined;
			messageStore.addAssistantMessage(persistencePersonaId, persistenceLastText, toolCalls);
			persistenceToolCalls = [];
			persistenceLastText = "";
		}
	});

	// ─── Config API ─────────────────────────────────────────────

	app.get("/api/config", (_req, res) => {
		res.json(workspaceConfig);
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

	// ─── Persona REST API ──────────────────────────────────────

	app.get("/api/personas", (_req, res) => {
		res.json(personaStore.list());
	});

	app.get("/api/personas/:id", (req, res) => {
		const p = personaStore.get(req.params.id);
		if (!p) return res.status(404).json({ error: "Not found" });
		res.json(p);
	});

	app.post("/api/personas", (req, res) => {
		const p = personaStore.create(req.body);
		res.status(201).json(p);
	});

	app.put("/api/personas/:id", (req, res) => {
		try {
			const p = personaStore.update(req.params.id, req.body);
			res.json(p);
		} catch (e) {
			res.status(404).json({ error: (e as Error).message });
		}
	});

	app.delete("/api/personas/:id", (req, res) => {
		personaStore.delete(req.params.id);
		res.json({ success: true });
	});

	// ─── Message History API ──────────────────────────────────

	app.get("/api/messages/:personaId", (req, res) => {
		res.json(messageStore.list(req.params.personaId));
	});

	app.delete("/api/messages/:personaId", (req, res) => {
		messageStore.clear(req.params.personaId);
		res.json({ success: true });
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

	app.get("/api/files", (_req, res) => {
		const dir = workspaceConfig.workspaceDir;
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
		const root = workspaceConfig.workspaceDir;
		const full = resolve(root, filePath);
		if (!full.startsWith(root)) {
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
					const persona = msg.personaId
						? personaStore.get(msg.personaId)
						: undefined;

					persistencePersonaId = msg.personaId ?? "__default__";
					persistenceToolCalls = [];
					persistenceLastText = "";

					messageStore.addUserMessage(persistencePersonaId, msg.text);

					agentService.setWorkspaceDir(workspaceConfig.workspaceDir);
					await agentService.sendPrompt(msg.text, persona);
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

	const rendererDir = join(__dirname, "../renderer");
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
