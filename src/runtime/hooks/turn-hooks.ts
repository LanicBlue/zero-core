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

/**
 * Step 2E: dangling synthesis for the safety-net persist path was previously
 * applied here in-place before serializing ctx.blocks. It has been moved to the
 * rebuild path (AgentSession.rebuildFromSteps): persist writes the truth (a
 * tool legitimately "running" mid-step stays running), rebuild synthesizes
 * [interrupted] for any dangling tool-call so the rebuilt messages always carry
 * a paired tool-result. The TurnEnd / TurnError handlers therefore serialize
 * the blocks verbatim.
 */

export function registerTurnHooks(db: ISessionStore, registry: HookRegistry = HookRegistry.getInstance()): void {

	// ─── TurnStart: write user turn as step row ─────────────
	// (Step 1C: renamed from SessionStart — this is a per-run concern, not
	// the new agent-service-fired instance-lifecycle SessionStart.)

	registry.register("TurnStart", async (ctx) => {
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
			log.error("turn-hooks", "TurnStart hook failed:", (err as Error).message);
		}
	});

	// ─── PostToolUse: per-tool result immediate persist (Step 2B) ────
	//
	// As soon as a tool finishes, upsert the current step row so the tool
	// block (with its result) is durable. This is the hard precondition for
	// case2 recovery (side effect committed → crash before StepEnd would
	// otherwise orphan the result). The AgentLoop fires PostToolUse BEFORE
	// calling recorder.updateToolResult, so we apply the result to the
	// recorder here first; AgentLoop's own updateToolResult call afterward
	// is an idempotent re-set with the same value.
	//
	// StepEnd still does the final per-step persist (with usage). Both paths
	// use upsertStep against the same row (stepBaseSeq + stepOffset) so they
	// are idempotent: the immediate write lands the tool result, StepEnd
	// rewrites the same row later with usage attached. No duplication.

	registry.register("PostToolUse", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			// Sub-agent tool calls carry sessionId=undefined (isolated from the
			// parent session); nothing to persist for them. Same guard as the
			// tool-execution audit hook.
			const recorder = ctx.recorder as TurnRecorder | undefined;
			const stepBaseSeq = ctx.stepBaseSeq as number | undefined;
			const stepOffset = ctx.stepOffset as number | undefined;
			if (!recorder || stepBaseSeq === undefined || stepOffset === undefined) return;

			// Apply the known result to the recorder's tool block so the
			// persisted row carries result + status (not "running").
			recorder.updateToolResult(
				ctx.toolCallId as string | undefined,
				ctx.toolName as string,
				ctx.result,
				(ctx.isError as boolean | undefined) ?? false,
			);

			recorder.persistCurrentStep(db, sessionId, stepBaseSeq + stepOffset);
			log.debug("turn-hooks", `PostToolUse: immediate persist for tool ${ctx.toolName}, session ${sessionId}, seq=${stepBaseSeq + stepOffset}`);
		} catch (err) {
			log.error("turn-hooks", "PostToolUse immediate-persist hook failed:", (err as Error).message);
		}
	});

	// ─── PostToolUseFailure: same immediate persist for failed tools (Step 2B)
	//
	// Mirror of PostToolUse for the failure path: persist the tool block with
	// status=error so a crash before StepEnd still records the failed result.

	registry.register("PostToolUseFailure", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			const recorder = ctx.recorder as TurnRecorder | undefined;
			const stepBaseSeq = ctx.stepBaseSeq as number | undefined;
			const stepOffset = ctx.stepOffset as number | undefined;
			if (!recorder || stepBaseSeq === undefined || stepOffset === undefined) return;

			recorder.updateToolResult(
				ctx.toolCallId as string | undefined,
				ctx.toolName as string,
				ctx.error as string,
				true,
			);

			recorder.persistCurrentStep(db, sessionId, stepBaseSeq + stepOffset);
			log.debug("turn-hooks", `PostToolUseFailure: immediate persist for tool ${ctx.toolName}, session ${sessionId}, seq=${stepBaseSeq + stepOffset}`);
		} catch (err) {
			log.error("turn-hooks", "PostToolUseFailure immediate-persist hook failed:", (err as Error).message);
		}
	});

	// ─── StepEnd: persist completed steps to DB ───────────────
	//
	// Fires on finish-step (per LLM API call completion) and once
	// more at finalizeStream for any trailing blocks.
	// AgentLoop owns recorder state + stepOffset; this hook only
	// handles the DB write. (Step 1C: renamed from PostStep.)
	//
	// Step 2B note: PostToolUse/PostToolUseFailure hooks above have already
	// upserted the current step row per tool. This handler rewrites the
	// per-step rows with usage attached (idempotent via upsertStep).

	registry.register("StepEnd", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			const recorder = ctx.recorder as TurnRecorder | undefined;
			const stepBaseSeq = ctx.stepBaseSeq as number | undefined;

			if (recorder && stepBaseSeq !== undefined && stepBaseSeq >= 0) {
				recorder.persistAllSteps(db, sessionId, stepBaseSeq);
				log.debug("turn-hooks", `StepEnd: persisted steps for session ${sessionId}, baseSeq=${stepBaseSeq}, offset=${ctx.stepOffset}`);
			}
		} catch (err) {
			log.error("turn-hooks", "StepEnd hook failed:", (err as Error).message);
		}
	});

	// ─── TurnEnd: safety net for final assistant step ───────────
	//
	// Normally, StepEnd hook persists steps incrementally during streaming.
	// This hook is a safety net for cases where abort occurs before
	// finish-step fires (e.g., user abort, timeout). (Step 1C: Stop → TurnEnd.)

	registry.register("TurnEnd", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;

			// Safety net: if blocks are provided and we have step-level storage,
			// ensure they're persisted (abort may have occurred before finish-step)
			const blocks = ctx.blocks as any[] | undefined;
			if (blocks && blocks.length > 0) {
				// Step 2E: persist writes the truth; dangling synthesis moved to
				// rebuild (AgentSession.rebuildFromSteps). Serialize verbatim.
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
			log.error("turn-hooks", "TurnEnd hook failed:", (err as Error).message);
		}
	});

	// ─── TurnError: save whatever we have ─────────────────────
	// (Step 1C: StopFailure → TurnError.)

	registry.register("TurnError", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			const turnSeq = sessionTurnSeq.get(sessionId);
			if (turnSeq === undefined) return;

			// Keep whatever blocks we have — they represent actual work done
			const blocks = ctx.blocks as any[] | undefined;
			if (blocks && blocks.length > 0) {
				// Step 2E: persist writes the truth; dangling synthesis moved to
				// rebuild (AgentSession.rebuildFromSteps). Serialize verbatim.
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
			log.error("turn-hooks", "TurnError hook failed:", (err as Error).message);
		}
	});
}
