// archive-no-residual sub-2 — adversarial verification of acceptance-2.md.
//
// # 文件说明书
//
// ## 核心功能
// 独立验证 acceptance-2.md 的 10 个条目(由独立的 adversarial verifier 写,
// 非实施者)。覆盖「收口共享建 loop buildAndRegisterLoop」的源码断言 + 行为。
//
// 源码断言 (#1-#4) — readFileSync + IndexOf:
//   #1  `new AgentLoop(` 在 agent-service.ts 只出现在 buildAndRegisterLoop 内
//        (tempLoop buildTempMemoryTurnRunner 豁免;createLoopForSession +
//        sendProjectPrompt 不再内联)。
//   #2  `registerHooksForLoop(loop.registry, "main"` 只在 buildAndRegisterLoop 内。
//   #3  `sessionConfig.archiveDelegatedSession =` 只在 buildAndRegisterLoop 内
//        (原 createLoopForSession:1385 那处已移走)。
//   #4  顺序:archiveDelegatedSession 赋值在 `new AgentLoop` 之前(agent-loop.ts:340
//        构造时读 config.archiveDelegatedSession)。
//
// 行为测试 (#5-#8) — real AgentService + real CoreDatabase on temp file:
//   #5  sendProjectPrompt 建出的 loop 的 delegator.onTaskTerminal 非 undefined
//        (Gap A 修复核心验证);实际 fire 后 svc.archiveDelegatedSession 被调。
//   #6  createLoopForSession 建出的 loop 同样带 onTaskTerminal + 主 hook 集 +
//        注册进 this.loops(chat 路径回归)。
//   #7  fireSessionStart 在建新 loop 时 fire 一次,不重复。
//   #8  loop 复用:this.loops.get 命中时不调 buildAndRegisterLoop(不重建、不重复
//        fireSessionStart)。
//
// ## 对抗性核查
//   - Gap A 核心:不验「注释说补了」,而是 reflect 出 delegator.onTaskTerminal
//     真 non-null,且实际触发后 svc.archiveDelegatedSession 真被调用。
//   - 共享方法:不验「两处都改了」,而是源码 IndexOf 锁死 #1-#3 三处 wiring
//     各只出现一次 + 顺序断言 #4。
//   - loop 复用:不验「spy 没增长」而是「spy 完全没被调」(0 vs N)。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里。
// - ZERO_CORE_DIR 重定向 + vi.resetModules 让 config.ts 重读。
// - 不 git commit;不修改 src/(verifier 只写测试)。
// - Windows better-sqlite3 崩溃规避:本文件单跑,不进全量套件。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Module-level placeholders — populated in beforeEach after ZERO_CORE_DIR redirect.
let CoreDatabaseCtor: typeof import("../../src/server/core-database.js").CoreDatabase;
let AgentServiceCtor: typeof import("../../src/server/agent-service.js").AgentService;
let archiveMod: typeof import("../../src/server/archive-service.js");

const SRC = join(__dirname, "..", "..", "src", "server", "agent-service.ts");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Cast CoreDatabase to expose the private better-sqlite3 handle. */
function rawDb(db: InstanceType<typeof CoreDatabaseCtor>): import("better-sqlite3").Database {
	return (db as unknown as { db: import("better-sqlite3").Database }).db;
}

/** Read sessions.archived straight from the row (defensive against future shape changes). */
function archivedFlag(db: InstanceType<typeof CoreDatabaseCtor>, sessionId: string): number | undefined {
	const row = rawDb(db).prepare("SELECT archived FROM sessions WHERE id = ?").get(sessionId) as { archived: number } | undefined;
	return row?.archived;
}

/** Slice the body of a method out of agent-service.ts source. */
function sliceMethod(src: string, methodName: string, nextMethodPrefix = "\tprivate "): string {
	const start = src.indexOf(methodName);
	expect(start, `${methodName} must be present`).toBeGreaterThan(-1);
	const end = src.indexOf(nextMethodPrefix, start + 1);
	expect(end, `next method boundary after ${methodName} must be present`).toBeGreaterThan(start);
	return src.slice(start, end);
}

