import { Router } from "express";
import type { createAgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";

export function createSessionRouter(deps: {
	agentService: ReturnType<typeof createAgentService>;
	agentStore: AgentStore;
}): Router {
	const router = Router();
	const { agentService, agentStore } = deps;

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

	// Messages
	router.delete("/:agentId/messages", (req, res) => {
		const db = getDb();
		const session = db.createSession(req.params.agentId);
		db.setMainSession(req.params.agentId, session.id);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json({ success: true });
	});

	router.put("/:agentId/messages/:seq", (req, res) => {
		const { newText } = req.body;
		const db = getDb();
		const session = db.getMainSession(req.params.agentId);
		if (!session) return res.status(404).json({ error: "session not found" });

		db.updateTurnContent(session.id, parseInt(req.params.seq), newText);
		const rows = db.getMessagesWithSeq(session.id);
		const target = rows.find((r: any) => r.seq === parseInt(req.params.seq));
		if (target) {
			const msg = JSON.parse(target.msg_json);
			msg.content = newText;
			db.updateMessageContent(session.id, parseInt(req.params.seq), newText, JSON.stringify(msg));
		}
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json({ success: true });
	});

	router.delete("/:agentId/messages/:seq", (req, res) => {
		const db = getDb();
		const session = db.getMainSession(req.params.agentId);
		if (!session) return res.status(404).json({ error: "session not found" });

		const seq = parseInt(req.params.seq);
		db.deleteTurn(session.id, seq);
		db.deleteMessage(session.id, seq);
		const agent = agentStore.get(req.params.agentId);
		agentService.recreateLoop(req.params.agentId, session.id, agent);
		res.json({ success: true });
	});

	return router;
}
