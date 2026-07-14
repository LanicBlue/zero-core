// 全局配置 REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供全局配置（工作区、设备上下文、指南等）的 Express REST API 路由
//
// ## 输入
// HTTP 请求、SessionDB、ToolRegistry、WorkspaceConfig
//
// ## 输出
// Express Router，处理配置读写 API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供配置管理端点
//
// ## 依赖
// express、session-db.ts、core/config.ts、workspace-config.ts
//
// ## 维护规则
// 配置结构变更需考虑向后兼容和迁移
//
import { Router } from "express";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionDB } from "./session-db.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import type { WorkspaceConfig } from "./workspace-config.js";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "./workspace-config.js";
import { loadConfig, saveGlobalConfig, DEFAULT_GUIDELINES } from "../core/config.js";
import { ALL_TOOLS } from "../tools/index.js";
import { getToolInputFields } from "../tools/tool-factory.js";
import { loadDeviceContext, saveDeviceContext, generateAndSaveDeviceContext } from "../core/device-context.js";

export interface ConfigRouterDeps {
	sessionDB: SessionDB;
	registry: ToolRegistry;
	buildDefaultPrompt: (name: string) => string;
}

export function createConfigRouter(deps: ConfigRouterDeps): Router {
	const router = Router();
	const { sessionDB, registry, buildDefaultPrompt } = deps;
	const kv = () => sessionDB.getKVStore();

	// ─── Workspace Config ────────────────────────────────────

	// config:get — return workspace config + default prompt
	router.get("/", (_req, res) => {
		try {
			const config = loadWorkspaceConfig(sessionDB);
			res.json({ ...config, defaultPrompt: buildDefaultPrompt("Agent") });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// config:update — update workspace config
	router.put("/", (req, res) => {
		try {
			const data = req.body as { workspaceDir?: string; defaultModel?: string; defaultProvider?: string; proxy?: any };

			if (typeof data.workspaceDir === "string") {
				const abs = resolve(data.workspaceDir);
				if (!existsSync(abs)) {
					try {
						mkdirSync(abs, { recursive: true });
					} catch {
						res.status(400).json({ error: "Cannot create directory" });
						return;
					}
				}
				saveWorkspaceConfig({ workspaceDir: abs }, sessionDB);
			}

			if (data.defaultModel !== undefined || data.defaultProvider !== undefined) {
				saveWorkspaceConfig(
					{ defaultModel: data.defaultModel, defaultProvider: data.defaultProvider },
					sessionDB,
				);
			}

			if (data.proxy !== undefined) {
				saveWorkspaceConfig({ proxy: data.proxy }, sessionDB);
				import("../runtime/proxy-manager.js").then((m) => m.applyProxy(data.proxy)).catch(() => {});
			}

			const config = loadWorkspaceConfig(sessionDB);
			res.json(config);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// ─── Theme ───────────────────────────────────────────────

	// config:get-theme
	router.get("/theme", (_req, res) => {
		try {
			const stored = kv().getJson<{ mode: string; customPrimaryColor?: string }>("theme");
			res.json(stored ?? { mode: "dark", customPrimaryColor: null });
		} catch {
			res.json({ mode: "dark", customPrimaryColor: null });
		}
	});

	// config:set-theme
	router.put("/theme", (req, res) => {
		try {
			kv().setJson("theme", req.body);
			res.json({ success: true });
		} catch {
			res.status(400).json({ error: "failed to save theme" });
		}
	});

	// ─── Device Context ──────────────────────────────────────

	// device-context:get
	router.get("/device-context", (_req, res) => {
		try {
			const content = loadDeviceContext(kv());
			res.json({ content });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// device-context:generate — generate and save device context
	router.post("/device-context/generate", (_req, res) => {
		try {
			const content = generateAndSaveDeviceContext(kv());
			res.json({ content });
		} catch (err: any) {
			res.status(500).json({ content: "", error: err.message });
		}
	});

	// device-context:save — save device context
	router.put("/device-context", (req, res) => {
		try {
			const { content } = req.body as { content: string };
			saveDeviceContext(content, kv());
			res.json({ success: true });
		} catch (err: any) {
			res.status(400).json({ error: err.message });
		}
	});

	// ─── Guidelines ──────────────────────────────────────────

	// guidelines:get — get guidelines from config
	router.get("/guidelines", (_req, res) => {
		try {
			const config = loadConfig(process.cwd(), undefined, kv());
			const guidelines = config.systemPrompt?.guidelines;
			res.json({
				guidelines: guidelines ?? DEFAULT_GUIDELINES,
				defaults: DEFAULT_GUIDELINES,
				isDefault: !guidelines,
			});
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// guidelines:save — save guidelines
	router.put("/guidelines", (req, res) => {
		try {
			const guidelines = req.body as string[];
			const configData: any = kv().getJson("global_config") ?? {};
			if (!configData.systemPrompt) configData.systemPrompt = {};
			configData.systemPrompt.guidelines = guidelines;
			kv().setJson("global_config", configData);
			res.json({ success: true });
		} catch {
			res.status(400).json({ error: "failed to save guidelines" });
		}
	});

	// ─── Compression Config ──────────────────────────────────
	// (route name kept as /memory-config for IPC stability; the standalone
	// memory/autoRecall config was residual — memory lives in the wiki tree.
	// Only compression is exchanged now.)
	//
	// compression-archive-simplify sub-5: `enabled` removed from the default
	// fallback — it was an unread fake (the trigger hook never checked it).
	// The default is now an empty object (provider/model fall through to the
	// session's working model; summarySystemPrompt falls through to the
	// in-file SUMMARY_SYSTEM literal in compression-core).

	// config:memory-get
	router.get("/memory-config", (_req, res) => {
		try {
			const configData: any = kv().getJson("global_config") ?? {};
			res.json({
				compression: configData.compression ?? {},
			});
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// config:memory-update
	router.put("/memory-config", (req, res) => {
		try {
			const { compression } = req.body as { compression?: any };
			const configData: any = kv().getJson("global_config") ?? {};
			if (compression !== undefined) configData.compression = compression;
			kv().setJson("global_config", configData);
			res.json({ success: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// ─── Tools ───────────────────────────────────────────────

	// tools:list — list tools from registry
	router.get("/tools", (_req, res) => {
		try {
			const tools = registry.getAll().map((d) => ({
				name: d.name,
				description: d.description,
				prompt: d.prompt,
				group: d.category,
				source: d.source,
				mcpServerName: d.mcpServerName,
				// v0.8 (M0): surface stable agent-tool entry id for policy keying
				agentToolId: d.agentToolId,
				configSchema: d.configSchema,
				meta: d.meta,
				inputFields: getToolInputFields(ALL_TOOLS[d.name]),
			}));
			res.json(tools);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// tool-config:get — get tool config
	router.get("/tool-config", (_req, res) => {
		res.json(registry.getToolConfig());
	});

	// tool-config:save — save tool config
	router.put("/tool-config", (req, res) => {
		try {
			registry.saveToolConfig(req.body);
			res.json({ success: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	return router;
}
