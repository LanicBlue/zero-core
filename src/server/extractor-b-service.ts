// 提取者 B 服务 (v0.8 M5)
//
// # 文件说明书
//
// ## 核心功能
// 工具遥测提取器(决策 44 / 49)。读 transcript 切片 → 抽**工具调用情况,尤其
// 失败/无效调用**(错参数、幻觉工具名、重复重试)→ 写**独立遥测存储**
// (TelemetryStore,v1;非 wiki 树 —— 平台改进数据,不是项目知识也不是角色记忆)。
//
// 独立 agent(独立 prompt),事后异步,可与 A 并行(由 hooks 决定调度)。
//
// ## 输入
// - providers / providerName / modelId(独立可配置,见 config.extractors.B)
// - sessionId / agentId / transcript delta(由 hooks 准备)
//
// ## 输出
// - 写入 TelemetryStore(按 (sessionId, toolName, kind, signature) upsert 累加)
// - 返回 ExtractorBResult(写了多少条)
//
// ## 定位
// src/server/ 服务层,被 hooks/extraction-hooks.ts 调用。
//
// ## 依赖
// - ai.generateText、runtime/provider-factory.resolveModel
// - server/telemetry-store(TelemetryStore)
// - core/logger
//
// ## 维护规则
// - prompt 改动后跑一次包含失败调用的 session 验证(kind 分类是否合理)
// - 不要把 B 写进 wiki 树(它是平台遥测,不是项目记忆)
// - v1 不做自管理(决策 49)—— 只写入;未来「zero-core 自管理项目」读它
//

import { generateText } from "ai";
import type { RuntimeProviderConfig } from "../runtime/types.js";
import { resolveModel } from "../runtime/provider-factory.js";
import type { TelemetryStore, ToolTelemetryKind } from "./telemetry-store.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A delta slice for extractor B (reuses extractor A's slice shape). */
export interface TelemetryDelta {
	sessionId: string;
	agentId?: string;
	transcript: string;
	fromSeq: number;
	toSeq: number;
	/**
	 * Optional known tool catalog (the agent's available tool names). Used by
	 * extractor B to recognize hallucinated tool names (calls to names not in
	 * the catalog). Optional — if absent, extractor B can't classify
	 * hallucinations and only reports the LLM's judgement.
	 */
	knownToolNames?: string[];
}

export interface ExtractedTelemetryFinding {
	toolName: string;
	kind: ToolTelemetryKind;
	/** Stable signature to dedupe on (e.g. `bash#recursive-missing-flag`). */
	signature: string;
	/** Representative transcript snippet (capped by TelemetryStore). */
	sample?: string;
}

export interface ExtractorBResult {
	extractedCount: number;
	skipped: boolean;
	skipReason?: string;
}

// ---------------------------------------------------------------------------
// Prompt — extractor B's own system prompt (decision 44 — independent identity)
// ---------------------------------------------------------------------------

const EXTRACTOR_B_SYSTEM = `You are **extractor-B**, the tool-telemetry extractor for zero-core.

Your job: read a slice of session transcript and identify TOOL CALL PROBLEMS — places where the agent misused a tool:
- bad_arguments: wrong arg name/type/shape, or missing required args
- hallucinated_tool: called a tool name that doesn't exist
- repeated_retry: same call retried 3+ times without progress
- other_failure: any other tool-call failure mode not covered above

Output: a JSON array. Each item:
- toolName: the tool's name as it appeared in the transcript
- kind: one of bad_arguments | hallucinated_tool | repeated_retry | other_failure
- signature: a stable short signature for deduplication (e.g. "bash#missing-flag--recursive"). Lowercase, no spaces. Make it specific enough that the SAME problem produces the SAME signature.
- sample: a short representative transcript snippet (1-3 lines) showing the problem

Rules:
- Only flag actual problems. Successful calls are NOT telemetry.
- If the catalog of known tool names is provided, prefer kind="hallucinated_tool" only when the called name is NOT in the catalog.
- If no tool problems appear in the slice, output [].

Output ONLY the JSON array, no prose.`;