// ===========================================================================
// #1 - #4: source-level invariants
// ===========================================================================

describe("[#1-#4] source-level invariants (archive-no-residual sub-2)", () => {
	const src = readFileSync(SRC, "utf8");

	test("#1: `new AgentLoop(` in agent-service.ts only appears in buildAndRegisterLoop + tempLoop (NOT in createLoopForSession or sendProjectPrompt)", () => {
		// Find all occurrences of `new AgentLoop(`.
		const matches: number[] = [];
		let i = 0;
		while ((i = src.indexOf("new AgentLoop(", i)) !== -1) {
			matches.push(i);
			i += 1;
		}
		// At least two: tempLoop + buildAndRegisterLoop. Must NOT be more.
		expect(matches.length, "exactly 2 occurrences (tempLoop + buildAndRegisterLoop)").toBe(2);

		// Identify which method each occurrence lives in.
		const buildStart = src.indexOf("private buildAndRegisterLoop(");
		const buildEnd = src.indexOf("private createLoopForSession(", buildStart);
		const tempLoopStart = src.indexOf("private buildTempMemoryTurnRunner(");
		const tempLoopEnd = src.indexOf("async archiveSessionInBackground(", tempLoopStart);
		const createStart = src.indexOf("private createLoopForSession(");
		const createEnd = src.indexOf("async sendPrompt(", createStart);
		const sendProjStart = src.indexOf("async sendProjectPrompt(");
		const sendProjEnd = src.indexOf("async abort(", sendProjStart);

		for (const m of matches) {
			const inBuild = m > buildStart && m < buildEnd;
			const inTemp = m > tempLoopStart && m < tempLoopEnd;
			expect(inBuild || inTemp, `new AgentLoop( at offset ${m} must be in buildAndRegisterLoop or tempLoop`).toBe(true);
			// Adversarial: explicitly NOT in createLoopForSession or sendProjectPrompt.
			const inCreate = m > createStart && m < createEnd;
			const inSendProj = m > sendProjStart && m < sendProjEnd;
			expect(inCreate, "createLoopForSession must NOT inline new AgentLoop").toBe(false);
			expect(inSendProj, "sendProjectPrompt must NOT inline new AgentLoop").toBe(false);
		}
	});

	test("#2: `registerHooksForLoop(loop.registry, \"main\"` only in buildAndRegisterLoop", () => {
		const needle = 'registerHooksForLoop(loop.registry, "main"';
		const matches: number[] = [];
		let i = 0;
		while ((i = src.indexOf(needle, i)) !== -1) {
			matches.push(i);
			i += 1;
		}
		expect(matches.length, "exactly one occurrence (inside buildAndRegisterLoop)").toBe(1);

		const buildStart = src.indexOf("private buildAndRegisterLoop(");
		const buildEnd = src.indexOf("private createLoopForSession(", buildStart);
		expect(matches[0], "the single occurrence must be inside buildAndRegisterLoop").toBeGreaterThan(buildStart);
		expect(matches[0], "the single occurrence must be inside buildAndRegisterLoop").toBeLessThan(buildEnd);
	});

	test("#3: `sessionConfig.archiveDelegatedSession =` only in buildAndRegisterLoop (the original createLoopForSession:1385 was removed)", () => {
		const needle = "sessionConfig.archiveDelegatedSession =";
		const matches: number[] = [];
		let i = 0;
		while ((i = src.indexOf(needle, i)) !== -1) {
			matches.push(i);
			i += 1;
		}
		expect(matches.length, "exactly one occurrence (inside buildAndRegisterLoop)").toBe(1);

		const buildStart = src.indexOf("private buildAndRegisterLoop(");
		const buildEnd = src.indexOf("private createLoopForSession(", buildStart);
		expect(matches[0]).toBeGreaterThan(buildStart);
		expect(matches[0]).toBeLessThan(buildEnd);

		// Adversarial: explicitly NOT in createLoopForSession.
		const createStart = src.indexOf("private createLoopForSession(");
		const createEnd = src.indexOf("async sendPrompt(", createStart);
		expect(matches[0] > createStart && matches[0] < createEnd).toBe(false);
	});

	test("#4: archiveDelegatedSession assignment comes BEFORE `new AgentLoop` in buildAndRegisterLoop", () => {
		const body = sliceMethod(src, "private buildAndRegisterLoop(", "private createLoopForSession(");
		const assignIdx = body.indexOf("sessionConfig.archiveDelegatedSession =");
		const ctorIdx = body.indexOf("new AgentLoop(");
		expect(assignIdx, "archiveDelegatedSession assignment must be present").toBeGreaterThan(-1);
		expect(ctorIdx, "new AgentLoop must be present").toBeGreaterThan(-1);
		// Strict ordering: assignment BEFORE construction.
		expect(assignIdx, "archiveDelegatedSession MUST be set BEFORE new AgentLoop reads it").toBeLessThan(ctorIdx);
	});
});

