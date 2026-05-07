import { Router } from "express";
import type { WebSocketServer, WebSocket } from "ws";

export function createAgentRouter(_wss: WebSocketServer): Router {
	const router = Router();

	// TODO: Phase 3 - Agent session management and streaming
	// For now, just a stub endpoint
	router.post("/send", (req, res) => {
		res.json({ status: "ok", message: "Agent not yet connected" });
	});

	router.post("/abort", (_req, res) => {
		res.json({ status: "ok" });
	});

	return router;
}
