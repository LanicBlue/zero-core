// 提取者 A 服务 (v0.8 M5)
//
// # 文件说明书
//
// ## 核心功能
// 内容记忆的唯一写入者(RFC §2.18 / 决策 53/54)。读 session transcript 的一个
// delta 切片 → 抽「做了什么 / 决策 / 成果 / 经验」→ 写**全局 wiki 树 type=memory**
// 节点(M2 WikiStore.createMemoryNode，**不在任何 project 子树**，决策 46 N2)。
//
// 统一职责:
//   ① 低 checkpoint 增量提取(机制 2)每次触发后调用本服务处理 delta;
//   ② session 关闭 flush(机制 3)对尾批做最后一次 delta 提取。
//   —— 两条路径都走这里(决策 54 — A 是统一关闭归档器)。
//
// ## 独立 agent 身份(决策 44)
// A 有自己的 prompt + 自己的 LLM 调用上下文(独立 systemPrompt,与工作 session 的
// agent 隔离)。它**事后异步执行,不阻塞工作 session**(由 hooks 调度,fire-and-forget)。
// 当前实现以 generateText 单次调用表达「独立提取者身份」(MiMo Code Writer 风格的
// 简化形式);未来可换成完整 AgentLoop,但接口(extractDelta)不变。
//
// ## 产出合并(决策 53)
// 按 (subject, type) 演进:命中已有 memory 节点则更新 content/updatedAt,不重复
// 新建。这是 WikiStore.createMemoryNode 的 upsert 语义(按 parentId+path 命中)。
//
// ## 输入
// - providers / providerName / modelId(独立可配置,见 config.extractors.A)
// - sessionId / steps delta(由 hooks 准备)
// - WikiStore(写入目标)
//
// ## 输出
// - 写入 wiki 树 type=memory 节点
// - 返回 ExtractorAResult(写了多少条 / 是否更新而非新建)
//
// ## 定位
// src/server/ 服务层,被 hooks/extraction-hooks.ts 调用。
//
// ## 依赖
// - ai.generateText、runtime/provider-factory.resolveModel
// - server/wiki-node-store(WikiStore.createMemoryNode / ensureMemoryTypeRoot /
//   memoryTypeRootId — 全局 memory 节点 upsert + 类型根挂载)
// - core/logger
//
// ## 维护规则
// - prompt 改动后跑一次长 session 端到端验证(acceptance-M5 端到端条目)
// - 不要把 A 写进任何 project 子树(createMemoryNode 已强制)
//

import { generateText } from "ai";
import type { RuntimeProviderConfig } from "../runtime/types.js";
import { resolveModel } from "../runtime/provider-factory.js";
import type { WikiStore } from "./wiki-node-store.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One delta slice handed to extractor A. */
export interface TranscriptDelta {
	/** ISO timestamp / seq context, for the extractor's situating prompt. */
	sessionId: string;
	agentId?: string;
	/** Markdown transcript slice (already pruned to fit a single LLM call). */
	transcript: string;
	/** Lower bound seq (inclusive) — for traceability in logs. */
	fromSeq: number;
	/** Upper bound seq (exclusive). */
	toSeq: number;
}

export interface ExtractedMemoryFact {
	subject: string;
	type: "event" | "decision" | "discovery" | "status_change" | "preference";
	content: string;
}

export interface ExtractorAResult {
	extractedCount: number;
	createdCount: number;
	updatedCount: number;
	skipped: boolean;
	skipReason?: string;
}

function subjectSlug(subject: string): string {
	return subject
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64) || "unnamed";
}

// ---------------------------------------------------------------------------
// Prompt — extractor A's own system prompt (decision 44 — independent identity)
// ---------------------------------------------------------------------------

const EXTRACTOR_A_SYSTEM = `You are **extractor-A**, the cross-project content-memory archiver for zero-core.

Your job: read a slice of session transcript and extract memory-worthy facts about WHAT WAS DONE, DECISIONS MADE, OUTCOMES ACHIEVED, and LESSONS LEARNED. These memories are cross-project role/skill knowledge — they live on the global wiki tree under type nodes, NOT under any specific project.

Output: a JSON array. Each item:
- subject: who/what this is about (a person, project, tool, technique, concept — concrete enough to be searchable later)
- type: one of: event | decision | discovery | status_change | preference
- content: a single factual statement (one sentence ideally), in the same language as the transcript

Rules:
- Skip trivial things (greetings, formatting, tool noise).
- Prefer DECISIONS and DISCOVERIES over narration.
- If a later turn supersedes an earlier one, extract only the latest state.
- If nothing is worth remembering, output [].

Output ONLY the JSON array, no prose.`;

const EXTRACTOR_A_USER_TEMPLATE = `Extract memory-worthy facts from this transcript slice.

Session: {sessionId}
Agent: {agentId}
Seq range: [{fromSeq}, {toSeq})

--- TRANSCRIPT ---
{transcript}`;

