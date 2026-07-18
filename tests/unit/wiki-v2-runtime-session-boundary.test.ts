// wiki-system-redesign acceptance-final §G.4 / §G.5-runtime — release-gate 补齐。
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-final §G 的两条 running-session 行为(spec/wiki-management.spec.ts
// 里 test.skip 的两处 fixture):
//
//   §G.4    running session 在安全边界应用新 policy revision;**进行中 tool call
//           的 CallerCtx.wikiAccess 不变**(每 tool call 快照);**下一 turn 的
//           CallerCtx 反映新 revision**。
//   §G.5-runtime  active project 切换后,project:// + compiled access + Wiki Prompt
//                 在**同一安全边界**一起切换,**无旧项目内容残留**。
//
// ## 为什么用 integration 而非 E2E
//   - 真实 running AgentLoop + 可控阻塞 tool call + 中段 publish / project switch +
//     断言 in-flight vs next-turn CallerCtx 是 timing-sensitive 的;Playwright E2E
//     在 UI 层根本到不了 tool-call 粒度,且无法精确把 publish 卡在 tool call 中段。
//   - integration(vitest + mock provider)直接驱动真实 AgentLoop + 真实 AgentService
//     的 publish/switch 路径,用一个 await latch 的 Block tool 让 turn 停在 tool call
//     中段 → 测试同步 publish / sendProjectPrompt → 释放 latch → 断言快照差异。
//     与 wiki-v2-runtime-e2e-wiring.test.ts / step-resume.test.ts / sub2-ephemeral-turn
//     同模式。
//
// ## 关键不变量(测试对应源码真相)
//   - src/runtime/agent-loop.ts `buildCallerCtx(toolCallId)`:每 tool call 构建 fresh
//     CallerCtx,从 `this.config.wikiAccess` 桥接 → snapshot 语义(in-flight 不被
//     中途换)。
//   - src/runtime/agent-loop.ts `applyConfigUpdate({wikiAccess})`:写回
//     `this.config.wikiAccess` → 下一次 `buildCallerCtx` 拿到新值。
//   - src/runtime/hooks/config-sync-hooks.ts:StepEnd hook,flushPendingConfigUpdate
//     取出排队 patch → applyConfigUpdate(busy loop 边界应用)。
//   - src/server/agent-service.ts `enqueueConfigPatch`:busy loop 排队,StepEnd flush;
//     idle loop 立即 apply。
//   - src/server/agent-service.ts `publishAgentWikiPolicy`:CAS revision+1 →
//     AgentStore.update → setAgentStore.onChange 热同步到 active loop。
//   - src/server/agent-service.ts `sendProjectPrompt`(loop 已存在的 else-if 分支):
//     重 compile wikiAccess + enqueueConfigPatch(round-2 B2② —— 这条路径才走 StepEnd
//     边界)。
//
// ## 不改实现源
//   源码接线由 sub-05/07 验过;本测试若揭示真 bug → 报告 finding 不修。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { LanguageModelV2 } from "@ai-sdk/provider";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
	const { tmpdir: td } = require("node:os") as typeof import("node:os");
	const { join: j } = require("node:path") as typeof import("node:path");
	const d = mk(j(td(), "zc-wiki-v2-session-boundary-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

// Mock provider-factory BEFORE importing AgentLoop/AgentService so loop.run
// resolves an inline mock model (no external LLM). Same shape as
// step-resume.test.ts / wiki-v2-runtime-e2e-wiring.test.ts.
const resolveModelMock = vi.fn();
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: (...args: unknown[]) => resolveModelMock(...args),
	getContextWindow: () => 128000,
	getMultimodal: () => false,
}));

import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { AgentService } from "../../src/server/agent-service.js";
import { AgentLoop } from "../../src/runtime/agent-loop.js";
// Turn-start/end persistence: needed so run()'s refreshTurnsCache() finds the
// user step (else messages go empty → streamText "messages must not be empty").
import { registerTurnHooks } from "../../src/runtime/hooks/turn-hooks.js";
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { setWikiRuntime, _resetWikiRuntimeForTests } from "../../src/server/wiki/wiki-runtime.js";
import type { CompiledWikiAccess } from "../../src/shared/wiki-types.js";
import type { SessionConfig, RuntimeCallbacks, StreamEvent, DynamicSystemSection } from "../../src/runtime/types.js";

