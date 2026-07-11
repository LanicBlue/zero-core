// 提取者 A 服务 (steps-overhaul sub-7 — 多步 agent,topic wiki 合并)
//
// # 文件说明书
//
// ## 核心功能
// 内容记忆的唯一写入者(RFC §2.18 / 决策 53 修订 / 决策 54)。sub-7 把它从
// 单步 generateText 升级成**多步 agent loop**(独立 loop,**不在工作 session 里**):
//
//   读被压缩 agent 的现有 memory 子树 + 新 step(以阶段3 summary 形式)→
//   判定每个内容映射到**已有 topic 节点**(补充)还是**新主题**(新建)→
//   合并写入(**去重 + 去伪(纠正过时/错误)+ 冲突无法判定则 flags 标注**,
//   非 dumb append、非覆盖)→ 核对输出格式(不符重试/兜底)。
//
// 多步以实现:wiki 读(看已有 topic 节点)→ 判定(新建 vs 补充)→ 写(合并)。
// 一次压缩可产多个 summary(跨主题);每段 summary 喂一次 Extractor A 合并。
//
// ## 独立 agent 身份(决策 44 / 阶段3 design)
// A 有自己的 prompt + 自己的 LLM 调用上下文(独立 systemPrompt,与工作 session
// 的 agent 隔离)。它**事后异步执行,不阻塞工作 session**(由 compressSession
// fire-and-forget 调,或归档末次压缩调)。**call 不存储**(不留痕于工作 session)
// —— 它的 tool calls 只写 wiki 节点,不进 steps/messages 表。
//
// 用 AI SDK 的 tool-calling generateText 循环(stopWhen: stepCountIs(N))实现
// 「多步」。这是独立轻量 agent loop(不是工作 session 的 AgentLoop 实例)——
// 符合 memory feedback-agent-loop-hooks-only(不塞进工作 session 的 AgentLoop)。
//
// ## 模型
// settings/memory 配置的独立模型(config.extractors.A.provider/model,默认回落
// 到 session 工作模型)。
//
// ## callerCtx 注入(sub-6 global-anchor)
// Wiki 工具的 createMemory/updateMemory 走 buildGlobalAnchorWikiCallerCtx()
// (session-less,anchor = [WIKI_GLOBAL_ROOT_ID],整树可读写)。Extractor A 直
// 调 wikiTool.execute 而非 store,统一 path 前缀(避免 store 路径与工具路径混
// 出两套 —— sub-7 决策:统一走工具 createMemory/updateMemory)。
//
// ## 产出合并(决策 53 修订)
// 按 (topicId, subject) 演进:命中已有 memory 节点则合并更新(content 的 ##
// 历史段累积),不重复新建。去重(同主题不重复)+ 去伪(纠正过时/错误)+
// 冲突无法判定则 flags 标注。detail 留 ## 历史段(无 version/history 列,
// 用正文段绕过)。
//
// ## 输入
// - providers / providerName / modelId(独立可配置,见 config.extractors.A)
// - mergeSummaryIntoWiki({ summary, topicId, agentId }):压缩产物 → wiki 合并
// - extractDelta(delta):legacy 通路(m5 测试 + 旧 close flush 残留接口),
//   内部仍走多步 agent loop,但 transcript→facts 由模型在 loop 内自行决定
//
// ## 输出
// - 写入 wiki 树 type=memory 节点(per-topic 子树)
// - 返回 ExtractorAResult(写了多少条 / 是否更新而非新建 / mergeCount)
//
// ## 定位
// src/server/ 服务层,被 compressSession(每段 summary 后调)+ 归档末次压缩
// (sub-8)调。不塞进 AgentLoop。
//
// ## 依赖
// - ai.generateText + ai.tool + ai.stepCountIs、runtime/provider-factory.resolveModel
// - tools/wiki-tool(wikiTool.execute + buildGlobalAnchorWikiCallerCtx)
// - server/wiki-node-store(WikiStore.ensureMemoryTopicRoot / listMemoryNodes /
//   searchMemoryNodes / readNodeDetail —— 用于 read 工具的实现)
// - core/logger
//
// ## 维护规则
// - prompt 改动后跑 sub-7 acceptance 测试(去重/纠正/标注/跨主题多 summary)
// - 不要把 A 写进任何 project 子树(createMemory 工具已强制 parent=memory)
// - multi-step 工具集改动后同步核对:createMemory/updateMemory 必须走 wikiTool
//   (global-anchor callerCtx),不要旁路到 store 直写
//

