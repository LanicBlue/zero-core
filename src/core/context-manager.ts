import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		if ("content" in msg && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if ("text" in block && typeof block.text === "string") {
					total += Math.ceil(block.text.length / 4);
				}
			}
		} else if ("content" in msg && typeof msg.content === "string") {
			total += Math.ceil(msg.content.length / 4);
		}
	}
	return total;
}

function messageTokens(msg: AgentMessage): number {
	return estimateTokens([msg]);
}

// ---------------------------------------------------------------------------
// Should we prune?
// ---------------------------------------------------------------------------

export function shouldPrune(config: ZeroCoreConfig, messages: AgentMessage[]): boolean {
	const maxTokens = config.context.maxTokens;
	if (!maxTokens) return false;
	return estimateTokens(messages) > maxTokens - (config.context.reserveTokens ?? 16384);
}

// ---------------------------------------------------------------------------
// Prune dispatch
// ---------------------------------------------------------------------------

export function pruneMessages(config: ZeroCoreConfig, messages: AgentMessage[]): AgentMessage[] {
	const strategy = config.context.pruningStrategy ?? "turn-boundary";
	const keepRecent = config.context.keepRecentTokens ?? 20000;

	if (strategy === "tail") {
		return pruneTail(messages, keepRecent, config);
	}

	if (strategy === "smart") {
		return pruneSmart(messages, keepRecent, config);
	}

	return pruneTurnBoundary(messages, keepRecent, config);
}

// ---------------------------------------------------------------------------
// Tail strategy — keep last N tokens
// ---------------------------------------------------------------------------

function pruneTail(messages: AgentMessage[], keepRecentTokens: number, config: ZeroCoreConfig): AgentMessage[] {
	let tokenBudget = keepRecentTokens;
	const kept: AgentMessage[] = [];

	for (let i = messages.length - 1; i >= 0; i--) {
		const cost = messageTokens(messages[i]);
		if (tokenBudget - cost < 0) break;
		tokenBudget -= cost;
		kept.unshift(messages[i]);
	}

	return applyPreserveToolResults(kept, messages, config);
}

// ---------------------------------------------------------------------------
// Turn-boundary strategy — keep complete turns
// ---------------------------------------------------------------------------

function pruneTurnBoundary(messages: AgentMessage[], keepRecentTokens: number, config: ZeroCoreConfig): AgentMessage[] {
	let tokenBudget = keepRecentTokens;
	const kept: AgentMessage[] = [];

	for (let i = messages.length - 1; i >= 0; i--) {
		const cost = messageTokens(messages[i]);
		if (tokenBudget - cost < 0) break;
		tokenBudget -= cost;
		kept.unshift(messages[i]);
	}

	// Snap to turn boundary: if first kept message is a toolResult, include its assistant message
	if (kept.length > 0 && kept[0].role === "toolResult") {
		const toolCallId = (kept[0] as { toolCallId: string }).toolCallId;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "assistant") {
				const content = (messages[i] as { content: unknown[] }).content;
				if (content?.some((b) => (b as Record<string, unknown>).type === "toolCall" && (b as { id: string }).id === toolCallId)) {
					// Already included?
					if (!kept.includes(messages[i])) {
						const cost = messageTokens(messages[i]);
						if (tokenBudget - cost >= 0) {
							kept.unshift(messages[i]);
						}
					}
					break;
				}
			}
		}
	}

	return applyPreserveToolResults(kept, messages, config);
}

// ---------------------------------------------------------------------------
// Smart strategy — importance scoring
// ---------------------------------------------------------------------------

interface ScoredMessage {
	msg: AgentMessage;
	index: number;
	score: number;
	tokens: number;
}

