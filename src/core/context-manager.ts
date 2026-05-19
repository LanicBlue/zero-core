import type { ModelMessage } from "ai";
import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(messages: ModelMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			total += Math.ceil(msg.content.length / 4);
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if ("text" in part && typeof part.text === "string") {
					total += Math.ceil(part.text.length / 4);
				}
			}
		}
	}
	return total;
}

function messageTokens(msg: ModelMessage): number {
	return estimateTokens([msg]);
}

// ---------------------------------------------------------------------------
// Should we prune?
// ---------------------------------------------------------------------------

export function shouldPrune(config: ZeroCoreConfig, messages: ModelMessage[]): boolean {
	const maxTokens = config.context.maxTokens;
	if (!maxTokens) return false;
	return estimateTokens(messages) > maxTokens - (config.context.reserveTokens ?? 16384);
}

// ---------------------------------------------------------------------------
// Prune dispatch
// ---------------------------------------------------------------------------

export function pruneMessages(config: ZeroCoreConfig, messages: ModelMessage[]): ModelMessage[] {
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

function pruneTail(messages: ModelMessage[], keepRecentTokens: number, config: ZeroCoreConfig): ModelMessage[] {
	let tokenBudget = keepRecentTokens;
	const kept: ModelMessage[] = [];

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

function pruneTurnBoundary(messages: ModelMessage[], keepRecentTokens: number, config: ZeroCoreConfig): ModelMessage[] {
	let tokenBudget = keepRecentTokens;
	const kept: ModelMessage[] = [];

	for (let i = messages.length - 1; i >= 0; i--) {
		const cost = messageTokens(messages[i]);
		if (tokenBudget - cost < 0) break;
		tokenBudget -= cost;
		kept.unshift(messages[i]);
	}

	// Snap to turn boundary: if first kept message is a tool result, include its assistant message
	if (kept.length > 0 && kept[0].role === "tool") {
		const toolContent = kept[0].content;
		const toolCallId = Array.isArray(toolContent) && toolContent.length > 0
			? (toolContent[0] as { toolCallId?: string }).toolCallId
			: undefined;

		if (toolCallId) {
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "assistant") {
					const content = messages[i].content;
					if (Array.isArray(content) && content.some((b) =>
						(b as { type: string }).type === "tool-call" && (b as { toolCallId: string }).toolCallId === toolCallId
					)) {
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
	}

	return applyPreserveToolResults(kept, messages, config);
}

// ---------------------------------------------------------------------------
// Smart strategy — importance scoring
// ---------------------------------------------------------------------------

interface ScoredMessage {
	msg: ModelMessage;
	index: number;
	score: number;
	tokens: number;
}

function scoreMessage(msg: ModelMessage, index: number, total: number): number {
	let score = 0;

	// Recency bonus: more recent = higher score (0..1)
	score += (index / total) * 3;

	if (msg.role === "user") {
		score += 2;
	} else if (msg.role === "assistant") {
		const content = msg.content;
		if (Array.isArray(content) && content.some((b) => (b as { type: string }).type === "tool-call")) {
			score += 1.5;
		}
		const tokens = messageTokens(msg);
		if (tokens > 500) score += 0.5;
	} else if (msg.role === "tool") {
		score += 0.5;
		// Check for error in tool results
		const content = msg.content;
		if (Array.isArray(content) && content.some((b) => (b as { isError?: boolean }).isError)) {
			score += 1;
		}
	}

	return score;
}

function pruneSmart(messages: ModelMessage[], keepRecentTokens: number, config: ZeroCoreConfig): ModelMessage[] {
	if (messages.length === 0) return [];

	const recentBudget = Math.floor(keepRecentTokens * 0.6);
	const scoredBudget = keepRecentTokens - recentBudget;

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

	const scored: ScoredMessage[] = olderMsgs.map((msg, idx) => ({
		msg,
		index: idx,
		score: scoreMessage(msg, idx, olderMsgs.length),
		tokens: messageTokens(msg),
	}));

	scored.sort((a, b) => b.score - a.score);

	const selected: ModelMessage[] = [];
	let usedTokens = 0;
	for (const s of scored) {
		if (usedTokens + s.tokens > scoredBudget) continue;
		selected.push(s.msg);
		usedTokens += s.tokens;
	}

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

function collectToolCallIds(msg: ModelMessage): string[] {
	if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
	return msg.content
		.filter((b) => (b as { type: string }).type === "tool-call")
		.map((b) => (b as { toolCallId: string }).toolCallId);
}

function collectToolResultIds(msg: ModelMessage): string[] {
	if (msg.role !== "tool" || !Array.isArray(msg.content)) return [];
	return msg.content
		.map((b) => (b as { toolCallId?: string }).toolCallId)
		.filter((id): id is string => typeof id === "string");
}

function applyPreserveToolResults(
	pruned: ModelMessage[],
	original: ModelMessage[],
	config: ZeroCoreConfig,
): ModelMessage[] {
	if (!config.context.preserveToolResults) return pruned;

	const prunedResultIds = new Set(pruned.flatMap(collectToolResultIds));

	const missingToolCallIds = new Set<string>();
	for (const msg of pruned) {
		for (const id of collectToolCallIds(msg)) {
			if (!prunedResultIds.has(id)) {
				missingToolCallIds.add(id);
			}
		}
	}

	if (missingToolCallIds.size === 0) return pruned;

	const result = [...pruned];
	for (const msg of original) {
		if (msg.role === "tool") {
			const resultIds = collectToolResultIds(msg);
			const hasMissing = resultIds.some((id) => missingToolCallIds.has(id));
			if (hasMissing && !result.includes(msg)) {
				const matchingId = resultIds.find((id) => missingToolCallIds.has(id));
				const assistantIdx = result.findIndex((m) =>
					collectToolCallIds(m).includes(matchingId!)
				);
				if (assistantIdx >= 0) {
					result.splice(assistantIdx + 1, 0, msg);
				} else {
					result.push(msg);
				}
				for (const id of resultIds) {
					missingToolCallIds.delete(id);
				}
			}
		}
	}

	return result;
}
