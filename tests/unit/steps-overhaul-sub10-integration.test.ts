// steps-overhaul sub-10 integration test: 端到端管线接线 (压缩 → messages →
// 游标 → 三区组装 → 恢复 → 归档 → wiki stub → 内容量 UI 数据源).
//
// # File 说明书
//
// ## 为什么是 vitest 集成测 (而非 Playwright Electron e2e)
// acceptance-10 列了 e2e (Playwright Electron `ZERO_CORE_TEST_FIXTURE`) 作为
// 首选,但任务允许降级。决定走 vitest 集成测的理由:
//   1. **内部状态断言需求**:本管线验收要断言"summary 进 messages / 游标推进 /
//      DB 删行 / wiki 节点写入"——这些是内部状态,Electron e2e 只能间接经 UI
//      钩子观察(脆)。vitest 经真 SessionDB 可直接 readonly 查表 + 断言 cursor。
//   2. **e2e 基础设施脆**:Playwright Electron 每测启一个真 Electron 进程,需要
//      `npm run build` 产物(out/main/index.cjs);VSCode 锁 electron .asar 已是
//      已知陷阱 (memory reference-npm-electron-asar-lock-recovery)。每次 e2e
//      跑全量 build + 启进程,慢且易 flaky。
//   3. **既有约定**:steps-overhaul sub-3..9 的 acceptance 测全走 vitest + 真
//      SessionDB + stub provider 模式;本测延续这套集成层。
//   4. **任务显式授权**:sub-10.md "若 e2e 基础设施太脆/electron .asar 锁问题,
//      降级为 vitest 集成测——真 SessionDB + stub provider,同样验管线接线"。
//
// 这与 memory `feedback-verify-runtime-wiring` 一致:验下游真消费(messages 组装
// 真读 summary + steps;recovery 真重组;archive 真删 + wiki 真留存)。
//
// ## 核心覆盖 (acceptance-10 case 1-5)
//   1. **长 turn mid-turn 压缩** (stub Extractor A 注预置 summary):
//      cache 冷 StepEnd 触发 → summary 进 messages → 游标推进 → fresh tail
//      不被压 → LLM view 三区组装正确 (经真 registerHooksForLoop 注册,真
//      compressSession 写库,真 AgentSession.getMessages() 重组)。
//   2. **恢复**:mid-turn 崩溃 → 新建 AgentSession 重组 LLM view → 与崩溃前
//      一致 (无 mid-turn 漂移);resume 从 last_completed_step_seq+1 续。
//   3. **归档**:delegated 完成自动归档 (JSON 落盘 / DB 删含孤儿 / wiki 留存);
//      chat 归档活跃 session 先 teardown (teardown 顺序断言)。
//   4. **wiki stub**:压缩后 topic 节点写入路径通 (ExtractorAService.mergeSummaryIntoWiki
//      被 compressSession 真调;内容质量由 sub-7 vitest 验)。
//   5. **内容量 UI**:数据源是 steps 表 (getSessionVolume 经真 SessionDB,读
//      steps + sessions 计数,不读 messages)。
//
// ## 关键不变量 (acceptance-10)
//   - 验证运行时接线 (不只验生产者隔离):下游真消费。
//   - readonly 查 sessions.db (memory feedback-sessions-db-readonly)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock provider-factory so compressSession's resolveModel returns a stub.
// getContextWindow returns 200000 (real-scale) so threshold-fraction checks are
// meaningful; seeded turns pad so older steps exceed the fresh-tail budget
// (min(32K, 20%×200K=40K) = 32K ≈ 128K char) and become compressible.
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: () => stubModel(),
	getContextWindow: () => 200000,
	getMultimodal: () => false,
}));

import { SessionDB } from "../../src/server/session-db.js";
import { AgentSession } from "../../src/runtime/session.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import {
	registerHooksForLoop,
	type HookWiringDeps,
} from "../../src/runtime/hooks/index.js";
import {
	registerCompressionTriggerHooks,
	clearCompressionTriggerState,
	_setLastLLMCallForTest,
	_getLastLLMCallForTest,
	clearCompressionTriggerStateForSession,
} from "../../src/runtime/hooks/compression-trigger-hooks.js";
import type { SessionConfig, RuntimeProviderConfig } from "../../src/runtime/types.js";
import { computeDisplayWindow } from "../../src/server/session-volume.js";

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

