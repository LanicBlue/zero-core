// Agent 会话管理
//
// # 文件说明书
//
// ## 核心功能
// Agent 会话类，管理消息历史、token 计算和上下文窗口。
//
// ## 输入
// - 系统提示词
// - 上下文窗口大小
//
// ## 输出
// - 消息历史
// - token 使用统计
//
// ## 定位
// Runtime 会话管理，被 AgentLoop 使用。
//
// ## 依赖
// - ai - AI SDK 类型
// - ./session-store-interface - 会话存储
// - ../core/hook-registry - Hook 触发
//
// ## 维护规则
// - token 计算逻辑变更时需更新
// - 保持消息修剪策略正确
//
import type { ModelMessage } from "ai";
import type { ISessionStore } from "./session-store-interface.js";
import { triggerHooks } from "../core/hook-registry.js";

const DEFAULT_CONTEXT_WINDOW = 128000;
const RESERVE_TOKENS = 16384;

export class AgentSession {
	private messages: ModelMessage[] = [];
	private readonly systemPrompt: string;
	private readonly contextWindow: number;
	private sessionId: string | null = null;
	private db: ISessionStore | null;

	/** Cached raw turns from DB — populated by rebuildFromTurns(), used as runtime source for UI. */
	private cachedTurns: Array<{ seq: number; role: string; content: string | null; createdAt: string }> = [];

	/** Calibrated token count from last API response. null = no calibration yet. */
	private lastActualInputTokens: number | null = null;
	/** How many messages were in the session when calibration was recorded. */
	private messageCountAtCalibration: number = 0;

	constructor(
		systemPrompt: string,
		contextWindow?: number,
		sessionId?: string,
		db?: ISessionStore,
	) {
		this.systemPrompt = systemPrompt;
		this.contextWindow = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		this.sessionId = sessionId ?? null;
		this.db = db ?? null;

		if (this.db && this.sessionId) {
			// Always rebuild from turns table (single source of truth).
			// The messages table is a write-through cache, not authoritative.
			this.messages = this.normalizeMessages(this.rebuildFromTurns());
		}
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	getSystemPrompt(): string {
		return this.systemPrompt;
	}

	getMessages(): ModelMessage[] {
		return this.messages;
	}

	/** Cached raw turns from DB (populated by rebuildFromTurns). Used as runtime source for UI. */
	/** Refresh the cached turns from DB (e.g. before UI session_init). */
	refreshTurnsCache(): void {
		if (!this.db || !this.sessionId) return;
		this.cachedTurns = this.db.getTurns(this.sessionId);
	}

	getTurns(): Array<{ seq: number; role: string; content: string | null; createdAt: string }> {
		return this.cachedTurns;
	}

	addMessage(msg: ModelMessage): void {
		this.messages.push(msg);
	}

	replaceMessages(messages: ModelMessage[]): void {
		this.messages = messages;
		this.invalidateCalibration();
	}

	getContextUsage(): number {
		const total = this.estimateTokens();
		return this.contextWindow > 0 ? total / this.contextWindow : 0;
	}

	getContextWindow(): number {
		return this.contextWindow;
	}

	getEstimatedTokens(): number {
		return this.estimateTokens();
	}

	saveToDb(): void {
		if (this.db && this.sessionId) {
			this.db.saveTurn(this.sessionId, this.messages);
		}
	}

	pruneIfNeeded(): void {
		const systemPromptTokens = this.estimateSystemPromptTokens();
		const available = this.contextWindow - RESERVE_TOKENS - systemPromptTokens;
		const total = this.estimateTokens();
		if (total <= available) return;

		triggerHooks("PreCompact", { sessionId: this.sessionId ?? "", messageCount: this.messages.length, estimatedTokens: this.estimateTokens(), contextWindow: this.contextWindow });

		let budget = available;
		const kept: ModelMessage[] = [];

		for (let i = this.messages.length - 1; i >= 0; i--) {
			const cost = this.estimateMessageTokens(this.messages[i]);
			if (budget - cost < 0) break;
			budget -= cost;
			kept.unshift(this.messages[i]);
		}

		this.messages = kept;
		this.invalidateCalibration();

		triggerHooks("PostCompact", { sessionId: this.sessionId ?? "", messageCount: this.messages.length, estimatedTokens: this.estimateTokens(), contextWindow: this.contextWindow });
	}

	/** Aggressively prune: keep only the last keepRatio of messages (by token budget). */
	aggressivePrune(keepRatio: number): void {
		const available = this.contextWindow - RESERVE_TOKENS - this.estimateSystemPromptTokens();
		const keepTokens = Math.floor(available * keepRatio);
		let budget = keepTokens;
		const kept: ModelMessage[] = [];
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const cost = this.estimateMessageTokens(this.messages[i]);
			if (budget - cost < 0) break;
			budget -= cost;
			kept.unshift(this.messages[i]);
		}
		this.messages = kept;
		this.invalidateCalibration();
	}

