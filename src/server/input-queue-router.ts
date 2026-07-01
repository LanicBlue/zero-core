// Input queue REST API router (Phase C2).
//
// Per-session input queue operations. The queue lives on AgentService.inputQueue
// (in-memory). List returns the current items; enqueue adds (default mode
// "queued" — also happens implicitly via /api/chat/send when busy); promote
// flips queued → insert_now (inject at next step); remove deletes.
//
import { Router } from "express";
import type { AgentService } from "./agent-service.js";

export function createInputQueueRouter(agentService: AgentService): Router {
	const router = Router();
	const q = agentService.inputQueue;

	/** GET /:sessionId — current queue for a session. */
	router.get("/:sessionId", (req, res) => {
		res.json(q.list(req.params.sessionId));
	});

	/** POST /:sessionId — enqueue { content, mode? }. */
	router.post("/:sessionId", (req, res) => {
		const { content, mode } = req.body as { content: string; mode?: "queued" | "insert_now" };
		if (!content || !content.trim()) { res.status(400).json({ error: "content required" }); return; }
		const item = q.enqueue(req.params.sessionId, content, mode ?? "queued");
		res.json(item);
	});

	/** POST /:id/promote — queued → insert_now. */
	router.post("/:id/promote", (req, res) => {
		res.json({ ok: q.promoteInsertNow(req.params.id) });
	});

	/** DELETE /:id — remove from queue. */
	router.delete("/:id", (req, res) => {
		res.json({ ok: q.remove(req.params.id) });
	});

	return router;
}
