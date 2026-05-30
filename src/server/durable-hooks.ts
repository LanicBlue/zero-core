import { HookRegistry } from "../core/hook-registry.js";
import type { SessionDB } from "./session-db.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Durable execution hooks — checkpoint turn state to the database
// The first consumer of the hook system. Registered at startup.
// ---------------------------------------------------------------------------

let turnSeqCounter = 0;

export function registerDurableHooks(sessionDb: SessionDB): void {
	const registry = HookRegistry.getInstance();

	registry.register("SessionStart", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			turnSeqCounter++;
			sessionDb.createTurnState(sessionId, turnSeqCounter);
			log.debug("durable", `Turn ${turnSeqCounter} created for session ${sessionId}`);
		} catch (err) {
			log.error("durable", "SessionStart hook failed:", (err as Error).message);
		}
	});

	registry.register("PostToolUse", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			sessionDb.updateTurnPhase(sessionId, turnSeqCounter, "tools_executing", {
				lastTool: ctx.toolName,
				timestamp: ctx.timestamp,
			});
		} catch (err) {
			log.error("durable", "PostToolUse hook failed:", (err as Error).message);
		}
	});

	registry.register("Stop", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			sessionDb.completeTurnState(sessionId, turnSeqCounter);
			log.debug("durable", `Turn ${turnSeqCounter} completed for session ${sessionId}`);
		} catch (err) {
			log.error("durable", "Stop hook failed:", (err as Error).message);
		}
	});

	registry.register("StopFailure", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			sessionDb.failTurnState(sessionId, turnSeqCounter, ctx.error as string ?? "Unknown error");
			log.debug("durable", `Turn ${turnSeqCounter} failed for session ${sessionId}`);
		} catch (err) {
			log.error("durable", "StopFailure hook failed:", (err as Error).message);
		}
	});

	log.db("Durable checkpoint hooks registered");
}