	rebuildFromTurns(): ModelMessage[] {
		if (!this.db || !this.sessionId) return [];
		this.cachedTurns = this.db.getTurns(this.sessionId);
		if (this.cachedTurns.length === 0) return [];
		const turns = this.cachedTurns;

		const messages: ModelMessage[] = [];

		for (const turn of turns) {
			if (turn.role === "user") {
				messages.push({ role: "user", content: turn.content ?? "" });
			} else if (turn.role === "assistant") {
				let blocks: any[] = [];
				try { blocks = JSON.parse(turn.content ?? "[]"); } catch { blocks = []; }
				this.appendAssistantMessages(blocks, messages);
			}
		}

		return messages;
	}

	private appendAssistantMessages(blocks: any[], messages: ModelMessage[]): void {
		const toolCalls: { id: string; name: string; input: any }[] = [];
		const toolResults: { id: string; name: string; output: any; isError?: boolean }[] = [];
		const textParts: string[] = [];

		for (const b of blocks) {
			if (b.type === "tool") {
				// Always regenerate toolCallId to avoid provider-specific ID formats
				// (e.g. MiniMax's "call_function_xxx_N") that APIs reject across sessions
				const id = "tc-" + toolCalls.length;
				toolCalls.push({ id, name: b.name, input: b.args ?? {} });
				const result = typeof b.result === "string" ? b.result : JSON.stringify(b.result ?? "");
				toolResults.push({ id, name: b.name, output: result, isError: b.status === "error" });
			} else if (b.type === "text") {
				textParts.push(b.text);
			}
		}

		// Build assistant message parts
		const parts: any[] = [];
		if (toolCalls.length > 0) {
			parts.push(...toolCalls.map((tc) => ({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, input: tc.input })));
		}
		const textContent = textParts.join("").trim();
		if (textContent) {
			parts.push({ type: "text", text: textContent });
		}

		if (parts.length > 0) {
			messages.push({ role: "assistant", content: parts });
		}

		// Add tool results as separate tool messages
		if (toolResults.length > 0) {
			for (const tr of toolResults) {
				messages.push({
					role: "tool",
					content: [{ type: "tool-result", toolCallId: tr.id, toolName: tr.name, output: typeof tr.output === "string" ? { type: "text", value: tr.output } : { type: "json", value: tr.output } }],
				} as any);
			}
		}
	}

		/** Extract turn blocks from an assistant message's content parts. */private extractBlocks(msg: ModelMessage): any[] {
		const blocks: any[] = [];
		const content = (msg as any).content;
		if (!Array.isArray(content)) {
			if (typeof content === "string" && content) {
				blocks.push({ type: "text", text: content });
			}
			return blocks;
		}

		// Group tool-call and tool-result pairs
		for (const part of content) {
			if (part.type === "text" && part.text) {
				blocks.push({ type: "text", text: part.text });
			} else if (part.type === "tool-call") {
				// Find matching tool result from subsequent tool messages
				const resultMsg = this.findToolResult(part.toolCallId);
				const result = resultMsg
					? this.extractToolResultText(resultMsg)
					: "";
				blocks.push({
					type: "tool",
					name: part.toolName,
					args: part.input ?? part.args,
					result,
					status: result ? "done" : "error",
					toolCallId: part.toolCallId,
				});
			}
		}
		return blocks;
	}

