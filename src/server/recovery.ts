import type { SessionDB } from "./session-db.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Startup recovery — find interrupted turns and mark them as failed
// Runs once at app startup after the database is initialized.
// ---------------------------------------------------------------------------

export async function runRecovery(sessionDb: SessionDB): Promise<void> {
	try {
		const incomplete = sessionDb.getIncompleteTurns();

		if (incomplete.length === 0) {
			log.debug("recovery", "No interrupted turns found");
			return;
		}

		log.db( `Found ${incomplete.length} interrupted turn(s)`);

		for (const turn of incomplete) {
			log.db( `Marking turn ${turn.turnSeq} in session ${turn.sessionId} (phase: ${turn.phase}) as failed`);
			sessionDb.failTurnState(turn.sessionId, turn.turnSeq, "Process interrupted — app restarted");
		}

		// Clean up old turn_state records (older than 24 hours)
		sessionDb.cleanOldTurnState(24 * 60 * 60 * 1000);

		log.db( "Recovery complete");
	} catch (err) {
		log.error("recovery", "Recovery failed:", (err as Error).message);
	}
}
