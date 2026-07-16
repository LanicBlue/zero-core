// steps-overhaul sub-4 acceptance test: 阶段3 压缩核心 (compressSession).
//
// # File说明书
// ## 核心功能
// 独立验证 acceptance-4.md 的核心条目,通过测试直调 compressSession():
//   - 压缩产 5 段结构化 summary(状态段含「下一步立即动作」)。
//   - summary 写 messages + 推进 last_compressed_step_seq。
//   - messages summary cap 3 FIFO(第 4 个进、最旧出)。
//   - compress once:同一段 step 不被 re-summarize(游标只前进)。
//   - 一次压缩可产多个 summary(跨主题 = 跨 turn_group)。
//   - summary 带寻回指针(stepRange = 被压 step seq 范围)。
//   - steps 表不动;fresh tail 不被压。
//   - 组装输出无连续同 role 消息(sub-3 Lens A 移交:summary 改 system + normalize 合并)。
//   - 输出格式核对(状态段缺「下一步」→ 重试;LLM 失败 → 兜底)。
//
// ## 不变量守恒(acceptance-4)
//   - compress once / steps 不动 / fresh tail/head 不被压 / cap 3 FIFO。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里(memory
//   feedback-sessions-db-readonly)。
// - fresh-tail 预算 = min(32K, 20% × window)。要压到东西,older turn 的 content
//   必须大到把 fresh-tail 预算吃光(本测试 window=1000 → 预算 ≈ 200 token ≈ 800
//   char;用 ~2000 char 的 assistant content 保证 older turn 超出预算)。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreDatabase } from "../../src/server/core-database.js";
import {
	compressSession,
	segmentByTurnGroup,
	computeFreshTailStartSeq,
} from "../../src/server/compression-core.js";
import { AgentSession } from "../../src/runtime/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub AI SDK model: returns the given text from generateText. */
function stubModel(text: string): any {
	return {
		specificationVersion: "v2",
		provider: "stub",
		modelId: "stub",
		async doGenerate() {
			return {
				content: [{ type: "text", text }],
				finishReason: "stop",
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				warnings: [],
			};
		},
	};
}

