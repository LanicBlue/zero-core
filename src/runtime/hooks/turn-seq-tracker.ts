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
