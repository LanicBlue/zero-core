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
			this.messages = this.normalizeMessages(this.db.getMessages(this.sessionId));
			if (this.messages.length === 0) {
				this.messages = this.rebuildFromTurns();
			}
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

	addMessage(msg: ModelMessage): void {
		this.messages.push(msg);
	}

	saveToDb(): void {
		if (this.db && this.sessionId) {
			this.db.saveTurn(this.sessionId, this.messages);
		}
	}

	pruneIfNeeded(): void {
		const total = this.estimateTokens();
		if (total <= this.contextWindow - RESERVE_TOKENS) return;

		triggerHooks("PreCompact", { sessionId: this.sessionId ?? "", messageCount: this.messages.length, estimatedTokens: this.estimateTokens(), contextWindow: this.contextWindow });

		const keepTokens = this.contextWindow - RESERVE_TOKENS;
		let budget = keepTokens;
		const kept: ModelMessage[] = [];

		for (let i = this.messages.length - 1; i >= 0; i--) {
			const cost = this.estimateMessageTokens(this.messages[i]);
			if (budget - cost < 0) break;
			budget -= cost;
			kept.unshift(this.messages[i]);
		}

		this.messages = kept;

		triggerHooks("PostCompact", { sessionId: this.sessionId ?? "", messageCount: this.messages.length, estimatedTokens: this.estimateTokens(), contextWindow: this.contextWindow });
	}

	/** Aggressively prune: keep only the last keepRatio of messages (by token budget). */
	aggressivePrune(keepRatio: number): void {
		const keepTokens = Math.floor((this.contextWindow - RESERVE_TOKENS) * keepRatio);
		let budget = keepTokens;
		const kept: ModelMessage[] = [];
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const cost = this.estimateMessageTokens(this.messages[i]);
			if (budget - cost < 0) break;
			budget -= cost;
			kept.unshift(this.messages[i]);
		}
		this.messages = kept;
	}

	rebuildFromTurns(): ModelMessage[] {
		if (!this.db || !this.sessionId) return [];
		const turns = this.db.getTurns(this.sessionId);
		if (turns.length === 0) return [];

		const messages: ModelMessage[] = [];
		let toolCallIdx = 0;

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
				const id = b.toolCallId ?? "tc-" + toolCalls.length;
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
	reset(): void {
		this.messages = [];
	}

	private estimateTokens(): number {
		let total = 0;
		for (const msg of this.messages) {
			total += this.estimateMessageTokens(msg);
		}
		return total;
	}

	private estimateMessageTokens(msg: ModelMessage): number {
		const json = JSON.stringify(msg);
		return Math.ceil(json.length / 4);
	}

	/**
	 * Normalize message format: AI SDK v6 response.messages uses `args` in
	 * tool-call parts, but ToolCallPart expects `input`. Convert so the SDK
	 * can parse tool arguments when messages are passed back to streamText().
	 */
	private normalizeMessages(msgs: ModelMessage[]): ModelMessage[] {
		const toolNameMap = new Map<string, string>();
		for (const msg of msgs) {
			if (msg.role === "assistant" && Array.isArray((msg as any).content)) {
				for (const part of (msg as any).content) {
					if (part.type === "tool-call") {
						if ("args" in part && !("input" in part)) part.input = part.args;
						if (part.toolName && part.toolCallId) toolNameMap.set(part.toolCallId, part.toolName);
					}
				}
			}
		}
		for (const msg of msgs) {
			if ((msg as any).role === "tool" && Array.isArray((msg as any).content)) {
				for (const part of (msg as any).content) {
					if (part.type === "tool-result") {
						if (!part.toolName && part.toolCallId) part.toolName = toolNameMap.get(part.toolCallId) ?? "unknown";
						// AI SDK v6 requires output to be { type, value }, not plain string
						if (typeof part.output === "string") {
							part.output = { type: "text", value: part.output };
						} else if (part.output != null && typeof part.output === "object" && !("type" in (part.output as any))) {
							part.output = { type: "json", value: part.output };
						}
					}
				}
			}
		}
		return msgs;
	}
}