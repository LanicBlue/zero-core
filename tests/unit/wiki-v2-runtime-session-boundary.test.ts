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
// round-2 fix §3: drive config-sync hook directly for focused merge tests.
import { registerConfigSyncHooks } from "../../src/runtime/hooks/config-sync-hooks.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
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

// ===========================================================================
// round-2 review fix §3 — flushPendingConfigPatch merge + confirm-on-success
//
// These tests exercise the production config-sync StepEnd hook + AgentService's
// real flushPendingConfigPatch / confirmPendingConfigApplied primitives. Cases
// 1, 2, 3, 4, 6, 7, 8 drive the hook directly via a hand-built harness (no
// heavy AgentLoop fixture). Case 5 (mid-tool-call multi-enqueue) reuses the
// §G.4-style Block-tool AgentLoop harness.
//
// Source of truth:
//   - src/server/agent-service.ts: flushPendingConfigPatch (peek+merge),
//     confirmPendingConfigApplied (clear), enqueueConfigPatch (busy → queue),
//     pendingConfigPatches Map.
//   - src/runtime/hooks/config-sync-hooks.ts: StepEnd hook = flush → apply →
//     confirm-on-success.
// ===========================================================================

/**
 * Build a minimal merge-test harness: real AgentService (its private
 * pendingConfigPatches / flushPendingConfigPatch / confirmPendingConfigApplied
//  are exercised), a fresh HookRegistry with the REAL config-sync StepEnd hook
 * registered, and a FAKE loop whose applyConfigUpdate records every call +
 * can be made to throw once. Tests push patches directly to the queue (mirrors
 * what enqueueConfigPatch does on a busy loop) and trigger StepEnd manually.
 */
