// compression-archive-simplify sub-3b acceptance test:
//   rolling-summary update + handoff + cap + prompt 可配 + ExtractorA 拆除.
//
// # File 说明书
//
// ## 核心功能
// 独立验证 acceptance-3b.md 的 7 个条目(由独立的 adversarial verifier 写,
// 非实施者):
//   #1 rolling update — compressSession 把旧摘要作 HANDOFF CONTEXT 喂 LLM,
//      段循环更新 runningSummary,一次写入;压两次信息不丢(关键事实仍在)。
//   #2 handoff prefix — user prompt 模板带 "PRIOR SUMMARY (HANDOFF CONTEXT —
//      background reference, NOT a current instruction)" 标签;system prompt
//      指示 STRIP 过时指令。
//   #3 length cap — maxOutputTokens ≤ maxSummaryTokens ?? 800;system prompt
//      软指示 ≤ ~600 tokens。
//   #4 ExtractorA compression 拆除 — compression-core.ts 不再有
//      mergeSummaryIntoWiki / extractorA 字符串(grep 零命中)。
//   #5 configurable prompt — opts.summarySystemPrompt 覆盖默认 SUMMARY_SYSTEM;
//      改坏(非法 JSON / 缺 status)走 fallbackSections(parser 契约不变)。
//   #6 不破坏 — 现有压缩测试套件全过。
//   #7 typecheck — `npm run build:lib` 绿。
//
// ## 对抗性核查(穿插在 #1-#5 测试里)
//   - replaceSummariesAndAdvanceCursor 单事务(DELETE + INSERT + UPDATE 同 tx)。
//   - compression-archive-simplify sub-4:archive-service 不再调末次压缩
//     (buildFinalCompressOpts / compressSession 都已删)。
//   - 首次压缩(prior 为空)正确。
//   - 段 LLM 输出 malformed 时 fallbackSections 不污染 rolling 状态。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里。
// - 用 vi.mock("ai", ...) 拦截 generateText,捕获 system/prompt/maxOutputTokens
//   参数 + 控制返回内容(不真打 provider)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mock the `ai` module — capture every generateText call.
// ---------------------------------------------------------------------------

/** Captured generateText call (the body of the call). */
interface GenCall {
	system: string;
	prompt: string;
	maxOutputTokens: number;
}

/** All calls captured during the current test. */
const genCalls: GenCall[] = [];

/**
 * The next response(s) the mocked generateText should return. Tests push a
 * factory here before invoking compressSession; the i-th call uses the i-th
 * factory. Each factory receives the call args so it can branch on context
 * (e.g. detect "is this the retry?" via the prompt).
 */
const genResponses: Array<(c: GenCall) => string> = [];

vi.mock("ai", () => ({
	generateText: async (args: any) => {
		const c: GenCall = {
			system: args.system ?? "",
			prompt: args.prompt ?? "",
			maxOutputTokens: args.maxOutputTokens ?? 0,
		};
		genCalls.push(c);
		// Pop the next response factory if queued. Otherwise reuse the LAST
		// pushed factory (so a test that pushes ONE response gets it for all
		// segments of a multi-segment compress — segmentByTurnGroup can split
		// 1 physical compress into N LLM calls). If no factory was ever
		// pushed, default to a well-formed summary.
		let factory: ((c: GenCall) => string) | null;
		if (genResponses.length > 0) {
			factory = genResponses.shift()!;
			lastStickyFactory = factory;
		} else {
			factory = lastStickyFactory ?? (() => goodSummaryJson({}));
		}
		const text = factory(c);
		// compressSession reads `result.text` — the AI SDK exposes it as a
		// getter over content[].text. Mirror that shape here.
		return {
			text,
			content: [{ type: "text", text }],
			finishReason: "stop",
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			warnings: [],
		};
	},
}));

/** Last-pushed factory, reused when genResponses is exhausted. */
let lastStickyFactory: ((c: GenCall) => string) | null = null;

