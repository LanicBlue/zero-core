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
// multimodal-input sub-4: live path persists the current turn's attachment
// META into turns.attachments (sub-2 column). sub-3's getMessagesMultimodal
// already reads this column on the rebuild path; this wiring makes the LIVE
// path (TurnStart → appendStep) write it so getMessagesMultimodal sees the
// current turn's attachments too. Bytes never enter here (principle A).
import type { AttachmentMeta } from "../../shared/types.js";
// Step 4A: turn_seq tracking consolidated into a single shared Map
// (turn-seq-tracker). turn-hooks re-exports the accessors so existing
// callers (agent-service, tests) keep their import paths; durable-hooks
// imports the tracker directly so both hooks operate on the same instance.
import { getTurnSeq, setTurnSeq, hasTurnSeq, deleteTurnSeq } from "./turn-seq-tracker.js";

export { getTurnSeq, setTurnSeq } from "./turn-seq-tracker.js";

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
			if (hasTurnSeq(sessionId)) {
				log.debug("turn-hooks", `Turn seq already set for session ${sessionId}, skipping user turn`);
				return;
			}

			const userMessage = ctx.userMessage as string;

			// multimodal-input sub-4: read the current turn's attachment META
			// off the TurnStart ctx (AgentLoop.run threaded it through from the
			// normalized UserContent) and persist it via appendStep →
			// turns.attachments. This is what sub-3's getMessagesMultimodal
			// reads to inline/annotate the CURRENT turn's attachments on the
			// LIVE path (sub-3 only covered rebuild). undefined for legacy
			// string-only callers → appendStep writes NULL (back-compat).
			const attachments = ctx.attachments as AttachmentMeta[] | undefined;

			// multimodal-input sub-4/sub-7: attachment-only sends (no text) are
			// permitted (ChatPanel allows Send with no text + ≥1 pending
			// attachment). The original guard `if (!userMessage) return;` skipped
			// writing the user step entirely on empty text — which also dropped
			// the turn's attachments (never persisted), so getMessagesMultimodal
			// could not inline/annotate them. Allow the step write through when
			// there are attachments even with empty text.
			if (!userMessage && (!attachments || attachments.length === 0)) return;

			const seq = db.getStepCount(sessionId);
			setTurnSeq(sessionId, seq);

			// Step 4A: step-only. The user row's turn_group = its own seq (a
			// user turn opens a new group); the legacy single-row write path is
			// retired.
			db.appendStep(sessionId, seq, seq, "user", userMessage, undefined, attachments);
			log.debug("turn-hooks", `User turn ${seq} saved for session ${sessionId}${attachments && attachments.length ? ` (${attachments.length} attachment(s))` : ""}`);
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

			const turnSeq = getTurnSeq(sessionId);
			if (turnSeq === undefined) return;

			// Safety net: if blocks are provided, ensure they're persisted as an
			// assistant step (abort may have occurred before finish-step).
			const blocks = ctx.blocks as any[] | undefined;
			if (blocks && blocks.length > 0) {
				// Step 2E: persist writes the truth; dangling synthesis moved to
				// rebuild (AgentSession.rebuildFromSteps). Serialize verbatim.
				const blocksJson = JSON.stringify(blocks);
				// Step 4A: step-only — write as a single assistant step (in the
				// current turn_group) if nothing has been persisted yet.
				const assistantSeq = turnSeq + 1;
				const existing = db.getSteps(sessionId).find(s => s.turnGroup === turnSeq && s.role === "assistant");
				if (!existing) {
					db.appendStep(sessionId, assistantSeq, turnSeq, "assistant", blocksJson);
					log.debug("turn-hooks", `Safety net: assistant step ${assistantSeq} saved for session ${sessionId}`);
				}
			}

			deleteTurnSeq(sessionId);
		} catch (err) {
			log.error("turn-hooks", "TurnEnd hook failed:", (err as Error).message);
		}
	});

	// ─── TurnEnd (turn-boundary closure): close the current turn_group and
	//     advance turn_seq so the next user input's TurnStart reads seq+1.
	//
	// Step 3B: turn_seq is read implicitly at TurnStart via db.getStepCount()
	// (the user-turn row written at TurnStart makes the next count higher).
	// The safety-net handler above only clears sessionTurnSeq when it actually
	// ran its persist path; this dedicated handler closes the boundary
	// UNCONDITIONALLY so the next TurnStart always re-reads a fresh count,
	// regardless of which TurnEnd path fired. It runs AFTER the safety net
	// (registered later → fired later), so the safety net still sees the seq.
	//
	// "Closing the turn_group" here means: clear the in-memory turn_seq marker
	// for this session. The recorder's own turn-group state is reset by the
	// next run()'s recorder.reset() + startTurnGroup(userSeq) pair, so there is
	// nothing to close on the recorder at TurnEnd (its blocks were already
	// either persisted by StepEnd or by the safety-net above).

	registry.register("TurnEnd", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;
			// Unconditional closure. Idempotent: deleting a missing key is fine,
			// and the safety-net handler may already have deleted it.
			deleteTurnSeq(sessionId);
		} catch (err) {
			log.error("turn-hooks", "TurnEnd closure hook failed:", (err as Error).message);
		}
	});

	// ─── TurnError: save whatever we have ─────────────────────
	// (Step 1C: StopFailure → TurnError.)

	registry.register("TurnError", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			if (!sessionId) return;

			const turnSeq = getTurnSeq(sessionId);
			if (turnSeq === undefined) return;

			// Keep whatever blocks we have — they represent actual work done
			const blocks = ctx.blocks as any[] | undefined;
			if (blocks && blocks.length > 0) {
				// Step 2E: persist writes the truth; dangling synthesis moved to
				// rebuild (AgentSession.rebuildFromSteps). Serialize verbatim.
				const blocksJson = JSON.stringify(blocks);
				// Step 4A: step-only — write as a single assistant step in the
				// current turn_group if nothing has been persisted yet.
				const assistantSeq = turnSeq + 1;
				const existing = db.getSteps(sessionId).find(s => s.turnGroup === turnSeq && s.role === "assistant");
				if (!existing) {
					db.appendStep(sessionId, assistantSeq, turnSeq, "assistant", blocksJson);
					log.debug("turn-hooks", `Assistant step ${assistantSeq} saved (with error) for session ${sessionId}`);
				}
			}

			deleteTurnSeq(sessionId);
		} catch (err) {
			log.error("turn-hooks", "TurnError hook failed:", (err as Error).message);
		}
	});
}
