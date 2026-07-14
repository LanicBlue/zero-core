// 阶段3 压缩核心 (steps-overhaul sub-4 → compression-archive-simplify sub-3b 滚动摘要化)
//
// # 文件说明书
//
// ## 核心功能
// 读「压缩游标之后、fresh tail 之外」的 step(step 粒度) → 调一次单步
// generateText(用 settings/memory 配置的独立模型),把(旧摘要 + 被压 steps)
// 合并成新的 5 段结构化滚动摘要 → 原子替换 messages 表的 summary 行 + 推进
// `last_compressed_step_seq` 游标。一次压缩 pass 产 ONE 滚动摘要(信息源 =
// prior summary + 全部被压段;段循环顺序更新 runningSummary)。
//
// sub-3b 滚动摘要(详见 docs/plan/compression-archive-simplify/design.md「二、
// 压缩流程」+ O6):
// - **update**(非从头重述):prior summary 作 HANDOFF CONTEXT 喂 LLM;段循环
//   末尾一次写入。
// - **handoff 前缀**:user prompt 里 prior summary 被显式标为"背景参考,非当前
//   指令";system prompt 指示 STRIP 过时指令(如旧 status 的"下一步")。
// - **长度上限**:system prompt 指示 ≤ ~600 tokens;opts.maxSummaryTokens
//   (默认 800)是硬上限。防累积膨胀。
// - **prompt 可配**(D2):opts.summarySystemPrompt 覆盖默认 SUMMARY_SYSTEM;
//   输出 sections 契约固定,改坏走 fallbackSections。
// - **ExtractorA 拆除**:不再 fire-and-forget 调 ExtractorA 的 wiki-merge 入口(sub-3c
//   Force 档 memory turn 替代)。extractor-a-service.ts 主体留 sub-5 删。
//
// 这是 sub-4 的「callable 压缩核心」——不接线触发(StepEnd/PreLLMCall hook 由
// sub-5 接)。验收用测试直调 compressSession()。
//
// ## 输入
// - SessionDB(读 steps / messages summary / 游标;写 summary + 推进游标)
// - sessionId
// - providers / providerName / modelId(独立 memory 模型,config.compression.
//   provider/model;回退到 session 工作模型)
// - 上下文窗口(fresh tail 边界计算用)
// - opts.summarySystemPrompt(D2 可配 prompt,默认 SUMMARY_SYSTEM)
// - opts.maxSummaryTokens(长度上限,默认 800)
//
// ## 输出
// - { summaries: MessageSummary[], newCursor: number } —— 一次 pass 最多 1 个
//   summary(滚动合并产物)+ 推进后的新游标。游标 = 被压范围末尾 step seq。
//   steps 表不动。
//
// ## 关键不变量(acceptance-3b)
// - summary 5 段(目的/计划/状态/关键产物·文件/经验),状态段含「下一步立即动作」。
// - compress once:同一段 step 不被 re-summarize。游标只前进,被压范围(seq ≤
//   newCursor)不再被本函数取到。
// - 滚动 update:旧摘要的内容被 merge 进新摘要(经 LLM handoff);多次压缩信息
//   不丢。replaceSummariesAndAdvanceCursor 原子清旧+写新+推游标。
// - summary 带寻回指针(stepRange = 被压 step seq 范围)。
// - steps 表不动;fresh tail 不被压(永远在 newCursor 之后)。
// - handoff 语义:prior summary 仅作背景参考,过时指令(status 的"下一步")剥除。
// - 长度上限:摘要不无限累积;system prompt 软指示 + maxOutputTokens 硬上限。
//
// ## 不做
// - 不接线触发(StepEnd / PreLLMCall / new-turn / reactive 兜底——sub-5)。
// - 不写 wiki(ExtractorA compression 耦合已拆;wiki 写由 sub-3c Force 档 memory
//   ephemeral turn 替代)。
// - 不动 steps 表(只是读)。
//
// ## 定位
// src/server/ 服务层模块。被 sub-5 的触发器(stepend-trigger / preflight)调,
// 也被测试直调。不塞进 AgentLoop(memory feedback-agent-loop-hooks-only)。
//
// ## 依赖
// - ai.generateText、runtime/provider-factory.resolveModel(独立模型)
// - server/session-db(SessionDB: getSteps / getCompressionCursor / getSummaries /
//   replaceSummariesAndAdvanceCursor / saveSummaryAndAdvanceCursor)
// - runtime/session-store-interface 类型(MessageSummary / StepRow)
// - core/logger
//
// ## 维护规则
// - summary 模板/prompt 改动后跑 acceptance-3b 测试(滚动 update + handoff 前缀
//   + 长度上限 + 5 段 + 状态段「下一步」+ 寻回指针 + 输出格式核对)。
// - fresh tail 边界:compression-core 的 computeFreshTailStartSeq 是 design.md
//   「fresh tail 保护」规则的 SINGLE 源(sub-3a:session.ts 的同名镜像已删)。
//   LLM view 不再用它(2-zone = summary + postCursor verbatim);它只在压缩
//   pipeline 里决定 cursor 前进到哪。
//

