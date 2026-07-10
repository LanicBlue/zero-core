// 阶段3 压缩核心 (steps-overhaul sub-4)
//
// # 文件说明书
//
// ## 核心功能
// 读「压缩游标之后、fresh tail 之外」的 step(step 粒度) → 调一次 Extractor A
// 风格的单步 generateText(用 settings/memory 配置的独立模型)产 5 段结构化
// summary → 写 `messages` 表的 summary 块 + 推进 `last_compressed_step_seq`
// 游标。一次压缩可产多个 summary(跨主题),每段 step 只 summarize 一次。
//
// 这是 sub-4 的「callable 压缩核心」——不接线触发(StepEnd/PreLLMCall hook 由
// sub-5 接)。验收用测试直调 compressSession()。
//
// ## 输入
// - SessionDB(读 steps / messages summary / 游标;写 summary + 推进游标)
// - sessionId
// - providers / providerName / modelId(独立 memory 模型,见 config.extractors.A
//   —— 本 sub 复用同一模型配置;sub-7 多步 Extractor A agent 也是它)
// - 上下文窗口(fresh tail 边界计算用)
//
// ## 输出
// - { summaries: MessageSummary[], newCursor: number } —— 写进了多少 summary
//   块 + 推进后的新游标。游标 = 被压范围末尾 step seq。steps 表不动。
//
// ## 关键不变量(acceptance-4)
// - summary 5 段(目的/计划/状态/关键产物·文件/经验),状态段含「下一步立即动作」。
// - compress once:同一段 step 不被 re-summarize。游标只前进,被压范围(seq ≤
//   newCursor)不再被本函数取到。
// - summary 写 messages + 推进 last_compressed_step_seq;cap 3 FIFO(sub-3
//   saveSummaryAndAdvanceCursor 已实现)。
// - summary 带寻回指针(stepRange = 被压 step seq 范围)。
// - steps 表不动;fresh tail 不被压(永远在 newCursor 之后)。
// - 一次压缩可产多个 summary(跨主题):按 turn_group(=主题近似)分段,每段产
//   一个 summary。
//
// ## 不做
// - 不接线触发(StepEnd / PreLLMCall / new-turn / reactive 兜底——sub-5)。
// - 不写 wiki(本 sub 只产 summary;wiki 节点更新留 sub-7 Extractor A 多步 agent)。
// - 不动 steps 表(只是读)。
//
// ## 定位
// src/server/ 服务层模块。被 sub-5 的触发器(stepend-trigger / preflight)调,
// 也被测试直调。不塞进 AgentLoop(memory feedback-agent-loop-hooks-only)。
//
// ## 依赖
// - ai.generateText、runtime/provider-factory.resolveModel(独立模型)
// - server/session-db(SessionDB: getSteps / getCompressionCursor /
//   saveSummaryAndAdvanceCursor)
// - runtime/session-store-interface 类型(MessageSummary / StepRow)
// - core/logger
//
// ## 维护规则
// - summary 模板/prompt 改动后跑 acceptance-4 测试(5 段 + 状态段「下一步」+
//   寻回指针 + 输出格式核对)。
// - fresh tail 边界语义与 session.ts assembleLLMView 的 computeFreshTailBoundary
//   保持一致(两边都是 design.md「fresh tail 保护」的同一条规则)。
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
}

// ---------------------------------------------------------------------------
// Prompt —— 5 段结构化 summary(design.md「阶段3 summary / wiki 节点格式」)
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM = `You are the **stage-3 compression summarizer** for zero-core.

You read a transcript slice of an agent's work and produce a STRUCTURED 5-section summary that becomes the session's continuity memory (and the input to a later wiki-node merge). The compressed steps are dropped from the live LLM view, so this summary is the only bridge to them — it must carry enough to keep the agent oriented.

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
- Do NOT re-summarize content that is already a summary.

Output ONLY the JSON object, no prose, no code fences.`;

