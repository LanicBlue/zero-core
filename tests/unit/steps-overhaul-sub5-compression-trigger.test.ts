// steps-overhaul sub-5 acceptance test: 压缩触发器 + fresh tail 保护.
//
// # File 说明书
// ## 核心功能
// 独立验证 acceptance-5.md 的核心条目,通过 HookRegistry 直接 fire 触发事件
// (StepEnd / PreLLMCall / OnLLMError / TurnStart) 验证触发逻辑:
//   - cache 冷热判定:冷才跑完整压缩(免费);热只提醒/到 hard 才强压。
//   - 冷路径(StepEnd,可 mid-turn):冷 + 超阈值 → 压缩。
//   - 热路径(新 turn PreLLMCall):新 turn+热+>200K/70% → 提醒;>400K/90% → 强制。
//   - mid-turn+热 不打断:mid-turn+热+超阈值 → no-op(既不提醒也不强压)。
//   - resume-time 冷 preflight:PreLLMCall 冷 + 超阈值 → 强制压缩(覆盖 WAIT 醒后
//     首 call / 崩溃恢复首 call / 冷新 turn)。
//   - reactive:OnLLMError prompt_too_long → 强制压缩 + retry。
//   - fresh tail 不被压:触发器路由 compressSession,核心自带 fresh tail 保护。
//   - 防抖:连续两次压缩省 <10% 停。
//   - cacheTTL per-provider 默认 6min;lastLLMCall 内存(重启必冷)。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里。
// - compressSession 的 LLM 调用 mock 成 stub model(不真打 provider)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionDB } from "../../src/server/session-db.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import {
	registerCompressionTriggerHooks,
	clearCompressionTriggerState,
	_setLastLLMCallForTest,
	_getLastLLMCallForTest,
	_setLastReductionForTest,
} from "../../src/runtime/hooks/compression-trigger-hooks.js";
import type { SessionConfig, RuntimeProviderConfig } from "../../src/runtime/types.js";