import { generateText } from "ai";
import type { RuntimeProviderConfig } from "../runtime/types.js";
import { resolveModel } from "../runtime/provider-factory.js";
import type { SessionDB, MessageSummary } from "./session-db.js";
import type { StepRow } from "../runtime/session-store-interface.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Constants — fresh-tail boundary (mirrors session.ts assembleLLMView)
// ---------------------------------------------------------------------------

// design.md「fresh tail 保护」:fresh tail = 最近若干 step,token 预算 =
// min(32K token, 20% 窗口),step 粒度,tool-pair 安全。压缩只作用于边界之前。
// 与 src/runtime/session.ts 的同名常量保持一致(两边是同一条 design 规则)。
const FRESH_TAIL_ABSOLUTE_TOKEN_BUDGET = 32_000;
const FRESH_TAIL_WINDOW_FRACTION = 0.20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 一段待压缩的 step(按 turn_group 近似主题切)。 */
interface CompressionSegment {
	/** 这段第一个 step 的 seq(含)。 */
	fromSeq: number;
	/** 这段最后一个 step 的 seq(含)。 */
	toSeqInclusive: number;
	/** 这段的 step 行(渲染 transcript 用)。 */
	steps: StepRow[];
}

/** compressSession 的返回。 */
export interface CompressionResult {
	/** 本次写入 messages 表的 summary 块(0..N)。 */
	summaries: MessageSummary[];
	/** 推进后的新压缩游标(被压范围末尾 step seq)。无新压缩时 = 旧游标。 */
	newCursor: number;
	/** 本次跳过原因(无待压 step / LLM 失败 / 等)。无跳过时 undefined。 */
	skippedReason?: string;
}

export interface CompressSessionOptions {
	providers: RuntimeProviderConfig[];
	providerName: string;
	modelId: string;
	/** 上下文窗口(token),fresh tail 边界用。 */
	contextWindow?: number;
	/**
	 * 测试专用:跳过 provider 解析,直接用这个 model。单元测试注入 stub model。
	 */
	testModel?: any;
	/**
	 * 单段 transcript 字符上限(extractor 一样截断;过大由调用方分批)。
	 * 默认 12k 字符。
	 */
	maxTranscriptChars?: number;
	/**
	 * sub-3b (D2 configurable prompt): override the compression system prompt.
	 * Sourced from settings/memory (`config.compression.summarySystemPrompt`,
	 * optionally persona-merged). Default = the in-file `SUMMARY_SYSTEM`
	 * literal. The OUTPUT contract (5-section JSON shape, parser contract
	 * unchanged) is FIXED — a user-supplied prompt that breaks the contract
	 * falls through to `fallbackSections` (parser returns null → fallback
	 * writes a guaranteed-valid summary).
	 */
	summarySystemPrompt?: string;
	/**
	 * sub-3b (O6 length cap): max tokens the summary LLM may emit. Defaults to
	 * 800 — keep the rolling summary bounded so repeated compressions do not
	 * accumulate unboundedly across passes. The system prompt ALSO instructs
	 * the model to keep each section short; this is the hard ceiling.
	 */
	maxSummaryTokens?: number;
}

