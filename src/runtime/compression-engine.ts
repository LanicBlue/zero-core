// 对话压缩引擎
//
// 渐进式压缩：L1（摘要）+ L2（记忆节点提取）
// L1: 上下文 > 70% 时将旧 turn 的 assistant 压缩为摘要
// L2: L1 后仍 > 50% 时从已压缩 turn 提取记忆节点，然后丢弃

import { generateText } from "ai";
import type { RuntimeProviderConfig } from "./types.js";
import type { MemoryNodeInput } from "../server/memory-node-store.js";
import { resolveModel } from "./provider-factory.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnBoundary {
	/** Index of the user message that starts this turn */
	start: number;
	/** Index past the last message in this turn */
	end: number;
}

export interface CompressionResult {
	messages: any[];
	memoryNodes: MemoryNodeInput[];
	didCompress: boolean;
	didExtract: boolean;
}

// ---------------------------------------------------------------------------
// CompressionEngine
// ---------------------------------------------------------------------------

const L1_PROMPT = `Compress the following assistant turn into a brief summary.

Format: "意图 → 问题 → 结果"
- Preserve core intent and outcome
- Note key decisions or discoveries
- If tools were used, note which ones briefly
- 2-4 sentences max, same language as the original

--- USER MESSAGE ---
{userMessage}

--- ASSISTANT TURN ---
{assistantContent}`;

const L2_PROMPT = `Analyze the following compressed conversation turns and extract memory-worthy facts.

For each fact provide:
- subject: who/what this is about (person, project, concept, etc.)
- type: one of: event, decision, discovery, status_change, preference
- content: a factual statement about the subject

Output a JSON array. If no facts are worth remembering, output an empty array.
Example: [{"subject":"ProjectX","type":"decision","content":"Decided to use SQLite for storage."}]

--- TURNS ---
{turnTexts}`;

export class CompressionEngine {
	constructor(
		private providers: RuntimeProviderConfig[],
		private providerName: string,
		private modelId: string,
	) {}

