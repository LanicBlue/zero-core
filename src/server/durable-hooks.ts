// 持久化执行 Hook
//
// # 文件说明书
//
// ## 核心功能
// 将执行状态检查点到数据库，确保 hook 事件持久化后可恢复
//
// ## 输入
// Hook 事件上下文、SessionDB 实例
//
// ## 输出
// 数据库中的 turn_state 记录（含 last_completed_step_seq 检查点）
//
// ## 定位
// src/server/ — 服务层，Hook 系统的首个持久化消费者
//
// ## 依赖
// core/hook-registry.ts、session-db.ts、core/logger.ts
//
// ## 维护规则
// 检查点格式变更需考虑数据迁移
//
import { HookRegistry } from "../core/hook-registry.js";
import type { SessionDB } from "./session-db.js";
import { log } from "../core/logger.js";
// Step 4A (fix): the shared turn_seq Map is OWNED by turn-hooks — it writes the
// user-step row at TurnStart, so it owns the cursor. durable-hooks READS the
// shared Map (for createTurnState's seq) but does NOT write to it. Instead it
// dedups turn_state creation through the shared turn-seq-tracker marker
// (markTurnStatePrecreated / isTurnStatePrecreated — sub-4: moved from a local
// Set here so the runtime layer's resumeTask can pre-populate it too). This
// removes the TurnStart ordering dependency that previously caused step-resume
// regressions: when durable's TurnStart ran first it set the cursor, which
// made turn-hooks' hasTurnSeq() guard skip the user-row write. With durable
// out of the writer seat, turn-hooks' TurnStart always writes the user row
// regardless of registration order.
import { getTurnSeq, setTurnSeq, markTurnStatePrecreated, isTurnStatePrecreated, clearTurnStatePrecreated } from "../runtime/hooks/turn-seq-tracker.js";

/**
 * Back-compat shim: existing callers (agent-service resume, step-resume test)
 * import `setSessionTurnSeq` from durable-hooks. Step 4A (fix): this is the
 * "this turn is being resumed, do NOT re-initialize" signal. It writes BOTH:
 *   - the shared turn_seq Map (turn-hooks' TurnStart guard consults it to skip
 *     the user-row write — correct, the row already exists on resume), and
 *   - the shared turn_state-precreate marker (so durable's TurnStart skips
 *     createTurnState, preserving the existing turn_state row + checkpoint).
 *
 * sub-4 (subagent-recovery): the dedup marker moved from this file's local Set
 * to a shared accessor in turn-seq-tracker.ts so the RUNTIME layer
 * (subagent-delegator.resumeTask, called by TaskResume) can pre-populate it too
 * — closing the turn+1 bug on the TaskResume path. Same single-source
 * invariant; the Set just lives one layer down where both writers reach it.
 */
export function setSessionTurnSeq(sessionId: string, turnSeq: number): void {
	setTurnSeq(sessionId, turnSeq);
	markTurnStatePrecreated(sessionId);
}

// ---------------------------------------------------------------------------
// Durable execution hooks — step-level checkpoint to the database
// The first consumer of the hook system. Registered at startup.
//
// Step 2D: checkpoint granularity moved from turn-level phase to step-level.
//   - TurnStart       → createTurnState (initialize checkpoint, phase=pending)
//   - StepEnd         → advanceStepCheckpoint (push last_completed_step_seq)
//   - TurnEnd         → completeTurnState (mark session turn done)
//   - TurnError       → failTurnState (mark session turn failed)
// resume() reads last_completed_step_seq and continues from +1, so completed
// steps are never re-run. The previous PostToolUse "tools_executing" phase
// flip is gone — phase now only marks terminal session state.
// ---------------------------------------------------------------------------

