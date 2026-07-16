// Agent REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 Agent 的 Express REST API 路由（列表、创建、更新、删除）
//
// ## 输入
// HTTP 请求（GET/POST/PUT/DELETE）、AgentStore、AgentService、CoreDatabase
//
// ## 输出
// Express Router，处理 Agent CRUD API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供 Agent 管理端点
//
// ## 依赖
// express、agent-store.ts、agent-service.ts、core-database.ts
//
// ## 维护规则
// API 路径变更需同步更新前端调用
//
import { Router } from "express";
import type { AgentStore } from "./agent-store.js";
import type { createAgentService } from "./agent-service.js";
import type { CoreDatabase } from "./core-database.js";

export function createAgentRouter(deps: {
	agentStore: AgentStore;
	agentService: ReturnType<typeof createAgentService>;
	sessionDB: CoreDatabase;
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
		// v0.8 §11.5: agent-as-tool retired — no AgentToolStore rows to cascade.
		agentStore.delete(req.params.id);
		res.json({ success: true });
	});

	// -----------------------------------------------------------------------
	// Messages
	// -----------------------------------------------------------------------

	/**
	 * GET /:agentId/messages — get messages for agent's current session.
	 *
	 * steps-overhaul sub-3: the source of truth for message content is now the
	 * STEPS table (messages was redefined to summary+cursor and stores no step
	 * content). This endpoint walks steps in seq order and flattens each step
	 * into a {role, text} entry — user steps emit their plain-text content,
	 * assistant steps parse their block-JSON content and join text blocks (tool
	 * blocks are skipped for this human-readable view). The shape mirrors the
	 * legacy {id, role, text, timestamp} contract the renderer expects.
	 */
	router.get("/:agentId/messages", (req, res) => {
		const session = sessionDB.getMainSession(req.params.agentId);
		if (!session) return res.json([]);
		const steps = sessionDB.getSteps(session.id);
		const result: { id: string; role: "user" | "assistant"; text: string; timestamp: number }[] = [];
		for (const step of steps) {
			const role = step.role as string;
			if (role !== "user" && role !== "assistant") continue;
			let text = "";
			if (role === "user") {
				text = step.content ?? "";
			} else {
				// assistant step content is a JSON array of blocks; join text blocks.
				try {
					const blocks = JSON.parse(step.content ?? "[]");
					if (Array.isArray(blocks)) {
						for (const b of blocks) {
							if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
								text += b.text;
							}
						}
					}
				} catch { /* malformed assistant content → empty text */ }
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
	router.put("/:agentId/sessions/switch/:sessionId", async (req, res) => {
		sessionDB.setMainSession(req.params.agentId, req.params.sessionId);
		await agentService.activateSession(req.params.agentId, req.params.sessionId);
		res.json({ success: true, sessionId: req.params.sessionId });
	});

	/** GET /:agentId/sessions/current — get current session */
	router.get("/:agentId/sessions/current", (req, res) => {
		res.json(sessionDB.getMainSession(req.params.agentId) ?? null);
	});

	return router;
}
