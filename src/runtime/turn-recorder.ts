// 轮次记录器
//
// # 文件说明书
//
// ## 核心功能
// 记录流式输出的轮次数据，包括文本、思考和工具调用。
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
// TurnRecorder — collects streaming blocks and persists turns to the DB
// ---------------------------------------------------------------------------

import { parseThinkingTags } from "./agent-utils.js";
import type { ISessionStore } from "./session-store-interface.js";

/**
 * Manages the turnBlocks array during a streaming run and provides methods
 * to persist user / assistant turns to the session store.
 */
export class TurnRecorder {
	/** Collected blocks for the current assistant turn (text, thinking, tool). */
	blocks: any[] = [];

	// Internal accumulators for the current step (between tool calls)
	private currentStepThinking = "";
	private currentStepText = "";

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
	addToolStart(name: string, args: any): void {
		this.sealStep();
		this.blocks.push({ type: "tool", name, status: "running", args });
	}

	/** Record a successful tool result. */
	addToolResult(name: string, output: any): void {
		const tb = this.findRunningTool(name);
		if (tb) {
			tb.status = "done";
			tb.result = output;
		}
	}

	/** Record a tool error. */
	addToolError(name: string, errorText: string, output?: any): void {
		const tb = this.findRunningTool(name);
		if (tb) {
			tb.status = "error";
			tb.result = errorText ?? String(output);
		}
	}

	/** Flush any pending text/thinking into blocks (called before tool calls and at end). */
	sealStep(): void {
		if (this.currentStepThinking) {
			let t = this.currentStepThinking;
			while (t.charCodeAt(t.length - 1) === 10) t = t.substring(0, t.length - 1);
			if (t) this.blocks.push({ type: "thinking", text: t });
			this.currentStepThinking = "";
		this.markStepStart();
		}
		if (this.currentStepText) {
			for (const b of parseThinkingTags(this.currentStepText)) this.blocks.push(b);
			this.currentStepText = "";
		}
	}

	// -----------------------------------------------------------------------
	// Step boundary tracking for per-step usage
	private stepStartIndex = 0;

	/** Mark the start of a new step (called on sealStep). */
	markStepStart(): void {
		this.stepStartIndex = this.blocks.length;
	}

	/** Attach per-step token usage to the last block of the current step. */
	addStepUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): void {
		if (this.blocks.length === 0) return;
		// Find the last block from this step (tool or text/thinking)
		const lastBlock = this.blocks[this.blocks.length - 1];
		if (!lastBlock.stepUsage) {
			lastBlock.stepUsage = {
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				totalTokens: usage.totalTokens ?? 0,
			};
		}
	}

	// Persistence
	// -----------------------------------------------------------------------

	/** Append a user turn to the turns table. */
	saveUserTurn(db: ISessionStore, sessionId: string, text: string): void {
		if (!db || !sessionId) return;
		const seq = db.getTurnCount(sessionId);
		db.appendTurn(sessionId, seq, "user", text);
	}


	/**
	 * Persist the current blocks snapshot to the DB (incremental write).
	 * Called at tool-call / tool-result events and text thresholds during streaming.
	 */
	persistBlocksSnapshot(db: ISessionStore, sessionId: string, assistantSeq: number): void {
		if (!db || !sessionId || this.blocks.length === 0) return;
		db.upsertAssistantTurn(sessionId, assistantSeq, JSON.stringify(this.blocks));
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/** Reset state for a new run. */
	reset(): void {
		this.blocks = [];
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

	/** Find the most recent running tool block with the given name. */
	private findRunningTool(name: string): any | undefined {
		return [...this.blocks].reverse().find(
			(b: any) => b.type === "tool" && b.name === name && b.status === "running",
		);
	}
}
