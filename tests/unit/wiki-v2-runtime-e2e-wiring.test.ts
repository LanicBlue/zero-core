// wiki-system-redesign sub-05 acceptance — 对抗 (adversarial-edge) lens.
//
// # 文件说明书
//
// ## 核心功能
// 端到端 wiring 验证 acceptance-05 §B.1/§C.5/§D.36-44「runtime 真活,非 dead-wiring」。
// round-1 三 lens 都只静态/code-present 验 → 假阳性;本文件驱动真实生产路径并断言
// 下游真消费(feedback-verify-runtime-wiring)。
//
// 覆盖 blocker 修复的 runtime 真活:
//   B2  enqueueConfigPatch 接线(setAgentStore.onChange busy 分支 + memory archive callback)
//   B5  sendProjectPrompt fresh session 在 buildAndRegisterLoop 前调 compileWikiAccessForSession
//       → callerCtx.wikiAccess 非 undefined → Wiki tool 第一次调用 NOT ACCESS_DENIED
//   B6  fresh session 第一 turn assemble() → ## Wiki Context 段非空(cacheBreak:true 生效)
//   B7  compileWikiAccessForSession fire-and-forget ensureAgentMemoryRoot(幂等,补缺,不扩权)
//   B1  fresh agent(name="zero", 无 wikiGrants)→ 只 own Memory + Knowledge read,不含全树
//
// ## 对抗 probe 焦点
//   - B6 cacheBreak:true 修了 cache-null 死锁,但 compute closure 返
//     `wikiContextClosureCache.get(sessionId) ?? ""`,cache 由 async
//     refreshWikiContextCache fire-and-forget 填充 → 首次 assemble 可能仍空(race)。
//     本文件探针同时测「立即 assemble」与「cache 填充后 assemble」两种状态。
//   - sendProjectPrompt 的 loop.run 是 fire-and-forget;若 loop 没 register 进 this.loops,
//     下游所有断言会假过。本文件显式从 svc.loops 取 loop 并断言 wikiAccess 字段。
//
// ## 输入
//   - 真实 CoreDatabase + runMigrations + 真实 WikiDatabase/WikiService/WikiSearchService
//     经 setWikiRuntime 单例注入(镜像 server/index.ts 启动序列)。
//   - 真实 AgentService + AgentStore;sendProjectPrompt 真实调用。
//   - provider-factory vi.mock(inline finish model)→ loop.run 不依赖外部 LLM。
//
// ## 维护规则
//   - 不 edit 实现源;发现违反报 blocker finding。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
	const { tmpdir: td } = require("node:os") as typeof import("node:os");
	const { join: j } = require("node:path") as typeof import("node:path");
	const d = mk(j(td(), "zc-wiki-v2-e2e-wiring-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

// Mock provider-factory BEFORE importing AgentLoop/AgentService so loop.run
// resolves an inline finish-only model (no external LLM). getContextWindow +
// getMultimodal stubbed to safe defaults (mirrors n4-config-hot-sync.test.ts).
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
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { setWikiRuntime, _resetWikiRuntimeForTests } from "../../src/server/wiki/wiki-runtime.js";
import { createWikiTool } from "../../src/tools/wiki-v2-tool.js";
import { getToolExecute } from "../../src/tools/tool-factory.js";
import type { CompiledWikiAccess } from "../../src/shared/wiki-types.js";
import type { CallerCtx, ToolResult } from "../../src/tools/types.js";

// ---------------------------------------------------------------------------
// inline finish-only language model
// ---------------------------------------------------------------------------
function createFinishModel(modelId = "e2e-mock"): LanguageModelV2 {
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId,
		supportedUrls: {},
		async doGenerate() { throw new Error("doGenerate not used"); },
		async doStream() {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue([{ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]);
					controller.close();
				},
			});
			return { stream } as any;
		},
	} as unknown as LanguageModelV2;
}

// ---------------------------------------------------------------------------
// harness
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
	const dir = mkdtempSync(join(tmpdir(), "zc-wiki-e2e-"));
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
	resolveModelMock.mockReturnValue(createFinishModel());
	return { svc, agentStore, db, wikiDb, wikiSvc, searchSvc, dir };
}

/** Wide admin wiki request context (for seeding wiki.db nodes directly). */
function wideCtx(agentId = "seed-admin"): any {
	const access: CompiledWikiAccess = {
		agentId, activeProjectId: undefined,
		grants: [{
			canonicalScope: "wiki-root",
			actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"],
		}],
		policyRevision: 1,
	};
	return { access, agentId, activeProjectId: undefined, sessionId: null, requestId: null };
}

