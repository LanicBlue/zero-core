// Turn 持久化 Hook
//
// # 文件说明书
//
// ## 核心功能
// 通过 Hook 系统处理所有 turn 持久化，取代 CheckpointManager 的直接 DB 写入
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
// core/hook-registry.ts、session-store-interface.ts、core/logger.ts
//
// ## 维护规则
// turns 表只通过此 hook 写入，AgentLoop 不直接访问 DB
//
import { HookRegistry } from "../../core/hook-registry.js";
import type { ISessionStore } from "../session-store-interface.js";
import { log } from "../../core/logger.js";

// Per-session turn sequence tracking
const sessionTurnSeq = new Map<string, number>();

export function getTurnSeq(sessionId: string): number | undefined {
	return sessionTurnSeq.get(sessionId);
}

export function setTurnSeq(sessionId: string, seq: number): void {
	sessionTurnSeq.set(sessionId, seq);
}

export function registerTurnHooks(db: ISessionStore): void {
	const registry = HookRegistry.getInstance();

	// ─── SessionStart: write user turn ──────────────────────────

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
			db.appendTurn(sessionId, seq, "user", userMessage);
			log.debug("turn-hooks", `User turn ${seq} saved for session ${sessionId}`);
		} catch (err) {
			log.error("turn-hooks", "SessionStart hook failed:", (err as Error).message);
		}
	});

	// ─── Stop: write final assistant turn ───────────────────────

	registry.register("Stop", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;

			// Write final assistant blocks
			const blocks = ctx.blocks as any[] | undefined;
			if (blocks && blocks.length > 0) {
				const blocksJson = JSON.stringify(blocks);
				const assistantSeq = turnSeq + 1;
				const existing = db.getTurns(sessionId).find(t => t.seq === assistantSeq);
				if (existing) {
					db.updateTurnContent(sessionId, assistantSeq, blocksJson);
				} else {
					db.appendTurn(sessionId, assistantSeq, "assistant", blocksJson);
				}
				log.debug("turn-hooks", `Assistant turn ${assistantSeq} saved (${blocks.length} blocks) for session ${sessionId}`);
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
				const assistantSeq = turnSeq + 1;
				const existing = db.getTurns(sessionId).find(t => t.seq === assistantSeq);
				if (existing) {
					db.updateTurnContent(sessionId, assistantSeq, blocksJson);
				} else {
					db.appendTurn(sessionId, assistantSeq, "assistant", blocksJson);
				}
				log.debug("turn-hooks", `Assistant turn ${assistantSeq} saved (with error) for session ${sessionId}`);
			}

			sessionTurnSeq.delete(sessionId);
		} catch (err) {
			log.error("turn-hooks", "StopFailure hook failed:", (err as Error).message);
		}
	});
}