// IMPORT AFTER vi.mock (vitest hoists vi.mock above imports).
import { CoreDatabase } from "../../src/server/core-database.js";
import { compressSession } from "../../src/server/compression-core.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** A well-formed 5-section summary JSON the LLM would emit. */
function goodSummaryJson(opts: {
	purpose?: string;
	plan?: string;
	status?: string;
	artifacts?: string;
	lessons?: string;
	nextAction?: string;
} = {}): string {
	return JSON.stringify({
		purpose: opts.purpose ?? "build feature X",
		plan: opts.plan ?? "step 1, step 2, step 3",
		status: opts.status ?? `did steps 1-2. 下一步: ${opts.nextAction ?? "run the tests"}`,
		artifacts: opts.artifacts ?? "src/feature.ts (created)",
		lessons: opts.lessons ?? "watch out for the off-by-one",
	});
}

/** A model stub (unused when `ai.generateText` is mocked, but required by
 *  CompressSessionOptions since compressSession still calls resolveModel
 *  when testModel is absent — passing one short-circuits that). */
function stubModel(): any {
	return {
		specificationVersion: "v2",
		provider: "stub",
		modelId: "stub",
		async doGenerate() {
			return {
				content: [{ type: "text", text: goodSummaryJson() }],
				finishReason: "stop",
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				warnings: [],
			};
		},
	};
}

/** Serialize an assistant step's blocks to the steps.content JSON shape. */
function assistantContent(blocks: any[]): string {
	return JSON.stringify(blocks);
}

/**
 * Seed a user+assistant pair into a fresh turn_group. The assistant content is
 * padded with `pad` chars so the turn is large enough to exceed the fresh-tail
 * budget (so older turns become compressible). Returns the last assistant seq.
 */
function seedTurn(
	db: CoreDatabase,
	sessionId: string,
	startSeq: number,
	userText: string,
	asstText: string,
	pad: number = 2000,
): number {
	const group = startSeq; // user row's seq == turn_group (turn-hooks convention)
	db.appendStep(sessionId, startSeq, group, "user", userText);
	db.appendStep(sessionId, startSeq + 1, group, "assistant", assistantContent([
		{ type: "text", text: asstText + " ".repeat(pad) },
	]));
	return startSeq + 1; // last assistant seq
}