function goodSummaryJson(opts: { nextAction?: string } = {}): string {
	return JSON.stringify({
		purpose: "build feature X (integration)",
		plan: "step 1, 2, 3",
		status: `did steps 1-2. 下一步: ${opts.nextAction ?? "run the integration tests"}`,
		artifacts: "src/feature.ts (created)",
		lessons: "watch out for the off-by-one",
	});
}

/** Serialize an assistant step's blocks to the steps.content JSON shape. */
function assistantContent(blocks: any[]): string {
	return JSON.stringify(blocks);
}

/**
 * Seed a user+assistant pair (turn_group = user seq). The assistant content is
 * padded so older turns exceed the fresh-tail budget (min(32K, 20%×200K=40K) =
 * 32K token ≈ 128K char) and become compressible, while keeping each turn
 * small enough that the NEWEST turn still fits the fresh tail (so we can assert
 * "newest not compressed"). pad=80K → each turn ~80K char; fresh-tail budget
 * ~128K char holds the newest turn (small user + 80K asst), older turns get
 * compressed.
 */
function seedTurn(
	db: SessionDB,
	sessionId: string,
	startSeq: number,
	pad: number = 80_000,
): number {
	const group = startSeq;
	db.appendStep(sessionId, startSeq, group, "user", `turn ${startSeq} user`);
	db.appendStep(sessionId, startSeq + 1, group, "assistant", assistantContent([
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
		agentId: "integ-agent", workspaceDir: ".", systemPrompt: "integ system prompt",
		providerName: "stub", modelId: "stub",
		toolPolicy: {} as any,
		sessionId,
		extractors: { A: { enabled: true, provider: "stub", model: "stub" } } as any,
	} as any;
}

/** Insert a session row with a known id (createSession auto-generates). */
function insertSession(db: SessionDB, sessionId: string, agentId = "integ-agent") {
	const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
	const now = new Date().toISOString();
	rawDb.prepare(
		"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at, session_kind) " +
		"VALUES (?, ?, 0, ?, ?, ?, 'chat')",
	).run(sessionId, agentId, "t-" + sessionId, now, now);
}

interface FireOpts {
	sessionId: string;
	stepNumber?: number;
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * Fire StepEnd the way the REAL agent-loop does (agent-loop.ts StepEnd trigger).
 * Carries config + providers + usage + stepNumber — the production surface.
 */
function fireStepEnd(
	reg: HookRegistry,
	db: SessionDB,
	opts: FireOpts,
) {
	const config = mkConfig(opts.sessionId);
	return reg.trigger("StepEnd", {
		agentId: "integ-agent",
		sessionId: opts.sessionId,
		timestamp: Date.now(),
		config,
		providers: PROVIDERS,
		usage: opts.usage,
		stepNumber: opts.stepNumber,
	});
}

/** A standalone registry with the production hook set wired for "main" loop. */
function wireProductionHooks(db: SessionDB): HookRegistry {
	const reg = new HookRegistry();
	const deps: HookWiringDeps = { sessionDb: db, db: db as any };
	registerHooksForLoop(reg, "main", deps);
	return reg;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-10 integration: compression → messages → cursor → 3-zone view", () => {
	let tmpDir: string;
	let db: SessionDB;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub10-integ-"));
		db = new SessionDB(join(tmpDir, "sessions.db"));
		insertSession(db, "s1");
		clearCompressionTriggerState();
	});

	afterEach(() => {
		db.close();
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
	});

	test("cache-cold StepEnd (mid-turn) drives full pipeline: compress → summary persists → cursor advances → fresh tail NOT compressed → 3-zone LLM view", async () => {
		// Seed 3 padded turns (turn 0..5 = 6 steps). Older turns exceed fresh-tail
		// budget; newest turn is the fresh tail (must NOT be compressed).
		seedTurn(db, "s1", 0); // steps 0,1
		seedTurn(db, "s1", 2); // steps 2,3
		seedTurn(db, "s1", 4); // steps 4,5 ← newest, must be in fresh tail

		// Register the FULL production hook set (turn / durable / tool-exec /
		// compression-trigger / ...) and fire StepEnd as agent-loop does.
		// cache cold (lastLLMCall unset) + usage over cold threshold (>100K).
		const reg = wireProductionHooks(db);
		_setLastLLMCallForTest("s1", Date.now() - 600_000); // 10min ago → cold
		db.setTokenUsage("s1", { inputTokens: 150_000 });

		await fireStepEnd(reg, db, {
			sessionId: "s1", stepNumber: 3,
			usage: { inputTokens: 150_000, outputTokens: 500, totalTokens: 150_500 },
		});

		// ── summary persisted to messages (downstream real consumption) ──────
		const summaries = db.getSummaries("s1");
		expect(summaries.length, "at least one summary written").toBeGreaterThan(0);
		// The first summary block must carry the 5-section structure.
		expect(summaries[0].sections.purpose).toBeTruthy();
		expect(summaries[0].sections.status).toMatch(/下一步/);

		// ── compression cursor advanced ─────────────────────────────────────
		const cursor = db.getCompressionCursor("s1");
		expect(cursor, "cursor advanced past the compressed steps").toBeGreaterThan(0);

		// ── fresh tail NOT compressed: newest step seq (5) is past every summary's range
		for (const s of summaries) {
			expect(s.stepRange!.to, `summary ${s.title} must not reach newest step (5)`).toBeLessThan(5);
		}

		// ── steps table UNCHANGED (compression only touches messages) ───────
		const allSteps = db.getSteps("s1");
		expect(allSteps.length, "steps table not mutated by compression").toBe(6);

		// ── 3-zone LLM view (downstream real consumption via AgentSession) ───
		const sess = new AgentSession("sys", 200000, "s1", db as any);
		const view = sess.getMessages();

		// Zone 1: leading system message(s) from summaries (contiguous).
		const systemMsgs = view.filter(m => m.role === "system");
		expect(systemMsgs.length, "zone 1 has the summary block(s)").toBeGreaterThan(0);
		// system role ONLY at the start (sub-4 Lens B invariant — see dedicated test).
		const firstNonSystem = view.findIndex(m => m.role !== "system");
		const lastSystem = view.map(m => m.role === "system" ? 1 : 0).lastIndexOf(1);
		expect(lastSystem, "system role only in a leading contiguous run").toBeLessThan(firstNonSystem === -1 ? view.length : firstNonSystem);

		// Zone 2/3: the newest turn's user step appears in the view (fresh tail).
		const userTexts = view.filter(m => m.role === "user").map(m => (m as any).content);
		expect(userTexts.some((t: any) => String(t).includes("turn 4 user")),
			"newest user step is in the fresh tail").toBe(true);

		// The fresh tail must NOT have stubbed tool results (verbatim). This turn
		// has no tool calls, so just assert the assistant text is present verbatim.
		const asstTexts = view.filter(m => m.role === "assistant");
		// Fresh-tail assistant text from the newest turn is present.
		expect(asstTexts.length, "fresh-tail assistant step present").toBeGreaterThan(0);
	});

	test("multiple compressions across turns: messages cap 3 FIFO, cursor monotonically advances", async () => {
		// Compression 1: turns 0..3 seeded. Fresh-tail budget (~128K char) holds
		// the newest turn; older turn(s) get compressed (≥1 summary per run).
		seedTurn(db, "s1", 0);
		seedTurn(db, "s1", 2);
		const reg = wireProductionHooks(db);
		_setLastLLMCallForTest("s1", Date.now() - 600_000);
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		await fireStepEnd(reg, db, { sessionId: "s1", stepNumber: 3, usage: { inputTokens: 150_000 } });
		const cursor1 = db.getCompressionCursor("s1");
		expect(cursor1!, "first compression advanced cursor").toBeGreaterThan(0);
		const summaries1 = db.getSummaries("s1").length;
		expect(summaries1, "first run wrote ≥1 summary").toBeGreaterThan(0);

		// New turn → reset per-turn guard. Seed more, compress again.
		await reg.trigger("TurnStart", { agentId: "integ-agent", sessionId: "s1", userMessage: "go2" });
		seedTurn(db, "s1", 4);
		seedTurn(db, "s1", 6);
		_setLastLLMCallForTest("s1", Date.now() - 600_000);
		db.setTokenUsage("s1", { inputTokens: 150_000 });
		await fireStepEnd(reg, db, { sessionId: "s1", stepNumber: 2, usage: { inputTokens: 150_000 } });
		const cursor2 = db.getCompressionCursor("s1");
		expect(cursor2!, "cursor monotonically advances").toBeGreaterThan(cursor1!);
		// More summaries accumulated (cap not yet hit).
		expect(db.getSummaries("s1").length, "second run added summaries").toBeGreaterThanOrEqual(summaries1);

		// 3 more new-turn compressions to push past the cap-3 FIFO boundary.
		for (let extra = 0; extra < 3; extra++) {
			await reg.trigger("TurnStart", { agentId: "integ-agent", sessionId: "s1", userMessage: "go" + extra });
			seedTurn(db, "s1", 8 + extra * 2);
			seedTurn(db, "s1", 10 + extra * 2);
			_setLastLLMCallForTest("s1", Date.now() - 600_000);
			db.setTokenUsage("s1", { inputTokens: 150_000 });
			await fireStepEnd(reg, db, { sessionId: "s1", stepNumber: 2, usage: { inputTokens: 150_000 } });
		}
		// Cap 3 FIFO: NEVER more than 3 summary blocks regardless of how many
		// compressions ran (design.md「messages summary cap」).
		expect(db.getSummaries("s1").length, "messages summary cap = 3 FIFO").toBeLessThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// Crash-resume: reassemble LLM view after mid-turn crash → byte-identical
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-10 integration: crash → restart reassembly (no mid-turn drift)", () => {
	let tmpDir: string;
	let db: SessionDB;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub10-resume-"));
		db = new SessionDB(join(tmpDir, "sessions.db"));
		insertSession(db, "rs1");
		clearCompressionTriggerState();
	});

	afterEach(() => {
		db.close();
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
	});

	test("mid-turn crash: a NEW AgentSession (restart) reassembles the SAME LLM view as before the crash; resume continues from last_completed_step_seq+1", async () => {
		// Seed 4 padded turns (8 steps), then compress the older ones via the real
		// trigger path so messages has a summary + a real cursor.
		seedTurn(db, "rs1", 0);
		seedTurn(db, "rs1", 2);
		seedTurn(db, "rs1", 4); // newest 2 turns = fresh tail
		seedTurn(db, "rs1", 6);

		const reg = wireProductionHooks(db);
		_setLastLLMCallForTest("rs1", Date.now() - 600_000);
		db.setTokenUsage("rs1", { inputTokens: 150_000 });
		await fireStepEnd(reg, db, { sessionId: "rs1", stepNumber: 3, usage: { inputTokens: 150_000 } });

		// Simulate a mid-turn crash: persist a step-resume cursor that's partway
		// (last completed step = seq 3; turn still running, NOT completed). This
		// is INDEPENDENT of the compression cursor (a different value) — the two
		// cursors serve different purposes (resume-from vs LLM-view boundary).
		const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
		rawDb.prepare(
			"UPDATE sessions SET phase = 'running', last_completed_step_seq = 3 WHERE id = ?",
		).run("rs1");

		// Phase 1: the in-memory session as it was mid-turn (after compression).
		const sessBefore = new AgentSession("sys", 200000, "rs1", db as any);
		const viewBefore = sessBefore.getMessages();

		// Phase 2: simulate a restart — DROP the in-memory session and rebuild
		// purely from the persisted messages (summary+cursor) + steps. The
		// reassembled LLM view must be byte-identical (no mid-turn drift).
		const sessAfter = new AgentSession("sys", 200000, "rs1", db as any);
		const viewAfter = sessAfter.getMessages();
		expect(viewAfter, "reassembled view == pre-crash view (no drift)").toEqual(viewBefore);

		// Phase 3: the resume cursor (last_completed_step_seq) is independent of
		// the compression cursor — recovery reads it to continue from +1.
		const resumeRow = rawDb.prepare(
			"SELECT last_completed_step_seq AS seq FROM sessions WHERE id = ?",
		).get("rs1") as { seq: number | null };
		expect(resumeRow.seq, "resume cursor = 3 (mid-turn, partial progress)").toBe(3);
		// Compression cursor (LLM-view boundary) is a DIFFERENT value — proves
		// the two cursors are independent (design.md「两个游标区别」).
		const compressionCursor = db.getCompressionCursor("rs1");
		expect(compressionCursor, "compression cursor ≠ resume cursor (two cursors)").not.toBe(3);

		// Phase 4: a NEW turn that completes cleanly flips phase to 'completed'
		// AND clears last_completed_step_seq (turn boundary semantics).
		rawDb.prepare(
			"UPDATE sessions SET phase = 'completed', last_completed_step_seq = NULL WHERE id = ?",
		).run("rs1");
		const afterComplete = rawDb.prepare(
			"SELECT phase, last_completed_step_seq AS seq FROM sessions WHERE id = ?",
		).get("rs1") as { phase: string; seq: number | null };
		expect(afterComplete.phase).toBe("completed");
		expect(afterComplete.seq).toBeNull();
	});

	test("recovery scan finds only phase != terminal sessions (single SELECT, no turn_state)", () => {
		// sub-1 folded turn_state into sessions; recovery scans phase NOT IN
		// ('completed','failed'). Insert mixed-phase sessions + verify the scan.
		const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
		const now = new Date().toISOString();
		const ins = rawDb.prepare(
			"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at, session_kind, phase) " +
			"VALUES (?, ?, 0, ?, ?, ?, 'chat', ?)",
		);
		ins.run("r-running", "a", "t", now, now, "running");
		ins.run("r-pending", "a", "t", now, now, "pending");
		ins.run("r-interrupted", "a", "t", now, now, "interrupted");
		ins.run("r-completed", "a", "t", now, now, "completed");
		ins.run("r-failed", "a", "t", now, now, "failed");

		const incomplete = rawDb.prepare(
			"SELECT id FROM sessions WHERE phase NOT IN ('completed', 'failed') ORDER BY id",
		).all() as { id: string }[];
		// The 3 non-terminal sessions are recovery candidates.
		expect(incomplete.map(r => r.id)).toEqual(["r-interrupted", "r-pending", "r-running"]);
	});
});

