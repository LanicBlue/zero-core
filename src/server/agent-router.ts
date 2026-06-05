// Agent REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 Agent 的 Express REST API 路由（列表、创建、更新、删除）
//
// ## 输入
// HTTP 请求（GET/POST/PUT/DELETE）、AgentStore、AgentService、SessionDB
//
// ## 输出
// Express Router，处理 Agent CRUD API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供 Agent 管理端点
//
// ## 依赖
// express、agent-store.ts、agent-service.ts、session-db.ts
//
// ## 维护规则
// API 路径变更需同步更新前端调用
//
import { Router } from "express";
import type { AgentStore } from "./agent-store.js";
import type { createAgentService } from "./agent-service.js";
import type { SessionDB } from "./session-db.js";

export function createAgentRouter(deps: {
	agentStore: AgentStore;
	agentService: ReturnType<typeof createAgentService>;
	sessionDB: SessionDB;
}): Router {
	const router = Router();
	const { agentStore, agentService, sessionDB } = deps;

	// -----------------------------------------------------------------------
	// Agent CRUD
	// -----------------------------------------------------------------------

	/** GET / — list agents */
	router.get("/", (_req, res) => {
		res.json(agentStore.list());
	});

	/** GET /:id — get agent */
	router.get("/:id", (req, res) => {
		const a = agentStore.get(req.params.id);
		if (!a) return res.status(404).json({ error: "Not found" });
		res.json(a);
	});

	/** POST / — create agent */
	router.post("/", (req, res) => {
		const a = agentStore.create(req.body);
		res.status(201).json(a);
	});

	/** PUT /:id — update agent */
	router.put("/:id", (req, res) => {
		try {
			const a = agentStore.update(req.params.id, req.body);
			res.json(a);
		} catch (e) {
			res.status(404).json({ error: (e as Error).message });
		}
	});

	/** DELETE /:id — delete agent */
	router.delete("/:id", (req, res) => {
		agentStore.delete(req.params.id);
		res.json({ success: true });
	});

	// -----------------------------------------------------------------------
	// Messages
	// -----------------------------------------------------------------------

	/** GET /:agentId/messages — get messages for agent's current session */
	router.get("/:agentId/messages", (req, res) => {
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

	/** DELETE /:agentId/messages — clear messages (new session) */
	router.delete("/:agentId/messages", (req, res) => {
		const session = sessionDB.createSession(req.params.agentId);
		sessionDB.setMainSession(req.params.agentId, session.id);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json({ success: true });
	});

	// -----------------------------------------------------------------------
	// Sessions
	// -----------------------------------------------------------------------

	/** GET /:agentId/sessions — list sessions */
	router.get("/:agentId/sessions", (req, res) => {
		res.json(sessionDB.listSessions(req.params.agentId));
	});

	/** POST /:agentId/sessions/new — create new session */
	router.post("/:agentId/sessions/new", (req, res) => {
		const session = sessionDB.createSession(req.params.agentId);
		sessionDB.setMainSession(req.params.agentId, session.id);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json(session);
	});

	/** PUT /:agentId/sessions/switch/:sessionId — switch session */
	router.put("/:agentId/sessions/switch/:sessionId", (req, res) => {
		sessionDB.setMainSession(req.params.agentId, req.params.sessionId);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, req.params.sessionId, agent);
		res.json({ success: true, sessionId: req.params.sessionId });
	});

	/** GET /:agentId/sessions/current — get current session */
	router.get("/:agentId/sessions/current", (req, res) => {
		res.json(sessionDB.getMainSession(req.params.agentId) ?? null);
	});

	return router;
}