// Common compress options (tiny window → small fresh-tail budget → easy to push
// older turns past it).
const COMPRESS_OPTS = {
	providers: [], providerName: "stub", modelId: "stub", contextWindow: 1000,
	testModel: stubModel(),
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe("compression-archive-simplify sub-3b: rolling summary + handoff + cap + prompt 可配", () => {
	let tmpDir: string;
	let dbPath: string;
	let sessionDB: CoreDatabase | null = null;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub3b-"));
		dbPath = join(tmpDir, "core.db");
		sessionDB = new CoreDatabase(dbPath);
		genCalls.length = 0;
		genResponses.length = 0;
		lastStickyFactory = null;
	});

	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
	});

	// ─────────────────────────────────────────────────────────────────────
	// #1 rolling update — update(旧 + 新),非重述;多次压缩信息不丢
	// ─────────────────────────────────────────────────────────────────────

	test("#1 rolling update: 2nd compress folds the prior summary into the new one (info not lost)", async () => {
		const sessionId = "sess-roll";

		// Round 1: 2 padded turns; tiny window → fresh-tail budget ≈ 800 char
		// → turn 0 exceeds budget → compressible.
		seedTurn(sessionDB!, sessionId, 0, "do ALPHA", "ALPHA outcome is FACT_ALPHA_VAULT");
		seedTurn(sessionDB!, sessionId, 2, "do more", "more text");

		// Round 1 LLM: emits a summary mentioning FACT_ALPHA.
		genResponses.push(() => goodSummaryJson({
			purpose: "ALPHA task",
			status: "did ALPHA. 下一步: continue with BETA",
			artifacts: "FACT_ALPHA_VAULT",
		}));
		const r1 = await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);
		expect(r1.summaries.length).toBe(1);
		expect(r1.summaries[0].sections.artifacts).toContain("FACT_ALPHA_VAULT");
		// Sanity: prior-handoff block was NOT in the round-1 call (first compress).
		expect(genCalls[0].prompt).not.toContain("PRIOR SUMMARY");

		// Add new steps beyond the cursor (round 2's compressible segment).
		// Use a new turn_group so segmentByTurnGroup splits it from any prior
		// tail. seq base = current step count.
		const base = sessionDB!.getStepCount(sessionId);
		seedTurn(sessionDB!, sessionId, base, "do BETA", "BETA outcome is FACT_BETA_NEWORDER");

		// Reset capture between rounds (we'll assert on round-2 calls only).
		const round1Calls = genCalls.length;
		genCalls.length = 0;

		// Round 2 LLM: ECHOES prior handoff's FACT_ALPHA + adds FACT_BETA.
		// This proves the rolling-update contract: the LLM was given the prior
		// summary as handoff and folded it in (rather than the caller dropping it).
		genResponses.push(() => goodSummaryJson({
			purpose: "ALPHA + BETA",
			status: "did ALPHA and BETA. 下一步: ship it",
			artifacts: "FACT_ALPHA_VAULT preserved; FACT_BETA_NEWORDER added",
		}));

		const r2 = await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);
		expect(r2.summaries.length).toBe(1);

		// The 2nd compress's LLM call MUST have been fed the prior summary
		// (round 1's stored summary) as the HANDOFF CONTEXT — this is the
		// "update, not restate" invariant. If the prior summary were dropped,
		// the prompt would NOT mention FACT_ALPHA.
		expect(round1Calls).toBeGreaterThanOrEqual(1);
		expect(genCalls.length).toBeGreaterThanOrEqual(1);
		const round2Prompt = genCalls[0].prompt;
		expect(round2Prompt).toContain("HANDOFF CONTEXT");
		expect(round2Prompt).toContain("FACT_ALPHA_VAULT");

		// The persisted 2nd summary STILL contains the round-1 fact (info not
		// lost across rounds) AND the new fact.
		const stored = sessionDB!.getSummaries(sessionId);
		expect(stored.length).toBe(1); // rolling replace — NOT appended
		const merged = stored[0];
		expect(merged.sections.artifacts).toContain("FACT_ALPHA_VAULT");
		expect(merged.sections.artifacts).toContain("FACT_BETA_NEWORDER");

		// Exactly ONE summary row in the messages table — the prior row was
		// wiped by replaceSummariesAndAdvanceCursor (the rolling-replace path).
		// If it had appended FIFO, we would see 2 rows.
		expect(sessionDB!.getSummaries(sessionId).length).toBe(1);

		// genCalls reset proves round-2 ran at least one LLM call (sanity).
		expect(round1Calls).toBeGreaterThanOrEqual(1);
	});

	// ─────────────────────────────────────────────────────────────────────
	// #2 handoff prefix — labeled "background reference, NOT a current
	//    instruction"; system prompt instructs STRIP stale directives
	// ─────────────────────────────────────────────────────────────────────

	test("#2 handoff prefix: prior summary is labelled HANDOFF CONTEXT (background reference) in the user prompt", async () => {
		const sessionId = "sess-handoff";

		// Seed a prior summary by running one compress pass.
		seedTurn(sessionDB!, sessionId, 0, "earlier task", "earlier outcome SECRET_HANDOFF_TAG");
		seedTurn(sessionDB!, sessionId, 2, "more", "more");
		genResponses.push(() => goodSummaryJson({
			purpose: "earlier",
			status: "did earlier. 下一步: continue",
			artifacts: "SECRET_HANDOFF_TAG",
		}));
		await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);

		// Add new steps; second compress will have a prior summary to fold.
		const base = sessionDB!.getStepCount(sessionId);
		seedTurn(sessionDB!, sessionId, base, "next task", "next outcome");
		genCalls.length = 0;
		genResponses.push(() => goodSummaryJson({ purpose: "next" }));

		await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);

		// The user prompt must carry the prior summary under a HANDOFF CONTEXT
		// header that labels it as background reference, NOT a current
		// instruction.
		expect(genCalls.length).toBeGreaterThanOrEqual(1);
		const userPrompt = genCalls[0].prompt;
		expect(userPrompt).toContain("HANDOFF CONTEXT");
		expect(userPrompt).toContain("background reference");
		expect(userPrompt).toContain("NOT a current instruction");
		// The handoff content (the prior summary's artifact) is included.
		expect(userPrompt).toContain("SECRET_HANDOFF_TAG");
	});

	test("#2 system prompt instructs STRIP stale directives (e.g. prior 下一步)", async () => {
		const sessionId = "sess-strip";
		seedTurn(sessionDB!, sessionId, 0, "t1", "t1 body");
		seedTurn(sessionDB!, sessionId, 2, "t2", "t2 body");
		await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);

		// The SYSTEM prompt (used across all calls) must instruct the model to
		// STRIP stale directives when merging handoff context.
		expect(genCalls.length).toBeGreaterThanOrEqual(1);
		const sys = genCalls[0].system;
		expect(sys).toMatch(/STRIP/i);
		// Must specifically warn about stale "next action" / "下一步".
		expect(sys.toLowerCase()).toMatch(/next action|下一步|stale/i);
	});

	// ─────────────────────────────────────────────────────────────────────
	// #3 length cap — maxOutputTokens bounded; prompt instructs ≤ ~600 tokens
	// ─────────────────────────────────────────────────────────────────────

	test("#3 length cap: maxOutputTokens bounded by default 800 and honors opts.maxSummaryTokens", async () => {
		const sessionId = "sess-cap-default";
		seedTurn(sessionDB!, sessionId, 0, "q1", "a1 padded");
		seedTurn(sessionDB!, sessionId, 2, "q2", "a2 padded");

		// Default path: no maxSummaryTokens → default 800.
		await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);
		expect(genCalls.length).toBeGreaterThanOrEqual(1);
		for (const c of genCalls) {
			expect(c.maxOutputTokens).toBeLessThanOrEqual(800);
			expect(c.maxOutputTokens).toBeGreaterThan(0);
		}
	});

	test("#3 length cap: custom maxSummaryTokens is forwarded as the hard ceiling", async () => {
		const sessionId = "sess-cap-custom";
		seedTurn(sessionDB!, sessionId, 0, "q1", "a1 padded");
		seedTurn(sessionDB!, sessionId, 2, "q2", "a2 padded");
		genCalls.length = 0;

		await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, maxSummaryTokens: 512,
		});
		expect(genCalls.length).toBeGreaterThanOrEqual(1);
		for (const c of genCalls) {
			expect(c.maxOutputTokens).toBeLessThanOrEqual(512);
		}
	});

	test("#3 system prompt instructs ≤ ~600 tokens (anti-bloat soft cap)", async () => {
		const sessionId = "sess-softcap";
		seedTurn(sessionDB!, sessionId, 0, "q1", "a1 padded");
		seedTurn(sessionDB!, sessionId, 2, "q2", "a2 padded");

		await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);
		const sys = genCalls[0].system;
		// Soft cap mentioned in the system prompt (~600 tokens).
		expect(sys).toMatch(/600\s*tokens|~?600/i);
	});

	// ─────────────────────────────────────────────────────────────────────
	// #4 ExtractorA removed from compression-core.ts (grep 0 hits)
	// ─────────────────────────────────────────────────────────────────────

	test("#4 ExtractorA compression coupling removed: no mergeSummaryIntoWiki / extractorA in compression-core.ts", () => {
		const src = readFileSync(
			join(__dirname, "..", "..", "src", "server", "compression-core.ts"),
			"utf-8",
		);
		// grep -c "mergeSummaryIntoWiki" src/server/compression-core.ts == 0
		// (count occurrences excluding the WORD inside the regex below).
		const mergeHits = (src.match(/mergeSummaryIntoWiki/g) ?? []).length;
		expect(mergeHits, `mergeSummaryIntoWiki must be 0 hits, got ${mergeHits}`).toBe(0);
		// `extractorA` (the opts field / property access) must also be gone.
		// Allow the literal token "extractorA" only inside a comment context —
		// but the spec says zero hits in compression-core.ts. Be strict:
		const extHits = (src.match(/extractorA/g) ?? []).length;
		expect(extHits, `extractorA must be 0 hits, got ${extHits}`).toBe(0);
	});

	// ─────────────────────────────────────────────────────────────────────
	// #5 configurable prompt — opts.summarySystemPrompt honored; default =
	//    SUMMARY_SYSTEM literal; malformed LLM output → fallbackSections
	// ─────────────────────────────────────────────────────────────────────

	test("#5 configurable prompt: opts.summarySystemPrompt overrides default SUMMARY_SYSTEM", async () => {
		const sessionId = "sess-prompt-override";
		seedTurn(sessionDB!, sessionId, 0, "q1", "a1 padded");
		seedTurn(sessionDB!, sessionId, 2, "q2", "a2 padded");
		genCalls.length = 0;

		const CUSTOM = "CUSTOM_SYSTEM_PROMPT_MARKER_42 — completely different text.";
		await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, summarySystemPrompt: CUSTOM,
		});
		expect(genCalls.length).toBeGreaterThanOrEqual(1);
		for (const c of genCalls) {
			expect(c.system).toBe(CUSTOM);
		}
	});

	test("#5 default prompt: when no override, falls back to the in-file SUMMARY_SYSTEM (carries the rolling-update instructions)", async () => {
		const sessionId = "sess-prompt-default";
		seedTurn(sessionDB!, sessionId, 0, "q1", "a1 padded");
		seedTurn(sessionDB!, sessionId, 2, "q2", "a2 padded");
		genCalls.length = 0;

		await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);
		expect(genCalls.length).toBeGreaterThanOrEqual(1);
		const sys = genCalls[0].system;
		// The default SUMMARY_SYSTEM literal mentions the 5-section JSON shape
		// AND the HANDOFF CONTEXT semantics + ~600 token cap.
		expect(sys).toMatch(/5-section|structured/i);
		expect(sys).toMatch(/HANDOFF CONTEXT/i);
		expect(sys).toMatch(/600/);
	});

	test("#5 malformed LLM output falls through to fallbackSections (parser contract unchanged)", async () => {
		const sessionId = "sess-malformed";
		seedTurn(sessionDB!, sessionId, 0, "what is X?", "X is ...");
		seedTurn(sessionDB!, sessionId, 2, "next q", "next a");

		// LLM returns garbage (not JSON, no status section). The parser must
		// return null → compressSession falls through to fallbackSections
		// (status always rewritten with 下一步; never parrots stale directives).
		genResponses.push(() => "this is not JSON at all {{garbage}}");
		// If the path retries, the retry may also return garbage — push a
		// second one so we don't depend on the retry count.
		genResponses.push(() => "still garbage {{{");

		const result = await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);

		// A summary IS written (fallbackSections guarantees one).
		expect(result.summaries.length).toBeGreaterThanOrEqual(1);
		const stored = sessionDB!.getSummaries(sessionId);
		expect(stored.length).toBeGreaterThanOrEqual(1);
		// Fallback sections always satisfy the next-action invariant.
		for (const s of stored) {
			expect(s.sections.status).toMatch(/下一步|next/i);
			// Fallback status carries the literal marker text we planted in
			// compression-core.ts's fallbackSections().
			expect(s.sections.status).toMatch(/兜底|fallback/i);
		}
	});

	// ─────────────────────────────────────────────────────────────────────
	// Adversarial: rolling state survives malformed mid-loop segment
	// ─────────────────────────────────────────────────────────────────────

	test("adversarial: malformed LLM output mid-loop does not corrupt rolling state", async () => {
		const sessionId = "sess-midloop-malformed";
		// Three turn_groups so segmentByTurnGroup produces 3 segments — the
		// middle one's LLM call returns garbage.
		seedTurn(sessionDB!, sessionId, 0, "topic A", "A content padded");
		seedTurn(sessionDB!, sessionId, 2, "topic B", "B content padded");
		seedTurn(sessionDB!, sessionId, 4, "topic C recent", "C content padded");

		// Segment 1: well-formed.
		genResponses.push(() => goodSummaryJson({
			purpose: "A done",
			status: "did A. 下一步: continue with B",
			artifacts: "ARTIFACT_A",
		}));
		// Segment 2: malformed (with a second malformed for the retry).
		genResponses.push(() => "{{not json}}");
		genResponses.push(() => "{{still not json}}");
		// Segment 3: well-formed — folds in the running summary (the segment-1
		// output, since segment 2 fell back to fallbackSections). The handoff
		// for segment 3 must include the running summary's content.
		genResponses.push((c) => {
			// Verify the running summary (segment 1's output, then merged with
			// the segment 2 fallback) is fed as HANDOFF CONTEXT to segment 3.
			expect(c.prompt).toContain("HANDOFF CONTEXT");
			expect(c.prompt).toContain("ARTIFACT_A");
			return goodSummaryJson({
				purpose: "A + B + C",
				status: "all done. 下一步: ship",
				artifacts: "ARTIFACT_A ARTIFACT_C",
			});
		});

		const result = await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);
		// Rolling summary IS written despite the mid-loop fallback.
		expect(result.summaries.length).toBe(1);
		expect(result.summaries[0].sections.artifacts).toContain("ARTIFACT_A");
	});

	// ─────────────────────────────────────────────────────────────────────
	// Adversarial: FIRST compress (no prior summary) — empty handoff, no crash
	// ─────────────────────────────────────────────────────────────────────

	test("adversarial: first compress (empty prior) — no handoff prefix, no crash", async () => {
		const sessionId = "sess-first";
		seedTurn(sessionDB!, sessionId, 0, "first q", "first a padded");
		seedTurn(sessionDB!, sessionId, 2, "second q", "second a padded");

		// Sticky factory: every LLM call returns a well-formed summary.
		genResponses.push(() => goodSummaryJson({ purpose: "first summary" }));

		const result = await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);
		expect(result.summaries.length).toBe(1);
		// A summary IS written (no crash on empty prior).
		expect(result.summaries[0].sections.purpose).toBe("first summary");

		// The FIRST call (segment 1, no prior summary in DB) must NOT carry a
		// PRIOR SUMMARY block. The handoffLine announces "from scratch".
		expect(genCalls.length).toBeGreaterThanOrEqual(1);
		const firstCallPrompt = genCalls[0].prompt;
		expect(firstCallPrompt).not.toContain("PRIOR SUMMARY");
		expect(firstCallPrompt).toMatch(/No prior summary|from scratch/i);
	});

	// ─────────────────────────────────────────────────────────────────────
	// Adversarial: replaceSummariesAndAdvanceCursor atomicity (DELETE-all +
	// INSERT-one + cursor-advance in ONE tx — readers never see half-state)
	// ─────────────────────────────────────────────────────────────────────

	test("adversarial: replaceSummariesAndAdvanceCursor wipes prior rows + leaves exactly ONE", async () => {
		const sessionId = "sess-atomic";

		// Seed a prior summary by running one compress pass.
		seedTurn(sessionDB!, sessionId, 0, "t1", "t1 body");
		seedTurn(sessionDB!, sessionId, 2, "t2", "t2 body");
		await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);
		expect(sessionDB!.getSummaries(sessionId).length).toBe(1);
		const cursorAfter1 = sessionDB!.getCompressionCursor(sessionId);
		expect(cursorAfter1).toBeGreaterThan(0);

		// Add new steps and run another pass — the rolling-replace path must
		// wipe the prior row and leave exactly ONE summary (the merged one).
		const base = sessionDB!.getStepCount(sessionId);
		seedTurn(sessionDB!, sessionId, base, "t3", "t3 body");
		genResponses.push(() => goodSummaryJson({ purpose: "merged" }));

		await compressSession(sessionId, sessionDB!, COMPRESS_OPTS);

		const stored = sessionDB!.getSummaries(sessionId);
		expect(stored.length).toBe(1); // exactly ONE (rolling replace, not FIFO append)
		expect(stored[0].sections.purpose).toBe("merged");
		// Cursor advanced beyond the previous position.
		const cursorAfter2 = sessionDB!.getCompressionCursor(sessionId);
		expect(cursorAfter2).toBeGreaterThan(cursorAfter1!);
	});

	// ─────────────────────────────────────────────────────────────────────
	// Adversarial: archive-service scope — compression-archive-simplify
	// sub-4 REMOVED buildFinalCompressOpts + the final compressSession call
	// (archive no longer runs a final compression; Q5b memory turn + atomic
	// export replaces it). Verifies the removal is clean.
	// ─────────────────────────────────────────────────────────────────────

	test("adversarial: archive-service no longer defines buildFinalCompressOpts nor calls compressSession (sub-4 removed)", () => {
		const src = readFileSync(
			join(__dirname, "..", "..", "src", "server", "archive-service.ts"),
			"utf-8",
		);
		// buildFinalCompressOpts function must be GONE (sub-4 deleted it).
		expect(src).not.toMatch(/(?:async\s+)?function\s+buildFinalCompressOpts\b/);
		// archive must NOT call compressSession anymore (D4 — final
		// compression is retired; archive = memory turn + atomic export).
		expect(src).not.toMatch(/compressSession\s*\(/);
		// The opts builder's summarySystemPrompt forwarding is gone with the
		// builder (no compression → no D2 prompt wiring at archive time).
		expect(src).not.toMatch(/summarySystemPrompt/);
		// mergeSummaryIntoWiki must remain gone entirely (sub-3b removed it;
		// sub-4 must not re-introduce it).
		expect((src.match(/mergeSummaryIntoWiki/g) ?? []).length).toBe(0);
		// ExtractorA name must not appear ANYWHERE in archive-service — even
		// in comments (sub-4 cleaned the dead-comment residue; acceptance-4 #6
		// is a strict grep with zero hits).
		expect((src.match(/ExtractorA|extractorA/g) ?? []).length,
			"ExtractorA/extractorA must not appear in archive-service.ts at all (sub-4 cleaned comments + code)").toBe(0);
	});

	// ─────────────────────────────────────────────────────────────────────
	// Adversarial: replaceSummariesAndAdvanceCursor implementation — atomic
	// (DELETE + INSERT + UPDATE in one transaction)
	// ─────────────────────────────────────────────────────────────────────

	test("adversarial: replaceSummariesAndAdvanceCursor is ONE transaction (DELETE-all + INSERT-one + cursor-advance)", () => {
		const src = readFileSync(
			join(__dirname, "..", "..", "src", "server", "core-database.ts"),
			"utf-8",
		);
		// Slice from the method definition to the end of its body (next method
		// or the ensureSession helper).
		const startIdx = src.indexOf("replaceSummariesAndAdvanceCursor(");
		expect(startIdx, "method must exist").toBeGreaterThan(0);
		// Find the next method boundary (ensureSession) — that's roughly the
		// body extent.
		const endIdx = src.indexOf("ensureSession(sessionId: string): void");
		const body = src.slice(startIdx, endIdx);

		// All three statements must be inside ONE transaction callback. We
		// confirm: (a) tx declared once, (b) DELETE + INSERT + UPDATE all
		// present, (c) tx() invoked once at the end.
		const txMatches = body.match(/this\.db\.transaction\(/g) ?? [];
		expect(txMatches.length, "exactly one transaction").toBe(1);
		expect(body).toMatch(/DELETE FROM messages WHERE session_id = \?/);
		expect(body).toMatch(/INSERT INTO messages/);
		// Cursor advance: either via the INSERT (last_compressed_step_seq =
		// ?) or a separate UPDATE — the spec requires cursor advances exactly
		// once in the same tx.
		expect(body).toMatch(/last_compressed_step_seq/);
		expect(body).toMatch(/tx\(\)/);
	});
});
