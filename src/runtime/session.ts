import type { ModelMessage } from "ai";
import type { SessionDB } from "../server/session-db.js";

const DEFAULT_CONTEXT_WINDOW = 128000;
const RESERVE_TOKENS = 16384;

export class AgentSession {
	private messages: ModelMessage[] = [];
	private readonly systemPrompt: string;
	private readonly contextWindow: number;
	private sessionId: string | null = null;
	private db: SessionDB | null = null;

	constructor(
		systemPrompt: string,
		contextWindow?: number,
		db?: SessionDB,
		sessionId?: string,
	) {
		this.systemPrompt = systemPrompt;
		this.contextWindow = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		this.db = db ?? null;
		this.sessionId = sessionId ?? null;

		if (this.db && this.sessionId) {
			this.messages = this.db.getMessages(this.sessionId);
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
