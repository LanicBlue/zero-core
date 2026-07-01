// Turn 持久化 Hook
//
// # 文件说明书
//
// ## 核心功能
// 通过 Hook 系统处理所有 turn 持久化，取代 CheckpointManager 的直接 DB 写入
// 使用 step-level 存储：user turn 和 assistant steps 分别写入独立的行
//
// ## 输入
// Hook 事件上下文（sessionId, userMessage, blocks 等）
//
// ## 输出
// turns 表的写入（append-only 原始数据）
//
// ## 定位
// src/runtime/hooks/ — 运行层 Hook，为 AgentLoop 提供 turn 持久化副作用
//
// ## 依赖
// core/hook-registry.ts、session-store-interface.ts、turn-recorder.ts、core/logger.ts
//
// ## 维护规则
// turns 表只通过此 hook 写入，AgentLoop 不直接访问 DB（增量流式写入除外）
//

import { HookRegistry } from "../../core/hook-registry.js";
import type { ISessionStore } from "../session-store-interface.js";
import { TurnRecorder } from "../turn-recorder.js";
import { log } from "../../core/logger.js";

// Per-session turn sequence tracking
const sessionTurnSeq = new Map<string, number>();

export function getTurnSeq(sessionId: string): number | undefined {
	return sessionTurnSeq.get(sessionId);
}

export function setTurnSeq(sessionId: string, seq: number): void {
	sessionTurnSeq.set(sessionId, seq);
}

export function registerTurnHooks(db: ISessionStore, registry: HookRegistry = HookRegistry.getInstance()): void {

	// ─── SessionStart: write user turn as step row ─────────────

	registry.register("SessionStart", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			// Skip if turn seq already set (recovery scenario)
			if (sessionTurnSeq.has(sessionId)) {
				log.debug("turn-hooks", `Turn seq already set for session ${sessionId}, skipping user turn`);
				return;
			}

			const userMessage = ctx.userMessage as string;
			if (!userMessage) return;

			const seq = db.getTurnCount(sessionId);
			sessionTurnSeq.set(sessionId, seq);

			// Use step-level storage if available, fallback to legacy
			if (db.hasStepSchema()) {
				db.appendStep(sessionId, seq, seq, "user", userMessage);
			} else {
				db.appendTurn(sessionId, seq, "user", userMessage);
			}
			log.debug("turn-hooks", `User turn ${seq} saved for session ${sessionId}`);
		} catch (err) {
			log.error("turn-hooks", "SessionStart hook failed:", (err as Error).message);
		}
	});

	// ─── PostStep: persist completed steps to DB ───────────────
	//
	// Fires on finish-step (per LLM API call completion) and once
	// more at finalizeStream for any trailing blocks.
	// AgentLoop owns recorder state + stepOffset; this hook only
	// handles the DB write.

	registry.register("PostStep", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			const recorder = ctx.recorder as TurnRecorder | undefined;
			const stepBaseSeq = ctx.stepBaseSeq as number | undefined;

			if (recorder && stepBaseSeq !== undefined && stepBaseSeq >= 0) {
				recorder.persistAllSteps(db, sessionId, stepBaseSeq);
				log.debug("turn-hooks", `PostStep: persisted steps for session ${sessionId}, baseSeq=${stepBaseSeq}, offset=${ctx.stepOffset}`);
			}
		} catch (err) {
			log.error("turn-hooks", "PostStep hook failed:", (err as Error).message);
		}
	});

	// ─── Stop: safety net for final assistant step ──────────────
	//
	// Normally, PostStep hook persists steps incrementally during streaming.
	// This hook is a safety net for cases where abort occurs before
	// finish-step fires (e.g., user abort, timeout).

	registry.register("Stop", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;

			// Safety net: if blocks are provided and we have step-level storage,
			// ensure they're persisted (abort may have occurred before finish-step)
			const blocks = ctx.blocks as any[] | undefined;
			if (blocks && blocks.length > 0) {
				const blocksJson = JSON.stringify(blocks);
				if (db.hasStepSchema()) {
					// Step-level: write as a single assistant step if nothing persisted yet
					const assistantSeq = turnSeq + 1;
					const existing = db.getSteps(sessionId).find(s => s.turnGroup === turnSeq && s.role === "assistant");
					if (!existing) {
						db.appendStep(sessionId, assistantSeq, turnSeq, "assistant", blocksJson);
						log.debug("turn-hooks", `Safety net: assistant step ${assistantSeq} saved for session ${sessionId}`);
					}
				} else {
					// Legacy fallback
					const assistantSeq = turnSeq + 1;
					const existing = db.getTurns(sessionId).find(t => t.seq === assistantSeq);
					if (existing) {
						db.updateTurnContent(sessionId, assistantSeq, blocksJson);
					} else {
						db.appendTurn(sessionId, assistantSeq, "assistant", blocksJson);
					}
					log.debug("turn-hooks", `Assistant turn ${assistantSeq} saved (${blocks.length} blocks) for session ${sessionId}`);
				}
			}

			sessionTurnSeq.delete(sessionId);
		} catch (err) {
			log.error("turn-hooks", "Stop hook failed:", (err as Error).message);
		}
	});

	// ─── StopFailure: save whatever we have ─────────────────────

	registry.register("StopFailure", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;

			// Keep whatever blocks we have — they represent actual work done
			const blocks = ctx.blocks as any[] | undefined;
			if (blocks && blocks.length > 0) {
				const blocksJson = JSON.stringify(blocks);
				if (db.hasStepSchema()) {
					const assistantSeq = turnSeq + 1;
					const existing = db.getSteps(sessionId).find(s => s.turnGroup === turnSeq && s.role === "assistant");
					if (!existing) {
						db.appendStep(sessionId, assistantSeq, turnSeq, "assistant", blocksJson);
						log.debug("turn-hooks", `Assistant step ${assistantSeq} saved (with error) for session ${sessionId}`);
					}
				} else {
					const assistantSeq = turnSeq + 1;
					const existing = db.getTurns(sessionId).find(t => t.seq === assistantSeq);
					if (existing) {
						db.updateTurnContent(sessionId, assistantSeq, blocksJson);
					} else {
						db.appendTurn(sessionId, assistantSeq, "assistant", blocksJson);
					}
					log.debug("turn-hooks", `Assistant turn ${assistantSeq} saved (with error) for session ${sessionId}`);
				}
			}

			sessionTurnSeq.delete(sessionId);
		} catch (err) {
			log.error("turn-hooks", "StopFailure hook failed:", (err as Error).message);
		}
	});
}