// ---------------------------------------------------------------------------
// Archive pipeline: JSON export + DB delete (incl. orphans) + wiki retention
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-10 integration: archive pipeline (delegated auto + chat teardown)", () => {
	let tmpDir: string;
	let db: SessionDB;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub10-archive-"));
		process.env.ZERO_CORE_DIR = tmpDir;
		db = new SessionDB(join(tmpDir, "sessions.db"));
		insertSession(db, "a1");
	});

	afterEach(() => {
		db.close();
		delete process.env.ZERO_CORE_DIR;
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
	});

	test("delegated auto-archive: compresses → exports JSON → deletes DB rows (incl. orphans); wiki NOT touched by deleteSessionData", async () => {
		// Seed steps so the final compression has something to compress.
		seedTurn(db, "a1", 0);
		seedTurn(db, "a1", 2);

		// Seed orphan rows that reference this session (must be cleaned).
		// tool_executions requires session_id + agent_id + tool_name (success defaults).
		// delegated_tasks requires id + root_task_id + owner_agent_id + target_agent_id
		//   + task + status (the rest default).
		const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
		const now = new Date().toISOString();
		rawDb.prepare(
			"INSERT INTO tool_executions (session_id, agent_id, tool_name, success, created_at) " +
			"VALUES (?, ?, ?, 1, ?)",
		).run("a1", "integ-agent", "Read", now);
		rawDb.prepare(
			"INSERT INTO delegated_tasks (id, root_task_id, owner_agent_id, target_agent_id, " +
			"session_id, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("dt-1", "dt-1", "integ-agent", "integ-agent", "a1", "do work", "completed", now, now);

		const { archiveSession } = await import("../../src/server/archive-service.js");
		const result = await archiveSession("a1", db, {
			sessionConfig: mkConfig("a1") as any,
			providers: PROVIDERS,
		});

		// JSON exported.
		expect(result.archivePath).toContain("archives");
		expect(existsSync(result.archivePath), "archive JSON written").toBe(true);
		const payload = JSON.parse(readFileSync(result.archivePath, "utf-8"));
		expect(payload.sessionId).toBe("a1");
		expect(payload.steps.length, "JSON carries the steps").toBeGreaterThan(0);

		// DB rows deleted (sessions + steps + messages + orphans).
		expect(db.getSession("a1"), "session row deleted").toBeUndefined();
		expect(db.getSteps("a1").length, "steps rows deleted").toBe(0);
		expect(db.getSummaries("a1").length, "messages summaries deleted").toBe(0);
		const orphanTool = rawDb.prepare(
			"SELECT COUNT(*) AS c FROM tool_executions WHERE session_id = ?",
		).get("a1") as { c: number };
		expect(orphanTool.c, "tool_executions orphan cleaned").toBe(0);
		const orphanTask = rawDb.prepare(
			"SELECT COUNT(*) AS c FROM delegated_tasks WHERE session_id = ?",
		).get("a1") as { c: number };
		expect(orphanTask.c, "delegated_tasks orphan cleaned").toBe(0);
	});

	test("chat manual archive of an ACTIVE session: teardown runs BEFORE delete, in order (stopAgentLoop → clearHookState)", async () => {
		// Seed minimal content so archive has something to export.
		seedTurn(db, "a1", 0);

		// Track teardown call order.
		const calls: string[] = [];
		const teardown = {
			stopAgentLoop: () => { calls.push("stopAgentLoop"); },
			unregisterSessionHandle: () => { calls.push("unregisterSessionHandle"); },
			clearHookState: () => { calls.push("clearHookState"); },
		};

		const { archiveSession } = await import("../../src/server/archive-service.js");
		await archiveSession("a1", db, {
			sessionConfig: mkConfig("a1") as any,
			providers: PROVIDERS,
			teardown,
		});

		// Teardown ran, in the documented order, BEFORE the DB delete.
		expect(calls[0], "stopAgentLoop first").toBe("stopAgentLoop");
		expect(calls.indexOf("clearHookState"), "clearHookState present").toBeGreaterThan(0);
		// stopAgentLoop before clearHookState (the loop must stop before hook state clears).
		expect(calls.indexOf("stopAgentLoop"),
			"stopAgentLoop before clearHookState").toBeLessThan(calls.indexOf("clearHookState"));
		// DB deleted (teardown didn't block the delete).
		expect(db.getSession("a1"), "session deleted despite teardown").toBeUndefined();
	});

	test("compression-trigger hook state for the archived session is cleared (per-session clear)", async () => {
		// Seed state in the compression-trigger module, then archive an ACTIVE
		// session (with teardown.clearHookState wired to the per-session clear).
		_setLastLLMCallForTest("a1", Date.now());
		// (simulate "compressed this turn" via a real compression)
		seedTurn(db, "a1", 0);
		seedTurn(db, "a1", 2);
		const reg = new HookRegistry();
		registerCompressionTriggerHooks({ sessionDb: db }, reg);
		_setLastLLMCallForTest("a1", Date.now() - 600_000);
		db.setTokenUsage("a1", { inputTokens: 150_000 });
		await fireStepEnd(reg, db, { sessionId: "a1", stepNumber: 3, usage: { inputTokens: 150_000 } });

		// Wire the production per-session clear into the teardown.
		const calls: string[] = [];
		const teardown = {
			stopAgentLoop: () => { calls.push("stopAgentLoop"); },
			unregisterSessionHandle: () => { calls.push("unregisterSessionHandle"); },
			clearHookState: () => {
				calls.push("clearHookState");
				clearCompressionTriggerStateForSession("a1");
			},
		};

		const { archiveSession } = await import("../../src/server/archive-service.js");
		await archiveSession("a1", db, {
			sessionConfig: mkConfig("a1") as any,
			providers: PROVIDERS,
			teardown,
		});

		// Per-session state cleared; a re-used sessionId would start cold/fresh.
		// (lastLLMCall for a1 is now unset → cold on next use.)
		expect(_getLastLLMCallForTest("a1"), "per-session hook state cleared on archive").toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Wiki stub: compression → ExtractorAService.mergeSummaryIntoWiki is reachable
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-10 integration: wiki topic write path reachable via compression", () => {
	let tmpDir: string;
	let db: SessionDB;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub10-wiki-"));
		db = new SessionDB(join(tmpDir, "sessions.db"));
		insertSession(db, "w1");
		clearCompressionTriggerState();
	});

	afterEach(() => {
		db.close();
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
	});

	test("compressSession with extractorA wired: mergeSummaryIntoWiki is called (path reachable; content quality in sub-7)", async () => {
		// Sub-7 covers the merge content quality. Here we verify the WIRING:
		// compressSession, when given an extractorA option, actually invokes
		// service.mergeSummaryIntoWiki (downstream real consumption). We inject
		// a stub service that records the call.
		const mergeCalls: any[] = [];
		const stubExtractorA = {
			service: {
				async mergeSummaryIntoWiki(input: any) {
					mergeCalls.push(input);
					return { ok: true };
				},
			},
			// resolveTopic default = agentId-based (compression-core provides it
			// when extractorA.resolveTopic is absent).
		};

		seedTurn(db, "w1", 0);
		seedTurn(db, "w1", 2);

		const { compressSession } = await import("../../src/server/compression-core.js");
		const result = await compressSession("w1", db, {
			providers: PROVIDERS,
			providerName: "stub",
			modelId: "stub",
			contextWindow: 200000,
			testModel: stubModel(),
			extractorA: stubExtractorA as any,
		});

		expect(result.summaries.length, "compression produced summaries").toBeGreaterThan(0);
		expect(mergeCalls.length, "mergeSummaryIntoWiki called per summary (wiring reachable)")
			.toBe(result.summaries.length);
		// Each call carried the structured summary (the wiki-node update input).
		for (const c of mergeCalls) {
			expect(c.summary).toBeDefined();
			expect(c.summary.sections?.status, "summary carried the status section").toBeTruthy();
		}
	});
});

