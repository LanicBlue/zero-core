// 轮次记录器
//
// # 文件说明书
//
// ## 核心功能
// 记录流式输出的轮次数据，包括文本、思考和工具调用。
// 按 step（一次 LLM API call）管理 blocks，每个 step 独立持久化。
//
// ## 输入
// - 流式事件
// - 会话存储
//
// ## 输出
// - 轮次数据
// - 工具调用记录
//
// ## 定位
// Runtime 记录器，被 AgentLoop 使用。
//
// ## 依赖
// - ./session-store-interface - 会话存储
// - ./agent-utils - 工具函数
//
// ## 维护规则
// - 新增事件类型时需更新
// - 保持记录准确性
//
// ---------------------------------------------------------------------------
// TurnRecorder — collects streaming blocks per step and persists to the DB
// ---------------------------------------------------------------------------

import { parseThinkingTags } from "./agent-utils.js";
import type { ISessionStore } from "./session-store-interface.js";

/** Data for a completed step, waiting for persistAllSteps(). */
interface StepData {
	blocks: any[];
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * Manages step-level blocks during a streaming run and provides methods
 * to persist user/assistant steps to the session store.
 *
 * External consumers still use `blocks` getter to get a merged view
 * of all blocks across steps (backward compatible).
 */
export class TurnRecorder {
	/** Blocks for the current (in-progress) step. */
	private currentStepBlocks: any[] = [];

	/** Completed steps awaiting final persist. */
	private completedSteps: StepData[] = [];

	/** Current turn group (set by startTurnGroup). */
	private currentTurnGroup = -1;

	/** Whether the current step has been persisted at least once. */
	private currentStepPersisted = false;

	// Internal accumulators for streaming deltas
	private currentStepThinking = "";
	private currentStepText = "";

	// -----------------------------------------------------------------------
	// Backward-compatible merged view
	// -----------------------------------------------------------------------

	/** Merged view of all blocks across completed steps + current step.
	 *  Used by getLoopState(), Stop hook, and UI streaming display. */
	get blocks(): any[] {
		const result: any[] = [];
		for (const s of this.completedSteps) {
			result.push(...s.blocks);
		}
		result.push(...this.currentStepBlocks);
		return result;
	}

	// -----------------------------------------------------------------------
	// Turn group management
	// -----------------------------------------------------------------------

	/** Start a new turn group. Resets all internal state. */
	startTurnGroup(turnGroup: number): void {
		this.currentTurnGroup = turnGroup;
		this.currentStepBlocks = [];
		this.completedSteps = [];
		this.currentStepPersisted = false;
		this.currentStepThinking = "";
		this.currentStepText = "";
	}

	/** Get the current turn group value. */
	getTurnGroup(): number {
		return this.currentTurnGroup;
	}

	/** Whether there is any unpersisted data (blocks in current step or completed steps). */
	hasUnpersistedData(): boolean {
		return this.currentStepBlocks.length > 0 || this.currentStepThinking.length > 0 || this.currentStepText.length > 0 || this.completedSteps.length > 0;
	}

	// -----------------------------------------------------------------------
	// Block accumulation
	// -----------------------------------------------------------------------

	/** Record that a text-delta was received. */
	addTextDelta(delta: string): void {
		this.currentStepText += delta;
	}

	/** Record that a reasoning-delta was received. */
	addThinkingDelta(delta: string): void {
		this.currentStepThinking += delta;
	}

	/** Record a tool-call start. Seals any pending text/thinking first. */
	addToolStart(name: string, args: any, toolCallId?: string): void {
		this.sealStep();
		this.currentStepBlocks.push({ type: "tool", name, status: "running", args, ...(toolCallId ? { toolCallId } : {}) });
	}

	/** Update a tool block when result arrives. Matches by toolCallId if provided, else by name. */
	updateToolResult(toolCallId: string | undefined, name: string, result: any, isError: boolean): void {
		const tb = this.findToolBlock(toolCallId, name);
		if (tb) {
			tb.status = isError ? "error" : "done";
			tb.result = result;
		}
	}

	/** Record a successful tool result (legacy API — matches by name only). */
	addToolResult(name: string, output: any): void {
		const tb = this.findToolBlock(undefined, name);
		if (tb) {
			tb.status = "done";
			tb.result = output;
		}
	}

	/** Record a tool error (legacy API — matches by name only). */
	addToolError(name: string, errorText: string, output?: any): void {
		const tb = this.findToolBlock(undefined, name);
		if (tb) {
			tb.status = "error";
			tb.result = errorText ?? String(output);
		}
	}