	/** Find the tool message containing the result for a given toolCallId. */
	private findToolResult(toolCallId: string): ModelMessage | undefined {
		for (const msg of this.messages) {
			if ((msg as any).role !== "tool") continue;
			const parts = (msg as any).content;
			if (!Array.isArray(parts)) continue;
			for (const p of parts) {
				if (p.type === "tool-result" && p.toolCallId === toolCallId) {
					return msg;
				}
			}
		}
		return undefined;
	}

	/** Extract text from a tool-result message's output. */
	private extractToolResultText(msg: ModelMessage): string {
		const parts = (msg as any).content;
		if (!Array.isArray(parts)) return "";
		for (const p of parts) {
			if (p.type === "tool-result") {
				if (typeof p.output === "string") return p.output;
				if (p.output?.type === "text" && typeof p.output.value === "string") return p.output.value;
				if (p.output?.type === "json") return JSON.stringify(p.output.value);
				if (p.output != null) return JSON.stringify(p.output);
			}
		}
		return "";
	}

	reset(): void {
		this.messages = [];
		this.invalidateCalibration();
	}

	calibrateFromActualUsage(actualInputTokens: number): void {
		this.lastActualInputTokens = actualInputTokens;
		this.messageCountAtCalibration = this.messages.length;
	}

	private estimateTokens(): number {
		if (this.lastActualInputTokens !== null) {
			// Use calibrated value + heuristic delta for messages added since last API call
			if (this.messages.length <= this.messageCountAtCalibration) {
				return this.lastActualInputTokens;
			}
			const delta = this.messages.slice(this.messageCountAtCalibration)
				.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
			return this.lastActualInputTokens + delta;
		}
		return this.messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
	}

	private estimateMessageTokens(msg: ModelMessage): number {
		const json = JSON.stringify(msg);
		return Math.ceil(json.length / 4) + 4;
	}

	private estimateSystemPromptTokens(): number {
		return Math.ceil(this.systemPrompt.length / 4) + 4;
	}

	private invalidateCalibration(): void {
		this.lastActualInputTokens = null;
		this.messageCountAtCalibration = 0;
	}

	/**
	 * Normalize message format for AI SDK compatibility:
	 * 1. Convert args → input (AI SDK v6)
	 * 2. Fix tool-result output format
	 * 3. Strip orphaned tool results (no matching tool-call)
	 * 4. Deduplicate consecutive identical user messages
	 */
	private normalizeMessages(msgs: ModelMessage[]): ModelMessage[] {
		// Pass 1: Collect tool-call IDs
		const toolCallIds = new Set<string>();
		for (const msg of msgs) {
			if (msg.role === "assistant" && Array.isArray((msg as any).content)) {
				for (const part of (msg as any).content) {
					if (part.type === "tool-call") {
						if ("args" in part && !("input" in part)) part.input = part.args;
						if (part.toolCallId) toolCallIds.add(part.toolCallId);
					}
				}
			}
		}

		// Pass 2: Fix tool-result format and strip orphans
		for (const msg of msgs) {
			if ((msg as any).role === "tool" && Array.isArray((msg as any).content)) {
				const kept: any[] = [];
				for (const part of (msg as any).content) {
					if (part.type === "tool-result") {
						if (!part.toolCallId || !toolCallIds.has(part.toolCallId)) {
							// Orphaned — skip entirely to avoid provider errors
							continue;
						}
						if (!part.toolName && part.toolCallId) part.toolName = "unknown";
						if (typeof part.output === "string") {
							part.output = { type: "text", value: part.output };
						} else if (part.output != null && typeof part.output === "object" && !("type" in (part.output as any))) {
							part.output = { type: "json", value: part.output };
						}
						kept.push(part);
					} else {
						kept.push(part);
					}
				}
				(msg as any).content = kept;
			}
		}

		// Pass 3: Remove empty tool messages, deduplicate user messages
		const result: ModelMessage[] = [];
		for (const msg of msgs) {
			// Skip empty tool messages
			if ((msg as any).role === "tool") {
				const parts = (msg as any).content;
				if (Array.isArray(parts) && parts.length === 0) continue;
			}

			// Deduplicate consecutive identical user messages
			if (msg.role === "user" && typeof (msg as any).content === "string") {
				const last = result[result.length - 1];
				if (last && last.role === "user" && typeof (last as any).content === "string" && (last as any).content === (msg as any).content) {
					continue;
				}
			}

			result.push(msg);
		}

		return result;
	}
}