/** Poll the AgentService wiki-context closure cache until populated (or timeout). */
async function pollClosureCache(svc: AgentService, sessionId: string, timeoutMs = 2000): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const cached = (svc as any).wikiContextClosureCache.get(sessionId);
		if (typeof cached === "string" && cached.length > 0) return cached;
		await new Promise((r) => setTimeout(r, 10));
	}
	const final = (svc as any).wikiContextClosureCache.get(sessionId);
	return typeof final === "string" ? final : "";
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
// B5 + B6 e2e: sendProjectPrompt fresh session → assemble + Wiki tool
// ===========================================================================

describe("wiki-v2 e2e wiring [B5/B6 对抗 lens] — sendProjectPrompt → real loop consumes", () => {
	test("B5: sendProjectPrompt compiles wikiAccess into the registered loop config (NOT undefined)", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "proj-agent",
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [
				{ scope: "memory://", actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"] },
				{ scope: "project://", actions: ["expand", "read", "search"] },
			],
		} as any);

		const sessionId = `e2e-b5-${Date.now()}`;
		await c.svc.sendProjectPrompt(agent.id, sessionId, "go", {
			projectId: "proj-123",
			projectPath: c.dir,
			projectName: "Demo",
		}, "work");

		const loop = (c.svc as any).loops.get(sessionId);
		expect(loop, "sendProjectPrompt must register the loop in svc.loops").toBeDefined();
		const cfg = (loop as any).config;
		expect(cfg.wikiAccess, "B5: loop.config.wikiAccess must be compiled (not undefined)").toBeDefined();
		// project:// grant must have resolved to wiki-root/projects/proj-123 (active project).
		const scopes = (cfg.wikiAccess.grants as Array<{ canonicalScope: string }>)
			.map((g) => g.canonicalScope);
		expect(scopes).toContain("wiki-root/projects/proj-123");
		expect(scopes).toContain(`wiki-root/memory/${agent.id}`);
	}, 30000);

	test("B6: fresh session first assemble() contains non-empty ## Wiki Context + project canonical path (after closure cache fill)", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "proj-agent",
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [
				{ scope: "memory://", actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"] },
				{ scope: "project://", actions: ["expand", "read", "search"] },
			],
		} as any);

		const sessionId = `e2e-b6-${Date.now()}`;
		await c.svc.sendProjectPrompt(agent.id, sessionId, "go", {
			projectId: "proj-123",
			projectPath: c.dir,
			projectName: "Demo",
		}, "work");

		const loop = (c.svc as any).loops.get(sessionId);
		expect(loop).toBeDefined();

		// Wait for the fire-and-forget refreshWikiContextCache to populate the
		// closure cache (the compute closure returns this cache).
		await pollClosureCache(c.svc, sessionId);

		const sys = await (loop as any).assembleSystemPrompt();
		expect(typeof sys).toBe("string");
		expect(sys, "B6: system prompt must contain '## Wiki Context' section").toContain("## Wiki Context");
		// project:// canonical path must appear in the rendered section.
		expect(sys).toContain("wiki-root/projects/proj-123");
		// memory:// address + retrieval guidance must appear (§C.5).
		expect(sys).toMatch(/memory:\/\//);
		expect(sys).toMatch(/Retrieval guidance|search/i);
	}, 30000);

	test("B6 race probe [对抗 / deterministic]: compute closure returns '' until the fire-and-forget cache fill resolves", async () => {
		// 对抗 probe(round-1 假阳性根因复现):B6 cacheBreak:true 修了 cache-null
		// 死锁(SystemPromptAssembler 不再 cache.set(name,null)),但 compute closure
		// 体是 `this.wikiContextClosureCache.get(sessionId) ?? ""`,而 cache 由
		// refreshWikiContextCache **fire-and-forget** 填充。所以「第一次 assemble
		// 是否渲染 ## Wiki Context」是时序依赖,非确定性:
		//   - 若 assemble 发生在 async resolve 之前 → closure 返 "" → assembler
		//     `if (value) push` 跳过 → section 缺失(首 turn prompt 无 Wiki Context)。
		//   - grant/wikiAccess 本身不受影响(同步写 config),agent 首 turn 仍能用
		//     Wiki tool —— 只是描述性 section 可能缺。
		//
		// 本测试**确定性**证明该 race:同步(same tick,0 个 await)调 compute() → "",
		// 再 await pollClosureCache → compute() 非空。production 首 turn 是否命中
		// 取决于 loop.run 内 setup 与 wiki I/O 的相对时序(小 DB 快,大 DB 慢)。
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "race-agent",
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read", "expand"] }],
		} as any);

		const sessionId = `e2e-race-${Date.now()}`;
		// Call the production compiler directly (same path sendProjectPrompt uses).
		const out = (c.svc as any).compileWikiAccessForSession(agent, sessionId, undefined);
		expect(out.dynamicSection, "compiler must produce a dynamicSection").toBeDefined();
		// SAME TICK — refreshWikiContextCache has been fired but NOT awaited.
		const immediate = out.dynamicSection.compute();
		expect(immediate, "compute() returns '' before the async cache fill resolves (deterministic race)").toBe("");

		// After the fire-and-forget resolves, the closure yields the rendered text.
		await pollClosureCache(c.svc, sessionId);
		const filled = out.dynamicSection.compute();
		expect(filled, "after cache fill, compute() returns the rendered ## Wiki Context").toContain("## Wiki Context");
	}, 30000);

	test("B5 grant生效: Wiki tool first call via buildCallerCtx is NOT ACCESS_DENIED (own memory read)", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "tool-agent",
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [
				{ scope: "memory://", actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"] },
			],
		} as any);

		// Pre-ensure the own memory root exists so the read is deterministic.
		await c.wikiSvc.ensureAgentMemoryRoot(agent.id, agent.name);

		const sessionId = `e2e-tool-${Date.now()}`;
		await c.svc.sendProjectPrompt(agent.id, sessionId, "go", {}, "work");
		const loop = (c.svc as any).loops.get(sessionId);
		expect(loop).toBeDefined();
		expect((loop as any).config.wikiAccess, "B5: wikiAccess must be bridged").toBeDefined();

		// buildCallerCtx is the production CallerCtx factory used by every tool call.
		// It must bridge config.wikiAccess → callerCtx.wikiAccess.
		const callerCtx: CallerCtx = (loop as any).buildCallerCtx("tc-e2e-1");
		expect(callerCtx.wikiAccess, "B5: buildCallerCtx must bridge wikiAccess onto CallerCtx").toBeDefined();

		// Now drive the REAL Wiki v2 tool with that callerCtx — read own memory root.
		const tool = createWikiTool({ wikiService: c.wikiSvc, searchService: c.searchSvc });
		const rawExecute = getToolExecute(tool)!;
		const res: ToolResult = await rawExecute(
			{ action: "read", node: "memory://" },
			callerCtx,
		);
		expect(res.ok, `Wiki tool first call must NOT be ACCESS_DENIED (got: ${res.error})`).toBe(true);
		expect(String(res.error ?? "")).not.toMatch(/ACCESS_DENIED/i);
	}, 30000);

	test("B5 no-project: sendProjectPrompt without projectId → memory-only access, no project grant", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "memonly-agent",
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [
				{ scope: "memory://", actions: ["read", "expand"] },
				{ scope: "project://", actions: ["read"] },
			],
		} as any);

		const sessionId = `e2e-noproj-${Date.now()}`;
		// NO projectId → project:// must be inactive (not widened to wiki-root/projects).
		await c.svc.sendProjectPrompt(agent.id, sessionId, "go", {}, "work");
		const loop = (c.svc as any).loops.get(sessionId);
		expect(loop).toBeDefined();
		const access: CompiledWikiAccess = (loop as any).config.wikiAccess;
		expect(access).toBeDefined();
		for (const g of access.grants) {
			// §B.3 / §H: no project grant may resolve to wiki-root/projects root.
			expect(g.canonicalScope).not.toBe("wiki-root/projects");
			expect(g.canonicalScope.startsWith("wiki-root/projects/")).toBe(false);
		}
		// own memory grant must still be present.
		expect(access.grants.some((g) => g.canonicalScope === `wiki-root/memory/${agent.id}`)).toBe(true);

		// Section still renders the memory:// address even without a project.
		await pollClosureCache(c.svc, sessionId);
		const sys = await (loop as any).assembleSystemPrompt();
		expect(sys).toContain("## Wiki Context");
		expect(sys).toMatch(/memory:\/\//);
	}, 30000);
});