import { generateText, tool as defineTool, stepCountIs } from "ai";
import type { RuntimeProviderConfig } from "../runtime/types.js";
import { resolveModel } from "../runtime/provider-factory.js";
import type { WikiStore } from "./wiki-node-store.js";
import {
	WIKI_GLOBAL_ROOT_ID,
	memoryTopicRootId,
} from "./wiki-node-store.js";
import { wikiTool, buildGlobalAnchorWikiCallerCtx } from "../tools/wiki-tool.js";
import type { MessageSummary } from "./session-db.js";
import { log } from "../core/logger.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One delta slice handed to extractor A (legacy extractDelta path). */
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

/** Input for the sub-7 wiki-merge entry point: a compression summary → wiki. */
export interface MergeSummaryInput {
	/** The compression summary produced by compressSession (5-section form). */
	summary: MessageSummary;
	/**
	 * Topic id for the memory subtree this summary feeds. Typically derived
	 * from the session's agentId or the summary's dominant subject; the caller
	 * (compressSession) picks it. Extractor A ensures the topic root exists
	 * and merges the summary's facts under it.
	 */
	topicId: string;
	/** Optional human-readable topic title (used when creating the topic root). */
	topicTitle?: string;
	/** Source agent (for provenance in the body's ## 历史 section). */
	agentId?: string;
	/** Source session id (for provenance). */
	sessionId?: string;
}

export interface ExtractorAResult {
	extractedCount: number;
	createdCount: number;
	updatedCount: number;
	/** sub-7: how many createMemory/updateMemory tool calls the agent made. */
	mergeCount?: number;
	skipped: boolean;
	skipReason?: string;
}

// ---------------------------------------------------------------------------
// Prompt — extractor A's own system prompt (multi-step, tool-calling)
// ---------------------------------------------------------------------------

const EXTRACTOR_A_SYSTEM = `You are **extractor-A**, zero-core's cross-project content-memory archivist (steps-overhaul sub-7).

You run as an INDEPENDENT multi-step agent, OUT OF BAND from the working session. Your tool calls are NOT stored in the working session — they only write wiki memory nodes. You read the agent's existing memory subtree, then merge new content (a compression summary) into it.

## Your tools (multi-step: read → decide → write)
- listTopics: list the topic memory roots that already exist.
- readTopicMemory: read a topic's existing memory leaves (title + summary + body) so you can decide NEW vs SUPPLEMENT.
- searchMemory: search across all memory leaves by keyword (for cross-topic lookups).
- createMemory: UPSERT a memory leaf under a topic root. Same (parentId, subject) → same node (idempotent merge). Use content for the merged body, flags for conflict markers.
- updateMemory: PATCH a memory leaf (metadata + body). PATCH semantics — omit a field to leave it alone.

## Merge rules (NON-NEGOTIABLE — this is what makes memory curatable, not a dumb log)
- **去重 (dedupe)**: if the new content's subject already exists under the topic, UPDATE that node — do NOT create a duplicate. Same subject → same node.
- **去伪 (correct stale/wrong)**: if the new content contradicts an existing fact and the new one is more recent/authoritative, REPLACE the old statement. Keep the old value in the body's \`## 历史\` section as a provenance trail (append \`- <date>: <old value> (superseded by <new>)\`).
- **冲突标注 (flag unresolvable conflicts)**: if two sources disagree AND you cannot tell which is correct, keep BOTH statements in the body, set flags: ["conflict:needs-review"], and note the disagreement in ## 历史.
- **## 历史 section**: every memory body SHOULD carry a \`## 历史\` section (there is no version/history column — the body's history section is the provenance trail). Append a line per merge: \`- <ISO date>: merged from session <sid> (agent <aid>)\`.
- **跨主题 (multi-topic)**: a single summary may span multiple subjects. Decide per-fact which topic it belongs to. You may call createMemory under DIFFERENT topic parents in one run.

## Output format
After your tool calls finish, emit a SHORT plain-text summary of what you did (1-3 lines), e.g. "Created 2 nodes under topic auth, updated 1 (corrected stale timeout), flagged 1 conflict." This is for logging only — the wiki nodes themselves are the real product.

## Rules
- Skip trivial things (greetings, formatting, tool noise). If a summary has nothing memory-worthy, emit "nothing to merge" and stop.
- Prefer DECISIONS and DISCOVERIES over narration.
- Match the source language (Chinese summary → Chinese memory content).
- Never invent a topic id — use the one provided in the user prompt, or derive a clear slug from the dominant subject (e.g. "auth-system", "billing-pipeline").`;

