import { ipcMain, type BrowserWindow } from "electron";
import { resolve, extname, join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { log } from "../core/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const toFileURL = (p: string) => { const { pathToFileURL: p2u } = require("url"); return p2u(p).href; };

const ts = () => new Date().toISOString().substring(11, 23);

const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

// ─── ESM module cache ────────────────────────────────────────

let agentStore: InstanceType<typeof import("../server/agent-store").AgentStore>;
let agentService: ReturnType<typeof import("../server/agent-service").createAgentService> | undefined;
let createAgentService: typeof import("../server/agent-service").createAgentService;
let providerStore: InstanceType<typeof import("../server/provider-store").ProviderStore>;
let templateStore: InstanceType<typeof import("../server/template-store").TemplateStore>;
let mcpStore: InstanceType<typeof import("../server/mcp-store").McpStore>;
let mcpManager: typeof import("../server/mcp-manager").mcpManager;
let kbStore: any;
let kbDb: any;
let workspaceConfig: { workspaceDir: string; defaultModel?: string; defaultProvider?: string };
let saveWorkspaceConfig: (config: { workspaceDir?: string; defaultModel?: string; defaultProvider?: string }) => { workspaceDir: string; defaultModel?: string; defaultProvider?: string };
let buildDefaultPrompt: typeof import("../core/default-prompt").buildDefaultPrompt;

let mainWindow: BrowserWindow;

// ─── File tree helpers ───────────────────────────────────────

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
					return { name: e.name, path: relPath, type: "dir", children: buildTree(fullPath, relPath) };
				}
				return { name: e.name, path: relPath, type: "file" };
			});
	} catch {
		return [];
	}
}

// ─── Dynamic ESM loader (core modules) ──────

async function loadCoreModules(): Promise<void> {
	const t0 = Date.now();
	const distServer = join(__dirname, "../../dist/server");
	const distCore = join(__dirname, "../../dist/core");

	log.ipc("Loading core modules...");
	const { AgentStore } = await import(toFileURL(join(distServer, "agent-store.js")));
	log.ipc("agent-store loaded", `+${Date.now() - t0}ms`);
	const { ProviderStore } = await import(toFileURL(join(distServer, "provider-store.js")));
	log.ipc("provider-store loaded", `+${Date.now() - t0}ms`);
	const agentSvcMod = await import(toFileURL(join(distServer, "agent-service.js")));
	createAgentService = agentSvcMod.createAgentService;
	const wsMod = await import(toFileURL(join(distServer, "workspace-config.js")));
	const mod = await import(toFileURL(join(distCore, "default-prompt.js")));
	log.ipc("core imports done", `+${Date.now() - t0}ms`);

	const tmplMod = await import(toFileURL(join(distServer, "template-store.js")));
	const mcpMod = await import(toFileURL(join(distServer, "mcp-store.js")));
	const mcpMgrMod = await import(toFileURL(join(distServer, "mcp-manager.js")));

	agentStore = new AgentStore();
	providerStore = new ProviderStore();
	templateStore = new tmplMod.TemplateStore();
	mcpStore = new mcpMod.McpStore();
	mcpManager = mcpMgrMod.mcpManager;
	const { KbStore } = await import(toFileURL(join(distServer, "kb-store.js")));
	const { KbDB } = await import(toFileURL(join(distServer, "kb-db.js")));
	kbStore = new KbStore();
	kbDb = new KbDB();

	mcpManager.reconnectEnabled(mcpStore.list()).catch(() => {});
	buildDefaultPrompt = mod.buildDefaultPrompt;
	saveWorkspaceConfig = wsMod.saveWorkspaceConfig;

	workspaceConfig = wsMod.loadWorkspaceConfig();

	if (!existsSync(workspaceConfig.workspaceDir)) {
		mkdirSync(workspaceConfig.workspaceDir, { recursive: true });
	}

	// Eagerly init agent-service so session/message queries work before first chat
	agentService = createAgentService(workspaceConfig.workspaceDir);
	agentService.subscribe((event) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("agent:event", event);
		}
	});

	log.ipc("Core modules ready, workspace:", workspaceConfig.workspaceDir);
}