// ---------------------------------------------------------------------------
// ExtractorAService
// ---------------------------------------------------------------------------

export interface ExtractorAOptions {
	providers: RuntimeProviderConfig[];
	providerName: string;
	modelId: string;
	wiki: WikiStore;
	/**
	 * Test-only override: skip provider resolution and use this model
	 * directly. Lets unit tests inject a stub model without setting up a
	 * full RuntimeProviderConfig. Not intended for production use.
	 */
	testModel?: any;
}

export class ExtractorAService {
	constructor(private opts: ExtractorAOptions) {}

	/**
	 * Extract content memory from a transcript delta and merge into the global
	 * wiki tree (type=memory nodes). Returns counts; never throws — failures
	 * are logged and returned with skipped=true.
	 */
	async extractDelta(delta: TranscriptDelta): Promise<ExtractorAResult> {
		const empty: ExtractorAResult = {
			extractedCount: 0, createdCount: 0, updatedCount: 0,
			skipped: true, skipReason: "no transcript",
		};
		if (!delta.transcript.trim()) return empty;

		let facts: ExtractedMemoryFact[];
		try {
			facts = await this.callLLM(delta);
		} catch (err) {
			log.warn("extractor-A", "LLM call failed:", (err as Error).message);
			return { ...empty, skipReason: `LLM error: ${(err as Error).message}` };
		}
		if (facts.length === 0) {
			return { ...empty, skipReason: "no facts extracted" };
		}

		let created = 0;
		let updated = 0;
		// v0.8 (P2 §11.6): per-agent memory subtree. delta.agentId picks the
		// subtree; falls back to a sentinel "unknown" agent root so the write
		// never silently lands in the wrong place.
		const agentId = delta.agentId ?? "unknown";
		for (const fact of facts) {
			try {
				// createMemoryNodeForAgent upserts under the agent's own subtree
				// root (memory-agent:<agentId>), hanging directly under
				// WIKI_GLOBAL_ROOT_ID (memory is global to the agent — cross-
				// project, per RFC §11.6 risk note).
				const before = this.opts.wiki.getByParentAndPath(
					this.opts.wiki.ensureMemoryAgentRoot(agentId).id,
					`memory:${agentId}:${fact.type}:${subjectSlug(fact.subject)}`,
				);
				this.opts.wiki.createMemoryNodeForAgent({
					agentId,
					type: fact.type,
					subject: fact.subject,
					title: `${fact.subject} (${fact.type})`,
					summary: fact.content,
					detail: JSON.stringify({
						subject: fact.subject,
						type: fact.type,
						content: fact.content,
						sourceSessionId: delta.sessionId,
						sourceAgentId: agentId,
						sourceSeqRange: [delta.fromSeq, delta.toSeq],
					}, null, 2),
					provenance: "derived",
					lastUpdatedBy: "extractor-A",
				});
				if (before) updated++; else created++;
			} catch (err) {
				log.warn("extractor-A", `Failed to write fact for ${fact.subject}:`, (err as Error).message);
			}
		}

		log.debug("extractor-A",
			`session=${delta.sessionId} seq=[${delta.fromSeq},${delta.toSeq}) ` +
			`extracted=${facts.length} created=${created} updated=${updated}`);

		return {
			extractedCount: facts.length,
			createdCount: created,
			updatedCount: updated,
			skipped: false,
		};
	}

	private async callLLM(delta: TranscriptDelta): Promise<ExtractedMemoryFact[]> {
		const model = this.opts.testModel ?? resolveModel(this.opts.providers, this.opts.providerName, this.opts.modelId);
		const user = EXTRACTOR_A_USER_TEMPLATE
			.replace("{sessionId}", delta.sessionId)
			.replace("{agentId}", delta.agentId ?? "(unknown)")
			.replace("{fromSeq}", String(delta.fromSeq))
			.replace("{toSeq}", String(delta.toSeq))
			.replace("{transcript}", delta.transcript.slice(0, 12000));

		const result = await generateText({
			model,
			system: EXTRACTOR_A_SYSTEM,
			prompt: user,
			maxOutputTokens: 800,
		});
		const text = result.text.trim();
		const jsonMatch = text.match(/\[[\s\S]*\]/);
		if (!jsonMatch) return [];
		let parsed: any;
		try {
			parsed = JSON.parse(jsonMatch[0]);
		} catch {
			return [];
		}
		if (!Array.isArray(parsed)) return [];
		const allowedTypes = new Set(["event", "decision", "discovery", "status_change", "preference"]);
		return parsed
			.filter((n: any) =>
				n && typeof n.subject === "string" && n.subject.trim() &&
				typeof n.content === "string" && n.content.trim() &&
				allowedTypes.has(n.type),
			)
			.map((n: any) => ({
				subject: String(n.subject).trim().slice(0, 200),
				type: n.type as ExtractedMemoryFact["type"],
				content: String(n.content).trim().slice(0, 2000),
			}));
	}
}