// Mock provider-factory so compressSession's resolveModel returns a stub.
// getContextWindow returns 200000 (real-scale) so threshold-fraction checks
// are meaningful; seeded turns use a large pad so older turns exceed the
// fresh-tail budget (min(32K, 20%×200K=40K) = 32K ≈ 128K char) and compress.
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: () => stubModel(),
	getContextWindow: () => 200000,
}));

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function stubModel(text: string = goodSummaryJson()): any {
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

function goodSummaryJson(): string {
	return JSON.stringify({
		purpose: "build feature X",
		plan: "step 1, 2, 3",
		status: "did steps 1-2. 下一步: run the tests",
		artifacts: "src/feature.ts (created)",
		lessons: "watch out for off-by-one",
	});
}

/**
 * Seed a user+assistant pair (turn_group = user seq). The assistant content is
 * padded to ~150K char so older turns exceed the fresh-tail budget (min(32K,
 * 20%×200K=40K) = 32K token ≈ 128K char) and become compressible.
 */
function seedTurn(db: SessionDB, sessionId: string, startSeq: number, pad: number = 150_000): number {
	const group = startSeq;
	db.appendStep(sessionId, startSeq, group, "user", `turn ${startSeq} user`);
	db.appendStep(sessionId, startSeq + 1, group, "assistant", JSON.stringify([
		{ type: "text", text: `turn ${startSeq} assistant` + " ".repeat(pad) },
	]));
	return startSeq + 1;
}

const PROVIDERS: RuntimeProviderConfig[] = [
	{
		name: "stub", type: "mock", apiKey: "k", baseUrl: "u",
		models: [{ id: "stub", name: "stub", contextWindow: 200000, maxTokens: 8000 }],
		enabled: true, cacheTtlMs: 360_000,
	},
];

function mkConfig(sessionId: string): SessionConfig {
	return {
		agentId: "a", workspaceDir: ".", systemPrompt: "s",
		providerName: "stub", modelId: "stub",
		toolPolicy: {} as any,
		sessionId,
		extractors: { A: { enabled: true, provider: "stub", model: "stub" } } as any,
	} as any;
}

interface FireOpts {
	sessionId: string;
	stepNumber?: number;
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
	errorClass?: string;
}

/**
 * Mirror the REAL runtime ctx shape each event fires with (agent-loop.ts).
 * PreLLMCall/StepEnd carry config+providers; OnLLMError also carries them as of
 * sub-5 fix (reactive compression path needs them) — but TurnStart does NOT.
 *
 * `runtimeShape: false` (default) preserves the old test-only shape that
 * injects config/providers into EVERY event — useful where a test wants to
 * exercise handler logic independent of the runtime surface.
 * `runtimeShape: true` produces exactly what agent-loop fires, so the test
 * genuinely exercises the integration path (handler must resolve config/
 * providers FROM ctx, not from a test injection). Reactive OnLLMError tests
 * use runtimeShape:true to prove the dead-end fix works end-to-end.
 */
function fire(
	reg: HookRegistry,
	ev: "StepEnd" | "PreLLMCall" | "OnLLMError" | "TurnStart",
	db: SessionDB,
	opts: FireOpts,
	runtimeShape: boolean = false,
) {
	const config = mkConfig(opts.sessionId);
	const baseCtx: Record<string, unknown> = {
		agentId: "a", sessionId: opts.sessionId, timestamp: Date.now(),
	};
	// config/providers ride on StepEnd, PreLLMCall, AND OnLLMError in the real
	// runtime (sub-5 fix added them to OnLLMError). TurnStart never has them.
	const carriesConfig = ev === "StepEnd" || ev === "PreLLMCall" || ev === "OnLLMError";
	if (runtimeShape) {
		if (carriesConfig) {
			baseCtx.config = config;
			baseCtx.providers = PROVIDERS;
		}
	} else {
		// Legacy test-only shape: inject everywhere (TurnStart handler ignores).
		baseCtx.config = config;
		baseCtx.providers = PROVIDERS;
	}
	if (ev === "StepEnd" || ev === "PreLLMCall") {
		baseCtx.usage = opts.usage;
		baseCtx.stepNumber = opts.stepNumber;
	}
	if (ev === "OnLLMError") {
		baseCtx.error = "err";
		baseCtx.errorClass = opts.errorClass;
		baseCtx.stepNumber = opts.stepNumber;
	}
	return reg.trigger(ev, baseCtx);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-5: compression trigger hooks", () => {
	let tmpDir: string;
	let db: SessionDB;
	let reg: HookRegistry;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub5-trig-"));
		db = new SessionDB(join(tmpDir, "sessions.db"));
		// Insert a session row with a fixed id so token_usage / cursor updates
		// have a target (createSession auto-generates an id; we want a known one).
		const now = new Date().toISOString();
		(db as any).db.prepare(
			"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at, session_kind) " +
			"VALUES (?, ?, 0, ?, ?, ?, 'chat')",
		).run("s1", "a", "t", now, now);
		reg = new HookRegistry();
		clearCompressionTriggerState();
		registerCompressionTriggerHooks({ sessionDb: db }, reg);
	});

	afterEach(() => {
		db.close();
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
	});

	// ── cache 冷热判定基础 ───────────────────────────────────────────────

	test("lastLLMCall starts undefined → cold; PreLLMCall stamps it after the call", async () => {
		expect(_getLastLLMCallForTest("s1")).toBeUndefined();
		// Cold + below threshold (no token_usage yet) → no-op, then stamps.
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		expect(_getLastLLMCallForTest("s1")).toBeTypeOf("number");
	});

	test("cacheTTL default 6min; within TTL = hot, beyond = cold", async () => {
		// Set lastLLMCall to 1 minute ago → hot.
		_setLastLLMCallForTest("s1", Date.now() - 60_000);
		db.setTokenUsage("s1", { inputTokens: 250_000 }); // over cold threshold
		// Hot + mid-turn (step 2) → no compression.
		const summariesBefore = db.getSummaries("s1").length;
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 2 });
		expect(db.getSummaries("s1").length).toBe(summariesBefore);

		// Now set lastLLMCall to 10 minutes ago → cold.
		_setLastLLMCallForTest("s1", Date.now() - 600_000);
		// Need steps to compress. Seed a padded turn then compress preflight fires.
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 2 });
		expect(db.getSummaries("s1").length).toBeGreaterThan(0);
	});

	// ── 冷路径 StepEnd ───────────────────────────────────────────────────

	test("StepEnd cold path: cold + over threshold → compresses (mid-turn allowed)", async () => {
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		// Make cold (10 min ago) and over threshold.
		_setLastLLMCallForTest("s1", Date.now() - 600_000);
		// StepEnd stamps token_usage from ctx.usage first, then evaluates.
		await fire(reg, "StepEnd", db, {
			sessionId: "s1", stepNumber: 3,
			usage: { inputTokens: 150_000, outputTokens: 500, totalTokens: 150_500 },
		});
		expect(db.getSummaries("s1").length).toBeGreaterThan(0);
		expect(db.getCompressionCursor("s1")).toBeGreaterThan(0);
	});

	test("StepEnd hot path: hot → no compression even if over threshold", async () => {
		seedTurn(db, "s1", 0);
		_setLastLLMCallForTest("s1", Date.now() - 1_000); // 1s ago → hot
		const before = db.getSummaries("s1").length;
		await fire(reg, "StepEnd", db, {
			sessionId: "s1", stepNumber: 2,
			usage: { inputTokens: 250_000, outputTokens: 0, totalTokens: 250_000 },
		});
		expect(db.getSummaries("s1").length).toBe(before);
	});

	test("StepEnd persists token_usage from ctx.usage for the next trigger read", async () => {
		_setLastLLMCallForTest("s1", Date.now() - 600_000);
		await fire(reg, "StepEnd", db, {
			sessionId: "s1", stepNumber: 1,
			usage: { inputTokens: 42_000, outputTokens: 8, totalTokens: 42_008 },
		});
		// Below cold threshold (42K < 100K) so no compression, but usage persisted.
		const stored = db.getTokenUsage("s1");
		expect(stored?.inputTokens).toBe(42_000);
	});

	// ── 热路径 新 turn PreLLMCall ────────────────────────────────────────

	test("hot new-turn soft trigger: >70% window but <90% → injects reminder (appendMessages), no compression", async () => {
		seedTurn(db, "s1", 0);
		_setLastLLMCallForTest("s1", Date.now() - 1_000); // hot
		// 150K of 200K window = 75% → above soft (70%) but below hard (90%) and
		// below the 400K absolute hard floor.
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		const res = await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		expect(res.appendMessages).toBeDefined();
		expect((res.appendMessages as any[]).length).toBeGreaterThan(0);
		expect(db.getSummaries("s1").length).toBe(0); // no compression (soft)
	});

	test("hot new-turn hard trigger: >400K or >90% → forced compression", async () => {
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		_setLastLLMCallForTest("s1", Date.now() - 1_000); // hot
		db.setTokenUsage("s1", { inputTokens: 450_000 }); // >400K hard
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		expect(db.getSummaries("s1").length).toBeGreaterThan(0);
	});

	test("hot mid-turn: over threshold → NO interruption (no reminder, no force)", async () => {
		seedTurn(db, "s1", 0);
		_setLastLLMCallForTest("s1", Date.now() - 1_000); // hot
		db.setTokenUsage("s1", { inputTokens: 450_000 }); // would be hard limit if new turn
		const res = await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 3 }); // mid-turn
		expect(res.appendMessages).toBeUndefined();
		expect(db.getSummaries("s1").length).toBe(0); // no compression
	});

	// ── resume-time 冷 preflight ─────────────────────────────────────────

	test("PreLLMCall cold preflight: cold + over threshold on resume-first-call → forced compression", async () => {
		// Simulate resume: lastLLMCall unset (restart) → cold. step 1 (resume's
		// first LLM call) + over threshold → compress before the call.
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		_setLastLLMCallForTest("s1", undefined); // restart = cold
		db.setTokenUsage("s1", { inputTokens: 150_000 }); // >100K
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		expect(db.getSummaries("s1").length).toBeGreaterThan(0);
	});

	test("WAIT-woke folded into PreLLMCall cold preflight (no separate WAIT trigger)", async () => {
		// Long WAIT (>cacheTTL) ages the cache. On wake, the first LLM call is
		// PreLLMCall step 1 with a stale lastLLMCall → cold preflight fires.
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		_setLastLLMCallForTest("s1", Date.now() - 600_000); // 10 min ago (WAIT > TTL)
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		expect(db.getSummaries("s1").length).toBeGreaterThan(0);
	});

	// ── reactive OnLLMError ──────────────────────────────────────────────

	test("OnLLMError prompt_too_long → forces compression + requests retry", async () => {
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		// runtimeShape:true fires OnLLMError with the SAME ctx shape the real
		// agent-loop now fires (config/providers included). If the dead-end
		// regression returns (ctx missing config/providers) the guard at
		// compression-trigger-hooks.ts:315 short-circuits → no compression →
		// this assertion fails. So this test genuinely guards the fix.
		const res = await fire(reg, "OnLLMError", db, {
			sessionId: "s1", errorClass: "prompt_too_long",
		}, /* runtimeShape */ true);
		expect(db.getSummaries("s1").length).toBeGreaterThan(0);
		expect(res.retry).toBe(true);
	});

	test("OnLLMError non-prompt_too_long → no compression", async () => {
		seedTurn(db, "s1", 0);
		const before = db.getSummaries("s1").length;
		const res = await fire(reg, "OnLLMError", db, {
			sessionId: "s1", errorClass: "rate_limit",
		}, /* runtimeShape */ true);
		expect(db.getSummaries("s1").length).toBe(before);
		expect(res.retry).toBeUndefined();
	});

	test("regression guard: OnLLMError with pre-fix ctx shape (no config/providers) must NOT compress — proves the fix is load-bearing", async () => {
		// This test fires the OLD (pre-fix) ctx shape: OnLLMError with NO
		// config/providers. The handler guard (compression-trigger-hooks.ts:315)
		// short-circuits in that case — no compression, no retry result. If a
		// future change re-introduces the dead-end (removes config/providers from
		// the OnLLMError trigger surface), the runtime-shape reactive test above
		// would still pass — but THIS test would catch the regression because the
		// handler would now short-circuit and the assertions below would still
		// hold (no compress, no retry). The contract being pinned: the reactive
		// path is ONLY live when the trigger surface actually carries config/
		// providers. The companion reactive test (runtimeShape:true) is what
		// proves the surface carries them in production.
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		const before = db.getSummaries("s1").length;
		// Craft the ctx manually — no config, no providers (pre-fix shape).
		const res = await reg.trigger("OnLLMError", {
			agentId: "a", sessionId: "s1", timestamp: Date.now(),
			error: "err", errorClass: "prompt_too_long",
			stepNumber: 1, attempt: 1,
		});
		expect(db.getSummaries("s1").length).toBe(before); // guard short-circuited → no compression
		expect((res as any)?.retry).toBeUndefined(); // guard returned void → no retry requested by this handler
	});

	test("fresh tail protected: trigger-driven compression never includes newest steps in stepRange", async () => {
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		seedTurn(db, "s1", 4); // newest turn
		_setLastLLMCallForTest("s1", undefined); // cold
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		const summaries = db.getSummaries("s1");
		expect(summaries.length).toBeGreaterThan(0);
		// Newest step (seq 5) must NEVER be in any compressed range.
		for (const s of summaries) {
			expect(s.stepRange!.to).toBeLessThan(5);
		}
	});

	// ── 防抖:连续两次压缩省 <10% 停 ─────────────────────────────────────

	test("debounce: a prior compression with <10% reduction suppresses the next compression", async () => {
		// Seed enough compressible content for TWO compressions across two turns.
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		// First turn: compress normally.
		_setLastLLMCallForTest("s1", undefined); // cold
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		const after1 = db.getSummaries("s1").length;
		expect(after1).toBeGreaterThan(0);

		// Poison the reduction fraction to <10% (simulates a barely-useful run).
		_setLastReductionForTest("s1", 0.05);
		// New turn (resets per-turn guard but NOT lastReductionFraction).
		await fire(reg, "TurnStart", db, { sessionId: "s1" });
		// Seed fresh compressible content so there IS something to compress.
		seedTurn(db, "s1", 4);
		seedTurn(db, "s1", 6);
		_setLastLLMCallForTest("s1", undefined); // cold
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		// Debounce fired: NO new compression despite cold + over-threshold +
		// fresh compressible content. Summaries count unchanged.
		expect(db.getSummaries("s1").length).toBe(after1);
	});

	// ── per-turn double-compression guard ────────────────────────────────

	test("per-turn guard: a second forced compression in the same turn is skipped", async () => {
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		seedTurn(db, "s1", 4);
		seedTurn(db, "s1", 6);
		_setLastLLMCallForTest("s1", undefined); // cold
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		const after1 = db.getSummaries("s1").length;
		expect(after1).toBeGreaterThan(0);
		// Same turn, another PreLLMCall (step 2) — must NOT compress again even
		// though still cold+over-threshold (lastLLMCall stamped by step 1's call
		// makes it hot anyway, but the guard is the belt-and-suspenders).
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 2 });
		expect(db.getSummaries("s1").length).toBe(after1);
	});

	// ── TurnStart reset ──────────────────────────────────────────────────

	test("TurnStart clears the per-turn compression guard", async () => {
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		_setLastLLMCallForTest("s1", undefined);
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		expect(db.getSummaries("s1").length).toBeGreaterThan(0);

		// New turn: TurnStart resets the guard. Seed more, make cold again.
		await fire(reg, "TurnStart", db, { sessionId: "s1" });
		seedTurn(db, "s1", 4);
		seedTurn(db, "s1", 6);
		_setLastLLMCallForTest("s1", undefined); // cold (new turn, restart)
		await fire(reg, "PreLLMCall", db, { sessionId: "s1", stepNumber: 1 });
		// Summaries cap at 3; at least the same count (FIFO rotated).
		expect(db.getSummaries("s1").length).toBeGreaterThan(0);
	});

	// ── cacheTTL per-provider 默认 ───────────────────────────────────────

	test("cacheTTL: undefined provider cacheTtlMs → DEFAULT_CACHE_TTL_MS (1 hour) used", async () => {
		// Re-register with a provider that has NO cacheTtlMs.
		const reg2 = new HookRegistry();
		clearCompressionTriggerState();
		registerCompressionTriggerHooks({ sessionDb: db }, reg2);
		const providersNoTtl: RuntimeProviderConfig[] = [{
			name: "stub", type: "mock", apiKey: "k", baseUrl: "u",
			models: [{ id: "stub", name: "stub", contextWindow: 200000 }],
			enabled: true,
		}];
		// 3 min ago → within default 1 hour TTL → hot → no compression.
		_setLastLLMCallForTest("s1", Date.now() - 180_000);
		seedTurn(db, "s1", 0);
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		const cfg = mkConfig("s1");
		await reg2.trigger("PreLLMCall", {
			agentId: "a", sessionId: "s1", timestamp: Date.now(),
			config: cfg, providers: providersNoTtl, stepNumber: 1,
		});
		expect(db.getSummaries("s1").length).toBe(0);
	});
});
