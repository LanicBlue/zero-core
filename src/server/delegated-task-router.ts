// Delegated task REST API router.
//
// # 文件说明书
//
// ## 核心功能
// Read-only surface over the delegated_tasks table for the TaskTree UI:
//   - GET /by-session/:sessionId  — tasks spawned directly by a chat session
//                                   (parent_session_id = sessionId), newest-first.
//   - GET /:id                    — single delegated task record.
//
// Live progress (turns/tokens/currentTool) is pulled periodically by the
// renderer (pull-on-display + slow poll while visible); no push channel —
// updateDelegatedTask fires on every tool_start/usage, too hot for push.
//
// ## 输入
// - SessionDB (listDelegatedTasks / getDelegatedTask)
//
// ## 输出
// - Express Router, mounted at /api/delegated-tasks
//
import { Router } from "express";
import type { SessionDB } from "./session-db.js";

export function createDelegatedTaskRouter(sessionDB: SessionDB): Router {
	const router = Router();

	/** GET /by-session/:sessionId — tasks this chat session launched. */
	router.get("/by-session/:sessionId", (req, res) => {
		const parentSessionId = req.params.sessionId;
		const tasks = sessionDB.listDelegatedTasks({ parentSessionId });
		res.json(tasks);
	});

	/** GET /:id — single task record. */
	router.get("/:id", (req, res) => {
		const task = sessionDB.getDelegatedTask(req.params.id);
		if (!task) { res.status(404).json({ error: "not found" }); return; }
		res.json(task);
	});

	return router;
}
