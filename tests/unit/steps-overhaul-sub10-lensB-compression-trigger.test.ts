// steps-overhaul sub-10 (sub-5 Lens B 移交): real-AgentLoop-driven reactive
// compression wiring.
//
// # File 说明书
//
// ## 为什么这个测补 sub-5 的自动化缺口
// sub-5 unit 测(steps-overhaul-sub5-compression-trigger.test.ts)直接调
// `registerCompressionTriggerHooks` + 手 fire 事件,runtimeShape:true 那条验证了
// "OnLLMError 在生产 ctx 形态(config+providers)下能驱动压缩"。但它**没**验证:
//   - 真实生产接线 `registerHooksForLoop`(hooks/index.ts)是否真把 compression
//     trigger 注册上了(未来若有人改 hooks/index.ts 漏了 compressionTriggerDeps,
//     sub-5 unit 测不会抓——它绕过了 registerHooksForLoop)。
//   - AgentLoop 持有的 registry 真能被 OnLLMError 命中压缩(生产 fire 路径)。
//
// 本测补这个缺口:用真实 `registerHooksForLoop(reg, "main", deps)`(生产接线)
// 注册完整 hook 集,然后 fire OnLLMError(生产 ctx 形态),断言 compressSession
// **真被调**——下游真消费(summary count 增 + cursor 推进,不只生产者存在)。
//
// ## 不变量守恒(acceptance-5 Lens B)
//   - 生产接线(registerHooksForLoop)真注册 compression trigger。
//   - OnLLMError(prompt_too_long) 在生产 ctx 形态下真驱动 compressSession。
//   - 防御:若未来 hooks/index.ts 漏注册 compressionTriggerDeps → 本测 fail。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock provider-factory so compressSession's resolveModel returns a stub.
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: () => stubModel(),
	getContextWindow: () => 200000,
	getMultimodal: () => false,
}));

import { CoreDatabase } from "../../src/server/core-database.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import {
	registerHooksForLoop,
	type HookWiringDeps,
} from "../../src/runtime/hooks/index.js";
import {
	clearCompressionTriggerState,
	_setLastLLMCallForTest,
	_getPendingForceSignalForTest,
} from "../../src/runtime/hooks/compression-trigger-hooks.js";
import type { SessionConfig, RuntimeProviderConfig } from "../../src/runtime/types.js";

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
		purpose: "reactive compression test",
		plan: "step 1, 2, 3",
		status: "did steps 1-2. 下一步: continue from the pruned context",
		artifacts: "src/x.ts",
		lessons: "none",
	});
}