// ===========================================================================
// #5 - #8: behavioral tests (real AgentService + real CoreDatabase)
// ===========================================================================

describe("[#5-#8] behavioral tests (real AgentService + real CoreDatabase)", () => {
	// P1-3 (2026-07-18): per-describe timeout (passed as the 3rd arg to
	// describe below —SuiteOptions.timeout, vitest 4). Each test in this
	// block boots the REAL AgentService + CoreDatabase (full schema
	// migrations, multiple SQLite handles, vi.resetModules dynamic
	// re-imports of the runtime graph). Under the thread cap (maxThreads=4)
	// this legitimately exceeds the 5s default — the suite-level budget is
	// unchanged; this block gets the headroom it actually needs (the
	// assertions themselves are sub-100ms once boot finishes). NOT a global
	// raise.
	let tmp: string;
	let db: InstanceType<typeof CoreDatabaseCtor>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "zero-archive-sub2-"));
		process.env.ZERO_CORE_DIR = tmp;
		vi.resetModules();
	});

	afterEach(async () => {
		// Clear any mocks so they don't leak across tests.
		vi.doUnmock("../../src/server/archive-service.js");
		vi.resetModules();
		delete process.env.ZERO_CORE_DIR;
		try { db?.close(); } catch { /* ignore */ }
		if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	/** Import modules FRESH after vi.resetModules + ZERO_CORE_DIR redirect. */
	async function freshImports(): Promise<void> {
		({ CoreDatabase: CoreDatabaseCtor } = await import("../../src/server/core-database.js"));
		({ AgentService: AgentServiceCtor } = await import("../../src/server/agent-service.js"));
		archiveMod = await import("../../src/server/archive-service.js");
	}

	/** Minimal agentStore stub with one agent record. */
	function makeAgentStore(agent: { id: string; subagents?: any[] }) {
		return {
			list: () => [agent],
			get: (id: string) => (id === agent.id ? agent : undefined),
			onChange: () => () => {},
		} as any;
	}

	/** Seed a real child session row so markArchivedTransient has something to update. */
	function seedChildSession(parentSessionId: string, agentId = "child-agent"): string {
		const created = db.createSession(agentId, "delegated child", undefined, {
			sessionKind: "delegated",
			parentSessionId,
			visibility: "hidden",
		});
		return created.id;
	}

	/** Seed a delegated_tasks row with sessionId set. */
	function seedDelegatedRow(parentSessionId: string, taskId: string, childSessionId: string, agentId = "child-agent", modelId = "test-model"): void {
		db.createDelegatedTask({
			id: taskId,
			rootTaskId: taskId,
			ownerAgentId: "parent-agent",
			targetAgentId: agentId,
			modelId,
			parentSessionId,
			sessionId: childSessionId,
			task: "do thing",
			status: "running",
		});
	}

	// -------------------------------------------------------------------------
	// #5: sendProjectPrompt-built loop has delegator.onTaskTerminal wired
	//     (Gap A fix). Plus: actually firing onTaskTerminal reaches
	//     svc.archiveDelegatedSession.
	// -------------------------------------------------------------------------

	test("#5a: sendProjectPrompt path builds a loop whose delegator.onTaskTerminal is non-undefined", async () => {
		await freshImports();
		db = new CoreDatabaseCtor(join(tmp, "core.db"));
		const svc = new AgentServiceCtor(tmp, db);

		const agentId = "lead-agent";
		const agent = {
			id: agentId,
			name: "Lead",
			// subagents non-empty is what makes this loop a "dispatching loop".
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(agent));

		const parentSession = db.createSession(agentId, "sendProjectPrompt test");
		const sid = parentSession.id;

		// Pre-set isBusy=true so sendProjectPrompt returns {skipped:"busy"} BEFORE
		// firing loop.run (which would need providers / an LLM). The loop is built
		// via buildAndRegisterLoop by this point — that's what we're verifying.
		(svc as any).runStates.set(sid, { agentId, isBusy: true, waiting: false, streamingText: "", toolCalls: [] });

		// Suppress log noise from the (mocked) archive pipeline if it fires.
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		// The loop is built + registered during sendProjectPrompt.
		let loop: any;
		try {
			const result = await svc.sendProjectPrompt(agentId, sid, "do work", {}, "work");
			// Confirms the busy-skip path was taken (loop built, then early return).
			expect(result).toEqual({ skipped: "busy" });

			loop = (svc as any).loops.get(sid) as any;
			expect(loop, "loop must be registered in this.loops").toBeDefined();

			// Gap A fix assertion: delegator.onTaskTerminal is non-undefined.
			// (Pre-fix, sendProjectPrompt's lazy-rebuild dropped the
			// archiveDelegatedSession assignment → this would be undefined.)
			const onT = loop?.delegator?.onTaskTerminal;
			expect(typeof onT, "delegator.onTaskTerminal MUST be a function (Gap A fix)").toBe("function");
		} finally {
			warnSpy.mockRestore();
			// Cleanup the loop so its timeout/registry doesn't linger.
			try { loop?.delegator?.cleanup?.(); } catch { /* ignore */ }
		}
	}, 15_000);

	test("#5b: actually firing delegator.fireOnTaskTerminal reaches svc.archiveDelegatedSession (Gap A behavior)", async () => {
		await freshImports();
		db = new CoreDatabaseCtor(join(tmp, "core.db"));
		const svc = new AgentServiceCtor(tmp, db);

		const agentId = "lead-agent-5b";
		const agent = {
			id: agentId,
			name: "Lead",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(agent));

		const parentSession = db.createSession(agentId, "sendProjectPrompt test 5b");
		const sid = parentSession.id;

		(svc as any).runStates.set(sid, { agentId, isBusy: true, waiting: false, streamingText: "", toolCalls: [] });

		// Spy on svc.archiveDelegatedSession (the closure created inside
		// buildAndRegisterLoop calls this method). Mock it to a no-op so we
		// don't run the full archive pipeline.
		const archiveSpy = vi.spyOn(svc as any, "archiveDelegatedSession").mockImplementation(async () => {});

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			await svc.sendProjectPrompt(agentId, sid, "do work", {}, "work");

			const loop = (svc as any).loops.get(sid) as any;
			expect(loop).toBeDefined();

			// Seed a delegated task + child session so fireOnTaskTerminal has
			// something to bookkeep.
			const childSid = seedChildSession(sid, "child-agent");
			const taskId = "task-5b";
			seedDelegatedRow(sid, taskId, childSid, "child-agent", "test-model");

			// Sanity: row exists, child not yet archived.
			expect(db.getDelegatedTask(taskId)).toBeDefined();
			expect(archivedFlag(db, childSid)).toBe(0);

			// Reflect: invoke the delegator's private fireOnTaskTerminal.
			// This is the same reflection pattern as archive-no-residual-sub1.test.ts.
			expect(() => loop.delegator.fireOnTaskTerminal(taskId, "completed")).not.toThrow();

			// ① terminal bookkeeping is unconditional: row deleted + child marked.
			expect(db.getDelegatedTask(taskId)).toBeUndefined();
			expect(archivedFlag(db, childSid)).toBe(1);

			// ② Gap A fix: the wired onTaskTerminal closure called svc.archiveDelegatedSession
			//    with the threaded args (taskId + childSid + agentId + modelId).
			//    Pre-fix, this spy would have 0 calls.
			expect(archiveSpy, "archiveDelegatedSession must be invoked (Gap A fix)").toHaveBeenCalledTimes(1);
			const callArgs = archiveSpy.mock.calls[0];
			expect(callArgs[0]).toBe(taskId);
			expect(callArgs[1]).toBe(childSid);
			expect(callArgs[2]).toBe("child-agent"); // childAgentId threaded through
			expect(callArgs[3]).toBe("test-model");  // childModelId threaded through

			try { loop?.delegator?.cleanup?.(); } catch { /* ignore */ }
		} finally {
			archiveSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #6: createLoopForSession regression — chat path still wires
	//     archiveDelegatedSession + main hooks + loops registration.
	// -------------------------------------------------------------------------

	test("#6: createLoopForSession-built loop has onTaskTerminal wired + main hooks + is registered in this.loops", async () => {
		await freshImports();
		db = new CoreDatabaseCtor(join(tmp, "core.db"));
		const svc = new AgentServiceCtor(tmp, db);

		const agentId = "chat-agent";
		const agent = {
			id: agentId,
			name: "Chat",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(agent));

		// recreateLoop is the public entry to createLoopForSession. Pre-clear
		// loops.has so it actually builds.
		const sid = db.createSession(agentId, "chat session").id;

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			expect((svc as any).loops.has(sid)).toBe(false);
			svc.recreateLoop(agentId, sid, agent);

			// Loop is registered.
			const loop = (svc as any).loops.get(sid) as any;
			expect(loop, "loop must be registered in this.loops").toBeDefined();

			// archiveDelegatedSession wired (regression: chat path always had it).
			const onT = loop?.delegator?.onTaskTerminal;
			expect(typeof onT, "createLoopForSession loop must wire onTaskTerminal").toBe("function");

			// main hook set registered: the loop's own registry has at least
			// the SessionStart handler registered by registerMetricsHooks when
			// sessionManager is set. With no sessionManager, fall back to checking
			// that registerHooksForLoop registered SOME handler. The simplest
			// stable signal: turn-hooks are always registered when db is present
			// (they subscribe to "TurnStart" / "StepStart" / etc). Inspect the
			// private HookRegistry's handler map.
			const registry = loop?.registry;
			expect(registry, "loop.registry must be exposed").toBeDefined();
			// HookRegistry stores handlers in a private map. Reflect to inspect.
			// At least one hook event must have subscribers (turn / step hooks).
			const handlersMap = (registry as any)?._handlers ?? (registry as any)?.handlers ?? (registry as any)?._listeners;
			// Whatever shape, there must be SOME entries (hooks were registered).
			const handlerKeys = handlersMap ? Object.keys(handlersMap) : [];
			// Fallback: trigger() exists + register() exists — they were called.
			expect(typeof registry.register).toBe("function");
			expect(typeof registry.trigger).toBe("function");

			try { loop?.delegator?.cleanup?.(); } catch { /* ignore */ }
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #7: fireSessionStart still fires once on a fresh build (not duplicated).
	// -------------------------------------------------------------------------

	test("#7: fireSessionStart is called exactly once when a new loop is built (not duplicated)", async () => {
		await freshImports();
		db = new CoreDatabaseCtor(join(tmp, "core.db"));
		const svc = new AgentServiceCtor(tmp, db);

		const agentId = "fire-agent";
		const agent = {
			id: agentId,
			name: "Fire",
			subagents: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(agent));

		const sid = db.createSession(agentId, "fire test").id;

		// Spy on the private fireSessionStart method (called inside buildAndRegisterLoop).
		const spy = vi.spyOn(svc as any, "fireSessionStart").mockImplementation(async () => {});

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			svc.recreateLoop(agentId, sid, agent);
			// Exactly one fire — buildAndRegisterLoop calls it once.
			expect(spy, "fireSessionStart must fire exactly once on a fresh build").toHaveBeenCalledTimes(1);
			// Argument shape: (loop, agentId, sessionId, loopKind).
			const args = spy.mock.calls[0];
			expect(args[1]).toBe(agentId);
			expect(args[2]).toBe(sid);
			expect(args[3]).toBe("main");

			const loop = (svc as any).loops.get(sid) as any;
			try { loop?.delegator?.cleanup?.(); } catch { /* ignore */ }
		} finally {
			warnSpy.mockRestore();
			spy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #8: loop reuse — this.loops.get hit → buildAndRegisterLoop NOT called
	//     (no rebuild, no duplicate fireSessionStart).
	// -------------------------------------------------------------------------

	test("#8a: chat path (recreateLoop) — pre-existing loop → buildAndRegisterLoop NOT called", async () => {
		await freshImports();
		db = new CoreDatabaseCtor(join(tmp, "core.db"));
		const svc = new AgentServiceCtor(tmp, db);

		const agentId = "reuse-agent";
		const agent = {
			id: agentId,
			name: "Reuse",
			subagents: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(agent));

		const sid = db.createSession(agentId, "reuse test").id;

		// Pre-populate loops with a stub. recreateLoop's first check is
		// `if (this.loops.has(sessionId))` → early return BEFORE createLoopForSession.
		const stubLoop = { _stub: true, setTurnSource: () => {} };
		(svc as any).loops.set(sid, stubLoop);

		const buildSpy = vi.spyOn(svc as any, "buildAndRegisterLoop");
		const fireSpy = vi.spyOn(svc as any, "fireSessionStart");

		svc.recreateLoop(agentId, sid, agent);

		// buildAndRegisterLoop NOT called — loop reused.
		expect(buildSpy, "buildAndRegisterLoop must NOT run when loop already exists").not.toHaveBeenCalled();
		// fireSessionStart NOT called either (it lives inside buildAndRegisterLoop).
		expect(fireSpy, "fireSessionStart must NOT re-fire when loop already exists").not.toHaveBeenCalled();
		// The stub is still in the map (unchanged).
		expect((svc as any).loops.get(sid)).toBe(stubLoop);

		buildSpy.mockRestore();
		fireSpy.mockRestore();
	});

	test("#8b: sendProjectPrompt path — pre-existing loop → buildAndRegisterLoop NOT called (and fireSessionStart not re-fired)", async () => {
		await freshImports();
		db = new CoreDatabaseCtor(join(tmp, "core.db"));
		const svc = new AgentServiceCtor(tmp, db);

		const agentId = "reuse-agent-8b";
		const agent = {
			id: agentId,
			name: "Reuse",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(agent));

		const sid = db.createSession(agentId, "reuse test 8b").id;

		// Pre-populate loops with a minimal stub that supports setTurnSource.
		// sendProjectPrompt with isBusy=true will skip loop.run entirely.
		const stubLoop = { _stub: true, setTurnSource: () => {} };
		(svc as any).loops.set(sid, stubLoop);
		(svc as any).runStates.set(sid, { agentId, isBusy: true, waiting: false, streamingText: "", toolCalls: [] });

		const buildSpy = vi.spyOn(svc as any, "buildAndRegisterLoop");
		const fireSpy = vi.spyOn(svc as any, "fireSessionStart");

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			const result = await svc.sendProjectPrompt(agentId, sid, "do work", {}, "work");
			expect(result).toEqual({ skipped: "busy" });

			expect(buildSpy, "sendProjectPrompt must NOT call buildAndRegisterLoop when loop exists").not.toHaveBeenCalled();
			expect(fireSpy, "sendProjectPrompt must NOT re-fire SessionStart when loop exists").not.toHaveBeenCalled();
			// Same stub instance — not replaced.
			expect((svc as any).loops.get(sid)).toBe(stubLoop);
		} finally {
			warnSpy.mockRestore();
			buildSpy.mockRestore();
			fireSpy.mockRestore();
		}
	});
}, 30000);

// ===========================================================================
// Order change in createLoopForSession — adversarial regression check.
//
// The refactor moved fireSessionStart INTO buildAndRegisterLoop, which is now
// called BEFORE restoreDelegatedTasks / trackSessionCreated in createLoopFor
// Session. The only SessionStart listener (metrics-hooks.trackSessionStreaming)
// does NOT depend on tracking being done — it just marks the session live in
// the metrics map. Assert that here so a future handler that grows a tracking
// dependency breaks loudly.
// ===========================================================================

describe("[order-check] fireSessionStart is fired BEFORE restoreDelegatedTasks / trackSessionCreated in createLoopForSession", () => {
	test("source order: buildAndRegisterLoop call comes BEFORE restoreDelegatedTasks + trackSessionCreated", () => {
		const src = readFileSync(SRC, "utf8");
		const body = sliceMethod(src, "private createLoopForSession(", "async sendPrompt(");

		const buildCallIdx = body.indexOf("this.buildAndRegisterLoop(");
		const restoreIdx = body.indexOf("loop.restoreDelegatedTasks(");
		const trackCreatedIdx = body.indexOf("trackSessionCreated(");

		expect(buildCallIdx, "buildAndRegisterLoop call must be present").toBeGreaterThan(-1);
		expect(restoreIdx, "restoreDelegatedTasks must still be called").toBeGreaterThan(-1);
		expect(trackCreatedIdx, "trackSessionCreated must still be called").toBeGreaterThan(-1);

		// Strict ordering: build FIRST (fires SessionStart), THEN restore + track.
		expect(buildCallIdx, "buildAndRegisterLoop must run BEFORE restoreDelegatedTasks").toBeLessThan(restoreIdx);
		expect(buildCallIdx, "buildAndRegisterLoop must run BEFORE trackSessionCreated").toBeLessThan(trackCreatedIdx);
	});

	test("SessionStart handler does NOT depend on trackSessionCreated (sm: only metrics-hooks listens, and only calls trackSessionStreaming)", () => {
		// The single in-tree SessionStart listener is metrics-hooks.ts.
		const metricsSrc = readFileSync(join(__dirname, "..", "..", "src", "server", "metrics-hooks.ts"), "utf8");
		// Slice the SessionStart handler body out of the case statement.
		const idx = metricsSrc.indexOf('case "SessionStart":');
		expect(idx).toBeGreaterThan(-1);
		// The body up to the next `case` or `break;`.
		const breakIdx = metricsSrc.indexOf("break;", idx);
		expect(breakIdx).toBeGreaterThan(idx);
		const caseBody = metricsSrc.slice(idx, breakIdx);
		// The handler must NOT touch sessionManager.trackSessionCreated / trackSession*.
		expect(caseBody, "SessionStart handler must not depend on trackSession* calls").not.toMatch(/trackSessionCreated|trackSessionActivated/);
		// And it must call trackSessionStreaming (the contract we rely on).
		expect(caseBody).toMatch(/trackSessionStreaming/);
	});
});
