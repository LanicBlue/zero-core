import { ipcMain } from "electron";
import type { IpcContext } from "./types.js";

export function registerSessionHandlers(ctx: IpcContext): void {
	// ─── Messages (backed by SessionDB) ──────────────
	// Converts full ModelMessage[] to simplified format with tool call records for renderer
	ipcMain.handle("messages:list", async (_e, agentId: string) => {
		if (!ctx.modulesReady || !ctx.agentService) return [];
		const db = ctx.agentService.getDB();
		const session = db.getMainSession(agentId);
		if (!session) return [];
		const turns = db.getTurns(session.id);
		if (turns.length === 0) return [];

		return turns.map((turn: any) => {
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
		if (ctx.agentService) {
			const db = ctx.agentService.getDB();
			const session = db.createSession(agentId);
			db.setMainSession(agentId, session.id);
			const agent = ctx.agentStore.get(agentId);
			ctx.agentService.recreateLoop(agentId, session.id, agent);
		}
		return { success: true };
	});

	ipcMain.handle("messages:edit", async (_e, agentId: string, msgSeq: number, newText: string) => {
		if (!ctx.agentService) return { error: "not ready" };
		const db = ctx.agentService.getDB();
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
		const agent = ctx.agentStore.get(agentId);
		ctx.agentService.recreateLoop(agentId, session.id, agent);
		return { success: true };
	});

	ipcMain.handle("messages:delete", async (_e, agentId: string, msgSeq: number) => {
		if (!ctx.agentService) return { error: "not ready" };
		const db = ctx.agentService.getDB();
		const session = db.getMainSession(agentId);
		if (!session) return { error: "session not found" };
		db.deleteTurn(session.id, msgSeq);
		db.deleteMessage(session.id, msgSeq);
		const agent = ctx.agentStore.get(agentId);
		ctx.agentService.recreateLoop(agentId, session.id, agent);
		return { success: true };
	});

	// ─── Sessions ────────────────────────────────────
	ipcMain.handle("sessions:list", async (_e, agentId: string) => {
		if (!ctx.agentService) return [];
		return ctx.agentService.getDB().listSessions(agentId);
	});

	ipcMain.handle("sessions:new", async (_e, agentId: string) => {
		if (!ctx.agentService) return { error: "not ready" };
		const db = ctx.agentService.getDB();
		const session = db.createSession(agentId);
		db.setMainSession(agentId, session.id);
		const agent = ctx.agentStore.get(agentId);
		ctx.agentService.recreateLoop(agentId, session.id, agent);
		return session;
	});

	ipcMain.handle("sessions:switch", async (_e, agentId: string, sessionId: string) => {
		if (!ctx.agentService) return { error: "not ready" };
		const db = ctx.agentService.getDB();
		db.setMainSession(agentId, sessionId);
		const agent = ctx.agentStore.get(agentId);
		ctx.agentService.recreateLoop(agentId, sessionId, agent);
		return { success: true, sessionId };
	});

	ipcMain.handle("sessions:current", async (_e, agentId: string) => {
		if (!ctx.agentService) return null;
		return ctx.agentService.getDB().getMainSession(agentId) ?? null;
	});

	ipcMain.handle("sessions:delete", async (_e, agentId: string, sessionId: string) => {
		if (!ctx.agentService) return { error: "not ready" };
		const db = ctx.agentService.getDB();
		const mainSession = db.getMainSession(agentId);
		db.deleteSession(sessionId);
		// If deleted the current main session, create a new one
		if (mainSession?.id === sessionId) {
			const newSession = db.createSession(agentId);
			db.setMainSession(agentId, newSession.id);
			const agent = ctx.agentStore.get(agentId);
			ctx.agentService.recreateLoop(agentId, newSession.id, agent);
			return { success: true, newSessionId: newSession.id };
		}
		return { success: true };
	});
}
