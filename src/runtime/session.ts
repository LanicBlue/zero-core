import type { ModelMessage } from "ai";
import { getSessionDB } from "./db-access.js";

const DEFAULT_CONTEXT_WINDOW = 128000;
const RESERVE_TOKENS = 16384;

export class AgentSession {
	private messages: ModelMessage[] = [];
	private readonly systemPrompt: string;
	private readonly contextWindow: number;
	private sessionId: string | null = null;

	constructor(
		systemPrompt: string,
		contextWindow?: number,
		sessionId?: string,
	) {
		this.systemPrompt = systemPrompt;
		this.contextWindow = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		this.sessionId = sessionId ?? null;

		const db = getSessionDB();
		if (db && this.sessionId) {
			this.messages = db.getMessages(this.sessionId);
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
		const db = getSessionDB();
		if (db && this.sessionId) {
			db.saveTurn(this.sessionId, this.messages);
		}
	}

	pruneIfNeeded(): void {
		const total = this.estimateTokens();
		if (total <= this.contextWindow - RESERVE_TOKENS) return;

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
	}

	rebuildFromTurns(): ModelMessage[] {
		const db = getSessionDB();
		if (!db || !this.sessionId) return [];
		const turns = db.getTurns(this.sessionId);
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
		const toolResults: { id: string; output: any; isError?: boolean }[] = [];
		const textParts: string[] = [];

		for (const b of blocks) {
			if (b.type === "tool") {
				const id = "tc-" + toolCalls.length;
				toolCalls.push({ id, name: b.name, input: b.args ?? {} });
				const result = typeof b.result === "string" ? b.result : JSON.stringify(b.result ?? "");
				toolResults.push({ id, output: result, isError: b.status === "error" });
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
					content: [{ type: "tool-result", toolCallId: tr.id, output: tr.output, isError: tr.isError }],
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
}
