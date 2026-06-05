// Agent 工具 REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 Agent 自定义工具的 Express REST API 路由（列表、创建、更新、删除）
//
// ## 输入
// HTTP 请求、AgentToolStore
//
// ## 输出
// Express Router，处理 Agent 工具 CRUD API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供 Agent 工具管理端点
//
// ## 依赖
// express、agent-tool-store.ts
//
// ## 维护规则
// API 路径变更需同步更新前端调用
//
import { Router } from "express";
import type { AgentToolStore } from "./agent-tool-store.js";

export function createAgentToolRouter(agentToolStore: AgentToolStore): Router {
	const router = Router();

	/** GET / — list all agent tools */
	router.get("/", (_req, res) => {
		res.json(agentToolStore.list());
	});

	/** GET /by-agent/:agentId — get tools by agent ID */
	router.get("/by-agent/:agentId", (req, res) => {
		const tool = agentToolStore.getByAgentId(req.params.agentId);
		res.json(tool ?? null);
	});

	/** GET /:id — get agent tool */
	router.get("/:id", (req, res) => {
		const tool = agentToolStore.get(req.params.id);
		if (!tool) return res.status(404).json({ error: "Not found" });
		res.json(tool);
	});

	/** POST / — create agent tool */
	router.post("/", (req, res) => {
		const tool = agentToolStore.create(req.body);
		res.status(201).json(tool);
	});

	/** PUT /:id — update agent tool */
	router.put("/:id", (req, res) => {
		try {
			const tool = agentToolStore.update(req.params.id, req.body);
			res.json(tool);
		} catch (e) {
			res.status(404).json({ error: (e as Error).message });
		}
	});

	/** DELETE /:id — delete agent tool */
	router.delete("/:id", (req, res) => {
		agentToolStore.delete(req.params.id);
		res.json({ success: true });
	});

	return router;
}
