import { HookRegistry } from "../core/hook-registry.js";
import type { SessionDB } from "./session-db.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Durable execution hooks — checkpoint turn state to the database
// The first consumer of the hook system. Registered at startup.
// ---------------------------------------------------------------------------

// Per-session turn sequence tracking
const sessionTurnSeq = new Map<string, number>();

export function setSessionTurnSeq(sessionId: string, turnSeq: number): void {
	sessionTurnSeq.set(sessionId, turnSeq);
}

export function registerDurableHooks(sessionDb: SessionDB): void {
	const registry = HookRegistry.getInstance();

	registry.register("SessionStart", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			// Skip if already tracked (e.g. recovery scenario — turn_state exists)
			if (sessionTurnSeq.has(sessionId)) {
				log.debug("durable", `Turn seq already set for session ${sessionId}, skipping create`);
				return;
			}
			const turnSeq = sessionDb.getTurnCount(sessionId);
			sessionTurnSeq.set(sessionId, turnSeq);
			sessionDb.createTurnState(sessionId, turnSeq);
			log.debug("durable", `Turn ${turnSeq} created for session ${sessionId}`);
		} catch (err) {
			log.error("durable", "SessionStart hook failed:", (err as Error).message);
		}
	});

	registry.register("PostToolUse", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;
			sessionDb.updateTurnPhase(sessionId, turnSeq, "tools_executing", {
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
			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;
			sessionDb.completeTurnState(sessionId, turnSeq);
			log.debug("durable", `Turn ${turnSeq} completed for session ${sessionId}`);
			sessionTurnSeq.delete(sessionId);
		} catch (err) {
			log.error("durable", "Stop hook failed:", (err as Error).message);
		}
	});

	registry.register("StopFailure", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;
			sessionDb.failTurnState(sessionId, turnSeq, ctx.error as string ?? "Unknown error");
			log.debug("durable", `Turn ${turnSeq} failed for session ${sessionId}`);
			sessionTurnSeq.delete(sessionId);
		} catch (err) {
			log.error("durable", "StopFailure hook failed:", (err as Error).message);
		}
	});

	log.db("Durable checkpoint hooks registered");
}