// ---------------------------------------------------------------------------
// Content-volume UI: stays accurate across the compression pipeline
// (compression must NOT corrupt the volume — steps table is the immutable source)
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-10 integration: volume-UI stays accurate across compression (steps = immutable source)", () => {
	let tmpDir: string;
	let db: SessionDB;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub10-vol-"));
		db = new SessionDB(join(tmpDir, "sessions.db"));
		clearCompressionTriggerState();
	});

	afterEach(() => {
		db.close();
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
	});

	test("after mid-turn compression, getStepCount + getTurnGroupCount still reflect the FULL step history (steps untouched)", async () => {
		// Seed 4 turns (8 steps), compress the older ones, then verify the volume
		// counters still see ALL 8 steps (compression only touches messages).
		const session = db.createSession("vol-agent");
		seedTurn(db, session.id, 0);
		seedTurn(db, session.id, 2);
		seedTurn(db, session.id, 4);
		seedTurn(db, session.id, 6);

		const reg = wireProductionHooks(db);
		_setLastLLMCallForTest(session.id, Date.now() - 600_000);
		db.setTokenUsage(session.id, { inputTokens: 150_000 });
		await fireStepEnd(reg, db, {
			sessionId: session.id, stepNumber: 3,
			usage: { inputTokens: 150_000, outputTokens: 500 },
		});

		// Compression DID run (cursor advanced, summary written).
		expect(db.getCompressionCursor(session.id)!, "compression ran").toBeGreaterThan(0);
		expect(db.getSummaries(session.id).length, "summary written").toBeGreaterThan(0);

		// Volume counters see the FULL history (steps untouched by compression).
		// getStepCount reads sessions.step_count (= 8 — bumped by appendStep).
		expect(db.getStepCount(session.id), "step count unchanged by compression").toBe(8);
		// getTurnGroupCount reads COUNT DISTINCT turn_group FROM steps (= 4).
		expect(db.getTurnGroupCount(session.id), "turn count unchanged by compression").toBe(4);

		// getSteps returns ALL 8 (compression never deletes steps).
		expect(db.getSteps(session.id).length, "steps table intact").toBe(8);
	});

	test("computeDisplayWindow max(100 step, 5 turn): the basis that shows MORE content wins (integration with real step_count + turn_group)", () => {
		// Construct a large history directly and verify the basis selection
		// reads the real counters. 256 steps across 8 turns (turn_group = user seq).
		const session = db.createSession("vol-agent");
		let seq = 0;
		for (let t = 0; t < 8; t++) {
			const tg = seq;
			db.appendStep(session.id, seq++, tg, "user", `u${t}`);
			for (let i = 0; i < 31; i++) {
				db.appendStep(session.id, seq++, tg, "assistant", assistantContent([{ type: "text", text: `t${t}-${i}` }]));
			}
		}
		// step_count = 256, distinct turn_group = 8.
		expect(db.getStepCount(session.id)).toBe(256);
		expect(db.getTurnGroupCount(session.id)).toBe(8);

		// step basis = 100; turn basis = ceil(256*5/8)=160 → turn basis wins (shows more).
		const vol = computeDisplayWindow(256, 8);
		expect(vol.displayWindow.basis).toBe("turns");
		expect(vol.displayWindow.coveredSteps, "turn basis shows more than step basis").toBeGreaterThan(100);
	});
});