// ---------------------------------------------------------------------------
// Inline mock language model — per-call step schedule (adapted from
// step-resume.test.ts). Emits tool-call chunks for our Block tool + finish.
// ---------------------------------------------------------------------------

type MockChunk =
	| { type: "text"; text: string }
	| { type: "tool-call"; toolName: string; input: object; toolCallId?: string }
	| { type: "finish"; finishReason?: "stop" | "length" | "tool-calls" | "error"; usage?: MockUsage };

interface MockUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

interface MockModelConfig {
	/** Per-call chunk schedules. Index = call number (0-based). */
	steps: MockChunk[][];
}

function createMockModel(config: MockModelConfig, modelId = "mock-boundary"): LanguageModelV2 {
	let callCount = 0;
	const toStreamPart = (chunk: MockChunk) => {
		switch (chunk.type) {
			case "text": {
				const id = `t-${Math.random().toString(36).slice(2)}`;
				return [
					{ type: "text-start", id },
					{ type: "text-delta", id, delta: chunk.text },
					{ type: "text-end", id },
				];
			}
			case "tool-call": {
				const id = chunk.toolCallId ?? `tc-${Math.random().toString(36).slice(2)}`;
				const inputStr = JSON.stringify(chunk.input);
				return [
					{ type: "tool-input-start", id, toolName: chunk.toolName },
					{ type: "tool-input-delta", id, delta: inputStr },
					{ type: "tool-input-end", id },
					{ type: "tool-call", toolCallId: id, toolName: chunk.toolName, input: inputStr },
				];
			}
			case "finish": {
				const u = chunk.usage ?? {};
				const inputTokens = u.inputTokens ?? 10;
				const outputTokens = u.outputTokens ?? 5;
				return [{
					type: "finish",
					finishReason: chunk.finishReason ?? "stop",
					usage: { inputTokens, outputTokens, totalTokens: u.totalTokens ?? inputTokens + outputTokens },
				}];
			}
		}
	};

	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId,
		supportedUrls: {},
		async doGenerate() { throw new Error("doGenerate not used"); },
		async doStream() {
			const myCallNumber = ++callCount;
			const idx = Math.min(myCallNumber - 1, config.steps.length - 1);
			const chunks = config.steps[idx] ?? [];
			const stream = new ReadableStream({
				async start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					for (const chunk of chunks) {
						for (const part of toStreamPart(chunk)) controller.enqueue(part);
					}
					controller.close();
				},
			});
			return { stream };
		},
	} as unknown as LanguageModelV2;
}

// ---------------------------------------------------------------------------
// Latch — a controlled deferred the Block tool awaits so the test can do
// publish / project-switch mid-call.
// ---------------------------------------------------------------------------