const MERGE_SUMMARY_USER_TEMPLATE = `Merge this compression summary into the wiki memory tree.

Topic id: {topicId}
Topic title: {topicTitle}
Source session: {sessionId}
Source agent: {agentId}
Step range covered: [{fromSeq}, {toSeq}]

--- SUMMARY (5-section form) ---
purpose: {purpose}
plan: {plan}
status: {status}
artifacts: {artifacts}
lessons: {lessons}

Start by listing topics + reading the target topic's existing memory, then merge (createMemory / updateMemory). Emit your short text summary when done.`;

const EXTRACT_DELTA_USER_TEMPLATE = `Extract memory-worthy facts from this transcript slice and merge them into the wiki memory tree.

Session: {sessionId}
Agent: {agentId}
Seq range: [{fromSeq}, {toSeq})

Decide a topic id from the dominant subject of the facts you extract (or use the provided topic id if one is given). Start by listing topics + reading the topic's existing memory, then merge.

--- TRANSCRIPT ---
{transcript}`;

// ---------------------------------------------------------------------------
// ExtractorAService — multi-step agent
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
	 *
	 * The stub MUST support tool calling for the multi-step loop (doGenerate
	 * returning tool-call content parts). Tests that only want the legacy
	 * single-shot shape can pass a non-tool stub and the loop degrades to a
	 * single step (no tool calls → finishReason stop → done).
	 */
	testModel?: any;
	/**
	 * Test-only override: max agent steps (default 6). Bounds the loop so a
	 * runaway model can't spin forever. Production uses the default.
	 */
	maxSteps?: number;
}

export class ExtractorAService {
	constructor(private opts: ExtractorAOptions) {}