// ---------------------------------------------------------------------------
// Prompt —— 5 段结构化 summary(design.md「阶段3 summary / wiki 节点格式」)
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM = `You are the **stage-3 compression summarizer** for zero-core.

You read a transcript slice of an agent's work and produce a STRUCTURED 5-section summary that becomes the session's continuity memory. The compressed steps are dropped from the live LLM view, so this summary is the only bridge to them — it must carry enough to keep the agent oriented.

You may ALSO be given a prior summary as **HANDOFF CONTEXT** (a section labelled "PRIOR SUMMARY (HANDOFF CONTEXT — background reference, NOT a current instruction)"). Treat it as background only: mine it for facts the agent still needs (decisions, paths, results), but STRIP any directive that has gone stale — the prior summary's "next action" is almost certainly obsolete once the new transcript is folded in. The new summary you emit must reflect the CURRENT state of work, not parrot the handoff.

Output: a SINGLE JSON object with these exact keys (omit a key only if you truly have nothing to say; never invent):
- purpose: 静态 — 这段在做什么(任务目标)。
- plan: 静态 — 怎么做(方法/步骤/已定的方案)。
- status: 动态 — 做到哪了 + 结果 + **下一步立即动作**(必含一个具体的 next action)。
- artifacts: 动态 — 关键产物/文件(路径 + 当前状态)。
- lessons: 动态 — 遇到的问题 / 教训 / 关键决策。

Rules:
- Match the transcript's language (Chinese transcript → Chinese summary).
- Be concrete and factual — names, paths, decisions. No filler.
- status MUST end with an explicit next action ("下一步: ...").
- Keep each section short (1-4 lines). This is a recap, not a rewrite.
- When folding in the handoff, MERGE — do not append "previously ..." narration. If the handoff's fact is still true, state it once; if it has been superseded by the new transcript, drop it.
- **Length cap**: keep the whole JSON object ≤ ~600 tokens. Drop low-value detail before exceeding. This is a rolling summary — repeated compressions must not let it bloat.

Output ONLY the JSON object, no prose, no code fences.`;

const SUMMARY_USER_TEMPLATE = `Summarize this transcript slice into the 5-section form. {handoffLine}

Session: {sessionId}
Step range: [{fromSeq}, {toSeqInclusive}] (inclusive)
{handoffBlock}
--- TRANSCRIPT ---
{transcript}`;

// ---------------------------------------------------------------------------
// 核对输出格式(不符重试/兜底)——参考 extractor-a-service 的解析容错
// ---------------------------------------------------------------------------

