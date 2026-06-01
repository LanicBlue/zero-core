import type { SessionDB } from "./session-db.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Startup recovery — scan for interrupted turns and clean up stale records.
// Actual resume is driven by AgentService.recoverIncompleteSessions().
// Runs once at app startup after the database is initialized.
// ---------------------------------------------------------------------------

export function scanIncompleteTurns(sessionDb: SessionDB): Array<{ sessionId: string; turnSeq: number; phase: string }> {
	// Clean up old turn_state records (older than 24 hours)
	sessionDb.cleanOldTurnState(24 * 60 * 60 * 1000);

	const incomplete = sessionDb.getIncompleteTurns();
	if (incomplete.length === 0) {
		log.debug("recovery", "No interrupted turns found");
	} else {
		log.db(`Found ${incomplete.length} interrupted turn(s)`);
	}
	return incomplete;
}