	/**
	 * sub-7 entry: merge a compression summary into the wiki memory tree.
	 *
	 * This is the primary path — compressSession calls it once per summary
	 * (a single compression can produce multiple summaries = multiple merges).
	 * The merge is fire-and-forget from the caller's POV: failures are logged
	 * and returned with skipped=true, never thrown (a memory-merge failure
	 * must NOT break the compression that produced the summary).
	 *
	 * Returns counts of tool calls made (mergeCount) + created/updated nodes
	 * observed by re-querying the topic subtree before/after.
	 */
	async mergeSummaryIntoWiki(input: MergeSummaryInput): Promise<ExtractorAResult> {
		const empty: ExtractorAResult = {
			extractedCount: 0, createdCount: 0, updatedCount: 0,
			mergeCount: 0, skipped: true, skipReason: "empty summary",
		};
		const summary = input.summary;
		const hasContent = !!summary &&
			Object.values(summary.sections ?? {}).some(v => typeof v === "string" && v.trim());
		if (!hasContent) return empty;

		// Ensure the topic root exists so the agent's createMemory has a parent.
		const topicRoot = this.opts.wiki.ensureMemoryTopicRoot(input.topicId, input.topicTitle);
		const beforeIds = new Set(this.collectTopicMemoryIds(input.topicId));

		const toolCalls = await this.runAgentLoop(
			MERGE_SUMMARY_USER_TEMPLATE
				.replace("{topicId}", input.topicId)
				.replace("{topicTitle}", input.topicTitle ?? input.topicId)
				.replace("{sessionId}", input.sessionId ?? "(unknown)")
				.replace("{agentId}", input.agentId ?? "(unknown)")
				.replace("{fromSeq}", String(summary.stepRange?.from ?? "?"))
				.replace("{toSeq}", String(summary.stepRange?.to ?? "?"))
				.replace("{purpose}", summary.sections?.purpose ?? "(none)")
				.replace("{plan}", summary.sections?.plan ?? "(none)")
				.replace("{status}", summary.sections?.status ?? "(none)")
				.replace("{artifacts}", summary.sections?.artifacts ?? "(none)")
				.replace("{lessons}", summary.sections?.lessons ?? "(none)"),
		).catch((err: unknown) => {
			log.warn("extractor-A", `merge agent loop failed (topic=${input.topicId}):`, (err as Error).message);
			return 0;
		});

		const afterIds = new Set(this.collectTopicMemoryIds(input.topicId));
		let created = 0;
		for (const id of afterIds) if (!beforeIds.has(id)) created++;
		const updated = Math.max(0, toolCalls - created);

		log.debug("extractor-A",
			`merge topic=${input.topicId} session=${input.sessionId ?? "?"} ` +
			`toolCalls=${toolCalls} created=${created} updated=${updated}`);

		if (toolCalls === 0) {
			return { ...empty, skipReason: "agent made no memory writes" };
		}
		return {
			extractedCount: toolCalls,
			createdCount: created,
			updatedCount: updated,
			mergeCount: toolCalls,
			skipped: false,
		};
	}

	/**
	 * Legacy delta path (m5 close-flush + tests). Internally upgraded to the
	 * multi-step agent loop. The transcript is fed as the user prompt; the
	 * agent decides facts + topic + merge internally.
	 *
	 * Kept for back-compat with m5-extractors test + any close-flush caller
	 * that hasn't migrated to mergeSummaryIntoWiki yet. New code should call
	 * mergeSummaryIntoWiki (summary form) — this path is transcript form.
	 */
	async extractDelta(delta: TranscriptDelta): Promise<ExtractorAResult> {
		const empty: ExtractorAResult = {
			extractedCount: 0, createdCount: 0, updatedCount: 0,
			mergeCount: 0, skipped: true, skipReason: "no transcript",
		};
		if (!delta.transcript.trim()) return empty;

		const beforeIds = new Set(this.opts.wiki.listMemoryNodes().map(n => n.id));

		const toolCalls = await this.runAgentLoop(
			EXTRACT_DELTA_USER_TEMPLATE
				.replace("{sessionId}", delta.sessionId)
				.replace("{agentId}", delta.agentId ?? "(unknown)")
				.replace("{fromSeq}", String(delta.fromSeq))
				.replace("{toSeq}", String(delta.toSeq))
				.replace("{transcript}", delta.transcript.slice(0, 12000)),
		).catch((err: unknown) => {
			log.warn("extractor-A", "extract agent loop failed:", (err as Error).message);
			return 0;
		});

		const afterNodes = this.opts.wiki.listMemoryNodes();
		let created = 0;
		for (const n of afterNodes) if (!beforeIds.has(n.id)) created++;
		const updated = Math.max(0, toolCalls - created);

		if (toolCalls === 0) {
			return { ...empty, skipReason: "agent made no memory writes" };
		}
		return {
			extractedCount: toolCalls,
			createdCount: created,
			updatedCount: updated,
			mergeCount: toolCalls,
			skipped: false,
		};
	}

	// ─── internals ──────────────────────────────────────────────────