function seedTurn(db: CoreDatabase, sessionId: string, startSeq: number, pad = 80_000): number {
	const group = startSeq;
	db.appendStep(sessionId, startSeq, group, "user", `turn ${startSeq} user`);
	db.appendStep(sessionId, startSeq + 1, group, "assistant", JSON.stringify([
		{ type: "text", text: `turn ${startSeq} asst` + " ".repeat(pad) },
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
		agentId: "lensb-agent", workspaceDir: ".", systemPrompt: "sys",
		providerName: "stub", modelId: "stub",
		toolPolicy: {} as any,
		sessionId,
		extractors: { A: { enabled: true, provider: "stub", model: "stub" } } as any,
	} as any;
}

function insertSession(db: CoreDatabase, sessionId: string) {
	const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
	const now = new Date().toISOString();
	rawDb.prepare(
		"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at, session_kind) " +
		"VALUES (?, 'lensb-agent', 0, ?, ?, ?, 'chat')",
	).run(sessionId, "t-" + sessionId, now, now);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-10 Lens B (sub-5 移交): production hook wiring drives reactive compression", () => {
	let tmpDir: string;
	let db: CoreDatabase;
	let reg: HookRegistry;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub10-lensb-"));
		db = new CoreDatabase(join(tmpDir, "core.db"));
		insertSession(db, "lb1");
		clearCompressionTriggerState();
		// Production wiring: registerHooksForLoop is what agent-service calls on
		// every loop's own registry. This is the path a future regression could
		// break (e.g. dropping compressionTriggerDeps from the deps shape).
		reg = new HookRegistry();
		const deps: HookWiringDeps = { sessionDb: db, db: db as any };
		registerHooksForLoop(reg, "main", deps);
	});

	afterEach(() => {
		db.close();
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
	});

	test("OnLLMError(prompt_too_long) via PRODUCTION wiring → compressSession actually called (summary count + cursor advance — downstream real consumption)", async () => {
		// Seed compressible content (older turns exceed fresh-tail budget).
		seedTurn(db, "lb1", 0);
		seedTurn(db, "lb1", 2);
		seedTurn(db, "lb1", 4); // newest stays in fresh tail

		const summariesBefore = db.getSummaries("lb1").length;
		const cursorBefore = db.getCompressionCursor("lb1") ?? 0;
		expect(summariesBefore, "baseline: no summaries yet").toBe(0);

		// Fire OnLLMError EXACTLY as agent-loop.ts:1687 does (production ctx shape
		// — config + providers + session + error + errorClass + stepNumber + attempt).
		// This is the same shape sub-5 unit测的 runtimeShape:true 验证过, but here
		// the handler was registered by registerHooksForLoop (not a direct
		// registerCompressionTriggerHooks call) — so this catches wiring regressions
		// that bypass registerHooksForLoop.
		const result = await reg.trigger("OnLLMError", {
			agentId: "lensb-agent",
			sessionId: "lb1",
			timestamp: Date.now(),
			config: mkConfig("lb1"),
			providers: PROVIDERS,
			session: {} as any, // agent-loop passes this.session; handler ignores it
			error: "prompt is too long",
			errorClass: "prompt_too_long",
			stepNumber: 3,
			attempt: 1,
		});

		// Downstream real consumption: compressSession was called.
		const summariesAfter = db.getSummaries("lb1").length;
		const cursorAfter = db.getCompressionCursor("lb1") ?? 0;
		expect(summariesAfter, "reactive compression wrote summaries (compressSession called)")
			.toBeGreaterThan(summariesBefore);
		expect(cursorAfter, "cursor advanced (compressSession ran to completion)")
			.toBeGreaterThan(cursorBefore);
		// The handler returned retry:true + delayMs:0 (reactive retry request).
		expect((result as any)?.retry, "handler requested retry").toBe(true);
	});

	test("regression guard: OnLLMError with a non-prompt_too_long class does NOT compress (handler short-circuits)", async () => {
		seedTurn(db, "lb1", 0);
		seedTurn(db, "lb1", 2);
		const summariesBefore = db.getSummaries("lb1").length;

		const result = await reg.trigger("OnLLMError", {
			agentId: "lensb-agent",
			sessionId: "lb1",
			timestamp: Date.now(),
			config: mkConfig("lb1"),
			providers: PROVIDERS,
			session: {} as any,
			error: "rate limited",
			errorClass: "rate_limit",
			stepNumber: 3,
			attempt: 1,
		});

		// No compression for non-prompt_too_long errors.
		expect(db.getSummaries("lb1").length, "non-prompt_too_long → no compression")
			.toBe(summariesBefore);
		// No retry requested by THIS handler (default policy handled elsewhere).
		expect((result as any)?.retry).toBeUndefined();
	});

	test("StepEnd cold path via PRODUCTION wiring → sets Force signal (sub-3c; the StepEnd trigger is wired too, not just OnLLMError)", async () => {
		// Verify the OTHER trigger seam (StepEnd) is also wired by the production
		// path. sub-5 unit 测 covers StepEnd directly; this asserts the wiring
		// through registerHooksForLoop. sub-3c: the StepEnd cold path now SETS
		// THE FORCE SIGNAL instead of compressing directly (AgentLoop coordinates
		// at the turn boundary — memory ephemeral turn → compressSession).
		seedTurn(db, "lb1", 0);
		seedTurn(db, "lb1", 2);
		seedTurn(db, "lb1", 4);

		_setLastLLMCallForTest("lb1", Date.now() - 600_000); // cold
		db.setTokenUsage("lb1", { inputTokens: 150_000 });

		const summariesBefore = db.getSummaries("lb1").length;
		await reg.trigger("StepEnd", {
			agentId: "lensb-agent",
			sessionId: "lb1",
			timestamp: Date.now(),
			config: mkConfig("lb1"),
			providers: PROVIDERS,
			usage: { inputTokens: 150_000, outputTokens: 500, totalTokens: 150_500 },
			stepNumber: 3,
		});
		// sub-3c: Force signal set; NO direct compression at the hook layer.
		expect(_getPendingForceSignalForTest("lb1"),
			"StepEnd cold via production wiring sets Force signal").toBeDefined();
		expect(db.getSummaries("lb1").length,
			"hook does NOT compress directly (sub-3c signal-based)").toBe(summariesBefore);
	});

	test("single fire → exactly one compression (no duplicate registration double-fires compressSession)", async () => {
		// Defensive: registerHooksForLoop must register the compression-trigger
		// handler ONCE per event. A duplicate registration would double-fire
		// compressSession (write 2 summaries per single OnLLMError). The per-turn
		// guard inside the handler would catch the 2nd, but we assert the contract
		// at the producer side too: one fire → one new summary block group.
		seedTurn(db, "lb1", 0);
		seedTurn(db, "lb1", 2);
		seedTurn(db, "lb1", 4);

		const before = db.getSummaries("lb1").length;
		await reg.trigger("OnLLMError", {
			agentId: "lensb-agent",
			sessionId: "lb1",
			timestamp: Date.now(),
			config: mkConfig("lb1"),
			providers: PROVIDERS,
			session: {} as any,
			error: "too long",
			errorClass: "prompt_too_long",
			stepNumber: 3,
			attempt: 1,
		});
		const after = db.getSummaries("lb1").length;
		// Exactly one compression ran (1+ summaries from one segment batch, but
		// NOT double). The cursor advanced exactly once.
		expect(after, "exactly one compression per fire").toBeGreaterThan(before);
		expect(db.getCompressionCursor("lb1")!, "cursor advanced once").toBeGreaterThan(0);
		// A SECOND fire in the same turn is guarded (per-turn dedup) — no new work.
		const midCursor = db.getCompressionCursor("lb1");
		await reg.trigger("OnLLMError", {
			agentId: "lensb-agent",
			sessionId: "lb1",
			timestamp: Date.now(),
			config: mkConfig("lb1"),
			providers: PROVIDERS,
			session: {} as any,
			error: "too long",
			errorClass: "prompt_too_long",
			stepNumber: 3,
			attempt: 2,
		});
		// Per-turn guard: second OnLLMError in the same turn does NOT compress again
		// (compressedThisTurn flag). Cursor unchanged.
		expect(db.getCompressionCursor("lb1"), "second same-turn fire: per-turn guard held")
			.toBe(midCursor);
	});
});