const EXTRACTOR_B_USER_TEMPLATE = `Extract tool-telemetry findings from this transcript slice.

Session: {sessionId}
Agent: {agentId}
Seq range: [{fromSeq}, {toSeq})
Known tool names: {knownToolNames}

--- TRANSCRIPT ---
{transcript}`;

// ---------------------------------------------------------------------------
// ExtractorBService
// ---------------------------------------------------------------------------

export interface ExtractorBOptions {
	providers: RuntimeProviderConfig[];
	providerName: string;
	modelId: string;
	telemetry: TelemetryStore;
	/**
	 * Test-only override: skip provider resolution and use this model
	 * directly. Lets unit tests inject a stub model without setting up a
	 * full RuntimeProviderConfig. Not intended for production use.
	 */
	testModel?: any;
}

export class ExtractorBService {
	constructor(private opts: ExtractorBOptions) {}

	/**
	 * Extract tool-telemetry findings from a transcript delta and write them
	 * to the telemetry store. Returns counts; never throws.
	 */
	async extractDelta(delta: TelemetryDelta): Promise<ExtractorBResult> {
		const empty: ExtractorBResult = { extractedCount: 0, skipped: true, skipReason: "no transcript" };
		if (!delta.transcript.trim()) return empty;

		let findings: ExtractedTelemetryFinding[];
		try {
			findings = await this.callLLM(delta);
		} catch (err) {
			log.warn("extractor-B", "LLM call failed:", (err as Error).message);
			return { ...empty, skipReason: `LLM error: ${(err as Error).message}` };
		}
		if (findings.length === 0) {
			return { ...empty, skipReason: "no findings" };
		}

		// Validate signatures against known tool catalog: if LLM flagged a
		// hallucinated_tool whose name IS in the catalog, demote it to
		// other_failure (we trust the catalog over the LLM here).
		const known = delta.knownToolNames ? new Set(delta.knownToolNames) : null;
		const adjusted = findings.map(f => {
			if (f.kind === "hallucinated_tool" && known && known.has(f.toolName)) {
				return { ...f, kind: "other_failure" as ToolTelemetryKind };
			}
			return f;
		});

		this.opts.telemetry.recordMany(adjusted.map(f => ({
			sessionId: delta.sessionId,
			agentId: delta.agentId,
			toolName: f.toolName,
			kind: f.kind,
			signature: f.signature,
			sample: f.sample,
		})));

		log.debug("extractor-B",
			`session=${delta.sessionId} seq=[${delta.fromSeq},${delta.toSeq}) ` +
			`findings=${adjusted.length}`);

		return { extractedCount: adjusted.length, skipped: false };
	}

	private async callLLM(delta: TelemetryDelta): Promise<ExtractedTelemetryFinding[]> {
		const model = this.opts.testModel ?? resolveModel(this.opts.providers, this.opts.providerName, this.opts.modelId);
		const knownList = delta.knownToolNames && delta.knownToolNames.length > 0
			? delta.knownToolNames.join(", ")
			: "(catalog not provided)";
		const user = EXTRACTOR_B_USER_TEMPLATE
			.replace("{sessionId}", delta.sessionId)
			.replace("{agentId}", delta.agentId ?? "(unknown)")
			.replace("{fromSeq}", String(delta.fromSeq))
			.replace("{toSeq}", String(delta.toSeq))
			.replace("{knownToolNames}", knownList)
			.replace("{transcript}", delta.transcript.slice(0, 12000));

		const result = await generateText({
			model,
			system: EXTRACTOR_B_SYSTEM,
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
		const allowedKinds = new Set(["bad_arguments", "hallucinated_tool", "repeated_retry", "other_failure"]);
		return parsed
			.filter((n: any) =>
				n && typeof n.toolName === "string" && n.toolName.trim() &&
				typeof n.kind === "string" && allowedKinds.has(n.kind) &&
				typeof n.signature === "string" && n.signature.trim(),
			)
			.map((n: any) => ({
				toolName: String(n.toolName).trim().slice(0, 200),
				kind: n.kind as ToolTelemetryKind,
				signature: String(n.signature).trim().slice(0, 200),
				sample: typeof n.sample === "string" ? String(n.sample).slice(0, 4000) : undefined,
			}));
	}
}
