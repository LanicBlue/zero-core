// MCP 服务器 REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 MCP 服务器的 Express REST API 路由（列表、创建、更新、删除、工具调用）
//
// ## 输入
// HTTP 请求、McpStore、MCPManager
//
// ## 输出
// Express Router，处理 MCP 服务器管理 API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供 MCP 管理端点
//
// ## 依赖
// express、mcp-store.ts、mcp-manager.ts
//
// ## 维护规则
// 新增 MCP 操作类型需在此添加对应路由
//
import { Router } from "express";
import type { McpStore } from "./mcp-store.js";
import type { MCPManager } from "./mcp-manager.js";

export function createMcpRouter(mcpStore: McpStore, mcpManager: MCPManager): Router {
	const router = Router();

	// mcp:list — list all MCP servers
	router.get("/", (_req, res) => {
		try {
			res.json(mcpStore.list());
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// mcp:get — get a single server
	router.get("/:id", (req, res) => {
		try {
			const server = mcpStore.get(req.params.id);
			if (!server) {
				res.status(404).json({ error: "Server not found" });
				return;
			}
			res.json(server);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// mcp:create — create server, connect if enabled
	router.post("/", async (req, res) => {
		try {
			const record = mcpStore.create(req.body);
			if (record.enabled) {
				const result = await mcpManager.connect(record);
				res.status(201).json({ ...record, connectedTools: result.tools, connectError: result.error });
			} else {
				res.status(201).json(record);
			}
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// mcp:update — update server, connect/disconnect accordingly
	router.put("/:id", async (req, res) => {
		try {
			const record = mcpStore.update(req.params.id, req.body);
			if (record.enabled) {
				await mcpManager.connect(record);
			} else {
				await mcpManager.disconnect(req.params.id);
			}
			res.json(record);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// mcp:delete — disconnect and delete
	router.delete("/:id", async (req, res) => {
		try {
			await mcpManager.disconnect(req.params.id);
			mcpStore.delete(req.params.id);
			res.json({ success: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// mcp:test — test connection (body has full server config)
	router.post("/:id/test", async (req, res) => {
		try {
			const result = await mcpManager.testConnection(req.body);
			res.json(result);
		} catch (e) {
			res.status(400).json({ tools: [], error: (e as Error).message });
		}
	});

	// mcp:tools — get tools for server, connect if needed
	router.get("/:id/tools", async (req, res) => {
		try {
			const server = mcpStore.get(req.params.id);
			if (!server) {
				res.json([]);
				return;
			}
			if (!mcpManager.isConnected(req.params.id)) {
				const result = await mcpManager.connect(server);
				res.json(result.tools);
				return;
			}
			const connected = mcpManager.getConnectedServers();
			const entry = connected.find((s) => s.id === req.params.id);
			res.json(entry?.toolCount ?? 0);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// mcp:connect — connect to server
	router.post("/:id/connect", async (req, res) => {
		try {
			const server = mcpStore.get(req.params.id);
			if (!server) {
				res.json({ tools: [], error: "Server not found" });
				return;
			}
			const result = await mcpManager.connect(server);
			res.json(result);
		} catch (e) {
			res.status(400).json({ tools: [], error: (e as Error).message });
		}
	});

	// mcp:disconnect — disconnect from server
	router.post("/:id/disconnect", async (req, res) => {
		try {
			await mcpManager.disconnect(req.params.id);
			res.json({ success: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// mcp:status — get all connected servers
	router.get("/status", (_req, res) => {
		res.json(mcpManager.getConnectedServers());
	});

	return router;
}