	/**
	 * Run the multi-step agent loop. Returns the number of createMemory +
	 * updateMemory tool calls the model made (the "merge count"). 0 means
	 * the model decided there was nothing memory-worthy.
	 *
	 * This is the "independent loop, not in working session, calls not
	 * stored" primitive: generateText with tools + stopWhen. Its tool calls
	 * only touch the wiki tree (via wikiTool.execute with a global-anchor
	 * callerCtx) — they NEVER write to steps/messages tables. The result
	 * object is discarded after counting; no transcript is persisted.
	 */
	private async runAgentLoop(userPrompt: string): Promise<number> {
		const model = this.opts.testModel ?? resolveModel(this.opts.providers, this.opts.providerName, this.opts.modelId);
		const wiki = this.opts.wiki;
		const callerCtx = buildGlobalAnchorWikiCallerCtx();
		const maxSteps = this.opts.maxSteps ?? 6;

		let memoryWriteCalls = 0;

		const tools = {
			listTopics: defineTool({
				description: "List all topic memory roots (subtree roots under the global root, path prefix memory-topic:). Use first to see what topics already exist before deciding NEW vs SUPPLEMENT.",
				inputSchema: z.object({}),
				execute: async () => {
					// Topic roots are wiki-root:memory-topic:<id> nodes (type=project,
					// index container). List them by id prefix.
					const all = wiki.list();
					const topics = all
						.filter(n => n.id.startsWith("wiki-root:memory-topic:"))
						.map(n => ({
							topicId: n.id.slice("wiki-root:memory-topic:".length),
							title: n.title ?? n.id,
							leafCount: wiki.getChildren(n.id).length,
						}));
					return { topics };
				},
			}),
			readTopicMemory: defineTool({
				description: "Read a topic's existing memory leaves (title + summary + body). Use after listTopics / when you know the target topic id, to decide whether a fact is NEW (create) or SUPPLEMENT (update).",
				inputSchema: z.object({
					topicId: z.string().describe("The topic id (slug, not the full wiki-root id)"),
				}),
				execute: async ({ topicId }: { topicId: string }) => {
					const root = wiki.get(memoryTopicRootId(topicId));
					if (!root) return { leaves: [], note: `topic ${topicId} does not exist yet` };
					const leaves = wiki.getChildren(root.id).map(n => ({
						nodeId: n.id,
						subject: n.path ?? "",
						title: n.title ?? "",
						summary: n.summary ?? "",
						flags: n.flags ?? [],
						body: wiki.readNodeDetail(n.id) ?? "",
					}));
					return { leaves };
				},
			}),
			searchMemory: defineTool({
				description: "Search across ALL memory leaves (every topic + per-agent + legacy) by keyword. Use for cross-topic lookups when a fact might already live under a different topic.",
				inputSchema: z.object({
					query: z.string().describe("Whitespace-separated terms; all must match (title/summary/body)"),
				}),
				execute: async ({ query }: { query: string }) => {
					const hits = wiki.searchMemoryNodes(query, 20).map(n => ({
						nodeId: n.id,
						title: n.title ?? "",
						summary: n.summary ?? "",
						flags: n.flags ?? [],
						topicId: n.parentId?.startsWith("wiki-root:memory-topic:")
							? n.parentId.slice("wiki-root:memory-topic:".length)
							: undefined,
					}));
					return { hits };
				},
			}),
			createMemory: defineTool({
				description: "UPSERT a memory leaf under a topic root. Same (topicId, subject) → same node (idempotent merge). Use for BOTH new and supplemental writes — the upsert key is (parentId, subject). content = merged body (markdown, include a ## 历史 section). flags = conflict markers (e.g. [\"conflict:needs-review\"]).",
				inputSchema: z.object({
					topicId: z.string(),
					subject: z.string().describe("Stable subject key (slugged into the path; same subject → same node)"),
					title: z.string(),
					summary: z.string().optional(),
					content: z.string().optional().describe("Merged markdown body. Include ## 历史 section for provenance."),
					flags: z.array(z.string()).optional(),
				}),
				execute: async (args: {
					topicId: string; subject: string; title: string;
					summary?: string; content?: string; flags?: string[];
				}) => {
					memoryWriteCalls++;
					const topicRoot = wiki.ensureMemoryTopicRoot(args.topicId);
					const input: Record<string, unknown> = {
						action: "createMemory",
						parentId: topicRoot.id,
						subject: args.subject,
						title: args.title,
					};
					if (args.summary !== undefined) input.summary = args.summary;
					if (args.content !== undefined) input.content = args.content;
					if (args.flags !== undefined) input.flags = args.flags;
					return await this.invokeWiki(input, callerCtx);
				},
			}),
			updateMemory: defineTool({
				description: "PATCH a memory leaf's metadata + body. Use when you already know the nodeId (from readTopicMemory / searchMemory). PATCH semantics — omit a field to leave it alone. Use flags for conflict markers; append to the body's ## 历史 section for a provenance trail.",
				inputSchema: z.object({
					nodeId: z.string(),
					title: z.string().optional(),
					summary: z.string().optional(),
					content: z.string().optional().describe("Rewritten body (full markdown). Omit to leave body untouched."),
					flags: z.array(z.string()).optional(),
				}),
				execute: async (args: {
					nodeId: string; title?: string; summary?: string;
					content?: string; flags?: string[];
				}) => {
					memoryWriteCalls++;
					const input: Record<string, unknown> = { action: "updateMemory", nodeId: args.nodeId };
					if (args.title !== undefined) input.title = args.title;
					if (args.summary !== undefined) input.summary = args.summary;
					if (args.content !== undefined) input.content = args.content;
					if (args.flags !== undefined) input.flags = args.flags;
					return await this.invokeWiki(input, callerCtx);
				},
			}),
		};

		const result = await generateText({
			model,
			system: EXTRACTOR_A_SYSTEM,
			prompt: userPrompt,
			tools,
			stopWhen: stepCountIs(maxSteps),
			maxRetries: 1,
		});

		//核対输出:agent 必须完成 ≥1 memory write,否则视为"无可记忆内容"。
		//(result.text is logged for debugging; the wiki nodes are the product.)
		log.debug("extractor-A",
			`agent loop done: steps=${result.steps?.length ?? 0} ` +
			`memoryWrites=${memoryWriteCalls} textLen=${(result.text ?? "").length}`);
		if ((result.text ?? "").trim()) {
			log.debug("extractor-A", `agent text: ${result.text.trim().slice(0, 300)}`);
		}
		return memoryWriteCalls;
	}