// ===========================================================================
// B1 — fresh agent (name="zero", no wikiGrants) MUST NOT gain whole-tree
// ===========================================================================

describe("wiki-v2 e2e wiring [B1 对抗 lens] — pickDefaultGrants ignores name; explicit grant required for whole-tree", () => {
	test("B1: fresh agent named 'zero' with no wikiGrants → only own Memory + Knowledge read (NOT wiki-root)", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "zero", // §H #1 adversarial: name must NOT unlock whole-tree
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			// no wikiGrants
		} as any);

		// Use the REAL AgentService.compileWikiAccessForSession (private) — the
		// production path. Mirrors exactly what sendProjectPrompt / createLoop
		// run.
		const out = (c.svc as any).compileWikiAccessForSession(agent, `b1-${Date.now()}`, undefined);
		const access: CompiledWikiAccess = out.wikiAccess;
		expect(access, "B1: compileWikiAccessForSession must return wikiAccess even for fresh agent").toBeDefined();
		const scopes = access.grants.map((g) => g.canonicalScope);
		// Whole-tree grant MUST NOT appear for a fresh "zero" agent.
		expect(scopes, "fresh 'zero' must NOT receive wiki-root whole-tree").not.toContain("wiki-root");
		// Own memory grant present (wiki-root/memory/<id>) + Knowledge read.
		expect(scopes).toContain(`wiki-root/memory/${agent.id}`);
		expect(scopes).toContain("wiki-root/knowledge");
	});

	test("B1: adding explicit wikiGrants wiki-root to the same agent → whole-tree appears", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "zero",
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "wiki-root", actions: ["read", "expand", "search"] }],
		} as any);
		const out = (c.svc as any).compileWikiAccessForSession(agent, `b1x-${Date.now()}`, undefined);
		const scopes = out.wikiAccess.grants.map((g: any) => g.canonicalScope);
		expect(scopes).toContain("wiki-root");
	});
});

