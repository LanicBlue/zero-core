// Turn-seq tracker — shared in-memory turn_seq cursor.
//
// # 文件说明书
//
// ## 核心功能
// Step 4A: consolidates the per-session turn_seq Map that previously lived
// separately in turn-hooks.ts and durable-hooks.ts into a single shared
// instance. Both hooks need to read "what turn seq is this session on?" at
// TurnStart and clear it at TurnEnd/TurnError; running them off one Map
// removes the two-source-of-truth hazard where one hook's marker survives
// after the other's was cleared.
//
// ## 输入
// sessionId, turnSeq
//
// ## 输出
// get / set / has / delete accessors over a single module-level Map.
//
// ## 定位
// src/runtime/hooks/ — glue shared by turn-hooks + durable-hooks.
//
// ## 维护规则
// Only one Map instance per process. Do not re-introduce a per-hook copy.

const sessionTurnSeq = new Map<string, number>();

export function getTurnSeq(sessionId: string): number | undefined {
	return sessionTurnSeq.get(sessionId);
}

export function setTurnSeq(sessionId: string, seq: number): void {
	sessionTurnSeq.set(sessionId, seq);
}

export function hasTurnSeq(sessionId: string): boolean {
	return sessionTurnSeq.has(sessionId);
}

export function deleteTurnSeq(sessionId: string): void {
	sessionTurnSeq.delete(sessionId);
}

// ─── turn_state pre-create marker (sub-4) ────────────────────────────────
//
// subagent-recovery sub-4 / TaskResume turn_seq guard: when a delegated child
// session is RESUMED (not freshly started), its turn_state row for the
// interrupted turn already exists in the DB. TurnStart must NOT create a new
// one (that would allocate turn_seq+1 — the "turn+1 bug" the acceptance suite
// case 9 checks). The pre-create marker tells durable-hooks' TurnStart to skip
// createTurnState for this session THIS turn, mirroring what
// `setSessionTurnSeq` (server/durable-hooks.ts) used to do standalone.
//
// Layering: this lives in runtime/ so BOTH layers can touch it without a cycle
//   - server/durable-hooks.ts (consumer): already imports this module; switches
//     its local `turnStateCreated` Set to these accessors (single source).
//   - runtime/subagent-delegator.ts resumeTask (writer): sets it BEFORE
//     loop.resume() so the child's TurnStart sees it. Previously only the
//     server-side resume path (doRecoverIncompleteSessions) did this — the
//     runtime resumeTask path skipped it, which is exactly the bug the guard
//     closes.
//   - server/agent-service.ts doRecoverIncompleteSessions: keeps using its
//     existing `setSessionTurnSeq` shim (which now delegates here), so the
//     long-standing parent-resume path is unchanged.
const turnStatePrecreated = new Set<string>();

/** Mark that a turn_state row already exists for this session this turn. */
export function markTurnStatePrecreated(sessionId: string): void {
	turnStatePrecreated.add(sessionId);
}

export function isTurnStatePrecreated(sessionId: string): boolean {
	return turnStatePrecreated.has(sessionId);
}

/** Clear the pre-create marker (called on TurnEnd / TurnError). */
export function clearTurnStatePrecreated(sessionId: string): void {
	turnStatePrecreated.delete(sessionId);
}

/**
 * steps-overhaul sub-8 (archive): clear ALL in-memory state this module holds
 * for ONE session — both the turn_seq cursor AND the turn_state pre-create
 * marker. Called by the archive pipeline's teardown step (chat manual archive
 * of an active session) so a sessionId whose DB rows were just deleted doesn't
 * leave stale hook state behind. Idempotent (no-op if the session had no
 * state).
 */
export function clearTurnSeqStateForSession(sessionId: string): void {
	sessionTurnSeq.delete(sessionId);
	turnStatePrecreated.delete(sessionId);
}