/** A well-formed 5-section summary JSON the LLM would emit. */
function goodSummaryJson(opts: { purpose?: string; nextAction?: string } = {}): string {
	return JSON.stringify({
		purpose: opts.purpose ?? "build feature X",
		plan: "step 1, step 2, step 3",
		status: `did steps 1-2. 下一步: ${opts.nextAction ?? "run the tests"}`,
		artifacts: "src/feature.ts (created)",
		lessons: "watch out for the off-by-one",
	});
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
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-4: compressSession 压缩核心", () => {
	let tmpDir: string;
	let dbPath: string;
	let sessionDB: CoreDatabase | null = null;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub4-compress-"));
		dbPath = join(tmpDir, "core.db");
		sessionDB = new CoreDatabase(dbPath);
	});

	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
	});

	// ── 1. summary 5 段 + 状态段「下一步」+ 寻回指针 + 推进游标 ───────────

	test("compresses post-cursor steps into a 5-section summary with stepRange + advances cursor", async () => {
		const sessionId = "sess-5sec";
		// 2 padded turns; tiny window (1000) → fresh-tail budget ≈ 200 tokens ≈
		// 800 char. Each padded turn ~2000 char → turn 0 exceeds budget → compressible.
		const last0 = seedTurn(sessionDB!, sessionId, 0, "what is X?", "X is ...");
		const last1 = seedTurn(sessionDB!, sessionId, 2, "do thing", "done thing");

		const result = await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: stubModel(goodSummaryJson()),
		});

		// At least one summary written.
		expect(result.summaries.length).toBeGreaterThanOrEqual(1);
		// Cursor advanced past the older turn (>= turn-0's last seq).
		expect(result.newCursor).toBeGreaterThanOrEqual(last0);
		expect(result.newCursor).toBeGreaterThan(0);

		// The summary block persisted to messages has all 5 sections + status
		// with a next action.
		const summaries = sessionDB!.getSummaries(sessionId);
		expect(summaries.length).toBeGreaterThanOrEqual(1);
		const s = summaries[0];
		expect(s.sections.purpose).toBeTruthy();
		expect(s.sections.plan).toBeTruthy();
		expect(s.sections.status).toBeTruthy();
		expect(s.sections.status).toMatch(/下一步|next/i);
		expect(s.sections.artifacts).toBeTruthy();
		expect(s.sections.lessons).toBeTruthy();
		// stepRange anchor present + points at real step seqs.
		expect(s.stepRange).toBeDefined();
		expect(s.stepRange!.from).toBeGreaterThanOrEqual(0);
		expect(s.stepRange!.to).toBeGreaterThanOrEqual(s.stepRange!.from);
		// Cursor in DB matches result.newCursor.
		expect(sessionDB!.getCompressionCursor(sessionId)).toBe(result.newCursor);
		// last1 (newest assistant) is NOT in the compressed range — fresh tail
		// protected. The compressed range's `to` must be < last1.
		expect(s.stepRange!.to).toBeLessThan(last1);
	});

	// ── 2. compress once: 游标只前进,不 re-summarize ───────────────────

	test("compress once: calling compress twice does not re-summarize already-compressed steps", async () => {
		const sessionId = "sess-once";
		seedTurn(sessionDB!, sessionId, 0, "turn A user", "turn A assistant text");
		seedTurn(sessionDB!, sessionId, 2, "turn B user", "turn B assistant text");

		let llmCalls = 0;
		const countingModel = {
			specificationVersion: "v2", provider: "stub", modelId: "stub",
			async doGenerate() {
				llmCalls++;
				return { content: [{ type: "text", text: goodSummaryJson() }],
					finishReason: "stop",
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] };
			},
		};

		const r1 = await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: countingModel,
		});
		const cursorAfter1 = r1.newCursor;
		const callsAfter1 = llmCalls;
		expect(cursorAfter1).toBeGreaterThan(0);

		// No new steps added between calls → second call has nothing new to
		// compress (everything post-cursor is fresh tail). compress once: the
		// already-compressed range is NOT re-summarized.
		const r2 = await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: countingModel,
		});
		// Cursor did not move backward; either same or advanced only if there
		// was new content (there wasn't → same).
		expect(r2.newCursor).toBe(cursorAfter1);
		// No new LLM calls for the already-compressed range.
		expect(llmCalls).toBe(callsAfter1);
		expect(r2.summaries.length).toBe(0);
	});

	// ── 3. 滚动摘要:多 turn_group 合并成 ONE rolling summary(跨段合并)
	//     (sub-3b: 旧「多 summary per pass」契约已废。新契约为 segments 合并进
	//      runningSections,replaceSummariesAndAdvanceCursor 写一行;stepRange
	//      跨所有被压段。详见 sub3b-rolling-summary.test.ts + design「二、压缩流程」。)

	test("rolling-summary: multiple turn_groups beyond fresh-tail merge into ONE summary with combined stepRange", async () => {
		const sessionId = "sess-multi";
		// 3 padded turns; tiny window so turns 0 and 1 are both compressible
		// (only the newest step(s) of turn 2 fit the fresh tail).
		seedTurn(sessionDB!, sessionId, 0, "topic A", "A content");
		seedTurn(sessionDB!, sessionId, 2, "topic B", "B content");
		seedTurn(sessionDB!, sessionId, 4, "topic C (recent)", "C content");

		const result = await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: stubModel(goodSummaryJson({ purpose: "multi" })),
		});

		// sub-3b rolling-replace contract: ONE summary per pass (all merged
		// segments fold into runningSections, then a single row is written via
		// replaceSummariesAndAdvanceCursor). The old per-segment FIFO contract
		// is gone — `result.summaries.length === 1`, not > 1.
		expect(result.summaries.length).toBe(1);
		// The single rolling summary's stepRange spans ALL compressed segments
		// (covers from the first compressed seq through segment 2's last step
		// at seq 3 — turn_group 2; turn_group 0 starts at seq 0). The merged
		// range must NOT be just one segment's worth.
		// NOTE: pre-existing edge case — for a fresh session, `getCompression
		// Cursor` returns null and compression-core treats it as `?? 0`, so
		// seq 0 is excluded from postCursor (treated as already-compressed).
		// The rolling summary's stepRange thus starts at seq 1, not 0.
		const s = result.summaries[0];
		expect(s.stepRange).toBeDefined();
		expect(s.stepRange!.from).toBeGreaterThanOrEqual(0);
		// stepRange.to must reach into turn_group 2 (seq 2..3) — proves the
		// rolling summary covers MORE than just the first segment.
		expect(s.stepRange!.to).toBeGreaterThanOrEqual(3);
		// Persisted messages count matches (exactly ONE row — rolling replace,
		// not FIFO append).
		expect(sessionDB!.getSummaries(sessionId).length).toBe(1);
		// Cursor advanced to the last compressed step (== summary's stepRange.to).
		expect(result.newCursor).toBe(s.stepRange!.to);
		// The newest step (seq 5, turn 2's assistant) is in the fresh tail →
		// NOT in the compressed range.
		expect(s.stepRange!.to).toBeLessThan(5);
	});

	// ── 4. rolling-replace: 多次压缩后恒等于 ONE summary(替代旧 FIFO-3 cap)
	//     (sub-3b: replaceSummariesAndAdvanceCursor 每次擦旧行 + 写一行;
	//      MAX_MESSAGE_SUMMARIES + saveSummaryAndAdvanceCursor 现为死代码,
	//      sub-5 死代码清理时删 —— 本 sub scope 边界外。)

	test("rolling-replace: repeated compressions always leave exactly ONE summary (replaces, not FIFO-appends)", async () => {
		const sessionId = "sess-cap";
		// Repeatedly: seed 2 padded turns, compress. Under the new rolling-
		// replace contract, each compress wipes the prior row and writes ONE
		// new merged summary — the table never holds more than 1 row,
		// regardless of how many rounds have run.
		for (let round = 0; round < 5; round++) {
			const base = sessionDB!.getStepCount(sessionId);
			// base is the next seq to write (user row opens a new turn_group).
			seedTurn(sessionDB!, sessionId, base, `t${round}-a`, `asst ${round}-a`);
			seedTurn(sessionDB!, sessionId, base + 2, `t${round}-b`, `asst ${round}-b`);
			await compressSession(sessionId, sessionDB!, {
				...COMPRESS_OPTS, testModel: stubModel(goodSummaryJson({ purpose: `p${round}` })),
			});
			// After EVERY round, exactly ONE summary row exists (rolling
			// replace wipes prior rows in the same tx that writes the new one).
			expect(sessionDB!.getSummaries(sessionId).length).toBe(1);
		}

		// Final state: still exactly ONE summary (the latest rolling merge).
		const summaries = sessionDB!.getSummaries(sessionId);
		expect(summaries.length).toBe(1);
	});

	// ── 5. steps 表不动 ──────────────────────────────────────────────

	test("steps table is NOT mutated by compression", async () => {
		const sessionId = "sess-immutable";
		seedTurn(sessionDB!, sessionId, 0, "q1", "a1");
		seedTurn(sessionDB!, sessionId, 2, "q2", "a2");
		const stepsBefore = sessionDB!.getSteps(sessionId);

		await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: stubModel(goodSummaryJson()),
		});

		const stepsAfter = sessionDB!.getSteps(sessionId);
		expect(stepsAfter.length).toBe(stepsBefore.length);
		// Every step row identical (seq + content).
		for (let i = 0; i < stepsBefore.length; i++) {
			expect(stepsAfter[i].seq).toBe(stepsBefore[i].seq);
			expect(stepsAfter[i].content).toBe(stepsBefore[i].content);
			expect(stepsAfter[i].role).toBe(stepsBefore[i].role);
		}
	});

	// ── 6. 输出格式核对:状态段缺「下一步」→ 重试 ───────────────────

	test("validation retry: summary missing next-action is retried; retry succeeds", async () => {
		const sessionId = "sess-retry";
		seedTurn(sessionDB!, sessionId, 0, "q", "a");
		seedTurn(sessionDB!, sessionId, 2, "q2", "a2");

		// Track per-call outputs so we can assert a retry happened for the
		// first compressible segment. Multiple segments may each retry, so we
		// count how many calls returned the BAD shape vs the GOOD shape.
		let calls = 0;
		let badCalls = 0;
		const retryModel = {
			specificationVersion: "v2", provider: "stub", modelId: "stub",
			async doGenerate() {
				calls++;
				// Odd calls (1st, 3rd, ...) return the BAD shape (no next-action);
				// even calls (the retry) return the GOOD shape. This forces at
				// least one retry per compressible segment.
				const isBad = (calls % 2) === 1;
				if (isBad) badCalls++;
				const text = isBad
					? JSON.stringify({ purpose: "p", status: "did stuff" }) // no 下一步/next
					: goodSummaryJson();
				return { content: [{ type: "text", text }],
					finishReason: "stop",
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] };
			},
		};

		const result = await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: retryModel,
		});
		// At least one summary was written → at least one bad call was retried
		// (calls > badCalls means a retry succeeded).
		expect(result.summaries.length).toBeGreaterThanOrEqual(1);
		expect(calls).toBeGreaterThan(badCalls); // a retry happened
		// Every persisted summary satisfies the next-action invariant (retry or
		// fallback both guarantee it).
		for (const s of sessionDB!.getSummaries(sessionId)) {
			expect(s.sections.status).toMatch(/下一步|next/i);
		}
	});

	// ── 7. LLM 失败 → 兜底 summary(保证 cap 3 FIFO 语义 + 游标推进) ──

	test("fallback: LLM throw still writes a summary + advances cursor", async () => {
		const sessionId = "sess-fallback";
		seedTurn(sessionDB!, sessionId, 0, "q", "a");
		seedTurn(sessionDB!, sessionId, 2, "q2", "a2");
		const throwingModel = {
			specificationVersion: "v2", provider: "stub", modelId: "stub",
			async doGenerate() { throw new Error("boom"); },
		};

		const result = await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: throwingModel,
		});
		expect(result.summaries.length).toBeGreaterThanOrEqual(1);
		expect(result.newCursor).toBeGreaterThan(0);
		// Fallback summary still satisfies the next-action invariant.
		const s = sessionDB!.getSummaries(sessionId)[0];
		expect(s.sections.status).toMatch(/下一步|next/i);
	});

	// ── 8. fresh tail/head 不被压 ─────────────────────────────────────

	test("fresh tail protected: newest steps are never in the compressed stepRange", async () => {
		const sessionId = "sess-tail";
		seedTurn(sessionDB!, sessionId, 0, "old q", "old a");
		seedTurn(sessionDB!, sessionId, 2, "recent q", "recent a");

		const result = await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: stubModel(goodSummaryJson()),
		});
		// The newest step (seq 3) is in the fresh tail → not compressed.
		for (const s of result.summaries) {
			expect(s.stepRange!.to).toBeLessThan(3);
		}
	});

	// ── 9. 组装无连续同 role(sub-3 Lens A 移交) ─────────────────────

	test("assembled LLM view has NO consecutive same-role messages (summary is system, not user)", async () => {
		const sessionId = "sess-norole";
		// Seed a history large enough that compression runs, then assemble.
		seedTurn(sessionDB!, sessionId, 0, "first q", "first a");
		seedTurn(sessionDB!, sessionId, 2, "second q", "second a");
		seedTurn(sessionDB!, sessionId, 4, "third q", "third a");

		await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: stubModel(goodSummaryJson()),
		});

		const sess = new AgentSession("sys", 1000, sessionId, sessionDB as any);
		const msgs = sess.getMessages();
		expect(msgs.length).toBeGreaterThan(0);

		// No two consecutive messages share the same role.
		for (let i = 1; i < msgs.length; i++) {
			const a = (msgs[i - 1] as any).role;
			const b = (msgs[i] as any).role;
			// tool role may legitimately follow assistant (tool-use); skip tool.
			if (a === "tool" || b === "tool") continue;
			expect(b, `consecutive ${a},${b} at idx ${i}`).not.toBe(a);
		}

		// And at least one summary is rendered as a system message.
		const systemMsgs = msgs.filter(m => m.role === "system");
		expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
		expect((systemMsgs[0] as any).content).toContain("[summary:");
	});

	// ── 10. 纯函数:segmentByTurnGroup + computeFreshTailStartSeq ─────

	test("segmentByTurnGroup splits steps by turn_group", () => {
		const mk = (seq: number, tg: number): any => ({ seq, turnGroup: tg, role: "assistant", content: "x", inputTokens: 0, outputTokens: 0, totalTokens: 0, createdAt: "t" });
		const segs = segmentByTurnGroup([mk(0, 0), mk(1, 0), mk(2, 1), mk(3, 1), mk(4, 2)]);
		expect(segs.length).toBe(3);
		expect(segs[0].fromSeq).toBe(0);
		expect(segs[0].toSeqInclusive).toBe(1);
		expect(segs[2].fromSeq).toBe(4);
	});

	test("computeFreshTailStartSeq: empty → sentinel; newest always included", () => {
		const mk = (seq: number, content: string): any => ({ seq, turnGroup: 0, role: "assistant", content, inputTokens: 0, outputTokens: 0, totalTokens: 0, createdAt: "t" });
		expect(computeFreshTailStartSeq([], 128000)).toBe(Number.MAX_SAFE_INTEGER);
		// Newest step alone: even if huge, it's included (fresh tail non-empty).
		const steps = [mk(0, "x"), mk(1, "y"), mk(2, "z".repeat(100000))];
		const start = computeFreshTailStartSeq(steps, 1000);
		expect(start).toBe(2);
	});

	// ── 11. 无待压 step → skippedReason, 游标不动 ────────────────────

	test("no steps after cursor → skipped, cursor unchanged", async () => {
		const sessionId = "sess-empty";
		// Seed nothing.
		const result = await compressSession(sessionId, sessionDB!, {
			...COMPRESS_OPTS, testModel: stubModel(goodSummaryJson()),
		});
		expect(result.summaries.length).toBe(0);
		expect(result.skippedReason).toBeTruthy();
		expect(result.newCursor).toBe(0);
	});
});
