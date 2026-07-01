// 持久化执行 Hook
//
// # 文件说明书
//
// ## 核心功能
// 将轮次状态检查点到数据库，确保 hook 事件持久化后可恢复
//
// ## 输入
// Hook 事件上下文、SessionDB 实例
//
// ## 输出
// 数据库中的轮次状态记录
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
// Durable execution hooks — checkpoint turn state to the database
// The first consumer of the hook system. Registered at startup.
// ---------------------------------------------------------------------------

// Per-session turn sequence tracking
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

	log.db("Durable checkpoint hooks registered");
}
