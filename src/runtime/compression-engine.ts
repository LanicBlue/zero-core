// 对话压缩引擎：上下文超阈值时对旧 turn 做渐进式压缩，并把可记忆事实抽成节点。
//
// # 文件说明书
//
// ## 核心功能
// 提供 CompressionEngine：L1（把单个旧 assistant turn 摘要成一句话）+ L2（从已压缩的旧 turn
// 里抽取记忆节点并整段丢弃）。两段阈值由 SessionConfig 控制；L1 阈值默认 70%，L2 默认 50%。
//
// ## 输入
// - 当前对话 messages 数组（user/assistant/tool 混排）
// - 当前 contextUsage（0-1 浮点）
// - keepRecentTurns / l1Threshold / l2Threshold 以及可选 provider、model 覆盖
//
// ## 输出
// - CompressionResult：压缩后的新 messages、待写入的记忆节点、didCompress/didExtract 标志
//
// ## 定位
// runtime 层纯算法模块，被 hooks/compression-hooks.ts 在 PostTurnComplete 调用；不直接读写 DB。
//
// ## 依赖
// - ai.generateText、provider-factory.resolveModel（执行摘要/抽取 LLM 调用）
// - server/memory-node-store 的 MemoryNodeInput 类型
// - core/logger
//
// ## 维护规则
// - 改阈值默认值或 prompt 模板时同步更新 types.ts 的 SessionConfig.compression 注释。
// - 新增/调整 turn 识别逻辑（identifyTurns）后必须验证 PreLLMCall 压缩链路仍可工作。
// - L1/L2 prompt 改动后应跑一次长对话以验证摘要质量和节点抽取有效性。

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
	 * Optional provider/model overrides for the AI calls.
	 */
	async compressIfNeeded(
		messages: any[],
		contextUsage: number,
		config: {
			keepRecentTurns: number;
			l1Threshold: number;
			l2Threshold: number;
			provider?: string;
			model?: string;
		},
	): Promise<CompressionResult> {
		const provider = config.provider || this.providerName;
		const model = config.model || this.modelId;

		let result: CompressionResult = {
			messages: [...messages],
			memoryNodes: [],
			didCompress: false,
			didExtract: false,
		};

		// L1: compress oldest uncompressed turn
		if (contextUsage > config.l1Threshold) {
			const l1Result = await this.compressOldestTurn(result.messages, config.keepRecentTurns, provider, model);
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
				const nodes = await this.extractMemoryNodes(result.messages, compressedTurns, provider, model);
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
		provider: string,
		model: string,
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
			const resolvedModel = resolveModel(this.providers, provider, model);
			const prompt = L1_PROMPT
				.replace("{userMessage}", serializeContent(userMsg.content).slice(0, 1000))
				.replace("{assistantContent}", assistantContent.slice(0, 4000));

			const result = await generateText({ model: resolvedModel, prompt, maxOutputTokens: 300 });
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
		provider: string,
		model: string,
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
			const resolvedModel = resolveModel(this.providers, provider, model);
			const prompt = L2_PROMPT.replace("{turnTexts}", turnTexts.slice(0, 6000));

			const result = await generateText({ model: resolvedModel, prompt, maxOutputTokens: 500 });
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