class Latch {
	private resolver: () => void = () => {};
	private readonly promise: Promise<void>;
	private released = false;
	constructor() {
		this.promise = new Promise<void>((resolve) => {
			this.resolver = () => { this.released = true; resolve(); };
		});
	}
	resolve(): void { this.resolver(); }
	getPromise(): Promise<void> { return this.promise; }
	isReleased(): boolean { return this.released; }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface SvcCtx {
	svc: AgentService;
	agentStore: AgentStore;
	db: CoreDatabase;
	wikiDb: WikiDatabase;
	wikiSvc: WikiService;
	searchSvc: WikiSearchService;
	dir: string;
}

function buildSvc(): SvcCtx {
	const dir = mkdtempSync(join(tmpdir(), "zc-wiki-boundary-"));
	const db = new CoreDatabase(join(dir, "core.db"));
	runMigrations(db);

	const wikiDb = new WikiDatabase(join(dir, "wiki.db"));
	const wikiSvc = WikiService.fromDatabase(wikiDb);
	const wdb = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(wdb);
	const repositoryStore = new WikiRepositoryStore(wdb);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const searchSvc = new WikiSearchService({
		db: wdb, nodeRepo, repositoryStore, addressService, authorizationService,
	});
	setWikiRuntime({ wikiService: wikiSvc, searchService: searchSvc });

	const svc = new AgentService(dir, db);
	const agentStore = new AgentStore(db);
	svc.setAgentStore(agentStore);
	resolveModelMock.mockReset();
	resolveModelMock.mockReturnValue(createMockModel({ steps: [[{ type: "finish" }]] }));
	return { svc, agentStore, db, wikiDb, wikiSvc, searchSvc, dir };
}

/**
 * Build a real AgentLoop with the given initial wikiAccess + dynamic section +
 * Block tool injected via getMcpTools (always enabled unless blocked — see
 * src/tools/index.ts buildToolsSet). Register it in svc.loops, wire the
 * config-sync StepEnd hook (mirror AgentService.registerConfigSyncHookForLoop
 * — private), and mark runStates busy so publish/switch paths take the busy
 * branch (matching a real running session).
 */
function buildAndRegisterLoop(args: {
	svc: AgentService;
	agentId: string;
	sessionId: string;
	workspaceDir: string;
	systemPrompt?: string;
	wikiAccess: CompiledWikiAccess;
	wikiContextSection?: DynamicSystemSection;
	blockTool: unknown;
}): AgentLoop {
	const cfg: SessionConfig = {
		agentId: args.agentId,
		workspaceDir: args.workspaceDir,
		systemPrompt: args.systemPrompt ?? "You are a test agent.",
		modelId: "mock-boundary",
		providerName: "Mock",
		sessionId: args.sessionId,
		db: args.svc.getDB() as any,
		toolPolicy: { tools: {} } as any,
		wikiAccess: args.wikiAccess,
		dynamicSystemSections: args.wikiContextSection ? [args.wikiContextSection] : undefined,
		// Inject Block tool via the MCP-merge seam (always enabled unless blocked;
		// same pattern as sub2-ephemeral-turn.test.ts).
		getMcpTools: async () => ({ Block: args.blockTool as any }),
	} as unknown as SessionConfig;

	const callbacks: RuntimeCallbacks = { onEvent: (_e: StreamEvent) => { /* discard */ } };
	const loop = new AgentLoop(cfg, [], callbacks);

	// Register turn-hooks so run()'s TurnStart persists the user step (matches
	// what step-resume.test.ts + sub2-ephemeral-turn.test.ts do; without this,
	// refreshTurnsCache rebuilds an empty messages array → streamText fails with
	// "messages must not be empty"). db is the same CoreDatabase AgentService uses.
	registerTurnHooks(args.svc.getDB() as any, loop.registry);

	// Wire the REAL config-sync StepEnd hook (production private method, mirror
	// of registerConfigSyncHookForLoop). This is the boundary flush path.
	(args.svc as any).registerConfigSyncHookForLoop(loop, args.sessionId);

	// Register in svc.loops + activeSessions + runStates. busy=true so
	// publishAgentWikiPolicy / sendProjectPrompt take the busy branch.
	(args.svc as any).loops.set(args.sessionId, loop);
	(args.svc as any).activeSessions.set(args.agentId, args.sessionId);
	(args.svc as any).runStates.set(args.sessionId, {
		agentId: args.agentId, isBusy: true, waiting: false, streamingText: "", toolCalls: [],
	});
	return loop;
}

/**
 * Build a Block tool that on every execute:
 *   1. extracts the per-call CallerCtx from experimental_context.buildCallerCtx
 *      (same path as src/tools/tool-factory.ts buildTool wrapper);
 *   2. pushes callerCtx.wikiAccess into `snapshots` (snapshot semantics: this
 *      is the value the in-flight tool call sees);
 *   3. resolves `captureSignal` (so the test knows the snapshot is captured);
 *   4. awaits the corresponding latch from `latches[snapshots.length-1]`.
 *
 * Returns string (AI SDK treats it as tool result); format is handled by ai-sdk
 * for raw `tool()` (string return → text tool result).
 */
function buildBlockTool(args: {
	snapshots: Array<CompiledWikiAccess | undefined>;
	captureSignals: Array<{ promise: Promise<void>; resolve: () => void }>;
	latches: Latch[];
}): unknown {
	return tool({
		description: "Block tool — captures wikiAccess snapshot then awaits a latch.",
		inputSchema: z.object({}),
		execute: async (_input: any, opts: any) => {
			const host = opts?.experimental_context;
			const buildCallerCtx = (host && typeof host === "object" && "buildCallerCtx" in host)
				? (host as { buildCallerCtx: (id: string) => any }).buildCallerCtx
				: null;
			const toolCallId = (opts?.toolCallId ?? opts?.id ?? "") as string;
			const callerCtx = buildCallerCtx ? buildCallerCtx(toolCallId) : null;
			const access: CompiledWikiAccess | undefined = callerCtx?.wikiAccess;
			args.snapshots.push(access);
			// Signal that this call's snapshot is captured (test awaits this
			// before doing mid-call publish / switch).
			const idx = args.snapshots.length - 1;
			const signal = args.captureSignals[idx];
			if (signal) signal.resolve();
			// Await the corresponding latch (test releases it).
			const latch = args.latches[idx];
			if (latch) await latch.getPromise();
			return "ok";
		},
	});
}

/** Make a capture signal (resolve-on-capture) for the test to await. */
function makeCaptureSignal(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

/** Poll until cond() returns true (or timeout). */
async function waitFor(cond: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor timed out after ${timeoutMs}ms (cond never became true)`);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

let ctxHolder: SvcCtx | null;

beforeEach(() => { ctxHolder = null; });
afterEach(async () => {
	try { await Promise.resolve(ctxHolder?.svc?.abort?.()); } catch { /* ignore */ }
	try { ctxHolder?.wikiDb?.close(); } catch { /* ignore */ }
	try { ctxHolder?.db?.close(); } catch { /* ignore */ }
	if (ctxHolder) rmSync(ctxHolder.dir, { recursive: true, force: true });
	_resetWikiRuntimeForTests();
});

// ===========================================================================
// §G.4 — running session safety boundary (in-flight snapshot + next-turn rev)
// ===========================================================================

describe("acceptance-final §G.4 — running session applies new revision at safety boundary", () => {
	test("publish mid-tool-call: in-flight CallerCtx unchanged; next step CallerCtx reflects new revision", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "g4-agent",
			provider: "Mock",
			model: "mock-boundary",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read", "expand"] }],
			// Explicit revision so the publish CAS + the compiled policyRevision
			// agree (compileWikiAccess defaults undefined→1, but publishAgentWikiPolicy
			// treats undefined→0 — set explicitly to avoid that mismatch).
			wikiPolicyRevision: 5,
		} as any);

		const sessionId = `g4-${Date.now()}`;

		// Initial compile → wikiAccess at agent.wikiPolicyRevision (rev N).
		const initial = (c.svc as any).compileWikiAccessForSession(agent, sessionId, undefined);
		expect(initial.wikiAccess, "precondition: initial wikiAccess compiled").toBeDefined();
		const initialRev: number = initial.wikiAccess.policyRevision;
		expect(initialRev, "precondition: compiled policyRevision matches agent record").toBe(5);

		// Latches + capture signals for two Block tool calls (steps 1 and 2).
		const latches = [new Latch(), new Latch()];
		const captureSignals = [makeCaptureSignal(), makeCaptureSignal()];
		const snapshots: Array<CompiledWikiAccess | undefined> = [];
		const blockTool = buildBlockTool({ snapshots, captureSignals, latches });

		const loop = buildAndRegisterLoop({
			svc: c.svc, agentId: agent.id, sessionId, workspaceDir: c.dir,
			wikiAccess: initial.wikiAccess, wikiContextSection: initial.dynamicSection,
			blockTool,
		});

		// Mock model: step1=Block call; step2=Block call; step3=text+stop.
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[{ type: "tool-call", toolName: "Block", input: {} }, { type: "finish", finishReason: "tool-calls" }],
				[{ type: "tool-call", toolName: "Block", input: {} }, { type: "finish", finishReason: "tool-calls" }],
				[{ type: "text", text: "done" }, { type: "finish", finishReason: "stop" }],
			],
		}));

		// Drive loop.run in background (don't await — it must block on latch).
		const runPromise = loop.run("go");

		// Wait for Block #1 to capture snapshot #1 (it's now awaiting latch[0]).
		await captureSignals[0].promise;
		await waitFor(() => snapshots.length >= 1);
		expect(snapshots[0], "precondition: Block #1 captured a snapshot").toBeDefined();

		// ── MID-CALL: publish grants (CAS revision+1) ──────────────────────────
		// publishAgentWikiPolicy → AgentStore.update → setAgentStore.onChange →
		// busy-loop applyConfigUpdate path. Record affectedSessions + the live
		// loop.config.wikiAccess.policyRevision immediately after publish
		// (diagnostic for the §G.4 "StepEnd boundary" claim).
		const pubResult = c.svc.publishAgentWikiPolicy({
			agentId: agent.id,
			expectedRevision: initialRev,
			patch: {
				wikiGrants: [{ scope: "memory://", actions: ["read", "expand", "create", "update", "delete"] }],
			},
		});
		const newRev = pubResult.newRevision;
		expect(newRev, "publish must bump revision").toBeGreaterThan(initialRev);

		// Diagnostic: state of loop.config.wikiAccess + pendingConfigPatches +
		// affectedSessions.applied RIGHT AFTER publish (before StepEnd flush).
		const configRevMidCall: number = (loop as any).config.wikiAccess.policyRevision;
		const pendingAfterPublish = (c.svc as any).pendingConfigPatches.get(sessionId) ?? [];
		const affectedEntry = pubResult.affectedSessions.find((s: any) => s.sessionId === sessionId);
		const affectedAppliedMidCall: boolean | undefined = affectedEntry?.applied;

		// Release Block #1 → tool returns → step 1 StepEnd fires (config-sync
		// hook flushes any pending patch). Then step 2 runs Block #2.
		latches[0].resolve();
		await captureSignals[1].promise;
		await waitFor(() => snapshots.length >= 2);
		// Release Block #2 → step 2 StepEnd → step 3 text → turn ends.
		latches[1].resolve();

		await runPromise;

		// ── CORE ASSERTIONS (load-bearing invariants) ─────────────────────────
		// (a) In-flight tool call's snapshot is the OLD revision (CallerCtx is a
		//     per-call snapshot — publish mid-call does NOT mutate it).
		expect(snapshots[0]!.policyRevision,
			"§G.4 (a): in-flight tool call's CallerCtx.wikiAccess must be the OLD revision (snapshot)",
		).toBe(initialRev);

		// (b) Next step's tool call snapshot reflects the NEW revision (the
		//     publish propagated to loop.config.wikiAccess by the next buildCallerCtx).
		expect(snapshots[1]!.policyRevision,
			"§G.4 (b): next step's CallerCtx.wikiAccess must reflect the NEW revision",
		).toBe(newRev);

		// ── DIAGNOSTIC ASSERTIONS (boundary mechanism — corrected StepEnd semantics) ──
		// P0-1 fix: publishAgentWikiPolicy's onChange callback now routes the
		// patch through enqueueConfigPatch, which on a BUSY loop does NOT call
		// applyConfigUpdate synchronously — it pushes the patch into
		// pendingConfigPatches and lets the config-sync StepEnd hook flush it
		// at the safety boundary. So immediately after publish (before StepEnd):
		//   - loop.config.wikiAccess.policyRevision is STILL the OLD revision
		//     (loop.config is not swapped mid-step).
		//   - pendingConfigPatches for this session has ≥1 entry.
		//   - affectedSessions[busy].applied === false (pending, not applied).
		// This matches the §G.5-runtime project-switch path and the
		// publishAgentWikiPolicy docstring ("busy loops use enqueueConfigPatch
		// + StepEnd flush"). The earlier "finding" asserted the bug; this is
		// now the passing specification.
		expect(configRevMidCall,
			"§G.4 mechanism (P0-1): publish path must NOT write loop.config.wikiAccess mid-step — " +
			"still the OLD revision right after publish (StepEnd boundary holds).",
		).toBe(initialRev);
		expect(pendingAfterPublish.length,
			"§G.4 mechanism (P0-1): publish path must enqueue the patch on busy loop " +
			"(pendingConfigPatches ≥ 1) — StepEnd flush will apply it.",
		).toBeGreaterThanOrEqual(1);
		expect(affectedAppliedMidCall,
			"§G.4 mechanism (P0-1): affectedSessions[busy].applied must be false right after publish " +
			"(patch is pending StepEnd flush, not applied).",
		).toBe(false);

		// And the in-flight tool's snapshot was already captured BEFORE publish
		// (CallerCtx built pre-publish) — supplementary confirmation of the
		// safety invariant that actually matters.
		expect(snapshots[0]!.policyRevision,
			"§G.4 supplementary: in-flight snapshot built BEFORE publish stays at OLD revision",
		).toBe(initialRev);
	}, 30000);
});

// ===========================================================================
// §G.4 (multi-call) — within a SINGLE model step emitting MULTIPLE tool calls,
// a publish between call #1 and call #2 must NOT swap loop.config mid-step.
// Both calls' CallerCtx must see the SAME (old) revision.
//
// This is the invariant the original §G.4 test completely missed: it used
// two SEPARATE model steps (one tool call each), so the StepEnd between them
// legitimately swapped the config. The bug (P0-1) only manifested when a
// publish landed INSIDE a single step between two tool calls — and the OLD
// code (direct applyConfigUpdate on busy) would swap loop.config.wikiAccess
// under call #2's feet, breaking the per-step revision-coherence invariant.
// ===========================================================================

describe("acceptance-final §G.4 (multi-tool-call-per-step) — single step keeps one revision", () => {
	test("publish between two tool calls in ONE step: both calls see the SAME old revision", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "g4-multi-agent",
			provider: "Mock",
			model: "mock-boundary",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read", "expand"] }],
			wikiPolicyRevision: 7,
		} as any);

		const sessionId = `g4-multi-${Date.now()}`;

		const initial = (c.svc as any).compileWikiAccessForSession(agent, sessionId, undefined);
		expect(initial.wikiAccess, "precondition: initial wikiAccess compiled").toBeDefined();
		const initialRev: number = initial.wikiAccess.policyRevision;
		expect(initialRev, "precondition: compiled policyRevision matches agent record").toBe(7);

		// Two latches for the two tool calls. latches[0] gates call #1's release
		// (and thus call #2's snapshot timing — see below). latches[1] gates
		// call #2's release so we can sequence the post-publish assertions.
		const latches = [new Latch(), new Latch()];
		const captureSignals = [makeCaptureSignal(), makeCaptureSignal()];
		const snapshots: Array<CompiledWikiAccess | undefined> = [];

		// ── Multi-call Block tool ───────────────────────────────────────────
		// Deterministic across ai-sdk parallel AND sequential tool execution.
		// Counter assigns each invocation an idx (0 for first, 1 for second).
		// idx 1 WAITS until latches[0] resolves (i.e. after the test has done
		// the mid-step publish) before capturing its snapshot. This forces
		// snapshot[1] to be captured AFTER publish even if ai-sdk spawns both
		// execute()s concurrently. The invariant under test: snapshot[1] must
		// STILL be the OLD revision because the publish is deferred to StepEnd
		// and does NOT swap loop.config mid-step.
		let nextIdx = -1;
		const blockTool = tool({
			description: "Multi-call Block — idx 0 captures immediately; idx 1 captures only after latch[0] released.",
			inputSchema: z.object({}),
			execute: async (_input: any, opts: any) => {
				const idx = ++nextIdx;
				const host = opts?.experimental_context;
				const buildCallerCtx = (host && typeof host === "object" && "buildCallerCtx" in host)
					? (host as { buildCallerCtx: (id: string) => any }).buildCallerCtx
					: null;
				const toolCallId = (opts?.toolCallId ?? opts?.id ?? "") as string;

				if (idx === 1) {
					// Wait for call #0 to have been released by the test. The
					// test releases latches[0] ONLY after publishing, so by the
					// time this resolves, the publish has already happened. We
					// then capture snapshot[1] from loop.config.wikiAccess.
					await latches[0].getPromise();
				}

				const callerCtx = buildCallerCtx ? buildCallerCtx(toolCallId) : null;
				const access: CompiledWikiAccess | undefined = callerCtx?.wikiAccess;
				snapshots.push(access);

				captureSignals[idx]?.resolve();
				await latches[idx].getPromise();
				return "ok";
			},
		});

		const loop = buildAndRegisterLoop({
			svc: c.svc, agentId: agent.id, sessionId, workspaceDir: c.dir,
			wikiAccess: initial.wikiAccess, wikiContextSection: initial.dynamicSection,
			blockTool,
		});

		// ── Mock model: ONE step emitting TWO Block tool-call chunks then finish.
		// Both tool calls live in the same model step → no StepEnd between them
		// → the publish done while call #1 is in-flight must stay deferred until
		// after this step's StepEnd (which fires once both tools have returned).
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "Block", input: {} },
					{ type: "tool-call", toolName: "Block", input: {} },
					{ type: "finish", finishReason: "tool-calls" },
				],
				// Step 2 is only reached AFTER StepEnd for step 1 has flushed
				// the pending patch — so step 2 (if it ever runs) would see the
				// NEW revision. We don't drive it for this assertion, but having
				// it keeps run() from throwing on an out-of-schedule call.
				[{ type: "text", text: "done" }, { type: "finish", finishReason: "stop" }],
			],
		}));

		const runPromise = loop.run("go");

		// Wait for call #0 to capture its snapshot (it's now awaiting latch[0]).
		await captureSignals[0].promise;
		await waitFor(() => snapshots.length >= 1);
		expect(snapshots[0], "precondition: call #0 captured a snapshot").toBeDefined();
		expect(snapshots[0]!.policyRevision,
			"precondition: call #0 (pre-publish) sees the OLD revision",
		).toBe(initialRev);

		// ── MID-STEP: publish grants (CAS revision+1). Call #0 is in-flight
		// (awaiting latch[0]); call #1 has NOT yet captured its snapshot
		// (it's waiting on latch[0]'s release). Under the OLD buggy code this
		// would synchronously swap loop.config.wikiAccess; under P0-1 the patch
		// is enqueued and loop.config stays at the OLD revision until StepEnd.
		const pubResult = c.svc.publishAgentWikiPolicy({
			agentId: agent.id,
			expectedRevision: initialRev,
			patch: {
				wikiGrants: [{ scope: "memory://", actions: ["read", "expand", "create", "update", "delete"] }],
			},
		});
		const newRev = pubResult.newRevision;
		expect(newRev, "publish must bump revision").toBeGreaterThan(initialRev);

		// Boundary mechanism check (mid-step, before StepEnd): loop.config
		// must STILL be the OLD revision; the patch is in pendingConfigPatches.
		expect((loop as any).config.wikiAccess.policyRevision,
			"§G.4 multi-call: loop.config.wikiAccess NOT swapped mid-step — still OLD revision",
		).toBe(initialRev);
		const pendingMidStep = (c.svc as any).pendingConfigPatches.get(sessionId) ?? [];
		expect(pendingMidStep.length,
			"§G.4 multi-call: publish enqueued patch on busy loop (pendingConfigPatches ≥ 1)",
		).toBeGreaterThanOrEqual(1);

		// Release latch[0] → call #0 returns; call #1 (whenever it spawned)
		// now unblocks its top-of-execute wait on latch[0] and captures snapshot[1]
		// from the STILL-OLD loop.config.wikiAccess (StepEnd has NOT fired yet —
		// we are still inside step 1 because call #1 hasn't returned).
		latches[0].resolve();

		// Wait for call #1 to capture its snapshot, then release it.
		await captureSignals[1].promise;
		await waitFor(() => snapshots.length >= 2);
		latches[1].resolve();

		await runPromise;

		// ── CORE ASSERTION ─────────────────────────────────────────────────
		// Both tool calls within the SAME model step saw the SAME (OLD) revision.
		// The publish done between them did NOT swap loop.config.mid-step.
		expect(snapshots[0]!.policyRevision,
			"§G.4 multi-call (a): call #0 snapshot is the OLD revision",
		).toBe(initialRev);
		expect(snapshots[1]!.policyRevision,
			"§G.4 multi-call (b): call #1 snapshot is ALSO the OLD revision — " +
			"single model step keeps one revision; publish deferred to StepEnd. " +
			"If this fails with newRev, the publish path swapped loop.config " +
			"mid-step (the P0-1 regression).",
		).toBe(initialRev);
		expect(snapshots[1]!.policyRevision,
			"§G.4 multi-call (b)': sanity — call #1 must NOT see the NEW revision mid-step",
		).not.toBe(newRev);
	}, 30000);
});

// ===========================================================================
// §G.5-runtime — active project switch boundary (no old-project residue)
// ===========================================================================

describe("acceptance-final §G.5-runtime — active project switch at safety boundary", () => {
	test("switch project mid-tool-call: snapshot stays on old project; next step has new project subtree, no residue", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const projectA = "proj-g5-A";
		const projectB = "proj-g5-B";

		const agent = c.agentStore.create({
			name: "g5-agent",
			provider: "Mock",
			model: "mock-boundary",
			toolPolicy: { tools: {} },
			wikiGrants: [
				{ scope: "memory://", actions: ["read", "expand"] },
				{ scope: "project://", actions: ["read", "expand"] },
			],
		} as any);

		const sessionId = `g5-${Date.now()}`;

		// Initial compile with projectA active → project:// resolves to
		// wiki-root/projects/proj-g5-A.
		const initial = (c.svc as any).compileWikiAccessForSession(agent, sessionId, projectA);
		expect(initial.wikiAccess, "precondition: initial wikiAccess compiled").toBeDefined();
		const initialScopes: string[] = initial.wikiAccess.grants.map((g: any) => g.canonicalScope);
		expect(initialScopes, "precondition: projectA subtree in initial access").toContain(`wiki-root/projects/${projectA}`);
		expect(initialScopes, "precondition: projectB subtree NOT in initial access").not.toContain(`wiki-root/projects/${projectB}`);

		// Latches + capture signals for two Block tool calls.
		const latches = [new Latch(), new Latch()];
		const captureSignals = [makeCaptureSignal(), makeCaptureSignal()];
		const snapshots: Array<CompiledWikiAccess | undefined> = [];
		const blockTool = buildBlockTool({ snapshots, captureSignals, latches });

		const loop = buildAndRegisterLoop({
			svc: c.svc, agentId: agent.id, sessionId, workspaceDir: c.dir,
			wikiAccess: initial.wikiAccess, wikiContextSection: initial.dynamicSection,
			blockTool,
		});

		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[{ type: "tool-call", toolName: "Block", input: {} }, { type: "finish", finishReason: "tool-calls" }],
				[{ type: "tool-call", toolName: "Block", input: {} }, { type: "finish", finishReason: "tool-calls" }],
				[{ type: "text", text: "done" }, { type: "finish", finishReason: "stop" }],
			],
		}));

		const runPromise = loop.run("go");

		// Wait for Block #1 to capture snapshot #1 (projectA).
		await captureSignals[0].promise;
		await waitFor(() => snapshots.length >= 1);

		// ── MID-CALL: switch active project via the production sendProjectPrompt
		// path (round-2 B2② — loop 已存在 → enqueueConfigPatch + busy 跳过 run) ──
		const switchResult = await c.svc.sendProjectPrompt(
			agent.id, sessionId, "switch",
			{ projectId: projectB, projectPath: c.dir, projectName: "ProjectB" },
			"work",
		);

		// The patch must have been enqueued (busy loop → StepEnd flush). The
		// run itself is skipped because the session is busy.
		expect(switchResult, "§G.5-runtime: sendProjectPrompt on busy loop returns skipped:busy").toEqual({ skipped: "busy" });
		const pendingAfterSwitch = (c.svc as any).pendingConfigPatches.get(sessionId) ?? [];
		expect(pendingAfterSwitch.length,
			"§G.5-runtime: project-switch path enqueues patch on busy loop (pending >= 1) — StepEnd will flush",
		).toBeGreaterThanOrEqual(1);

		// Diagnostic: loop.config.wikiAccess RIGHT AFTER switch (before StepEnd).
		// For this path it should STILL be projectA (StepEnd boundary holds).
		const configScopesMidCall: string[] =
			(loop as any).config.wikiAccess.grants.map((g: any) => g.canonicalScope);

		// Release Block #1 → tool returns → step 1 StepEnd fires → config-sync
		// hook flushes the enqueued patch → loop.config.wikiAccess = projectB.
		latches[0].resolve();
		await captureSignals[1].promise;
		await waitFor(() => snapshots.length >= 2);
		// Release Block #2 → step 2 StepEnd → step 3 text → turn ends.
		latches[1].resolve();

		await runPromise;

		// ── ASSERTIONS ─────────────────────────────────────────────────────────
		// (a) In-flight tool's snapshot is projectA (snapshot built before switch).
		const s1Scopes: string[] = snapshots[0]!.grants.map((g: any) => g.canonicalScope);
		expect(s1Scopes, "§G.5 (a): in-flight snapshot has projectA subtree").toContain(`wiki-root/projects/${projectA}`);
		expect(s1Scopes, "§G.5 (a): in-flight snapshot has NO projectB subtree").not.toContain(`wiki-root/projects/${projectB}`);

		// (b) Next step's snapshot is projectB (StepEnd flushed the new access).
		const s2Scopes: string[] = snapshots[1]!.grants.map((g: any) => g.canonicalScope);
		expect(s2Scopes, "§G.5 (b): next step snapshot has projectB subtree").toContain(`wiki-root/projects/${projectB}`);

		// (c) NO old-project residue: projectA's subtree is gone from snapshot #2.
		expect(s2Scopes, "§G.5 (c): next step snapshot has NO projectA residue (project switch is complete)").not.toContain(`wiki-root/projects/${projectA}`);

		// (d) Mechanism: the project-switch path held the StepEnd boundary —
		// loop.config.wikiAccess was STILL projectA immediately after switch
		// (before StepEnd flush). After the P0-1 fix the publishAgentWikiPolicy
		// path (§G.4) holds the SAME boundary — both paths route through
		// enqueueConfigPatch; the patch only applies at StepEnd.
		expect(configScopesMidCall,
			"§G.5 mechanism: project-switch path holds StepEnd boundary — config still projectA right after switch",
		).toContain(`wiki-root/projects/${projectA}`);
		expect(configScopesMidCall,
			"§G.5 mechanism: project-switch path holds StepEnd boundary — config NOT projectB right after switch",
		).not.toContain(`wiki-root/projects/${projectB}`);
	}, 30000);
});