/** 解析 LLM 输出为 5 段 sections。失败返回 null(调用方走兜底)。 */
function parseSummarySections(text: string): { [k: string]: string } | null {
	const trimmed = text.trim();
	// 容错:剥 ```json fences。
	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	const jsonText = fenceMatch ? fenceMatch[1] : trimmed;
	// 提取首个 {...} 对象。
	const objMatch = jsonText.match(/\{[\s\S]*\}/);
	if (!objMatch) return null;
	let parsed: any;
	try {
		parsed = JSON.parse(objMatch[0]);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const allowed = new Set(["purpose", "plan", "status", "artifacts", "lessons"]);
	const out: { [k: string]: string } = {};
	for (const [k, v] of Object.entries(parsed)) {
		if (!allowed.has(k)) continue;
		if (typeof v !== "string") continue;
		const s = v.trim();
		if (s) out[k] = s.slice(0, 4000);
	}
	// 至少要有 status 段(其它段允许空)。
	if (!out.status) return null;
	return out;
}

/** 状态段必须含「下一步」动作——acceptance-4 不变量。中英都认。 */
function statusHasNextAction(status: string): boolean {
	if (!status) return false;
	const lower = status.toLowerCase();
	// 中文:「下一步」「接下来」「然后」;英文:"next:", "then", "next step"。
	return /下一步|接下来|然后|next\s*:|next step|then\s*:|do next/i.test(status)
		|| /next action/i.test(lower);
}

// ---------------------------------------------------------------------------
// Fresh-tail boundary —— design.md「fresh tail 保护」规则的 SINGLE 源
// ---------------------------------------------------------------------------

/**
 * 计算 fresh tail 的起始 seq(含)。fresh tail 是最近一段总 token 预算内的 step,
 * 压缩只作用于它之前。返回 postCursorSteps 中属于 fresh tail 的最低 seq。
 *
 * sub-3a:这是 design.md「fresh tail 保护」规则的 SINGLE 源。session.ts 历史上有
 * 一份镜像(computeFreshTailBoundary),已在 sub-3a 删除 —— LLM view 改 2-zone
 * (summary + postCursor verbatim)后不再需要 boundary,这里只服务于压缩 pipeline
 * 决定 cursor 前进到哪。语义改动请同步更新 design.md「fresh tail 保护」段。
 */
export function computeFreshTailStartSeq(
	postCursorSteps: StepRow[],
	contextWindow: number,
): number {
	if (postCursorSteps.length === 0) return Number.MAX_SAFE_INTEGER;

	const absoluteBudget = FRESH_TAIL_ABSOLUTE_TOKEN_BUDGET;
	const windowBudget = Math.floor(contextWindow * FRESH_TAIL_WINDOW_FRACTION);
	let budget = Math.min(absoluteBudget, windowBudget);

	// postCursorSteps 升序;从最新向前吃预算。
	let freshStartIdx = postCursorSteps.length;
	for (let i = postCursorSteps.length - 1; i >= 0; i--) {
		const cost = estimateStepTokens(postCursorSteps[i]);
		if (budget - cost < 0) break;
		budget -= cost;
		freshStartIdx = i;
	}
	// 保证 tail 非空:最新的 step 必留(即使超预算)。
	if (freshStartIdx === postCursorSteps.length) {
		freshStartIdx = postCursorSteps.length - 1;
	}
	return postCursorSteps[freshStartIdx].seq;
}

function estimateStepTokens(step: StepRow): number {
	return Math.ceil((step.content ?? "").length / 4) + 8;
}

// ---------------------------------------------------------------------------
// Segment 切分(按 turn_group ≈ 主题)
// ---------------------------------------------------------------------------

/**
 * 把 postCursor、非 fresh-tail 的 step 按 turn_group 切成若干段。每段 = 一个主题
 * 近似 = 一个 summary 候选。一段内 user step 开头(如果有的话)携带任务方向。
 *
 * 切分规则:连续相同 turn_group 的 step 归一段。空段跳过。返回段按 seq 升序。
 */
export function segmentByTurnGroup(steps: StepRow[]): CompressionSegment[] {
	if (steps.length === 0) return [];
	const segments: CompressionSegment[] = [];
	let current: CompressionSegment | null = null;
	for (const step of steps) {
		if (!current || current.steps[0].turnGroup !== step.turnGroup) {
			if (current && current.steps.length > 0) segments.push(current);
			current = { fromSeq: step.seq, toSeqInclusive: step.seq, steps: [step] };
		} else {
			current.steps.push(step);
			current.toSeqInclusive = step.seq;
		}
	}
	if (current && current.steps.length > 0) segments.push(current);
	return segments;
}

// ---------------------------------------------------------------------------
// Transcript 渲染(复用 sliceTranscriptDelta 的语义,但作用在已切好的段上)
// ---------------------------------------------------------------------------

function renderSegmentTranscript(seg: CompressionSegment, maxChars: number): string {
	const lines: string[] = [];
	let used = 0;
	for (const step of seg.steps) {
		const text = renderStep(step);
		if (!text) continue;
		if (used + text.length + 2 > maxChars) break;
		lines.push(text);
		used += text.length + 2;
	}
	return lines.join("\n\n");
}

function renderStep(step: StepRow): string {
	const role = step.role === "user" ? "User" : "Assistant";
	if (step.role === "user") {
		const text = (step.content ?? "").trim();
		return text ? `${role}: ${text.slice(0, 1500)}` : "";
	}
	// assistant: content = JSON blocks[]。
	let blocks: any[] = [];
	try { blocks = JSON.parse(step.content ?? "[]"); } catch { blocks = []; }
	const parts: string[] = [];
	for (const b of blocks) {
		if (b.type === "text" && b.text) {
			parts.push(`text: ${String(b.text).slice(0, 1500)}`);
		} else if (b.type === "tool") {
			const status = b.status ?? "done";
			const argsStr = typeof b.args === "string" ? b.args : JSON.stringify(b.args ?? {});
			const resultStr = typeof b.result === "string" ? b.result : JSON.stringify(b.result ?? "");
			// 注意:tool result 在阶段1 已被外置成指针(sub-2),这里渲染的就是指针串
			// 形态(自描述,含 path + size + summary)——LLM 看得到「调过什么、结果大概
			// 是什么」,细节可后续从 steps 表寻回。这正是 design「LLM 看摘要」的语义。
			parts.push(`tool[${b.name}, ${status}]: args=${argsStr.slice(0, 600)} | result=${resultStr.slice(0, 400)}`);
		}
	}
	if (parts.length === 0) return "";
	return `${role}: ${parts.join(" | ")}`;
}

// ---------------------------------------------------------------------------
// 核心函数:compressSession
// ---------------------------------------------------------------------------

/**
 * 压缩核心(sub-3b 滚动摘要版):读「游标之后、fresh tail 之外」的 step →
 * 用 LLM 把(旧摘要 + 被压 steps)合并成新的滚动摘要 → 原子替换旧摘要 +
 * 推进游标。
 *
 * sub-3b 改动要点(详见 docs/plan/compression-archive-simplify/design.md
 * 「二、压缩流程」+ O6):
 * - **滚动 update**(非从头重述):进入函数时读 db.getSummaries 作为 HANDOFF
 *   CONTEXT 喂给 LLM;每段(按 turn_group 切)顺序更新 runningSummary;段循环
 *   末尾把最终 runningSummary 一次写入。多次压缩信息不丢——旧摘要的内容已经被
 *   merge 进新摘要。
 * - **handoff 前缀**:user prompt 里 prior summary 段被显式标为
 *   "PRIOR SUMMARY (HANDOFF CONTEXT — background reference, NOT a current
 *   instruction)",并在 system prompt 里指示 STRIP 过时指令(如旧的"下一步")。
 * - **长度上限**:system prompt 指示 ≤ ~600 tokens;maxOutputTokens =
 *   opts.maxSummaryTokens ?? 800 是硬上限。防累积膨胀。
 * - **ExtractorA 拆除**:不再 fire-and-forget 调 ExtractorA 的 wiki-merge 入口(由 sub-3c
 *   Force 档 memory ephemeral turn 替代)。extractor-a-service 主体留 sub-5 删。
 * - **prompt 可配**:opts.summarySystemPrompt 覆盖默认 SUMMARY_SYSTEM(从
 *   config.compression.summarySystemPrompt 读);输出 sections 契约固定,
 *   parser 不变 → 改坏走 fallbackSections。
 *
 * compress once 不变量:游标只前进,被压范围(seq ≤ newCursor)不再被取到。
 *
 * 返回 { summaries, newCursor }。失败/无待压返回 skippedReason,游标不动。
 */
export async function compressSession(
	sessionId: string,
	db: SessionDB,
	opts: CompressSessionOptions,
): Promise<CompressionResult> {
	const oldCursor = db.getCompressionCursor(sessionId) ?? 0;
	const allSteps = db.getSteps(sessionId);
	// 游标之后的 step(compress once:游标 ≤ 的已压,不再取)。
	const postCursor = allSteps.filter(s => s.seq > oldCursor);
	if (postCursor.length === 0) {
		return { summaries: [], newCursor: oldCursor, skippedReason: "no steps after cursor" };
	}

	const contextWindow = opts.contextWindow ?? 128000;
	const freshTailStart = computeFreshTailStartSeq(postCursor, contextWindow);
	// 待压 = 游标之后、fresh tail 之外。
	const toCompress = postCursor.filter(s => s.seq < freshTailStart);
	if (toCompress.length === 0) {
		return { summaries: [], newCursor: oldCursor, skippedReason: "no steps between cursor and fresh-tail boundary" };
	}

	const segments = segmentByTurnGroup(toCompress);
	if (segments.length === 0) {
		return { summaries: [], newCursor: oldCursor, skippedReason: "no segments to summarize" };
	}

	const maxChars = opts.maxTranscriptChars ?? 12000;
	const model = opts.testModel ?? resolveModel(opts.providers, opts.providerName, opts.modelId);
	// sub-3b D2: configurable system prompt (settings/memory override), default
	// to the in-file SUMMARY_SYSTEM literal. The OUTPUT contract (5-section
	// JSON) is fixed by the parser — a custom prompt that breaks it falls
	// through to fallbackSections.
	const systemPrompt = opts.summarySystemPrompt ?? SUMMARY_SYSTEM;
	const maxSummaryTokens = opts.maxSummaryTokens ?? 800;

	// sub-3b rolling update: read prior summaries as HANDOFF CONTEXT. The LLM
	// merges (handoff + compressed steps) → new rolling summary that replaces
	// both. Prior summaries are read here, fed to the LLM, then atomically
	// wiped by replaceSummariesAndAdvanceCursor at the end.
	const priorSummaries: MessageSummary[] =
		typeof db.getSummaries === "function" ? (db.getSummaries(sessionId) ?? []) : [];

	let runningSections: { [k: string]: string } | null = null;
	// runningRange tracks the step range the running summary currently covers
	// (across all merged segments + the prior handoff). Used for the title +
	// stepRange anchor on the final write.
	let runningRangeFrom = segments[0].fromSeq;
	let runningRangeTo = oldCursor;
	let compressedToSeq = oldCursor;
	let anySegmentsSummarized = false;

	for (const seg of segments) {
		const transcript = renderSegmentTranscript(seg, maxChars);
		if (!transcript.trim()) {
			// 空段(全是空 step)——跳过,但仍要把这段的 seq 算进被压范围(否则游标
			// 不前进,下轮又取到)。
			compressedToSeq = Math.max(compressedToSeq, seg.toSeqInclusive);
			runningRangeTo = Math.max(runningRangeTo, seg.toSeqInclusive);
			continue;
		}
		// handoff: prior summaries (first iteration only, before we have a
		// running summary) OR the running summary produced by the previous
		// segment in this pass. Both serve the same semantic role — context
		// the new summary should fold in, NOT a current directive.
		const handoff = runningSections
			? renderRunningHandoff(runningSections, runningRangeFrom, runningRangeTo)
			: renderPriorHandoff(priorSummaries);
		let sections: { [k: string]: string } | null = null;
		try {
			const user = SUMMARY_USER_TEMPLATE
				.replace("{handoffLine}", handoff ? "Fold the HANDOFF block into the new summary." : "No prior summary — summarize from scratch.")
				.replace("{sessionId}", sessionId)
				.replace("{fromSeq}", String(seg.fromSeq))
				.replace("{toSeqInclusive}", String(seg.toSeqInclusive))
				.replace("{handoffBlock}", handoff ?? "");
			const result = await generateText({
				model,
				system: systemPrompt,
				prompt: user,
				maxOutputTokens: maxSummaryTokens,
			});
			sections = parseSummarySections(result.text);
			// 核对输出格式:状态段必须有「下一步立即动作」。不符 → 兜底重试一次,
			// 仍不符 → 用兜底 sections(保证总有 summary 写入)。
			if (sections && !statusHasNextAction(sections.status)) {
				log.warn("compression-core",
					`summary status missing next-action (seg ${seg.fromSeq}..${seg.toSeqInclusive}); retrying`);
				const retry = await generateText({
					model,
					system: systemPrompt,
					prompt: user + "\n\nREMINDER: the `status` field MUST end with an explicit next action (下一步: ...).",
					maxOutputTokens: maxSummaryTokens,
				});
				sections = parseSummarySections(retry.text);
			}
		} catch (err) {
			log.warn("compression-core", `LLM call failed for seg ${seg.fromSeq}..${seg.toSeqInclusive}:`, (err as Error).message);
		}
		if (!sections) {
			// 兜底:仍产 sections(状态段含「下一步」);fold 进 prior handoff 的
			// 关键信息(purpose/plan/artifacts/lessons)以防 LLM 失败时丢上下文。
			sections = fallbackSections(seg, runningSections ?? mergePriorSections(priorSummaries));
		}
		runningSections = sections;
		anySegmentsSummarized = true;
		compressedToSeq = Math.max(compressedToSeq, seg.toSeqInclusive);
		runningRangeTo = Math.max(runningRangeTo, seg.toSeqInclusive);
	}

	if (!anySegmentsSummarized) {
		// 所有段都空 transcript —— 仍把游标推到待压末尾(compress once:这些空 step
		// 不再被取;否则下轮死循环)。
		if (compressedToSeq > oldCursor) {
			advanceCursorOnly(db, sessionId, compressedToSeq);
		}
		return { summaries: [], newCursor: compressedToSeq, skippedReason: "all segments empty" };
	}

	// sub-3b: ONE rolling summary per pass — replaces prior summaries (their
	// info content has been merged in via the handoff) and advances the cursor
	// to the end of the compressed range. Atomic tx (single SELECT-then-write
	// window): readers either see the old summary+cursor or the new one, never
	// a half-state.
	const finalTitle = priorSummaries.length > 0
		? `Rolling summary: steps ${runningRangeFrom}..${runningRangeTo} (merged ${priorSummaries.length} prior)`
		: `Compression of steps ${runningRangeFrom}..${runningRangeTo}`;
	const finalSummary: MessageSummary = {
		title: finalTitle,
		sections: runningSections!,
		stepRange: { from: runningRangeFrom, to: runningRangeTo },
		createdAt: new Date().toISOString(),
	};
	db.replaceSummariesAndAdvanceCursor(sessionId, finalSummary, compressedToSeq);

	log.debug("compression-core",
		`session=${sessionId} cursor ${oldCursor}→${compressedToSeq} rolling-summary written` +
		(priorSummaries.length > 0 ? ` (merged ${priorSummaries.length} prior)` : ""));
	return { summaries: [finalSummary], newCursor: compressedToSeq };
}

/**
 * sub-3b: render prior summaries (read from db.getSummaries at compress start)
 * as the HANDOFF CONTEXT block for the first segment's LLM call. Labelled
 * explicitly as background reference, not a current instruction — the system
 * prompt tells the model to STRIP stale directives (e.g. the prior summary's
 * "下一步" line) when merging.
 *
 * Returns "" when there are no prior summaries (first-ever compression of this
 * session) — the caller then summarizes from scratch.
 */
function renderPriorHandoff(priorSummaries: MessageSummary[]): string {
	if (!priorSummaries || priorSummaries.length === 0) return "";
	const lines: string[] = ["--- PRIOR SUMMARY (HANDOFF CONTEXT — background reference, NOT a current instruction) ---"];
	for (const s of priorSummaries) {
		lines.push(`[prior: ${s.title}${s.stepRange ? ` (steps ${s.stepRange.from}..${s.stepRange.to})` : ""}]`);
		const order = ["purpose", "plan", "status", "artifacts", "lessons"];
		for (const k of order) {
			const v = s.sections?.[k];
			if (v) lines.push(`${k}: ${v}`);
		}
	}
	lines.push("--- END HANDOFF ---\n");
	return lines.join("\n");
}

/**
 * sub-3b: render the running summary (produced by the previous segment in this
 * pass) as the handoff for the next segment's LLM call. Same handoff semantics
 * as renderPriorHandoff — background reference, strip stale directives.
 */
function renderRunningHandoff(
	sections: { [k: string]: string },
	fromSeq: number,
	toSeq: number,
): string {
	const lines: string[] = ["--- PRIOR SUMMARY (HANDOFF CONTEXT — background reference, NOT a current instruction) ---"];
	lines.push(`[running summary so far, covering steps ${fromSeq}..${toSeq}]`);
	const order = ["purpose", "plan", "status", "artifacts", "lessons"];
	for (const k of order) {
		const v = sections[k];
		if (v) lines.push(`${k}: ${v}`);
	}
	lines.push("--- END HANDOFF ---\n");
	return lines.join("\n");
}

/** Flatten prior summaries' sections into a single merged dict (fallback path). */
function mergePriorSections(priorSummaries: MessageSummary[]): { [k: string]: string } | null {
	if (!priorSummaries || priorSummaries.length === 0) return null;
	const merged: { [k: string]: string } = {};
	const order = ["purpose", "plan", "status", "artifacts", "lessons"];
	for (const s of priorSummaries) {
		for (const k of order) {
			const v = s.sections?.[k];
			if (!v) continue;
			merged[k] = merged[k] ? `${merged[k]}\n${v}` : v;
		}
	}
	return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * LLM 失败兜底:仍产 5 段(状态段含「下一步」,满足不变量),保证总有 summary 写入。
 *
 * sub-3b: 接受可选的 handoff sections(prior summary 或 running summary)—— LLM
 * 失败时把 handoff 的 purpose/plan/artifacts/lessons 抄进兜底(状态段重写为
 * "兜底+下一步",绝不照抄旧 status 里的过时指令)。这样 LLM 偶发失败不会丢上下文。
 */
function fallbackSections(
	seg: CompressionSegment,
	handoff?: { [k: string]: string } | null,
): { [k: string]: string } {
	// 从段里尽量抽点线索(首个 user / 最后 assistant text)。
	const userStep = seg.steps.find(s => s.role === "user");
	const userText = (userStep?.content ?? "").trim().slice(0, 500) || "(无显式用户指令)";
	const lastAsst = [...seg.steps].reverse().find(s => s.role === "assistant");
	let lastText = "";
	if (lastAsst) {
		try {
			const blocks = JSON.parse(lastAsst.content ?? "[]");
			lastText = (blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") || "").slice(0, 500);
		} catch { /* ignore */ }
	}
	// Fold in handoff context (purpose/plan/artifacts/lessons) so a transient
	// LLM failure does not erase the cross-session memory the rolling summary
	// is supposed to preserve. status is ALWAYS rewritten — never parrot the
	// handoff's stale "next action".
	const out: { [k: string]: string } = {
		purpose: (handoff?.purpose ? `${handoff.purpose}\n` : "") + userText,
		status: `压缩自动兜底(LLM 调用失败/格式不符)。覆盖 step ${seg.fromSeq}..${seg.toSeqInclusive}。下一步:从 steps 表按 stepRange 寻回原始 step,确认进展后续行。`,
	};
	if (handoff?.plan) out.plan = handoff.plan;
	if (lastText) out.artifacts = (handoff?.artifacts ? `${handoff.artifacts}\n` : "") + lastText;
	else if (handoff?.artifacts) out.artifacts = handoff.artifacts;
	if (handoff?.lessons) out.lessons = handoff.lessons;
	return out;
}

/**
 * 只推游标不写 summary(全空段场景)。messages 表有 ≥1 summary 行时游标冗余在每
 * 行,直接 UPDATE;无行时没地方挂游标——保持不动(下轮有内容一起推)。
 */
function advanceCursorOnly(db: SessionDB, sessionId: string, newCursor: number): void {
	try {
		const cnt = (db.getDb().prepare(
			"SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?",
		).get(sessionId) as { cnt: number } | undefined)?.cnt ?? 0;
		if (cnt === 0) return;
		db.getDb().prepare(
			"UPDATE messages SET last_compressed_step_seq = ? WHERE session_id = ?",
		).run(newCursor, sessionId);
	} catch (err) {
		log.warn("compression-core", `advanceCursorOnly failed (session=${sessionId}):`, (err as Error).message);
	}
}
