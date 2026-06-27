// Agent 会话与消息的 REST 入口,涵盖会话创建/切换/删除与历史消息编辑
//
// # 文件说明书
//
// ## 核心功能
// 管理 agent 维度的会话:列表、新建、切换/激活、删除(删主会话会自动重建),以及对会话消息的清空、按 turnGroup 编辑与删除(同时支持 step 级 schema 与旧 turn 级 schema);/metrics 路径在 /:agentId 之前注册以避免被参数捕获。任何消息改动后会调用 agentService.recreateLoop 让运行时重建上下文。
//
// ## 输入
// - 注入 agentService 与 agentStore(用于 recreateLoop 与 agent 查找)
// - :agentId / :sessionId / :seq 路径参数
// - PUT /:agentId/messages/:seq 请求体 { newText }
// - POST /:agentId/activate 请求体 { sessionId? }
//
// ## 输出
// - /metrics 返回聚合指标 + 各 session 详情(含并发快照、工具调用计数)
// - 会话操作返回 session 或 { success, sessionId? / newSessionId? }
// - 消息编辑/删除返回 { success: true }
//
// ## 定位
// src/server/ 服务层,挂载于 /api/sessions,服务于渲染进程的会话列表、对话面板与消息操作。
//
// ## 依赖
// - express Router
// - ./agent-service(createAgentService)、./agent-store
// - SessionDB(via agentService.getDB)提供的 step / turn / message 接口
//
// ## 维护规则
// - 新增 GET 端点若路径形如固定段(如 /metrics),必须放在 /:agentId 之前,否则会被 agentId 捕获。
// - 修改消息后必须 recreateLoop,否则运行时上下文与 DB 不一致。
// - step 级与 turn 级 schema 同时存在时,优先走 hasStepSchema() 分支,保持向后兼容。
//

import { Router } from "express";
import type { createAgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ManagementService } from "./management-service.js";

