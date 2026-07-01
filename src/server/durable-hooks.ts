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

// Per-session turn sequence tracking (the turn_state row key)
const sessionTurnSeq = new Map<string, number>();

export function setSessionTurnSeq(sessionId: string, turnSeq: number): void {
	sessionTurnSeq.set(sessionId, turnSeq);
}

export function registerDurableHooks(sessionDb: SessionDB, registry: HookRegistry = HookRegistry.getInstance()): void {

	registry.register("TurnStart", async (ctx) => {
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
			const turnSeq = sessionTurnSeq.get(sessionId);
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
			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;
			sessionDb.completeTurnState(sessionId, turnSeq);
			log.debug("durable", `Turn ${turnSeq} completed for session ${sessionId}`);
			sessionTurnSeq.delete(sessionId);
		} catch (err) {
			log.error("durable", "TurnEnd hook failed:", (err as Error).message);
		}
	});

	registry.register("TurnError", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;
			sessionDb.failTurnState(sessionId, turnSeq, ctx.error as string ?? "Unknown error");
			log.debug("durable", `Turn ${turnSeq} failed for session ${sessionId}`);
			sessionTurnSeq.delete(sessionId);
		} catch (err) {
			log.error("durable", "TurnError hook failed:", (err as Error).message);
		}
	});

	log.db("Durable checkpoint hooks registered (step-level)");
}