	/** Flush any pending text/thinking into currentStepBlocks.
	 *  Does NOT move currentStepBlocks into completedSteps — that happens on sealAndAdvanceStep(). */
	sealStep(): void {
		if (this.currentStepThinking) {
			let t = this.currentStepThinking;
			while (t.charCodeAt(t.length - 1) === 10) t = t.substring(0, t.length - 1);
			if (t) this.currentStepBlocks.push({ type: "thinking", text: t });
			this.currentStepThinking = "";
		}
		if (this.currentStepText) {
			for (const b of parseThinkingTags(this.currentStepText)) this.currentStepBlocks.push(b);
			this.currentStepText = "";
		}
	}

	/** Seal the current step, attach usage, and move it to completedSteps.
	 *  Called at finish-step event. */
	sealAndAdvanceStep(usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
		this.sealStep();
		if (this.currentStepBlocks.length > 0) {
			// Attach usage to the last block of this step
			if (usage) {
				const lastBlock = this.currentStepBlocks[this.currentStepBlocks.length - 1];
				if (!lastBlock.stepUsage) {
					lastBlock.stepUsage = {
						inputTokens: usage.inputTokens ?? 0,
						outputTokens: usage.outputTokens ?? 0,
						totalTokens: usage.totalTokens ?? 0,
					};
				}
			}
			this.completedSteps.push({
				blocks: this.currentStepBlocks,
				usage,
			});
		}
		this.currentStepBlocks = [];
		this.currentStepPersisted = false;
	}

	// -----------------------------------------------------------------------
	// Persistence
	// -----------------------------------------------------------------------

	/** Append a user turn as a step row. */
	saveUserTurn(db: ISessionStore, sessionId: string, text: string): void {
		if (!db || !sessionId) return;
		const seq = db.getTurnCount(sessionId);
		db.appendStep(sessionId, seq, seq, "user", text);
	}

	/** Persist the current in-progress step (for incremental streaming writes).
	 *  Uses upsertStep so it can be called repeatedly as deltas arrive.
	 *  Writes the merged view of ALL blocks (completedSteps + currentStep)
	 *  to maintain backward compatibility with streaming UI. */
	persistCurrentStep(db: ISessionStore, sessionId: string, seq: number): void {
		if (!db || !sessionId) return;
		this.sealStep();
		const allBlocks = this.blocks;
		if (allBlocks.length === 0) return;
		db.upsertStep(sessionId, seq, this.currentTurnGroup, "assistant", JSON.stringify(allBlocks));
		this.currentStepPersisted = true;
	}

	/** Persist all completed steps as individual rows.
	 *  Called at finish-step to write per-step rows with usage data.
	 *  baseSeq = the first seq for this turn group's assistant steps. */
	persistAllSteps(db: ISessionStore, sessionId: string, baseSeq: number): void {
		if (!db || !sessionId) return;
		this.sealStep();

		// Persist any completed steps that haven't been written yet
		for (let i = 0; i < this.completedSteps.length; i++) {
			const step = this.completedSteps[i];
			if (step.blocks.length > 0) {
				db.upsertStep(
					sessionId, baseSeq + i, this.currentTurnGroup,
					"assistant", JSON.stringify(step.blocks), step.usage,
				);
			}
		}

		// Persist current step
		if (this.currentStepBlocks.length > 0) {
			const stepIdx = this.completedSteps.length;
			db.upsertStep(
				sessionId, baseSeq + stepIdx, this.currentTurnGroup,
				"assistant", JSON.stringify(this.currentStepBlocks),
			);
			this.currentStepPersisted = true;
		}
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/** Reset state for a new run. */
	reset(): void {
		this.currentStepBlocks = [];
		this.completedSteps = [];
		this.currentTurnGroup = -1;
		this.currentStepPersisted = false;
		this.currentStepThinking = "";
		this.currentStepText = "";
	}

	/** Get a snapshot of tool-call blocks (for getState). */
	getToolCalls(): { name: string; status: string }[] {
		return this.blocks
			.filter((b: any) => b.type === "tool")
			.map((b: any) => ({ name: b.name, status: b.status }));
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/** Find a tool block by toolCallId (preferred) or by name+status=running. */
	private findToolBlock(toolCallId: string | undefined, name: string): any | undefined {
		if (toolCallId) {
			const found = [...this.blocks].reverse().find(
				(b: any) => b.type === "tool" && b.toolCallId === toolCallId,
			);
			if (found) return found;
		}
		return [...this.blocks].reverse().find(
			(b: any) => b.type === "tool" && b.name === name && b.status === "running",
		);
	}
}