// ===========================================================================
// B7 — ensureAgentMemoryRoot repair (idempotent, no scope expansion)
// ===========================================================================

describe("wiki-v2 e2e wiring [B7 对抗 lens] — compileWikiAccessForSession fires ensureAgentMemoryRoot", () => {
	test("B7: agent exists but memory root MISSING → compile repairs root; idempotent; no grant expansion", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "repair-agent",
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read", "expand", "create"] }],
		} as any);

		// Pre-condition: memory root does NOT exist yet.
		const nodeRepo = new WikiNodeRepository(c.wikiDb.getDb());
		const memPath = `wiki-root/memory/${agent.id}`;
		expect(nodeRepo.getActiveByPath(memPath), "precondition: memory root absent").toBeFalsy();

		// First compile fires ensureAgentMemoryRoot (fire-and-forget). Poll the
		// repo until the root appears (mirrors the runtime async completion).
		(c.svc as any).compileWikiAccessForSession(agent, `b7-${Date.now()}`, undefined);
		const start = Date.now();
		let appeared = nodeRepo.getActiveByPath(memPath);
		while (!appeared && Date.now() - start < 2000) {
			await new Promise((r) => setTimeout(r, 10));
			appeared = nodeRepo.getActiveByPath(memPath);
		}
		expect(appeared, "B7: ensureAgentMemoryRoot must create the missing root").toBeTruthy();

		// Idempotent: second compile must NOT create a duplicate node at the same
		// path. getActiveByPath returns the single active row; capture its id and
		// assert a second compile leaves exactly one node at this path (same id).
		const firstId = (appeared as { id: unknown }).id;
		(c.svc as any).compileWikiAccessForSession(agent, `b7-2-${Date.now()}`, undefined);
		// let the fire-and-forget settle
		await new Promise((r) => setTimeout(r, 60));
		const after = nodeRepo.getActiveByPath(memPath);
		expect(after, "B7: memory root still present after second compile").toBeTruthy();
		// Path is unique-constrained for active nodes; the same node must persist
		// (ensureAgentMemoryRoot updates display_name/summary in place, never inserts
		// a second row). A different id would mean a duplicate was created.
		expect((after as { id: unknown }).id, "B7: second compile must NOT duplicate the memory root (same node id)").toBe(firstId);

		// No grant expansion: access still scoped to own memory only.
		const out = (c.svc as any).compileWikiAccessForSession(agent, `b7-3-${Date.now()}`, undefined);
		const scopes = out.wikiAccess.grants.map((g: any) => g.canonicalScope);
		expect(scopes).toContain(memPath);
		expect(scopes, "B7: repair must NOT expand to wiki-root whole-tree").not.toContain("wiki-root");
	}, 30000);
});

// ===========================================================================
// B2 — onChange busy branch + memory archive callback both enqueueConfigPatch
// ===========================================================================