	/**
	 * Invoke the Wiki tool with the global-anchor callerCtx and return the
	 * text result. The tool's execute signature is (input, opts) where opts
	 * carries experimental_context.buildCallerCtx. We rebuild the host shape
	 * the tool-factory wrapper expects.
	 */
	private async invokeWiki(input: Record<string, unknown>, callerCtx: ReturnType<typeof buildGlobalAnchorWikiCallerCtx>): Promise<string> {
		const host = {
			ctx: { workingDir: "", agentId: "", emit: () => {} },
			buildCallerCtx: () => callerCtx,
		};
		try {
			const raw: any = await (wikiTool as any).execute(input, { experimental_context: host });
			if (raw && typeof raw === "object" && typeof raw.ok === "boolean") {
				return raw.data?.text ?? (raw.ok ? "ok" : "error");
			}
			return typeof raw === "string" ? raw : String(raw ?? "");
		} catch (err) {
			// tool-factory wraps ok:false results into a thrown Error carrying
			// the LLM-facing text as its message. Surface the message so the
			// agent sees the same text success-path callers do.
			return (err as Error).message;
		}
	}

	/** Collect the ids of all memory leaves under a topic subtree. */
	private collectTopicMemoryIds(topicId: string): string[] {
		const root = this.opts.wiki.get(memoryTopicRootId(topicId));
		if (!root) return [];
		return this.opts.wiki.getChildren(root.id).map(n => n.id);
	}
}