export function createSessionRouter(deps: {
	agentService: ReturnType<typeof createAgentService>;
	agentStore: AgentStore;
	/** M4: 注入 ManagementService 以支持 ensureProjectSession (project 路由 session)。 */
	management?: ManagementService;
}): Router {
	const router = Router();
	const { agentService, agentStore, management } = deps;

	const getDb = () => agentService.getDB();

	// Metrics (must come before /:agentId to avoid param capture)
	router.get("/metrics", (_req, res) => {
		const sm = agentService.getSessionManager();
		if (!sm) {
			return res.json({
				totalSessions: 0, activeSessions: 0, busySessions: 0, idleSessions: 0,
				totalTurns: 0, totalErrors: 0, totalToolCalls: 0,
				globalAvgTurnLatencyMs: 0, globalAvgToolCallDurationMs: 0,
				concurrencySnapshot: {}, lastUpdatedAt: Date.now(), sessions: {},
			});
		}
		const aggregate = sm.getAggregateMetrics();
		const sessions: Record<string, any> = {};
		for (const [id, m] of sm.getAllSessionMetrics()) {
			sessions[id] = { ...m, toolCallCounts: Object.fromEntries(m.toolCallCounts), toolCallErrors: Object.fromEntries(m.toolCallErrors) };
		}
		res.json({ ...aggregate, concurrencySnapshot: Object.fromEntries(Object.entries(aggregate.concurrencySnapshot)), sessions });
	});

	/**
	 * POST /for-project — M4: find-or-create 一个 (agentId, projectId) session。
	 * body: { agentId, projectId }。session 模型 (agentId, projectId?) 路由下,这是
	 * 渲染端"跳转到某 project chat"的后端原语(General 单例由渲染端用 /new 保证)。
	 * 必须放在 /:agentId 之前以免被参数捕获。
	 */
	router.post("/for-project", (req, res) => {
		if (!management) return res.status(503).json({ error: "ManagementService not available" });
		const agentId = req.body?.agentId;
		const projectId = req.body?.projectId;
		if (!agentId || !projectId) return res.status(400).json({ error: "agentId and projectId required" });
		try {
			const result = management.ensureProjectSession(agentId, projectId);
			res.json(result);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// Sessions
	router.get("/:agentId", (req, res) => {
		res.json(getDb().listSessions(req.params.agentId));
	});

	router.post("/:agentId/new", (req, res) => {
		const db = getDb();
		const session = db.createSession(req.params.agentId);
		db.setMainSession(req.params.agentId, session.id);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json(session);
	});

	router.put("/:agentId/switch/:sessionId", async (req, res) => {
		getDb().setMainSession(req.params.agentId, req.params.sessionId);
		await agentService.activateSession(req.params.agentId, req.params.sessionId);
		res.json({ success: true, sessionId: req.params.sessionId });
	});

	router.post("/:agentId/activate", async (req, res) => {
		const sessionId = req.body?.sessionId;
		const sid = await agentService.activateSession(req.params.agentId, sessionId);
		res.json({ success: true, sessionId: sid });
	});

	router.get("/:agentId/current", (req, res) => {
		res.json(getDb().getMainSession(req.params.agentId) ?? null);
	});

	router.delete("/:agentId/:sessionId", (req, res) => {
		const db = getDb();
		const mainSession = db.getMainSession(req.params.agentId);
		db.deleteSession(req.params.sessionId);
		if (mainSession?.id === req.params.sessionId) {
			const newSession = db.createSession(req.params.agentId);
			db.setMainSession(req.params.agentId, newSession.id);
			const agent = agentStore.get(req.params.agentId);
			agentService.recreateLoop(req.params.agentId, newSession.id, agent);
			return res.json({ success: true, newSessionId: newSession.id });
		}
		res.json({ success: true });
	});

	// Archive (soft-delete): mark the session archived=1, then create a clean
	// replacement with the SAME (agentId, projectId) context so routing lands on
	// a fresh session. The archived row is retained (excluded by the archived=0
	// filters in SessionDB). If the archived one was main, hand main to the new one.
	router.post("/:agentId/:sessionId/archive", (req, res) => {
		const db = getDb();
		const old = db.getSession(req.params.sessionId);
		if (!old) return res.status(404).json({ error: "session not found" });
		db.archiveSession(req.params.sessionId);
		const ns = db.createSession(req.params.agentId, undefined, old.context);
		const main = db.getMainSession(req.params.agentId); // already excludes archived
		if (!main || main.id === req.params.sessionId) {
			db.setMainSession(req.params.agentId, ns.id);
		}
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, ns.id, agent);
		res.json({ success: true, newSessionId: ns.id });
	});

	// Messages
	router.delete("/:agentId/messages", (req, res) => {
		const db = getDb();
		const session = db.createSession(req.params.agentId);
		db.setMainSession(req.params.agentId, session.id);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json({ success: true });
	});

	// Edit message — :seq is now a turnGroup value (from UI's `m${turnGroup}` id)
	router.put("/:agentId/messages/:seq", (req, res) => {
		const { newText } = req.body;
		const db = getDb();
		const session = db.getMainSession(req.params.agentId);
		if (!session) return res.status(404).json({ error: "session not found" });

		const seqParam = parseInt(req.params.seq);

		if (db.hasStepSchema()) {
			// Step-level: find the step(s) for this turnGroup and update content
			const steps = db.getStepGroup(session.id, seqParam);
			for (const step of steps) {
				if (step.role === "user") {
					db.updateStepContent(session.id, step.seq, newText);
				}
			}
		} else {
			db.updateTurnContent(session.id, seqParam, newText);
		}

		// Also update messages table for in-memory cache
		const rows = db.getMessagesWithSeq(session.id);
		const target = rows.find((r: any) => r.seq === seqParam);
		if (target) {
			const msg = JSON.parse(target.msg_json);
			msg.content = newText;
			db.updateMessageContent(session.id, seqParam, newText, JSON.stringify(msg));
		}
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json({ success: true });
	});

	// Delete message — :seq is now a turnGroup value, deletes entire group
	router.delete("/:agentId/messages/:seq", (req, res) => {
		const db = getDb();
		const session = db.getMainSession(req.params.agentId);
		if (!session) return res.status(404).json({ error: "session not found" });

		const seqParam = parseInt(req.params.seq);

		if (db.hasStepSchema()) {
			// Step-level: delete all steps in the turnGroup
			db.deleteStepGroup(session.id, seqParam);
		} else {
			db.deleteTurn(session.id, seqParam);
		}
		db.deleteMessage(session.id, seqParam);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json({ success: true });
	});

	return router;
}