	/**
	 * Identify turn boundaries in the message array.
	 * A turn starts with a user message and includes all subsequent assistant/tool messages.
	 */
	identifyTurns(messages: any[]): TurnBoundary[] {
		const turns: TurnBoundary[] = [];
		let turnStart = -1;

		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "user") {
				if (turnStart >= 0) {
					turns.push({ start: turnStart, end: i });
				}
				turnStart = i;
			}
		}
		if (turnStart >= 0) {
			turns.push({ start: turnStart, end: messages.length });
		}
		return turns;
	}

	/**
	 * Check if compression is needed based on context usage and turn count.
	 */
	shouldCompress(contextUsage: number, l1Threshold: number): boolean {
		return contextUsage > l1Threshold;
	}

	/**
	 * Run the full compression pipeline: L1 then L2 if needed.
	 */
	async compressIfNeeded(
		messages: any[],
		contextUsage: number,
		config: {
			keepRecentTurns: number;
			l1Threshold: number;
			l2Threshold: number;
		},
	): Promise<CompressionResult> {
		let result: CompressionResult = {
			messages: [...messages],
			memoryNodes: [],
			didCompress: false,
			didExtract: false,
		};

		// L1: compress oldest uncompressed turn
		if (contextUsage > config.l1Threshold) {
			const l1Result = await this.compressOldestTurn(result.messages, config.keepRecentTurns);
			if (l1Result) {
				result.messages = l1Result.messages;
				result.didCompress = true;
				log.debug("compression", "L1 compressed turn at index", l1Result.turnStart);
			}
		}

		// L2: extract memory from compressed turns and discard them
		const turns = this.identifyTurns(result.messages);
		const totalTurns = turns.length;
		if (totalTurns > config.keepRecentTurns) {
			const compressedTurns = this.findCompressedTurns(result.messages, turns, config.keepRecentTurns);
			if (compressedTurns.length > 0) {
				const nodes = await this.extractMemoryNodes(result.messages, compressedTurns);
				if (nodes.length > 0) {
					result.memoryNodes = nodes;
					result.didExtract = true;
				}

				// Discard the compressed turns
				result.messages = this.discardTurns(result.messages, compressedTurns);
				log.debug("compression", "L2 extracted", nodes.length, "memory nodes, discarded", compressedTurns.length, "turns");
			}
		}

		return result;
	}

	// ─── L1: Compress single turn ────────────────────────

	private async compressOldestTurn(
		messages: any[],
		keepRecentTurns: number,
	): Promise<{ messages: any[]; turnStart: number } | null> {
		const turns = this.identifyTurns(messages);
		if (turns.length <= keepRecentTurns) return null;

		// Find the oldest turn that hasn't been compressed (check assistant content length — compressed is very short)
		const target = turns[0];
		const userMsg = messages[target.start];

		// Collect all assistant/tool content from this turn
		let assistantContent = "";
		for (let i = target.start + 1; i < target.end; i++) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				assistantContent += serializeContent(msg.content) + "\n";
			} else if (msg.role === "tool") {
				assistantContent += "[Tool result] " + serializeContent(msg.content).slice(0, 500) + "\n";
			}
		}

		if (!assistantContent.trim()) return null;

		// Skip if already compressed (very short content suggests it was compressed)
		if (assistantContent.length < 200) return null;

		try {
			const model = resolveModel(this.providers, this.providerName, this.modelId);
			const prompt = L1_PROMPT
				.replace("{userMessage}", serializeContent(userMsg.content).slice(0, 1000))
				.replace("{assistantContent}", assistantContent.slice(0, 4000));

			const result = await generateText({ model, prompt, maxOutputTokens: 300 });
			const summary = result.text.trim();

			if (!summary) return null;

			// Replace the entire turn (user stays, assistant+tool block becomes one summary)
			const newMessages = [...messages];
			// Keep user message, replace rest with single assistant summary
			newMessages.splice(target.start + 1, target.end - target.start - 1, {
				role: "assistant",
				content: summary,
			});

			return { messages: newMessages, turnStart: target.start };
		} catch (err) {
			log.warn("compression", "L1 compression failed:", (err as Error).message);
			return null;
		}
	}

	// ─── L2: Extract memory nodes ────────────────────────

	private async extractMemoryNodes(
		messages: any[],
		turnRanges: TurnBoundary[],
	): Promise<MemoryNodeInput[]> {
		const turnTexts = turnRanges.map(t => {
			const userMsg = serializeContent(messages[t.start].content).slice(0, 300);
			let assistantText = "";
			for (let i = t.start + 1; i < t.end; i++) {
				assistantText += serializeContent(messages[i].content).slice(0, 500) + "\n";
			}
			return `User: ${userMsg}\nAssistant: ${assistantText.trim()}`;
		}).join("\n\n---\n\n");

		if (!turnTexts.trim()) return [];

		try {
			const model = resolveModel(this.providers, this.providerName, this.modelId);
			const prompt = L2_PROMPT.replace("{turnTexts}", turnTexts.slice(0, 6000));

			const result = await generateText({ model, prompt, maxOutputTokens: 500 });
			const text = result.text.trim();

			// Parse JSON from response
			const jsonMatch = text.match(/\[[\s\S]*\]/);
			if (!jsonMatch) return [];

			const parsed = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(parsed)) return [];

			return parsed.filter((n: any) =>
				n.subject && n.type && n.content &&
				["event", "decision", "discovery", "status_change", "preference"].includes(n.type),
			).map((n: any) => ({
				subject: String(n.subject),
				type: n.type as MemoryNodeInput["type"],
				content: String(n.content),
			}));
		} catch (err) {
			log.warn("compression", "L2 extraction failed:", (err as Error).message);
			return [];
		}
	}

	// ─── Helpers ─────────────────────────────────────────

	/**
	 * Find turns that appear to be compressed (short assistant content beyond recent N turns).
	 */
	private findCompressedTurns(messages: any[], turns: TurnBoundary[], keepRecent: number): TurnBoundary[] {
		const oldTurns = turns.slice(0, turns.length - keepRecent);
		return oldTurns.filter(t => {
			// Check if the assistant content is short (compressed)
			for (let i = t.start + 1; i < t.end; i++) {
				const msg = messages[i];
				if (msg.role === "assistant") {
					const text = serializeContent(msg.content);
					// Compressed turns are short (usually < 300 chars)
					// Also check there's only one assistant message (compressed turns merge into one)
					return text.length < 400;
				}
			}
			return false;
		});
	}

	/**
	 * Remove the specified turn ranges from the message array.
	 */
	private discardTurns(messages: any[], turns: TurnBoundary[]): any[] {
		// Build set of indices to remove (all messages in the turn range, including user)
		const toRemove = new Set<number>();
		for (const t of turns) {
			for (let i = t.start; i < t.end; i++) {
				toRemove.add(i);
			}
		}
		return messages.filter((_, i) => !toRemove.has(i));
	}
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function serializeContent(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p: any) => p.type === "text")
			.map((p: any) => p.text || "")
			.join("\n");
	}
	return JSON.stringify(content);
}
