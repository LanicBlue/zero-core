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

	/**
	 * Step 2E: stamp the delegated taskId onto the tool-call block identified by
	 * `toolCallId`. Persists with the step row so the parent resume path can
	 * resolve a dangling Agent tool-call → its delegated task. Matches by
	 * toolCallId (preferred) or by the most recent running tool block of `name`.
	 * Best-effort — no-op if the block isn't found (e.g. recorder was reset).
	 */
	setToolBlockTaskId(toolCallId: string | undefined, name: string | undefined, taskId: string): void {
		let tb: any | undefined;
		if (toolCallId) {
			tb = [...this.currentStepBlocks].reverse().find(
				(b: any) => b.type === "tool" && b.toolCallId === toolCallId,
			);
		}
		if (!tb && name) {
			tb = [...this.currentStepBlocks].reverse().find(
				(b: any) => b.type === "tool" && b.name === name && b.status === "running",
			);
		}
		if (tb) tb.taskId = taskId;
	}

	/**
	 * sub-9 (durable relative-timeout Wait): stamp the wall-clock startedAt onto
	 * a Wait tool-call block, as a block-level field SIBLING to `args` (not
	 * inside args — args is the tool's input, startedAt is execution metadata).
	 * Persisted with the step row so the resume path can compute remaining
	 * `timeout` across a restart. Mirrors setToolBlockTaskId. Best-effort no-op
	 * when the block isn't found (recorder reset / no current step).
	 */
	setToolBlockStartedAt(toolCallId: string | undefined, name: string | undefined, startedAt: number): void {
		let tb: any | undefined;
		if (toolCallId) {
			tb = [...this.currentStepBlocks].reverse().find(
				(b: any) => b.type === "tool" && b.toolCallId === toolCallId,
			);
		}
		if (!tb && name) {
			tb = [...this.currentStepBlocks].reverse().find(
				(b: any) => b.type === "tool" && b.name === name && b.status === "running",
			);
		}
		if (tb) tb.startedAt = startedAt;
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

	/**
	 * Step 2E: synthesize a result for every dangling tool block — i.e. any
	 * tool block still in status "running" with no result. A tool block reaches
	 * this state legitimately mid-step (a tool that is still executing), or on
	 * abort when an unfinished tool block couldn't be resumed.
	 *
	 * Persist paths write the TRUTH (a running tool stays "running"), so callers
	 * that persisted mid-step keep an accurate record. This method is therefore
	 * NOT called from persistCurrentStep / persistAllSteps. It is invoked only
	 * where a finished record is genuinely needed (kept available for the
	 * rebuild path; see AgentSession.rebuildFromSteps which synthesizes on read
	 * so the rebuilt messages always carry a paired tool-result). Idempotent —
	 * blocks that already have a result are untouched.
	 */
	synthesizeDanglingToolResults(): void {
		for (const b of this.currentStepBlocks) {
			if (b?.type === "tool" && b.status === "running" && b.result === undefined) {
				b.status = "error";
				b.result = "[interrupted]";
			}
		}
		for (const step of this.completedSteps) {
			for (const b of step.blocks) {
				if (b?.type === "tool" && b.status === "running" && b.result === undefined) {
					b.status = "error";
					b.result = "[interrupted]";
				}
			}
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
		// Step 2E: persist writes the TRUTH. A tool block legitimately stays
		// "running" mid-step (the tool is still executing) and must NOT be
		// synthesized to [interrupted] here — that would prematurely mark a
		// still-running tool as failed and break the per-tool-persist invariant.
		// Dangling synthesis happens at rebuild time (AgentSession.rebuildFromSteps),
		// which guarantees the rebuilt messages always carry a paired tool-result
		// without corrupting the persisted truth.
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
		// Step 2E: persist writes the truth; dangling synthesis is a rebuild
		// concern (see persistCurrentStep above), not a persist concern.

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

	/**
	 * Step 2C: discard the current (in-progress) step's partial state WITHOUT
	 * touching completed steps. Called before retrying a step whose model call
	 * failed mid-stream, so the retried attempt does not inherit orphaned
	 * text/thinking/tool blocks from the failed attempt. completedSteps (prior
	 * successful steps) are preserved — only the failed step is reset.
	 */
	resetCurrentStep(): void {
		this.currentStepBlocks = [];
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