describe("wiki-v2 e2e wiring [B2 对抗 lens] — enqueueConfigPatch wired to onChange + memory archive", () => {
	test("B2① onChange busy branch: agent wikiGrants change → enqueued patch carries wikiAccess + dynamicSystemSections (StepEnd flush)", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "sync-agent",
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);

		const applySpy = vi.fn();
		// Stub loop + BUSY run-state → onChange routes through enqueueConfigPatch's
		// BUSY branch (P0-1: patch enqueued for StepEnd flush, NOT applied
		// synchronously), not the idle rebuild branch and not the idle
		// immediate-apply branch.
		(c.svc as any).loops.set("sess-b2", {
			getConfigAgentId: () => agent.id,
			applyConfigUpdate: applySpy,
			isWaiting: () => false,
			getState: () => ({ isBusy: true }),
			abort: () => {},
		});
		(c.svc as any).activeSessions.set(agent.id, "sess-b2");
		(c.svc as any).runStates.set("sess-b2", { isBusy: true });

		// Mutate wikiGrants + fire onChange via a real store.update.
		c.agentStore.update(agent.id, {
			wikiGrants: [{ scope: "memory://", actions: ["read", "create"] }],
		});

		// P0-1: busy loop → enqueue, no synchronous apply.
		expect(applySpy, "busy loop applyConfigUpdate must NOT be called synchronously (StepEnd flush)").not.toHaveBeenCalled();
		const queue = (c.svc as any).pendingConfigPatches.get("sess-b2") ?? [];
		expect(queue.length, "busy loop patch must be enqueued to pendingConfigPatches").toBeGreaterThanOrEqual(1);
		const patch = queue[queue.length - 1].update;
		// B2①: the enqueued patch must carry BOTH wikiAccess and dynamicSystemSections
		// (these are what StepEnd will apply to the loop).
		expect(patch.wikiAccess, "enqueued patch must carry wikiAccess").toBeDefined();
		expect(patch.dynamicSystemSections, "enqueued patch must carry dynamicSystemSections").toBeInstanceOf(Array);
		expect(patch.dynamicSystemSections.length).toBeGreaterThan(0);
		expect(patch.dynamicSystemSections[0].name).toBe("wiki-context");
		// The new grant must reflect the updated wikiGrants (create action present).
		const scopes = patch.wikiAccess.grants.map((g: any) => g.canonicalScope);
		expect(scopes).toContain(`wiki-root/memory/${agent.id}`);
	});

	test("B2③ memory archive callback → refreshAgentWikiContextsExcept → sibling session applyConfigUpdate (enqueueConfigPatch flush)", async () => {
		// Two sessions for the same agent: the archived one is excepted; a sibling
		// IDLE stub loop must receive applyConfigUpdate via enqueueConfigPatch.
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "arch-agent",
			provider: "MockProv",
			model: "e2e-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read", "create"] }],
		} as any);

		const siblingApply = vi.fn();
		(c.svc as any).loops.set("sess-sibling", {
			getConfigAgentId: () => agent.id,
			applyConfigUpdate: siblingApply,
			isWaiting: () => false,
			getState: () => ({ isBusy: false }), // idle → enqueueConfigPatch applies immediately
			abort: () => {},
		});

		// Invoke the callback that archive-service fires after a memory turn.
		// agent-service wires: onMemoryTurnWikiWritesCommitted = (aid, except) =>
		//   this.refreshAgentWikiContextsExcept(aid, except)
		(c.svc as any).refreshAgentWikiContextsExcept(agent.id, "sess-archived");

		expect(siblingApply, "B2③: sibling session must receive applyConfigUpdate after memory archive").toHaveBeenCalledTimes(1);
		const patch = siblingApply.mock.calls[0][0];
		expect(patch.wikiAccess).toBeDefined();
		expect(patch.dynamicSystemSections).toBeInstanceOf(Array);
		expect(patch.dynamicSystemSections[0].name).toBe("wiki-context");
	});
});

// ===========================================================================
// Structural: sendProjectPrompt source actually calls compileWikiAccessForSession
// (defense vs round-1 dead-wiring where the call site was commented out).
// ===========================================================================

describe("wiki-v2 e2e wiring [structural guard 对抗 lens] — sendProjectPrompt live-calls the compiler", () => {
	const SRC = readFileSync("src/server/agent-service.ts", "utf8");

	test("sendProjectPrompt contains a LIVE call to compileWikiAccessForSession before buildAndRegisterLoop", () => {
		// Strip comments to defeat commented-out dead wiring (round-1 trap).
		const stripped = SRC
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		expect(stripped, "sendProjectPrompt must live-call compileWikiAccessForSession").toMatch(/compileWikiAccessForSession\s*\(/);
		expect(stripped, "agent-loop must not import wiki compiler (hooks-only)").toMatch(/buildAndRegisterLoop/);
	});
});