// ─── Ensure agent-service is available ──

async function ensureAgentService(): Promise<NonNullable<typeof agentService>> {
	if (agentService) return agentService;
	// Fallback: should not happen since we eagerly init in loadCoreModules
	agentService = createAgentService(workspaceConfig.workspaceDir);
	agentService.subscribe((event) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("agent:event", event);
		}
	});
	return agentService;
}

// ─── IPC handler registration ────────────────────────────────

let modulesReady = false;

export function registerIpc(win: BrowserWindow): void {
	mainWindow = win;

	ipcMain.handle("app:ready", () => modulesReady);

	ipcMain.handle("config:get", () => {
		if (!modulesReady) return { workspaceDir: "", defaultPrompt: "", loading: true };
		return { ...workspaceConfig, defaultPrompt: buildDefaultPrompt("Agent") };
	});

	ipcMain.handle("config:update", (_e, data: { workspaceDir?: string; defaultModel?: string; defaultProvider?: string }) => {
		if (!modulesReady) return { error: "loading" };
		if (typeof data.workspaceDir === "string") {
			const abs = resolve(data.workspaceDir);
			if (!existsSync(abs)) {
				try { mkdirSync(abs, { recursive: true }); } catch {
					return { error: "Cannot create directory" };
				}
			}
			workspaceConfig = saveWorkspaceConfig({ workspaceDir: abs });
		}
		if (data.defaultModel !== undefined || data.defaultProvider !== undefined) {
			workspaceConfig = saveWorkspaceConfig({ defaultModel: data.defaultModel, defaultProvider: data.defaultProvider });
		}
		return workspaceConfig;
	});

	ipcMain.handle("agents:list", () => modulesReady ? agentStore.list() : []);
	ipcMain.handle("agents:get", (_e, id: string) => modulesReady ? agentStore.get(id) : undefined);
	ipcMain.handle("agents:create", (_e, input: unknown) => modulesReady ? agentStore.create(input as any) : { error: "loading" });
	ipcMain.handle("agents:update", (_e, id: string, input: unknown) => {
		if (!modulesReady) return { error: "loading" };
		try { return agentStore.update(id, input as any); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("agents:delete", (_e, id: string) => {
		if (modulesReady) agentStore.delete(id);
		return { success: true };
	});

	// ─── Providers CRUD ───────────────────────────────
	ipcMain.handle("providers:list", () => modulesReady ? providerStore.list() : []);
	ipcMain.handle("providers:get", (_e, id: string) => modulesReady ? providerStore.get(id) : undefined);
	ipcMain.handle("providers:create", (_e, input: unknown) => {
		if (!modulesReady) return { error: "loading" };
		return providerStore.create(input as any);
	});
	ipcMain.handle("providers:update", (_e, id: string, input: unknown) => {
		if (!modulesReady) return { error: "loading" };
		try { return providerStore.update(id, input as any); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("providers:delete", (_e, id: string) => {
		if (modulesReady) providerStore.delete(id);
		return { success: true };
	});
	ipcMain.handle("providers:add-model", (_e, providerId: string, model: unknown) => {
		if (!modulesReady) return { error: "loading" };
		try { return providerStore.addModel(providerId, model as any); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("providers:remove-model", (_e, providerId: string, modelId: string) => {
		if (!modulesReady) return { error: "loading" };
		try { return providerStore.removeModel(providerId, modelId); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("providers:fetch-models", async (_e, providerId: string) => {
		if (!modulesReady) return [];
		const provider = providerStore.get(providerId);
		if (!provider || !provider.apiKey) return [];
		try {
			const baseUrl = provider.baseUrl.replace(/\/+$/, "");
			const url = provider.type === "anthropic"
				? `${baseUrl}/v1/models`
				: `${baseUrl}/models`;
			const headers: Record<string, string> = {};
			if (provider.type === "anthropic") {
				headers["x-api-key"] = provider.apiKey;
				headers["anthropic-version"] = "2023-06-01";
			} else {
				headers["Authorization"] = `Bearer ${provider.apiKey}`;
			}
			const resp = await fetch(url, { headers });
			if (!resp.ok) return [];
			const json = await resp.json() as any;
			const rawModels = json.data || json.models || [];
			return rawModels.map((m: any) => ({
				id: m.id || m.name,
				name: m.name || m.id || m.display_name,
				group: m.owned_by || undefined,
			}));
		} catch {
			return [];
		}
	});

	ipcMain.handle("models:list", () => {
		if (!modulesReady) return [];
		const providers = providerStore.list();
		const models: { provider: string; id: string; name: string; contextWindow?: number; maxTokens?: number }[] = [];
		for (const p of providers) {
			if (!p.enabled) continue;
			for (const m of p.models) {
				models.push({
					provider: p.name,
					id: m.id,
					name: m.name || m.id,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
				});
			}
		}
		return models;
	});

	ipcMain.handle("tools:list", () => {
		const runtimeTools = [
			{ name: "bash", description: "在环境中执行 Shell 命令", group: "runtime" },
			{ name: "read", description: "读取文件内容", group: "runtime" },
			{ name: "edit", description: "精确编辑文件", group: "runtime" },
			{ name: "write", description: "创建或覆盖文件", group: "runtime" },
			{ name: "grep", description: "搜索文件内容", group: "runtime" },
			{ name: "find", description: "按模式查找文件", group: "runtime" },
			{ name: "ls", description: "列出目录内容", group: "runtime" },
		];
		const builtInTools = [
			{ name: "fetch_html", description: "获取网页并返回 HTML 内容", group: "fetch" },
			{ name: "fetch_markdown", description: "获取网页并返回 Markdown 内容", group: "fetch" },
			{ name: "fetch_text", description: "获取网页并返回纯文本内容", group: "fetch" },
			{ name: "fetch_json", description: "获取 JSON 数据", group: "fetch" },
			{ name: "memory_create_entities", description: "在知识图谱中创建实体", group: "memory" },
			{ name: "memory_create_relations", description: "在实体间创建关系", group: "memory" },
			{ name: "memory_add_observations", description: "为实体添加观察", group: "memory" },
			{ name: "memory_delete_entities", description: "删除实体及其关系", group: "memory" },
			{ name: "memory_delete_relations", description: "删除关系", group: "memory" },
			{ name: "memory_read_graph", description: "读取整个知识图谱", group: "memory" },
			{ name: "memory_search_nodes", description: "搜索知识图谱中的实体和关系", group: "memory" },
			{ name: "sequentialthinking", description: "多步骤顺序推理思考", group: "thinking" },
			{ name: "fs_read", description: "读取文件内容（带行号）", group: "filesystem" },
			{ name: "fs_write", description: "创建或覆盖文件", group: "filesystem" },
			{ name: "fs_edit", description: "精确字符串替换编辑文件", group: "filesystem" },
			{ name: "fs_delete", description: "删除文件或目录", group: "filesystem" },
			{ name: "fs_list", description: "列出目录内容（树形结构）", group: "filesystem" },
			{ name: "fs_glob", description: "按 glob 模式匹配文件", group: "filesystem" },
			{ name: "fs_grep", description: "按正则搜索文件内容", group: "filesystem" },
			{ name: "assistant_info", description: "获取应用运行时信息", group: "assistant" },
			{ name: "assistant_logs", description: "读取最近日志", group: "assistant" },
			{ name: "assistant_config", description: "读取应用配置（已脱敏）", group: "assistant" },
			{ name: "assistant_read_source", description: "读取应用源码文件", group: "assistant" },
			{ name: "assistant_list_providers", description: "列出已配置的 AI 提供者", group: "assistant" },
			{ name: "assistant_list_files", description: "列出 zero-core 数据目录中的文件", group: "assistant" },
		];
		return [...runtimeTools, ...builtInTools];
	});

	// ─── Messages (backed by SessionDB) ──────────────
	// Converts full ModelMessage[] to simplified format with tool call records for renderer
		ipcMain.handle("messages:list", async (_e, agentId: string) => {
			if (!modulesReady || !agentService) return [];
			const db = agentService.getDB();
			const session = db.getMainSession(agentId);
			if (!session) return [];
			const turns = db.getTurns(session.id);
			if (turns.length === 0) return [];

			return turns.map((turn) => {
				if (turn.role === "user") {
					return { id: "t" + turn.seq, role: "user", text: turn.content ?? "", timestamp: turn.createdAt };
				}
				// assistant: content is JSON blocks array
				let blocks: any[] = [];
				try { blocks = JSON.parse(turn.content ?? "[]"); } catch { blocks = []; }
				// Extract text for search/display
				const textParts = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
				return { id: "t" + turn.seq, role: "assistant", blocks, text: textParts, timestamp: turn.createdAt };
			});
		});
		ipcMain.handle("messages:clear", async (_e, agentId: string) => {
			if (agentService) {
				const db = agentService.getDB();
				const session = db.createSession(agentId);
				db.setMainSession(agentId, session.id);
				const agent = agentStore.get(agentId);
				agentService.recreateLoop(agentId, session.id, agent);
			}
			return { success: true };
		});


	ipcMain.handle("messages:edit", async (_e, agentId: string, msgSeq: number, newText: string) => {
		if (!agentService) return { error: "not ready" };
		const db = agentService.getDB();
		const session = db.getMainSession(agentId);
		if (!session) return { error: "session not found" };
		db.updateTurnContent(session.id, msgSeq, newText);
		const rows = db.getMessagesWithSeq(session.id);
		const target = rows.find(r => r.seq === msgSeq);
		if (target) {
			const msg = JSON.parse(target.msg_json);
			msg.content = newText;
			db.updateMessageContent(session.id, msgSeq, newText, JSON.stringify(msg));
		}
		const agent = agentStore.get(agentId);
		agentService.recreateLoop(agentId, session.id, agent);
		return { success: true };
	});

	ipcMain.handle("messages:delete", async (_e, agentId: string, msgSeq: number) => {
		if (!agentService) return { error: "not ready" };
		const db = agentService.getDB();
		const session = db.getMainSession(agentId);
		if (!session) return { error: "session not found" };
		db.deleteTurn(session.id, msgSeq);
		db.deleteMessage(session.id, msgSeq);
		const agent = agentStore.get(agentId);
		agentService.recreateLoop(agentId, session.id, agent);
		return { success: true };
	});

	// ─── Sessions ────────────────────────────────────
	ipcMain.handle("sessions:list", async (_e, agentId: string) => {
		if (!agentService) return [];
		return agentService.getDB().listSessions(agentId);
	});

	ipcMain.handle("sessions:new", async (_e, agentId: string) => {
		if (!agentService) return { error: "not ready" };
		const db = agentService.getDB();
		const session = db.createSession(agentId);
		db.setMainSession(agentId, session.id);
		const agent = agentStore.get(agentId);
		agentService.recreateLoop(agentId, session.id, agent);
		return session;
	});

	ipcMain.handle("sessions:switch", async (_e, agentId: string, sessionId: string) => {
		if (!agentService) return { error: "not ready" };
		const db = agentService.getDB();
		db.setMainSession(agentId, sessionId);
		const agent = agentStore.get(agentId);
		agentService.recreateLoop(agentId, sessionId, agent);
		return { success: true, sessionId };
	});

	ipcMain.handle("sessions:current", async (_e, agentId: string) => {
		if (!agentService) return null;
		return agentService.getDB().getMainSession(agentId) ?? null;
	});

	ipcMain.handle("sessions:delete", async (_e, agentId: string, sessionId: string) => {
		if (!agentService) return { error: "not ready" };
		const db = agentService.getDB();
		const mainSession = db.getMainSession(agentId);
		db.deleteSession(sessionId);
		// If deleted the current main session, create a new one
		if (mainSession?.id === sessionId) {
			const newSession = db.createSession(agentId);
			db.setMainSession(agentId, newSession.id);
			const agent = agentStore.get(agentId);
			agentService.recreateLoop(agentId, newSession.id, agent);
			return { success: true, newSessionId: newSession.id };
		}
		return { success: true };
	});


	// ─── Files ───────────────────────────────────────
	ipcMain.handle("files:tree", (_e, root?: string) => {
		if (!modulesReady) return [];
		const dir = expandHome(root || workspaceConfig.workspaceDir);
		try {
			const s = statSync(dir);
			if (!s.isDirectory()) return { error: "not a directory" };
		} catch {
			return { error: "directory not found" };
		}
		return buildTree(dir, "");
	});

	ipcMain.handle("files:content", (_e, filePath: string, root?: string) => {
		if (!filePath) return { error: "path required" };
		const ext = extname(filePath);
		if (!TEXT_EXTS.has(ext) && ext !== "") {
			return { content: "(binary file)" };
		}
		const r = expandHome(root || (modulesReady ? workspaceConfig.workspaceDir : homedir()));
		const full = resolve(r, filePath);
		if (!full.startsWith(resolve(r))) {
			return { error: "access denied" };
		}
		try {
			const s = statSync(full);
			if (s.size > 500_000) return { content: "(file too large, > 500KB)" };
			return { content: readFileSync(full, "utf-8") };
		} catch {
			return { error: "file not found" };
		}
	});

	
	ipcMain.handle("files:resolve-path", (_e, filePath: string, root?: string) => {
		if (!filePath) return { error: "path required" };
		const r = expandHome(root || (modulesReady ? workspaceConfig.workspaceDir : homedir()));
		const full = resolve(r, filePath);
		if (!full.startsWith(resolve(r))) {
			return { error: "access denied" };
		}
		return { path: full };
	});

	ipcMain.handle("files:save", (_e, filePath: string, fileContent: string, root?: string) => {
		if (!filePath) return { error: "path required" };
		const r = expandHome(root || (modulesReady ? workspaceConfig.workspaceDir : homedir()));
		const full = resolve(r, filePath);
		if (!full.startsWith(resolve(r))) {
			return { error: "access denied" };
		}
		try {
			const { writeFileSync } = require("node:fs");
			writeFileSync(full, fileContent, "utf-8");
			return { success: true };
		} catch (err: any) {
			return { error: err.message };
		}
	});

ipcMain.handle("chat:send", async (_e, text: string, agentId?: string) => {
		if (!modulesReady) return { error: "loading" };
		const svc = await ensureAgentService();
		const agent = agentId ? agentStore.get(agentId) : undefined;

		const wsDir = expandHome(agent?.workspaceDir || workspaceConfig.workspaceDir);
		svc.setWorkspaceDir(wsDir);

		const providerConfigs = providerStore.list().map((p) => ({
			name: p.name,
			type: p.type,
			apiKey: p.apiKey,
			baseUrl: p.baseUrl,
			models: p.models.map((m) => ({
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
			})),
			enabled: p.enabled,
		}));
		svc.setProviders(providerConfigs, workspaceConfig.defaultModel, workspaceConfig.defaultProvider);

		svc.sendPrompt(text, agent).catch((err) => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("agent:event", { type: "error", error: err.message, agentId: agentId ?? undefined });
			}
		});
		return { success: true };
	});

	ipcMain.handle("chat:abort", async () => {
		if (agentService) await agentService.abort();
		return { success: true };
	});

	ipcMain.handle("chat:state", () => agentService ? agentService.getState() : { isBusy: false });

		// ─── Theme ────────────────────────────────────
		const themePath = join(homedir(), ".zero-core", "theme.json");
		ipcMain.handle("config:get-theme", () => {
			try {
				if (!existsSync(themePath)) return { mode: "dark", customPrimaryColor: null };
				return JSON.parse(readFileSync(themePath, "utf-8"));
			} catch {
				return { mode: "dark", customPrimaryColor: null };
			}
		});
		ipcMain.handle("config:set-theme", (_e, data) => {
			try {
				const dir = dirname(themePath);
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				const { writeFileSync } = require("node:fs");
				writeFileSync(themePath, JSON.stringify(data, null, 2), "utf-8");
				return { success: true };
			} catch {
				return { error: "failed to save theme" };
			}
		});

	
		// ─── Templates ────────────────────────────────────
		ipcMain.handle("templates:list", () => modulesReady ? templateStore.list() : []);
		ipcMain.handle("templates:get", (_e, id: string) => modulesReady ? templateStore.get(id) : undefined);
		ipcMain.handle("templates:create", (_e, input: unknown) => {
			if (!modulesReady) return { error: "loading" };
			return templateStore.create(input as any);
		});
		ipcMain.handle("templates:update", (_e, id: string, input: unknown) => {
			if (!modulesReady) return { error: "loading" };
			try { return templateStore.update(id, input as any); }
			catch (e) { return { error: (e as Error).message }; }
		});
		ipcMain.handle("templates:delete", (_e, id: string) => {
			if (!modulesReady) return { error: "loading" };
			try { templateStore.delete(id); return { success: true }; }
			catch (e) { return { error: (e as Error).message }; }
		});
		ipcMain.handle("templates:export", (_e, id: string) => {
			if (!modulesReady) return { error: "loading" };
			try { return templateStore.exportTemplate(id); }
			catch (e) { return { error: (e as Error).message }; }
		});
		ipcMain.handle("templates:import", (_e, json: string) => {
			if (!modulesReady) return { error: "loading" };
			try { return templateStore.importTemplate(json); }
			catch (e) { return { error: (e as Error).message }; }
		});


		// ─── MCP ─────────────────────────────────────────
		ipcMain.handle("mcp:list", () => modulesReady ? mcpStore.list() : []);
		ipcMain.handle("mcp:get", (_e, id: string) => modulesReady ? mcpStore.get(id) : undefined);
		ipcMain.handle("mcp:create", async (_e, input: unknown) => {
			if (!modulesReady) return { error: "loading" };
			const record = mcpStore.create(input as any);
			if (record.enabled) {
				const result = await mcpManager.connect(record);
				return { ...record, connectedTools: result.tools, connectError: result.error };
			}
			return record;
		});
		ipcMain.handle("mcp:update", async (_e, id: string, input: unknown) => {
			if (!modulesReady) return { error: "loading" };
			try {
				const record = mcpStore.update(id, input as any);
				if (record.enabled) {
					await mcpManager.connect(record);
				} else {
					await mcpManager.disconnect(id);
				}
				return record;
			} catch (e) { return { error: (e as Error).message }; }
		});
		ipcMain.handle("mcp:delete", async (_e, id: string) => {
			if (!modulesReady) return { error: "loading" };
			await mcpManager.disconnect(id);
			mcpStore.delete(id);
			return { success: true };
		});
		ipcMain.handle("mcp:test", async (_e, input: unknown) => {
			if (!modulesReady) return { tools: [], error: "loading" };
			return mcpManager.testConnection(input as any);
		});
		ipcMain.handle("mcp:tools", async (_e, serverId: string) => {
			if (!modulesReady) return [];
			const server = mcpStore.get(serverId);
			if (!server) return [];
			if (!mcpManager.isConnected(serverId)) {
				const result = await mcpManager.connect(server);
				return result.tools;
			}
			return mcpManager.getConnectedServers().find(s => s.id === serverId)?.toolCount ?? 0;
		});
		ipcMain.handle("mcp:connect", async (_e, id: string) => {
			if (!modulesReady) return { error: "loading" };
			const server = mcpStore.get(id);
			if (!server) return { tools: [], error: "Server not found" };
			const result = await mcpManager.connect(server);
			return result;
		});
		ipcMain.handle("mcp:disconnect", async (_e, id: string) => {
			await mcpManager.disconnect(id);
			return { success: true };
		});
		ipcMain.handle("mcp:status", () => {
			return mcpManager.getConnectedServers();
		});


		// ─── Knowledge Base ─────────────────────────────────
		ipcMain.handle("kb:list", () => modulesReady ? kbStore.list() : []);
		ipcMain.handle("kb:get", (_e, id: string) => modulesReady ? kbStore.get(id) : undefined);
		ipcMain.handle("kb:create", (_e, input: unknown) => {
			if (!modulesReady) return { error: "loading" };
			return kbStore.create(input as any);
		});
		ipcMain.handle("kb:update", (_e, id: string, input: unknown) => {
			if (!modulesReady) return { error: "loading" };
			try { return kbStore.update(id, input as any); }
			catch (e) { return { error: (e as Error).message }; }
		});
		ipcMain.handle("kb:delete", (_e, id: string) => {
			if (!modulesReady) return { error: "loading" };
			kbDb.deleteKbChunks(id);
			kbStore.delete(id);
			return { success: true };
		});
		ipcMain.handle("kb:add-files", async (_e, kbId: string, filePaths: string[]) => {
			if (!modulesReady) return { error: "loading" };
			const kb = kbStore.get(kbId);
			if (!kb) return { error: "Knowledge base not found" };
			// Ingest each file
			const results: { path: string; chunks: number; error?: string }[] = [];
			for (const fp of filePaths) {
				const { statSync } = require("node:fs");
				const { basename } = require("node:path");
				try {
					const stat = statSync(fp);
					// Get embedding provider from provider configs
					const providers = providerStore.list();
					const embProv = providers.find((p: any) => p.enabled && p.type !== "ollama");
					const embedder = createEmbeddingProvider(kb.embeddingProvider, {
						baseUrl: kb.embeddingProvider === "ollama" ? "http://localhost:11434" : (embProv?.baseUrl ?? "https://api.openai.com/v1"),
						apiKey: kb.embeddingProvider === "ollama" ? "" : (embProv?.apiKey ?? ""),
						model: kb.embeddingModel,
					});
					const result = await ingestFile(kbId, fp, kbDb, embedder);
					if (result.chunks > 0) {
						kbStore.updateFile(kbId, {
							path: fp,
							name: basename(fp),
							size: stat.size,
							chunks: result.chunks,
							ingestedAt: new Date().toISOString(),
						});
					}
					results.push({ path: fp, chunks: result.chunks, error: result.error });
				} catch (err: any) {
					results.push({ path: fp, chunks: 0, error: err.message });
				}
			}
			return results;
		});
		ipcMain.handle("kb:remove-file", (_e, kbId: string, filePath: string) => {
			if (!modulesReady) return { error: "loading" };
			removeFile(kbId, filePath, kbDb);
			kbStore.removeFile(kbId, filePath);
			return { success: true };
		});
		ipcMain.handle("kb:search", async (_e, kbIds: string[], query: string) => {
			if (!modulesReady) return [];
			const { search: kbSearch } = await import(toFileURL(join(distServer, "kb-search.js")));
			const allKbs = kbStore.list();
			const targetKbs = allKbs.filter((kb: any) => kbIds.includes(kb.id));
			if (targetKbs.length === 0) return [];
			const providers = providerStore.list();
			const embProv = providers.find((p: any) => p.enabled && p.type !== "ollama");
			const kb = targetKbs[0];
			const embedder = createEmbeddingProvider(kb.embeddingProvider, {
				baseUrl: kb.embeddingProvider === "ollama" ? "http://localhost:11434" : (embProv?.baseUrl ?? "https://api.openai.com/v1"),
				apiKey: kb.embeddingProvider === "ollama" ? "" : (embProv?.apiKey ?? ""),
				model: kb.embeddingModel,
			});
			return kbSearch(kbIds, query, embedder, kbDb, 5);
		});
		ipcMain.handle("kb:chunk-count", (_e, kbId: string) => {
			return kbDb.getChunkCount(kbId);
		});

log.ipc("All handlers registered");

	// Load core modules in background
	loadCoreModules().then(() => {
		modulesReady = true;
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("app:ready", true);
		}
	});
}