const SUMMARY_USER_TEMPLATE = `Summarize this transcript slice into the 5-section form.

Session: {sessionId}
Step range: [{fromSeq}, {toSeqInclusive}] (inclusive)

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
// Fresh-tail boundary —— 与 session.ts computeFreshTailBoundary 同语义
// ---------------------------------------------------------------------------

/**
 * 计算 fresh tail 的起始 seq(含)。fresh tail 是最近一段总 token 预算内的 step,
 * 压缩只作用于它之前。返回 postCursorSteps 中属于 fresh tail 的最低 seq。
 *
 * 与 src/runtime/session.ts AgentSession.computeFreshTailBoundary 是同一条 design
 * 规则(design.md「fresh tail 保护」)的两个消费者;语义必须保持一致,否则压缩边
 * 界 ≠ 组装边界,被压的 step 会出现在 fresh tail 里。
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
 * 压缩核心:读「游标之后、fresh tail 之外」的 step → 产 5 段 summary(每段一个)→
 * 写 messages + 推进游标。
 *
 * 不接线触发(sub-5);不写 wiki(sub-7);不动 steps 表。
 *
 * compress once 不变量:游标只前进,被压范围(seq ≤ newCursor)不再被取到。
 * 本函数读游标 → 只压游标之后的 → 推进到被压末尾。绝不对 summary 再 summarize。
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

	const written: MessageSummary[] = [];
	let compressedToSeq = oldCursor;

	for (const seg of segments) {
		const transcript = renderSegmentTranscript(seg, maxChars);
		if (!transcript.trim()) {
			// 空段(全是空 step)——跳过,但仍要把这段的 seq 算进被压范围(否则游标
			// 不前进,下轮又取到)。compressedToSeq 在段循环末尾统一推。
			compressedToSeq = Math.max(compressedToSeq, seg.toSeqInclusive);
			continue;
		}
		let sections: { [k: string]: string } | null = null;
		try {
			const user = SUMMARY_USER_TEMPLATE
				.replace("{sessionId}", sessionId)
				.replace("{fromSeq}", String(seg.fromSeq))
				.replace("{toSeqInclusive}", String(seg.toSeqInclusive))
				.replace("{transcript}", transcript);
			const result = await generateText({
				model,
				system: SUMMARY_SYSTEM,
				prompt: user,
				maxOutputTokens: 800,
			});
			sections = parseSummarySections(result.text);
			// 核对输出格式:状态段必须有「下一步立即动作」。不符 → 兜底重试一次,
			// 仍不符 → 用兜底 sections(保证总有 summary 写入,cap 3 FIFO 语义稳)。
			if (sections && !statusHasNextAction(sections.status)) {
				log.warn("compression-core",
					`summary status missing next-action (seg ${seg.fromSeq}..${seg.toSeqInclusive}); retrying`);
				const retry = await generateText({
					model,
					system: SUMMARY_SYSTEM,
					prompt: user + "\n\nREMINDER: the `status` field MUST end with an explicit next action (下一步: ...).",
					maxOutputTokens: 800,
				});
				sections = parseSummarySections(retry.text);
			}
		} catch (err) {
			log.warn("compression-core", `LLM call failed for seg ${seg.fromSeq}..${seg.toSeqInclusive}:`, (err as Error).message);
		}
		if (!sections) {
			// 兜底:仍写一个 summary(保证 cap 3 FIFO 语义 + 游标推进不被 LLM 失败阻塞)。
			sections = fallbackSections(seg);
		}

		const summary: MessageSummary = {
			title: `Compression of steps ${seg.fromSeq}..${seg.toSeqInclusive}`,
			sections,
			stepRange: { from: seg.fromSeq, to: seg.toSeqInclusive },
			createdAt: new Date().toISOString(),
		};
		// saveSummaryAndAdvanceCursor 内部 cap 3 FIFO + 推进 last_compressed_step_seq。
		// 推进值 = 这段末尾 step seq(被压范围末尾)。
		db.saveSummaryAndAdvanceCursor(sessionId, summary, seg.toSeqInclusive);
		written.push(summary);
		compressedToSeq = Math.max(compressedToSeq, seg.toSeqInclusive);
	}

	if (written.length === 0) {
		// 所有段都空 transcript —— 仍把游标推到待压末尾(compress once:这些空 step
		// 不再被取;否则下轮死循环)。
		if (compressedToSeq > oldCursor) {
			// 不写 summary,只推游标:直接 UPDATE(messages 表有 ≥1 行时游标在每行
			// 冗余;无行时没地方写游标——此时保持 oldCursor,下轮有内容再一起推)。
			advanceCursorOnly(db, sessionId, compressedToSeq);
		}
		return { summaries: [], newCursor: compressedToSeq, skippedReason: "all segments empty" };
	}

	log.debug("compression-core",
		`session=${sessionId} cursor ${oldCursor}→${compressedToSeq} summaries=${written.length}`);
	return { summaries: written, newCursor: compressedToSeq };
}

/** LLM 失败兜底:仍产 5 段(状态段含「下一步」,满足不变量),保证总有 summary 写入。 */
function fallbackSections(seg: CompressionSegment): { [k: string]: string } {
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
	return {
		purpose: userText,
		status: `压缩自动兜底(LLM 调用失败/格式不符)。覆盖 step ${seg.fromSeq}..${seg.toSeqInclusive}。下一步:从 steps 表按 stepRange 寻回原始 step,确认进展后续行。`,
		...(lastText ? { artifacts: lastText } : {}),
	};
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
