import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ZeroCoreConfig } from "./config.js";

// Rough token estimation: ~4 chars per token for English text.
function estimateTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		if ("content" in msg && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if ("text" in block && typeof block.text === "string") {
					total += Math.ceil(block.text.length / 4);
				}
			}
		}
	}
	return total;
}

export function shouldPrune(config: ZeroCoreConfig, messages: AgentMessage[]): boolean {
	const maxTokens = config.context.maxTokens;
	if (!maxTokens) return false;
	return estimateTokens(messages) > maxTokens - (config.context.reserveTokens ?? 16384);
}

export function pruneMessages(config: ZeroCoreConfig, messages: AgentMessage[]): AgentMessage[] {
	const strategy = config.context.pruningStrategy ?? "turn-boundary";
	const keepRecent = config.context.keepRecentTokens ?? 20000;

	if (strategy === "tail") {
		return pruneTail(messages, keepRecent);
	}

	return pruneTurnBoundary(messages, keepRecent);
}

function pruneTail(messages: AgentMessage[], keepRecentTokens: number): AgentMessage[] {
	let tokenBudget = keepRecentTokens;
	const kept: AgentMessage[] = [];

	for (let i = messages.length - 1; i >= 0; i--) {
		const msgTokens = estimateTokens([messages[i]]);
		if (tokenBudget - msgTokens < 0) break;
		tokenBudget -= msgTokens;
		kept.unshift(messages[i]);
	}

	// Always keep the first message if it's a system-like prompt
	if (kept.length > 0 && kept[0] !== messages[0] && messages[0].role === "user") {
		// Don't inject stale first messages
	}

	return kept;
}

function pruneTurnBoundary(messages: AgentMessage[], keepRecentTokens: number): AgentMessage[] {
	let tokenBudget = keepRecentTokens;
	const kept: AgentMessage[] = [];

	// Walk backwards, keeping complete turns (assistant + following toolResults)
	for (let i = messages.length - 1; i >= 0; i--) {
		const msgTokens = estimateTokens([messages[i]]);
		if (tokenBudget - msgTokens < 0) break;
		tokenBudget -= msgTokens;
		kept.unshift(messages[i]);
	}

	return kept;
}