function scoreMessage(msg: AgentMessage, index: number, total: number): number {
	let score = 0;

	// Recency bonus: more recent = higher score (0..1)
	score += (index / total) * 3;

	if (msg.role === "user") {
		// User messages are important — they define intent
		score += 2;
	} else if (msg.role === "assistant") {
		const content = (msg as { content: unknown[] }).content;
		// Assistant messages with tool calls are important for continuity
		if (content?.some((b) => (b as Record<string, unknown>).type === "toolCall")) {
			score += 1.5;
		}
		// Long assistant messages likely contain valuable analysis
		const tokens = messageTokens(msg);
		if (tokens > 500) score += 0.5;
	} else if (msg.role === "toolResult") {
		// Tool results are less important on their own
		score += 0.5;
		// Error results are worth keeping
		if ((msg as { isError?: boolean }).isError) score += 1;
	}

	return score;
}

function pruneSmart(messages: AgentMessage[], keepRecentTokens: number, config: ZeroCoreConfig): AgentMessage[] {
	if (messages.length === 0) return [];

	// Always keep the most recent messages (reserve 60% of budget for recency)
	const recentBudget = Math.floor(keepRecentTokens * 0.6);
	const scoredBudget = keepRecentTokens - recentBudget;

	// Collect recent messages (from end)
	let recentTokens = 0;
	let recentStart = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		const cost = messageTokens(messages[i]);
		if (recentTokens + cost > recentBudget) break;
		recentTokens += cost;
		recentStart = i;
	}

	const recentMsgs = messages.slice(recentStart);
	const olderMsgs = messages.slice(0, recentStart);

	if (olderMsgs.length === 0) {
		return applyPreserveToolResults(recentMsgs, messages, config);
	}

	// Score older messages and select best within budget
	const scored: ScoredMessage[] = olderMsgs.map((msg, idx) => ({
		msg,
		index: idx,
		score: scoreMessage(msg, idx, olderMsgs.length),
		tokens: messageTokens(msg),
	}));

	// Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	const selected: AgentMessage[] = [];
	let usedTokens = 0;
	for (const s of scored) {
		if (usedTokens + s.tokens > scoredBudget) continue;
		selected.push(s.msg);
		usedTokens += s.tokens;
	}

	// Re-sort selected by original order
	selected.sort((a, b) => {
		const ai = olderMsgs.indexOf(a);
		const bi = olderMsgs.indexOf(b);
		return ai - bi;
	});

	const result = [...selected, ...recentMsgs];
	return applyPreserveToolResults(result, messages, config);
}

// ---------------------------------------------------------------------------
// Preserve tool results — ensure no orphaned tool calls
// ---------------------------------------------------------------------------

function applyPreserveToolResults(
	pruned: AgentMessage[],
	original: AgentMessage[],
	config: ZeroCoreConfig,
): AgentMessage[] {
	if (!config.context.preserveToolResults) return pruned;

	// Collect toolCallIds from assistant messages in pruned set
	const prunedIds = new Set(pruned.map((m) => {
		if (m.role === "toolResult") return (m as { toolCallId: string }).toolCallId;
		return null;
	}).filter(Boolean) as string[]);

	// Find tool calls in pruned assistants that are missing their results
	const missingToolCallIds = new Set<string>();
	for (const msg of pruned) {
		if (msg.role === "assistant") {
			const content = (msg as { content: unknown[] }).content;
			for (const block of (content ?? [])) {
				if ((block as Record<string, unknown>).type === "toolCall") {
					const id = (block as { id: string }).id;
					if (!prunedIds.has(id)) {
						missingToolCallIds.add(id);
					}
				}
			}
		}
	}

	if (missingToolCallIds.size === 0) return pruned;

	// Find missing tool results from original messages
	const result = [...pruned];
	for (const msg of original) {
		if (msg.role === "toolResult") {
			const id = (msg as { toolCallId: string }).toolCallId;
			if (missingToolCallIds.has(id) && !result.includes(msg)) {
				// Insert after the assistant message that called it
				const assistantIdx = result.findIndex((m) => {
					if (m.role !== "assistant") return false;
					const content = (m as { content: unknown[] }).content;
					return content?.some((b) =>
						(b as Record<string, unknown>).type === "toolCall" && (b as { id: string }).id === id,
					);
				});
				if (assistantIdx >= 0) {
					result.splice(assistantIdx + 1, 0, msg);
				} else {
					result.push(msg);
				}
				missingToolCallIds.delete(id);
			}
		}
	}

	return result;
}
