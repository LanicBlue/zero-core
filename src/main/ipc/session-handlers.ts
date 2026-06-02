import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

export function registerSessionHandlers(ctx: IpcContext): void {
	typedHandle("messages:clear", ["agentService", "agentStore"],
		async (_ctx, agentId) => {
			const db = _ctx.agentService.getDB();
			const session = db.createSession(agentId);
			db.setMainSession(agentId, session.id);
			const agent = _ctx.agentStore.get(agentId);
			_ctx.agentService.recreateLoop(agentId, session.id, agent);
			return { success: true as const };
		},
	);

	typedHandle("messages:edit", ["agentService", "agentStore"],
		async (_ctx, agentId, msgSeq, newText) => {
			const db = _ctx.agentService.getDB();
			const session = db.getMainSession(agentId);
			if (!session) return { error: "session not found" };
			db.updateTurnContent(session.id, msgSeq, newText);
			const rows = db.getMessagesWithSeq(session.id);
			const target = rows.find((r: any) => r.seq === msgSeq);
			if (target) {
				const msg = JSON.parse(target.msg_json);
				msg.content = newText;
				db.updateMessageContent(session.id, msgSeq, newText, JSON.stringify(msg));
			}
			const agent = _ctx.agentStore.get(agentId);
			_ctx.agentService.recreateLoop(agentId, session.id, agent);
			return { success: true as const };
		},
	);

	typedHandle("messages:delete", ["agentService", "agentStore"],
		async (_ctx, agentId, msgSeq) => {
			const db = _ctx.agentService.getDB();
			const session = db.getMainSession(agentId);
			if (!session) return { error: "session not found" };
			db.deleteTurn(session.id, msgSeq);
			db.deleteMessage(session.id, msgSeq);
			const agent = _ctx.agentStore.get(agentId);
			_ctx.agentService.recreateLoop(agentId, session.id, agent);
			return { success: true as const };
		},
	);

	typedHandle("sessions:list", "agentService",
		async (_ctx, agentId) => _ctx.agentService.getDB().listSessions(agentId),
	);

	typedHandle("sessions:new", ["agentService", "agentStore"],
		async (_ctx, agentId) => {
			const db = _ctx.agentService.getDB();
			const session = db.createSession(agentId);
			db.setMainSession(agentId, session.id);
			const agent = _ctx.agentStore.get(agentId);
			_ctx.agentService.recreateLoop(agentId, session.id, agent);
			return session;
		},
	);

	typedHandle("sessions:switch", ["agentService", "agentStore"],
		async (_ctx, agentId, sessionId) => {
			_ctx.agentService.getDB().setMainSession(agentId, sessionId);
			await _ctx.agentService.activateSession(agentId, sessionId);
			return { success: true as const, sessionId };
		},
	);

	typedHandle("sessions:activate", "agentService",
		async (_ctx, agentId, sessionId) => {
			const sid = await _ctx.agentService.activateSession(agentId, sessionId);
			return { success: true as const, sessionId: sid };
		},
	);

	typedHandle("sessions:current", "agentService",
		async (_ctx, agentId) => _ctx.agentService.getDB().getMainSession(agentId) ?? null,
	);

	typedHandle("sessions:delete", ["agentService", "agentStore"],
		async (_ctx, agentId, sessionId) => {
			const db = _ctx.agentService.getDB();
			const mainSession = db.getMainSession(agentId);
			db.deleteSession(sessionId);
			if (mainSession?.id === sessionId) {
				const newSession = db.createSession(agentId);
				db.setMainSession(agentId, newSession.id);
				const agent = _ctx.agentStore.get(agentId);
				_ctx.agentService.recreateLoop(agentId, newSession.id, agent);
				return { success: true as const, newSessionId: newSession.id };
			}
			return { success: true as const };
		},
	);

	typedHandle("sessions:metrics", "agentService",
		async (_ctx) => {
			const sm = _ctx.agentService.getSessionManager();
			if (!sm) {
				return { totalSessions: 0, activeSessions: 0, busySessions: 0, idleSessions: 0, totalTurns: 0, totalErrors: 0, totalToolCalls: 0, globalAvgTurnLatencyMs: 0, globalAvgToolCallDurationMs: 0, concurrencySnapshot: {}, lastUpdatedAt: Date.now(), sessions: {} };
			}
			const aggregate = sm.getAggregateMetrics();
			const sessions: Record<string, any> = {};
			for (const [id, m] of sm.getAllSessionMetrics()) {
				sessions[id] = { ...m, toolCallCounts: Object.fromEntries(m.toolCallCounts), toolCallErrors: Object.fromEntries(m.toolCallErrors) };
			}
			return { ...aggregate, concurrencySnapshot: Object.fromEntries(Object.entries(aggregate.concurrencySnapshot)), sessions };
		},
	);
}