export function registerDurableHooks(sessionDb: SessionDB, registry: HookRegistry = HookRegistry.getInstance()): void {

	registry.register("TurnStart", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			// Local dedup: skip if we already created the turn_state row for
			// this session this turn (e.g. recovery scenario where
			// setSessionTurnSeq pre-populated the cursor, or a double-fire).
			// NOTE: deliberately NOT consulting the shared turn_seq Map here —
			// doing so would re-introduce the ordering dependency (durable
			// running first would mark the cursor, causing turn-hooks to skip
			// the user-row write). The local Set keeps durable's dedup
			// independent of turn-hooks' writer state.
			if (isTurnStatePrecreated(sessionId)) {
				log.debug("durable", `turn_state already created for session ${sessionId}, skipping`);
				return;
			}
			// Read the turn seq for createTurnState. Prefer turn-hooks' shared
			// cursor (it has already written the user-step row, so its seq is
			// authoritative); fall back to db.getTurnCount if turn-hooks has
			// not run yet (registration order varies across processes).
			let turnSeq = getTurnSeq(sessionId);
			if (turnSeq === undefined) {
				turnSeq = sessionDb.getTurnCount(sessionId);
			}
			sessionDb.createTurnState(sessionId, turnSeq);
			markTurnStatePrecreated(sessionId);
			log.debug("durable", `Turn ${turnSeq} created for session ${sessionId}`);
		} catch (err) {
			log.error("durable", "TurnStart hook failed:", (err as Error).message);
		}
	});

	registry.register("StepEnd", async (ctx) => {
		// Step 2D: advance the per-session step checkpoint. This fires once per
		// successful finish-step (and once at finalizeStream for any trailing
		// blocks). The completed step seq = stepBaseSeq + stepOffset (the AgentLoop
		// fires StepEnd BEFORE incrementing stepOffset, so stepOffset still points
		// at the just-completed step). Only moves the cursor forward.
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			const turnSeq = getTurnSeq(sessionId);
			if (turnSeq === undefined) return;
			const stepBaseSeq = ctx.stepBaseSeq as number | undefined;
			const stepOffset = ctx.stepOffset as number | undefined;
			if (stepBaseSeq === undefined || stepOffset === undefined) return;
			const completedStepSeq = stepBaseSeq + stepOffset;
			sessionDb.advanceStepCheckpoint(sessionId, turnSeq, completedStepSeq);
			log.debug("durable", `Step checkpoint advanced: session=${sessionId} turn=${turnSeq} stepSeq=${completedStepSeq}`);
		} catch (err) {
			log.error("durable", "StepEnd checkpoint hook failed:", (err as Error).message);
		}
	});

	registry.register("TurnEnd", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			const turnSeq = getTurnSeq(sessionId);
			// turn-hooks owns the cursor; it clears it on TurnEnd. Durable only
			// needs the seq to close the turn_state row. If turn-hooks already
			// cleared the cursor (its TurnEnd ran first), fall back to the
			// local dedup sentinel: if turnStateCreated has this session, a
			// turn_state row exists and we must complete it — read its seq.
			let seq = turnSeq;
			if (seq === undefined) {
				const row = sessionDb.getIncompleteTurns().find(t => t.sessionId === sessionId);
				seq = row?.turnSeq;
			}
			if (seq === undefined) return;
			sessionDb.completeTurnState(sessionId, seq);
			log.debug("durable", `Turn ${seq} completed for session ${sessionId}`);
			// Clear durable's local dedup marker — do NOT touch the shared Map
			// (turn-hooks owns it).
			clearTurnStatePrecreated(sessionId);
		} catch (err) {
			log.error("durable", "TurnEnd hook failed:", (err as Error).message);
		}
	});

	registry.register("TurnError", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			const turnSeq = getTurnSeq(sessionId);
			let seq = turnSeq;
			if (seq === undefined) {
				const row = sessionDb.getIncompleteTurns().find(t => t.sessionId === sessionId);
				seq = row?.turnSeq;
			}
			if (seq === undefined) return;
			sessionDb.failTurnState(sessionId, seq, ctx.error as string ?? "Unknown error");
			log.debug("durable", `Turn ${seq} failed for session ${sessionId}`);
			clearTurnStatePrecreated(sessionId);
		} catch (err) {
			log.error("durable", "TurnError hook failed:", (err as Error).message);
		}
	});

	log.db("Durable checkpoint hooks registered (step-level)");
}