function buildMergeHarness(args: {
	sessionId?: string;
	applyShouldThrowOnce?: boolean;
} = {}): {
	svc: AgentService;
	registry: HookRegistry;
	sessionId: string;
	appliedUpdates: Array<Record<string, unknown>>;
	setApplyThrowOnce: (v: boolean) => void;
	applyCallCount: () => number;
} {
	const c = buildSvc();
	ctxHolder = c;
	const sessionId = args.sessionId ?? `merge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const registry = new HookRegistry();
	const appliedUpdates: Array<Record<string, unknown>> = [];
	let throwOnce = !!args.applyShouldThrowOnce;
	let applyCallCount = 0;
	const fakeLoop = {
		applyConfigUpdate(update: Record<string, unknown>) {
			applyCallCount++;
			if (throwOnce) {
				throwOnce = false;
				throw new Error("mock apply failure");
			}
			appliedUpdates.push(update);
		},
	};
	// Register the REAL production hook against this registry. flush/confirm
	// go through AgentService's real private methods (peek+merge / clear) so
	// we test the production primitives end-to-end with the hook wiring.
	registerConfigSyncHooks(registry, {
		flushPendingConfigUpdate: (sid) => (c.svc as any).flushPendingConfigPatch(sid),
		confirmPendingConfigApplied: (sid) => (c.svc as any).confirmPendingConfigApplied(sid),
		resolveLoop: (sid) => (sid === sessionId ? fakeLoop : null),
	});
	return {
		svc: c.svc,
		registry,
		sessionId,
		appliedUpdates,
		setApplyThrowOnce: (v: boolean) => { throwOnce = v; },
		applyCallCount: () => applyCallCount,
	};
}

/**
 * Push a patch to AgentService.pendingConfigPatches (same shape enqueueConfigPatch
 * pushes on a busy loop). Direct map mutation — bypasses the idle/busy branch
 * so we can test the queue+hook+merge in isolation.
 */
function enqueuePending(svc: AgentService, sessionId: string, update: Record<string, unknown>): void {
	const map = (svc as any).pendingConfigPatches as Map<string, Array<{ sessionId: string; update: Record<string, unknown> }>>;
	const queue = map.get(sessionId) ?? [];
	queue.push({ sessionId, update });
	map.set(sessionId, queue);
}

function peekQueue(svc: AgentService, sessionId: string): Array<{ sessionId: string; update: Record<string, unknown> }> {
	return ((svc as any).pendingConfigPatches as Map<string, Array<{ sessionId: string; update: Record<string, unknown> }>>).get(sessionId) ?? [];
}

// ---------------------------------------------------------------------------
// §3.1 — full-then-wiki-only merge (the regression that motivated this fix)
// ---------------------------------------------------------------------------

describe("round-2 fix §3.1 — full-then-wiki-only: full patch fields preserved", () => {
	test("at StepEnd, applied update keeps systemPrompt/modelId/toolPolicy; wikiAccess@3 wins; dynamicSystemSections included", async () => {
		const h = buildMergeHarness();
		const wikiAccess2 = { policyRevision: 2, grants: [{ canonicalScope: "wiki-root/memory", actions: ["read"] }] };
		const wikiAccess3 = { policyRevision: 3, grants: [{ canonicalScope: "wiki-root/memory", actions: ["read", "expand"] }] };
		const dynamicSections = [{ name: "wiki-context", compute: (): string => "x", cacheBreak: true }];

		// 1) FULL SessionConfig patch.
		enqueuePending(h.svc, h.sessionId, {
			systemPrompt: "full-prompt",
			modelId: "full-model",
			toolPolicy: { tools: { Wiki: { enabled: true } } },
			capabilities: { management: {} },
			wikiAccess: wikiAccess2,
		});
		// 2) Wiki-only patch (different fields + overwrites wikiAccess).
		enqueuePending(h.svc, h.sessionId, {
			wikiAccess: wikiAccess3,
			dynamicSystemSections: dynamicSections,
		});

		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });

		expect(h.appliedUpdates.length, "exactly one applyConfigUpdate call after StepEnd").toBe(1);
		const applied = h.appliedUpdates[0]!;
		// Early (full) patch's unique fields survive.
		expect(applied.systemPrompt, "systemPrompt from full patch preserved").toBe("full-prompt");
		expect(applied.modelId, "modelId from full patch preserved").toBe("full-model");
		expect(applied.toolPolicy, "toolPolicy from full patch preserved").toEqual({ tools: { Wiki: { enabled: true } } });
		expect(applied.capabilities, "capabilities from full patch preserved").toEqual({ management: {} });
		// wikiAccess: last wins (wiki-only's @3, not full's @2).
		expect(applied.wikiAccess, "wikiAccess is the LAST (wiki-only's @3) verbatim — same reference").toBe(wikiAccess3);
		expect((applied.wikiAccess as any).policyRevision, "wikiAccess policyRevision is 3 (last wins)").toBe(3);
		// dynamicSystemSections from the wiki-only patch included.
		expect(applied.dynamicSystemSections, "dynamicSystemSections from wiki-only patch included").toBe(dynamicSections);
		// Queue cleared on successful apply+confirm.
		expect(peekQueue(h.svc, h.sessionId).length, "queue cleared after successful apply+confirm").toBe(0);
	});
});

// ---------------------------------------------------------------------------
// §3.2 — wiki-only-then-full (reverse order): full overwrites shared fields;
//        wiki-only's unique fields (dynamicSystemSections) survive.
// ---------------------------------------------------------------------------

describe("round-2 fix §3.2 — wiki-only-then-full: full overwrites shared; wiki-only unique survives", () => {
	test("at StepEnd, full's systemPrompt/modelId/toolPolicy overwrite; wikiAccess is full's (@5); dynamicSystemSections from wiki-only survives", async () => {
		const h = buildMergeHarness();
		const wikiAccess3 = { policyRevision: 3, grants: [] };
		const wikiAccess5 = { policyRevision: 5, grants: [{ canonicalScope: "wiki-root/memory", actions: ["read"] }] };
		const dynamicSections = [{ name: "wiki-context", compute: (): string => "y", cacheBreak: true }];

		// 1) Wiki-only patch.
		enqueuePending(h.svc, h.sessionId, {
			wikiAccess: wikiAccess3,
			dynamicSystemSections: dynamicSections,
		});
		// 2) Full patch (overwrites wikiAccess; adds systemPrompt/modelId).
		enqueuePending(h.svc, h.sessionId, {
			systemPrompt: "full-prompt",
			modelId: "full-model",
			toolPolicy: { tools: { Wiki: { enabled: true } } },
			capabilities: { management: {} },
			wikiAccess: wikiAccess5,
		});

		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });

		const applied = h.appliedUpdates[0]!;
		expect(applied.systemPrompt, "full overwrites systemPrompt").toBe("full-prompt");
		expect(applied.modelId, "full overwrites modelId").toBe("full-model");
		expect(applied.toolPolicy, "full overwrites toolPolicy").toEqual({ tools: { Wiki: { enabled: true } } });
		expect(applied.capabilities, "full overwrites capabilities").toEqual({ management: {} });
		// wikiAccess: last (full's @5) wins.
		expect((applied.wikiAccess as any).policyRevision, "wikiAccess is full's @5 (last wins)").toBe(5);
		expect(applied.wikiAccess, "wikiAccess is full's reference (last wins)").toBe(wikiAccess5);
		// dynamicSystemSections from wiki-only survives (full didn't set it).
		expect(applied.dynamicSystemSections, "dynamicSystemSections from wiki-only survives (full didn't overwrite)").toBe(dynamicSections);
	});
});

// ---------------------------------------------------------------------------
// §3.3 — 3+ patches, same field last-write-wins; all unique fields survive.
// ---------------------------------------------------------------------------

describe("round-2 fix §3.3 — 3+ patches: last-write-wins for shared field, uniques survive", () => {
	test("three patches writing modelId=A/B/C → applied modelId is C; each patch's unique fields survive", async () => {
		const h = buildMergeHarness();
		enqueuePending(h.svc, h.sessionId, { modelId: "A", systemPrompt: "p1" });
		enqueuePending(h.svc, h.sessionId, { modelId: "B", toolPolicy: { tools: { Read: { enabled: true } } } });
		enqueuePending(h.svc, h.sessionId, { modelId: "C", providerName: "P" });

		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });

		const applied = h.appliedUpdates[0]!;
		expect(applied.modelId, "last-write-wins for shared field modelId").toBe("C");
		expect(applied.systemPrompt, "unique field from patch 1 survives").toBe("p1");
		expect(applied.toolPolicy, "unique field from patch 2 survives").toEqual({ tools: { Read: { enabled: true } } });
		expect(applied.providerName, "unique field from patch 3 survives").toBe("P");
	});
});

// ---------------------------------------------------------------------------
// §3.4 — second flush returns null after successful apply+confirm.
// ---------------------------------------------------------------------------

describe("round-2 fix §3.4 — second flush returns null after successful apply+confirm", () => {
	test("queue cleared exactly once on success; subsequent flush / StepEnd are no-ops", async () => {
		const h = buildMergeHarness();
		enqueuePending(h.svc, h.sessionId, { modelId: "X" });

		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });

		expect(h.appliedUpdates.length, "precondition: first StepEnd applied once").toBe(1);
		expect(peekQueue(h.svc, h.sessionId).length, "precondition: queue cleared after success").toBe(0);

		// Direct flush returns null (queue empty).
		expect(
			(h.svc as any).flushPendingConfigPatch(h.sessionId),
			"direct flushPendingConfigPatch on empty queue returns null",
		).toBeNull();

		// Second StepEnd is a noop (no apply, no confirm).
		const applyCallsBefore = h.applyCallCount();
		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });
		expect(h.applyCallCount(), "second StepEnd did NOT call applyConfigUpdate").toBe(applyCallsBefore);
		expect(h.appliedUpdates.length, "second StepEnd did not record a new apply").toBe(1);
	});
});

// ---------------------------------------------------------------------------
// §3.5 — mid-tool-call multi-enqueue (reuses AgentLoop Block-tool fixture).
// ---------------------------------------------------------------------------

describe("round-2 fix §3.5 — mid-tool-call multi-enqueue: current step sees OLD, next step sees MERGED", () => {
	test("two mid-step enqueues: both step-1 tool calls see OLD revision; step-2 sees MERGED fields (modelId + wikiAccess@12)", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "merge-mid-agent",
			provider: "Mock",
			model: "mock-boundary",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read", "expand"] }],
			wikiPolicyRevision: 11,
		} as any);

		const sessionId = `merge-mid-${Date.now()}`;
		const initial = (c.svc as any).compileWikiAccessForSession(agent, sessionId, undefined);
		expect(initial.wikiAccess, "precondition: initial wikiAccess compiled").toBeDefined();
		const initialRev: number = initial.wikiAccess.policyRevision;
		expect(initialRev, "precondition: compiled policyRevision matches agent record").toBe(11);

		const latches = [new Latch(), new Latch()];
		const captureSignals = [makeCaptureSignal(), makeCaptureSignal(), makeCaptureSignal()];
		const snapshots: Array<CompiledWikiAccess | undefined> = [];

		// Multi-call Block tool. Idx 0 (step 1 call 1) captures immediately then
		// awaits latch[0]. Idx 1 (step 1 call 2) waits on latch[0] before
		// capturing (so its snapshot is taken AFTER the test's mid-step enqueue
		// but BEFORE StepEnd fires — both still in step 1). Idx 2 (step 2 call)
		// captures immediately and returns (no latch).
		let nextIdx = -1;
		const blockTool = tool({
			description: "Multi-call Block for §3.5 merge test",
			inputSchema: z.object({}),
			execute: async (_input: any, opts: any) => {
				const idx = ++nextIdx;
				const host = opts?.experimental_context;
				const buildCallerCtx = (host && typeof host === "object" && "buildCallerCtx" in host)
					? (host as { buildCallerCtx: (id: string) => any }).buildCallerCtx
					: null;
				const toolCallId = (opts?.toolCallId ?? opts?.id ?? "") as string;

				if (idx === 1) {
					// Wait for the test to release latch[0] (= test has enqueued
					// its two patches + released call #0). We then capture from
					// loop.config.wikiAccess — still OLD (StepEnd has NOT fired
					// because call #1 hasn't returned yet).
					await latches[0].getPromise();
				}

				const callerCtx = buildCallerCtx ? buildCallerCtx(toolCallId) : null;
				const access: CompiledWikiAccess | undefined = callerCtx?.wikiAccess;
				snapshots.push(access);
				captureSignals[idx]?.resolve();

				if (idx < 2) {
					// Step-1 calls await their latch so the test controls release
					// timing precisely. Idx 0 awaits latch[0]; idx 1 awaits
					// latch[1]. Both must return before step 1 StepEnd fires.
					await latches[idx].getPromise();
				}
				// Idx 2 (step 2) returns immediately.
				return "ok";
			},
		});

		const loop = buildAndRegisterLoop({
			svc: c.svc, agentId: agent.id, sessionId, workspaceDir: c.dir,
			wikiAccess: initial.wikiAccess, wikiContextSection: initial.dynamicSection,
			blockTool,
		});

		// Step 1 emits TWO Block tool calls (single step → both must see the
		// SAME OLD revision). Step 2 emits ONE Block call (must see MERGED).
		// Step 3 ends the turn with text.
		resolveModelMock.mockReturnValue(createMockModel({
			steps: [
				[
					{ type: "tool-call", toolName: "Block", input: {} },
					{ type: "tool-call", toolName: "Block", input: {} },
					{ type: "finish", finishReason: "tool-calls" },
				],
				[
					{ type: "tool-call", toolName: "Block", input: {} },
					{ type: "finish", finishReason: "tool-calls" },
				],
				[{ type: "text", text: "done" }, { type: "finish", finishReason: "stop" }],
			],
		}));

		const runPromise = loop.run("go");

		// Wait for call #0 to capture (now awaiting latch[0]).
		await captureSignals[0].promise;
		await waitFor(() => snapshots.length >= 1);
		expect(snapshots[0], "precondition: call #0 captured a snapshot").toBeDefined();
		expect(snapshots[0]!.policyRevision, "precondition: call #0 (pre-enqueue) sees OLD revision").toBe(initialRev);

		// ── MID-STEP: enqueue TWO patches via the production enqueueConfigPatch
		//    path (busy loop → both land in pendingConfigPatches). Patch 1 sets
		//    modelId; patch 2 sets wikiAccess@12. The merge must combine both.
		(c.svc as any).enqueueConfigPatch(sessionId, { modelId: "merged-model" });
		const rev12Access = { ...initial.wikiAccess, policyRevision: 12 };
		(c.svc as any).enqueueConfigPatch(sessionId, { wikiAccess: rev12Access });

		const pendingAfterEnqueue = (c.svc as any).pendingConfigPatches.get(sessionId) ?? [];
		expect(pendingAfterEnqueue.length,
			"§3.5 mechanism: both mid-step patches enqueued on busy loop (pendingConfigPatches = 2)",
		).toBe(2);

		// Boundary invariant: loop.config mid-step is STILL the OLD values
		// (no mid-step swap).
		expect((loop as any).config.modelId,
			"§3.5 boundary: loop.config.modelId NOT swapped mid-step",
		).toBe("mock-boundary");
		expect((loop as any).config.wikiAccess.policyRevision,
			"§3.5 boundary: loop.config.wikiAccess.policyRevision NOT swapped mid-step (still 11)",
		).toBe(initialRev);

		// Release latch[0] → call #0 returns; call #1 (was awaiting latch[0])
		// unblocks and captures from loop.config (STILL OLD — StepEnd has not
		// fired; we're still inside step 1 because call #1 hasn't returned yet).
		latches[0].resolve();
		await captureSignals[1].promise;
		await waitFor(() => snapshots.length >= 2);

		// Call #1's snapshot must be the OLD revision (snapshot invariant).
		expect(snapshots[1]!.policyRevision,
			"§3.5 (a): call #1 snapshot is OLD revision — single model step keeps one revision",
		).toBe(initialRev);

		// Release latch[1] → call #1 returns → step 1 StepEnd fires → config-sync
		// hook flushes the merged patch → loop.config now has merged fields.
		latches[1].resolve();

		// Wait for call #2 (step 2) to capture the MERGED snapshot.
		await captureSignals[2].promise;
		await waitFor(() => snapshots.length >= 3);

		// Call #2 (next step) sees the MERGED wikiAccess (policyRevision=12).
		expect(snapshots[2]!.policyRevision,
			"§3.5 (b): next-step snapshot reflects MERGED wikiAccess (rev 12)",
		).toBe(12);

		// Let the run finish (step 2 StepEnd + step 3 text+finish).
		await runPromise;

		// After run: loop.config.modelId has been swapped to the MERGED value.
		expect((loop as any).config.modelId,
			"§3.5 (c): loop.config.modelId reflects MERGED patch ('merged-model') after StepEnd",
		).toBe("merged-model");

		// Queue cleared after successful apply+confirm.
		expect(peekQueue(c.svc, sessionId).length,
			"§3.5 (d): pendingConfigPatches cleared after successful apply+confirm at StepEnd",
		).toBe(0);
	}, 30000);
});

// ---------------------------------------------------------------------------
// §3.6 — cross-session isolation: StepEnd on A applies only A's merged patch;
//        B's queue untouched.
// ---------------------------------------------------------------------------

describe("round-2 fix §3.6 — cross-session isolation", () => {
	test("StepEnd on sessionA applies A's merged patch only; sessionB's queue untouched", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const sessionA = `iso-A-${Date.now()}`;
		const sessionB = `iso-B-${Date.now()}`;
		const registry = new HookRegistry();
		const appliedUpdates: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const fakeLoopA = {
			applyConfigUpdate(update: Record<string, unknown>) {
				appliedUpdates.push({ sessionId: sessionA, update });
			},
		};
		registerConfigSyncHooks(registry, {
			flushPendingConfigUpdate: (sid) => (c.svc as any).flushPendingConfigPatch(sid),
			confirmPendingConfigApplied: (sid) => (c.svc as any).confirmPendingConfigApplied(sid),
			resolveLoop: (sid) => (sid === sessionA ? fakeLoopA : null),
		});

		// Enqueue on BOTH sessions.
		enqueuePending(c.svc, sessionA, { modelId: "A1", systemPrompt: "pA" });
		enqueuePending(c.svc, sessionA, { modelId: "A2" });
		enqueuePending(c.svc, sessionB, { modelId: "B1" });
		enqueuePending(c.svc, sessionB, { modelId: "B2", toolPolicy: { tools: {} } });

		// StepEnd on A only.
		await registry.trigger("StepEnd", { sessionId: sessionA });

		// A's patch applied (merged).
		expect(appliedUpdates.length, "exactly one apply on sessionA").toBe(1);
		expect(appliedUpdates[0]!.update.modelId, "A merged: last modelId wins").toBe("A2");
		expect(appliedUpdates[0]!.update.systemPrompt, "A merged: systemPrompt preserved").toBe("pA");

		// A's queue cleared.
		expect(peekQueue(c.svc, sessionA).length, "A queue cleared after apply+confirm").toBe(0);

		// B's queue UNTOUCHED (still has 2 patches in original order).
		const bQueue = peekQueue(c.svc, sessionB);
		expect(bQueue.length, "B queue untouched by A's StepEnd").toBe(2);
		expect(bQueue[0]!.update.modelId, "B queue[0] unchanged").toBe("B1");
		expect(bQueue[1]!.update.modelId, "B queue[1] unchanged").toBe("B2");
		expect(bQueue[1]!.update.toolPolicy, "B queue[1] toolPolicy unchanged").toEqual({ tools: {} });

		// A's flush now returns null; B's flush returns its merged patch.
		expect((c.svc as any).flushPendingConfigPatch(sessionA), "A flush empty after apply").toBeNull();
		const bFlush = (c.svc as any).flushPendingConfigPatch(sessionB);
		expect(bFlush, "B flush returns merged patch (peek, no clear)").not.toBeNull();
		expect(bFlush.update.modelId, "B flush merged modelId = last (B2)").toBe("B2");
		expect(bFlush.update.systemPrompt, "B flush has no systemPrompt (neither B patch set it)").toBeUndefined();
		// B's queue still has 2 entries (peek, not clear).
		expect(peekQueue(c.svc, sessionB).length, "B queue still 2 after peek-only flush").toBe(2);
	});
});

// ---------------------------------------------------------------------------
// §3.7 — whole-replace field (dynamicSystemSections) is NOT concatenated.
// ---------------------------------------------------------------------------

describe("round-2 fix §3.7 — whole-replace field is replaced verbatim, NOT concatenated", () => {
	test("two patches each set dynamicSystemSections: result is the LAST array verbatim", async () => {
		const h = buildMergeHarness();
		const sections1 = [
			{ name: "section-A", compute: (): string => "A", cacheBreak: true },
		];
		const sections2 = [
			{ name: "section-B", compute: (): string => "B", cacheBreak: true },
			{ name: "section-C", compute: (): string => "C", cacheBreak: true },
		];

		enqueuePending(h.svc, h.sessionId, { dynamicSystemSections: sections1 });
		enqueuePending(h.svc, h.sessionId, { dynamicSystemSections: sections2 });

		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });

		const applied = h.appliedUpdates[0]!;
		expect(applied.dynamicSystemSections, "dynamicSystemSections is the LAST array verbatim (same reference)").toBe(sections2);
		expect((applied.dynamicSystemSections as any[]).length, "NOT concatenated — length is 2 (sections2.length), not 3").toBe(2);
		expect((applied.dynamicSystemSections as any[])[0]!.name, "first entry is section-B (from sections2)").toBe("section-B");
		expect((applied.dynamicSystemSections as any[])[1]!.name, "second entry is section-C (from sections2)").toBe("section-C");
	});

	test("capabilities (whole-replace) is also replaced verbatim, NOT deep-merged", async () => {
		const h = buildMergeHarness();
		const caps1 = { management: { id: "mgmt-1" }, pmService: { id: "pm-1" } };
		const caps2 = { requirementStore: { id: "req-1" } };

		enqueuePending(h.svc, h.sessionId, { capabilities: caps1 });
		enqueuePending(h.svc, h.sessionId, { capabilities: caps2 });

		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });

		const applied = h.appliedUpdates[0]!;
		expect(applied.capabilities, "capabilities is LAST object verbatim (same reference)").toBe(caps2);
		expect(applied.capabilities, "capabilities replaced, not deep-merged").toEqual({ requirementStore: { id: "req-1" } });
		// management / pmService from caps1 are GONE (no deep merge).
		expect((applied.capabilities as any).management, "management from caps1 NOT retained (no deep merge)").toBeUndefined();
		expect((applied.capabilities as any).pmService, "pmService from caps1 NOT retained (no deep merge)").toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// §3.8 — apply-failure retention: queue NOT cleared; next StepEnd re-flushes,
//        applies, confirms.
// ---------------------------------------------------------------------------

describe("round-2 fix §3.8 — apply-failure retention: queue retained on throw, re-applied next StepEnd", () => {
	test("first StepEnd throws → queue retained; second StepEnd applies successfully + confirms (clears)", async () => {
		const h = buildMergeHarness({ applyShouldThrowOnce: true });

		enqueuePending(h.svc, h.sessionId, { modelId: "X", systemPrompt: "p" });

		// First StepEnd: applyConfigUpdate throws once.
		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });

		expect(h.appliedUpdates.length,
			"first StepEnd: apply threw → appliedUpdates empty (throw happened before push)",
		).toBe(0);
		expect(h.applyCallCount(),
			"first StepEnd: applyConfigUpdate was called once (and threw)",
		).toBe(1);
		expect(peekQueue(h.svc, h.sessionId).length,
			"first StepEnd: queue NOT cleared on apply failure (retention for retry)",
		).toBe(1);

		// Mid-retry enqueue: a new patch lands in the queue. The next flush
		// must re-merge ALL queued patches (original + new).
		enqueuePending(h.svc, h.sessionId, { modelId: "Y" });
		expect(peekQueue(h.svc, h.sessionId).length,
			"after mid-retry enqueue: queue has 2 patches (original retained + new)",
		).toBe(2);

		// Second StepEnd: applies successfully (throwOnce consumed).
		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });

		expect(h.applyCallCount(),
			"second StepEnd: applyConfigUpdate called exactly once more (total 2 calls: 1 threw + 1 succeeded)",
		).toBe(2);
		expect(h.appliedUpdates.length,
			"second StepEnd: exactly one SUCCESSFUL apply recorded",
		).toBe(1);

		const applied = h.appliedUpdates[0]!;
		expect(applied.systemPrompt, "successful apply preserved original patch's systemPrompt").toBe("p");
		expect(applied.modelId, "successful apply used RE-MERGED modelId (last wins = 'Y' from mid-retry enqueue)").toBe("Y");

		expect(peekQueue(h.svc, h.sessionId).length,
			"second StepEnd: queue cleared after successful apply+confirm",
		).toBe(0);

		// Third StepEnd is a noop (queue empty).
		await h.registry.trigger("StepEnd", { sessionId: h.sessionId });
		expect(h.applyCallCount(), "third StepEnd: no further apply calls").toBe(2);
		expect(h.appliedUpdates.length, "third StepEnd: still 1 successful apply").toBe(1);
	});
});
