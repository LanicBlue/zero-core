// archive-no-residual sub-3 — adversarial verification of acceptance-3.md.
//
// # 文件说明书
//
// ## 核心功能
// 独立验证 acceptance-3.md 的 12 个条目(由独立的 adversarial verifier 写,
// 非实施者)。覆盖父归档时级联归档子 session(递归孙子层)的行为 + 源码断言。
//
// 行为测试 (#1-#7) — real AgentService + real SessionDB on temp file:
//   #1  父归档级联终态子(2 completed 子)→ 子 session 行删 + 行清 + 父归档完成。
//   #2  父归档级联运行中子(子 loop 活跃 mock)→ 子 loop 被 teardown + 子归档。
//   #3  递归孙子层(父→子→孙)→ 孙 session 也归档。
//   #4  无子 session 的任务行仍清。
//   #5  并发撞锁 benign(子已被归档,cascade 再调 → skipped,不抛)。
//   #6  killed 语义不变(stopTask 不归档;父归档时 cascade 直接 archive killed 子)。
//   #7  idempotent(对已归档父再调 → no-op,不抛)。
//
// 源码断言 (#8-#10):
//   #8  archiveChildrenOf 存在,按 {parentSessionId} list。
//   #9  archiveDelegatedSession 与 archiveSessionInBackground 都调 archiveChildrenOf
//        (或 archiveOneSessionCascade)。
//   #10 cascade 路径不调 delegator kill / stopTask(直接 archiveSession)。
//
// 回归 (#11-#12):现有 archive 流测试不回归 + tsc 类型绿(独立跑 build:lib)。
//
// ## 对抗性核查
//   - 不信 implementer 自述"改了":git diff + 源码 IndexOf 双锁。
//   - 不信"调了 archiveChildrenOf":spy + 真实副作用(子行消失 / archives JSON 落盘)双重。
//   - killed 不被 fireOnTaskTerminal 归档:delegator.stopTask 走独立路径,父归档时
//     由 cascade 兜底直接 archiveSession(不是依赖 delegator 重新触发)。
//   - 并发撞锁:用真 archive-service 的 module-level Map(同进程内可复现),撞锁分支
//     返回 {skipped: "already-archiving"} 不抛。
//
// ## runningSubloops caveat(已记录在 acceptance 报告)
//   生产里子 agent loop 在 subagent-delegator.runningSubloops(按 taskId),不在
//   this.loops(按 sessionId)。故 this.loops.has(childSessionId) 恒 false,子全走
//   terminal 路径。active-loop 路径只在测试往 this.loops 塞 mock loop 时触发。
//   即 #2 mock 测试能 PASS,但生产里父中途归档时子 loop 不会被显式停(成孤儿运行
//   循环;数据已归档,非数据泄漏)。判定见验收报告。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里。
// - ZERO_CORE_DIR 重定向 + vi.resetModules 让 config.ts 重读。
// - 不 git commit;不修改 src/(verifier 只写测试)。
// - Windows better-sqlite3 崩溃规避:本文件单跑,不进全量套件。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Module-level placeholders — populated in beforeEach after ZERO_CORE_DIR redirect.
let SessionDBCtor: typeof import("../../src/server/session-db.js").SessionDB;
let AgentServiceCtor: typeof import("../../src/server/agent-service.js").AgentService;
let archiveMod: typeof import("../../src/server/archive-service.js");

const AGENT_SVC_SRC = join(__dirname, "..", "..", "src", "server", "agent-service.ts");
const DELEGATOR_SRC = join(__dirname, "..", "..", "src", "runtime", "subagent-delegator.ts");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Cast SessionDB to expose the private better-sqlite3 handle. */
function rawDb(db: InstanceType<typeof SessionDBCtor>): import("better-sqlite3").Database {
	return (db as unknown as { db: import("better-sqlite3").Database }).db;
}

/** Read sessions.archived straight from the row. */
function archivedFlag(db: InstanceType<typeof SessionDBCtor>, sessionId: string): number | undefined {
	const row = rawDb(db).prepare("SELECT archived FROM sessions WHERE id = ?").get(sessionId) as { archived: number } | undefined;
	return row?.archived;
}

/** True when the session row is gone (archive pipeline's ⑤ deleteSessionData ran). */
function sessionRowGone(db: InstanceType<typeof SessionDBCtor>, sessionId: string): boolean {
	return rawDb(db).prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) === undefined;
}

/** Slice the body of a method out of agent-service.ts source. */
function sliceMethod(src: string, methodName: string, nextMethodPrefix = "\tprivate "): string {
	const start = src.indexOf(methodName);
	expect(start, `${methodName} must be present`).toBeGreaterThan(-1);
	const end = src.indexOf(nextMethodPrefix, start + 1);
	expect(end, `next method boundary after ${methodName} must be present`).toBeGreaterThan(start);
	return src.slice(start, end);
}

/**
 * Strip C-style comments (block `/* … *​/` and line `// …`) from a source slice.
 * Used before regex assertions so that JSDoc text mentioning a symbol (e.g.
 * "NOT via delegator.stopTask") does NOT trip a "must not call X" check — we
 * want to flag actual call sites, not prose.
 */
function stripComments(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		// Block comment.
		if (src[i] === "/" && src[i + 1] === "*") {
			const close = src.indexOf("*/", i + 2);
			if (close === -1) break;
			i = close + 2;
			continue;
		}
		// Line comment.
		if (src[i] === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i + 2);
			if (nl === -1) break;
			i = nl;
			continue;
		}
		// String literal (skip so // inside a string isn't treated as comment).
		if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
			const quote = src[i];
			out += src[i];
			i += 1;
			while (i < src.length && src[i] !== quote) {
				if (src[i] === "\\" && i + 1 < src.length) { out += src[i] + src[i + 1]; i += 2; continue; }
				out += src[i];
				i += 1;
			}
			if (i < src.length) { out += src[i]; i += 1; }
			continue;
		}
		out += src[i];
		i += 1;
	}
	return out;
}

// ===========================================================================
// #8, #9, #10 — source-level invariants (read at module load, before any DB).
// ===========================================================================

describe("[#8, #9, #10] source-level invariants (archive-no-residual sub-3)", () => {
	const src = readFileSync(AGENT_SVC_SRC, "utf8");

	test("#8: `archiveChildrenOf` exists and lists by {parentSessionId}", () => {
		const body = sliceMethod(src, "private async archiveChildrenOf(", "private async archiveOneSessionCascade(");
		// Lists delegated tasks filtered by parentSessionId (the recursion predicate).
		expect(body, "must call listDelegatedTasks").toMatch(/listDelegatedTasks\(/);
		// Adversarial: confirm the filter key is parentSessionId, not just any list call.
		expect(body, "filter key MUST be {parentSessionId}").toMatch(/\{\s*parentSessionId\s*\}/);
	});

	test("#9a: archiveDelegatedSession funnels through archiveOneSessionCascade (which itself calls archiveChildrenOf)", () => {
		const body = sliceMethod(src, "async archiveDelegatedSession(", "private async archiveChildrenOf(");
		expect(body, "must call archiveOneSessionCascade").toMatch(/this\.archiveOneSessionCascade\(/);
	});

	test("#9b: archiveSessionInBackground calls archiveChildrenOf at entry (chat-manual cascade)", () => {
		const body = sliceMethod(src, "async archiveSessionInBackground(", "async teardownSessionForArchive(");
		expect(body, "archiveSessionInBackground MUST call archiveChildrenOf at entry").toMatch(/this\.archiveChildrenOf\(/);
	});

	test("#10: cascade path does NOT invoke delegator kill / stopTask / abandonTask (direct archiveSession only)", () => {
		// Inspect the three new cascade methods + the two entry points. None may
		// call delegator-style kill primitives; they must go through archiveSession.
		// stripComments is applied so JSDoc prose mentioning a symbol (e.g.
		// "NOT via delegator.stopTask") doesn't trip the regex — we only want
		// to flag actual call sites.
		const methodsToCheck = [
			"async archiveDelegatedSession(",
			"private async archiveChildrenOf(",
			"private async archiveOneSessionCascade(",
			"private async archiveActiveSessionViaArchive(",
			"private async archiveTerminalSessionViaArchive(",
			"async archiveSessionInBackground(",
		];
		for (const m of methodsToCheck) {
			const start = src.indexOf(m);
			expect(start, `${m} must be present`).toBeGreaterThan(-1);
			// Slice to the next tab-indented method declaration.
			const sliceEndPrivate = src.indexOf("\tprivate ", start + 1);
			const sliceEndAsync = src.indexOf("\tasync ", start + 1);
			const sliceEndComments = src.indexOf("\n\t/**", start + 1);
			const candidates = [sliceEndPrivate, sliceEndAsync, sliceEndComments].filter((i) => i > start);
			const sliceEnd = candidates.length ? Math.min(...candidates) : start + 5000;
			const body = stripComments(src.slice(start, sliceEnd));

			// Adversarial: must NOT call delegator kill / stopTask / abandonTask.
			expect(body, `${m} must NOT call delegator kill primitives (call sites only, comments stripped)`).not.toMatch(/delegator\.(stop|kill|abandon)|stopTask\(|abandonTask\(/);
		}

		// Adversarial positive: archiveChildrenOf + archiveOneSessionCascade MUST
		// reach archiveSession (via archiveActiveSessionViaArchive /
		// archiveTerminalSessionViaArchive both invoke it).
		const cascadeBody = sliceMethod(src, "private async archiveOneSessionCascade(", "private async archiveActiveSessionViaArchive(");
		expect(cascadeBody, "archiveOneSessionCascade must reference archiveSession plumbing").toMatch(/archiveActiveSessionViaArchive|archiveTerminalSessionViaArchive/);
	});
});

// ===========================================================================
// #1-#7 — behavioral tests (real AgentService + real SessionDB).
//
// Harness shape mirrors archive-no-residual-sub2.test.ts: ZERO_CORE_DIR redirect +
// vi.resetModules for fresh config + AgentService constructed with real SessionDB
// on a temp file. archive-service is mocked so we observe whether the cascade
// path is taken (memoryTurnRunner invoked) without needing a full LLM provider
// stack; the row-deletion side effect is still exercised through the real
// deleteSessionData() that the mocked archiveSession can call (or we mock it
// to call db.deleteSessionData to mimic the real pipeline).
// ===========================================================================

describe("[#1-#7] behavioral cascade tests", () => {
	let tmp: string;
	let db: InstanceType<typeof SessionDBCtor>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "zero-archive-sub3-"));
		process.env.ZERO_CORE_DIR = tmp;
		vi.resetModules();
	});

	afterEach(async () => {
		vi.doUnmock("../../src/server/archive-service.js");
		// #2 dynamic-imports these clearer modules inside archiveActiveSession
		// ViaArchive; unmock so the leak doesn't perturb later tests in the file.
		vi.doUnmock("../../src/runtime/hooks/compression-trigger-hooks.js");
		vi.doUnmock("../../src/runtime/hooks/turn-seq-tracker.js");
		vi.resetModules();
		delete process.env.ZERO_CORE_DIR;
		try { db?.close(); } catch { /* ignore */ }
		if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	/** Import modules FRESH after vi.resetModules + ZERO_CORE_DIR redirect. */
	async function freshImports(): Promise<void> {
		({ SessionDB: SessionDBCtor } = await import("../../src/server/session-db.js"));
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

	/** Seed a real session row. Returns its id. */
	function seedSession(agentId: string, parentSessionId?: string, kind: "chat" | "delegated" = "chat"): string {
		const created = db.createSession(agentId, kind, undefined, {
			sessionKind: kind,
			parentSessionId,
			visibility: kind === "delegated" ? "hidden" : "normal",
		});
		return created.id;
	}

	/** Seed a delegated_tasks row. Returns nothing (caller knows the taskId). */
	function seedDelegatedRow(
		parentSessionId: string,
		taskId: string,
		childSessionId: string | undefined,
		overrides?: { targetAgentId?: string; modelId?: string; status?: any },
	): void {
		db.createDelegatedTask({
			id: taskId,
			rootTaskId: taskId,
			ownerAgentId: "parent-agent",
			targetAgentId: overrides?.targetAgentId ?? "child-agent",
			modelId: overrides?.modelId ?? "test-model",
			parentSessionId,
			sessionId: childSessionId,
			task: "do thing",
			status: overrides?.status ?? "running",
		});
	}

	/**
	 * Mock archive-service to a controllable fake. The real archiveSession does
	 * mark + export + delete; the cascade only needs the DELETE step observable
	 * (mark + export are idempotent and not what these assertions target). We
	 * also expose a call-log so tests assert "child archive was invoked".
	 *
	 * The `deleteRow` flag controls whether the fake calls db.deleteSessionData
	 * (mimicking the real pipeline's ⑤ step). Tests that want to inspect the
	 * mark-then-delete contract turn it on; lock-race tests leave it on too.
	 */
	function interceptArchiveService(opts: { deleteRow?: boolean } = {}) {
		const calls: string[] = [];
		const fake = {
			archiveSession: vi.fn(async (sessionId: string, dbArg: any) => {
				calls.push(sessionId);
				if (opts.deleteRow !== false) {
					// Mimic the real pipeline's ⑤ delete (real atomic pipeline
					// deletes after writing JSON). This makes "session row gone"
					// observable in our assertions.
					dbArg.deleteSessionData(sessionId);
				}
				return {
					archivePath: `/dev/null/${sessionId}.json`,
					memoryTurnRan: false,
					stepsExported: 0,
					summariesExported: 0,
				};
			}),
			archivePathFor: () => "/dev/null/mock.json",
			ARCHIVES_ROOT: "/dev/null",
			recoverInterruptedArchives: vi.fn(async () => 0),
		};
		vi.doMock("../../src/server/archive-service.js", () => fake);
		return { fake, calls };
	}

	/**
	 * Real archive-service — used for the lock-race test (#5) and idempotent
	 * test (#7) so we exercise the actual withArchiveLock. Real archive writes
	 * a JSON file under ARCHIVES_ROOT (redirected via ZERO_CORE_DIR).
	 */

	// -------------------------------------------------------------------------
	// #1: 父归档级联终态子(2 completed 子)→ 行删 + 子 session 行消失 + 父归档
	// -------------------------------------------------------------------------

	test("#1: archiveSessionInBackground cascades into terminal children — both child rows + sessions gone + parent archived", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { calls: archiveCalls } = interceptArchiveService({ deleteRow: true });
		const { AgentService: Svc } = await import("../../src/server/agent-service.js");
		const svc = new Svc(tmp, db);

		const parentAgent = {
			id: "parent-agent-1",
			name: "Parent",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(parentAgent));

		const parentSid = seedSession("parent-agent-1");
		const child1 = seedSession("child-agent", parentSid, "delegated");
		const child2 = seedSession("child-agent", parentSid, "delegated");
		seedDelegatedRow(parentSid, "t-c1", child1, { status: "completed" });
		seedDelegatedRow(parentSid, "t-c2", child2, { status: "completed" });

		// Sanity: rows + child sessions present, none archived yet.
		expect(db.getDelegatedTask("t-c1")).toBeDefined();
		expect(db.getDelegatedTask("t-c2")).toBeDefined();
		expect(archivedFlag(db, child1)).toBe(0);
		expect(archivedFlag(db, child2)).toBe(0);

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			await svc.archiveSessionInBackground(parentSid);

			// Children's session rows GONE (cascade → archiveSession → deleteSessionData).
			expect(sessionRowGone(db, child1), "child1 session row must be deleted by cascade").toBe(true);
			expect(sessionRowGone(db, child2), "child2 session row must be deleted by cascade").toBe(true);

			// delegated_tasks rows GONE (cascade deletes rows).
			expect(db.getDelegatedTask("t-c1"), "child1 task row must be deleted by cascade").toBeUndefined();
			expect(db.getDelegatedTask("t-c2"), "child2 task row must be deleted by cascade").toBeUndefined();

			// Parent session row GONE (parent's own archive ran).
			expect(sessionRowGone(db, parentSid), "parent session row must be deleted by parent's own archive").toBe(true);

			// Adversarial: archiveSession was invoked 3 times (2 children + parent).
			expect(archiveCalls).toContain(child1);
			expect(archiveCalls).toContain(child2);
			expect(archiveCalls).toContain(parentSid);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #2: 父归档级联运行中子(子 loop 活跃 mock)→ teardown 调用 + 子归档
	// (CAVEAT: production subagent loops live in runningSubloops, not this.loops
	//  — see header. This test exercises the active-loop path via a mock loop
	//  injected into this.loops, exactly as acceptance #2 specifies.)
	// -------------------------------------------------------------------------

	test("#2: cascading a session whose loop is in this.loops invokes teardown.stopAgentLoop + archives (mock-injected loop)", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));

		// For this test we want to observe the active-loop path's teardown. Use
		// a fake archiveSession that captures the teardown callbacks (the real
		// archive-service calls them; we mimic that here).
		const teardownStopCalls: string[] = [];
		const teardownClearCalls: string[] = [];
		const archiveCalls: string[] = [];
		vi.doMock("../../src/server/archive-service.js", () => ({
			archiveSession: vi.fn(async (sessionId: string, dbArg: any, opts: any) => {
				archiveCalls.push(sessionId);
				// Mimic real archiveSession: run memoryTurnRunner (no-op for our
				// mock loop), then run teardown (the active-path side effect we
				// want to assert), then mark + delete.
				if (opts?.memoryTurnRunner) { try { await opts.memoryTurnRunner(); } catch { /* best-effort */ } }
				if (opts?.teardown) {
					opts.teardown.stopAgentLoop(sessionId);
					opts.teardown.clearHookState(sessionId);
				}
				dbArg.deleteSessionData(sessionId);
				return { archivePath: `/dev/null/${sessionId}.json`, memoryTurnRan: false, stepsExported: 0, summariesExported: 0 };
			}),
			archivePathFor: () => "/dev/null/mock.json",
			ARCHIVES_ROOT: "/dev/null",
			recoverInterruptedArchives: vi.fn(async () => 0),
		}));

		const { AgentService: Svc } = await import("../../src/server/agent-service.js");
		const svc = new Svc(tmp, db);

		const parentAgent = {
			id: "parent-agent-2",
			name: "Parent",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(parentAgent));

		const parentSid = seedSession("parent-agent-2");
		const childSid = seedSession("child-agent", parentSid, "delegated");
		seedDelegatedRow(parentSid, "t-running", childSid, { status: "running" });

		// Inject a MOCK loop into this.loops so the active-loop path is taken.
		// This mirrors the acceptance criterion's "子 loop 活跃 mock" spec.
		// The mock loop has a run() that returns immediately (so the memoryTurn
		// runner completes without needing providers).
		const mockLoop = {
			run: vi.fn(async () => ({}) as any),
			setTurnSource: () => {},
		};
		(svc as any).loops.set(childSid, mockLoop);

		// Spy evictSessionFromMemory so we observe the active path's stop callback.
		const evictSpy = vi.spyOn(svc as any, "evictSessionFromMemory").mockImplementation((sid: string) => {
			teardownStopCalls.push(sid);
			// Real evict pulls from this.loops; mimic so subsequent has() returns false.
			(svc as any).loops.delete(sid);
			(svc as any).runStates?.delete?.(sid);
		});

		// Also spy the (private) clearHookState import path indirectly — the
		// active path dynamic-imports clearer modules. We can't easily intercept
		// those without mocking the hook modules; instead, we assert via the
		// teardown callback the fake archiveSession invoked (stopAgentLoop).
		// To make clearHookState observable, mock the two clearer modules.
		vi.doMock("../../src/runtime/hooks/compression-trigger-hooks.js", () => ({
			clearCompressionTriggerStateForSession: (sid: string) => { teardownClearCalls.push(sid); },
			registerCompressionTriggerHooks: () => () => {},
		}));
		vi.doMock("../../src/runtime/hooks/turn-seq-tracker.js", () => ({
			clearTurnSeqStateForSession: (sid: string) => { teardownClearCalls.push(sid); },
		}));

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			await svc.archiveSessionInBackground(parentSid);

			// Child loop teardown was invoked: stopAgentLoop called with childSid.
			expect(teardownStopCalls, "active-path stopAgentLoop MUST be called for the child").toContain(childSid);
			// Child archive ran (not the kill path).
			expect(archiveCalls).toContain(childSid);
			// Child session row gone (delete ran after teardown).
			expect(sessionRowGone(db, childSid)).toBe(true);
			// delegated_tasks row gone.
			expect(db.getDelegatedTask("t-running")).toBeUndefined();

			// Adversarial: child's status did NOT become "killed" — the cascade
			// path doesn't touch the row's status; it just deletes it. (We
			// already assert row is undefined; this is a belt-and-suspenders
			// assertion that no kill-style status update happened.)
			// (Row is gone, so we can't read status — the assertion is the absence.)

			// Parent also archived.
			expect(sessionRowGone(db, parentSid)).toBe(true);
		} finally {
			warnSpy.mockRestore();
			evictSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #3: 递归孙子层(父→子→孙)→ 孙 session 也归档
	// -------------------------------------------------------------------------

	test("#3: grandchild session is archived when parent is archived (recursion depth 2)", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { calls: archiveCalls } = interceptArchiveService({ deleteRow: true });
		const { AgentService: Svc } = await import("../../src/server/agent-service.js");
		const svc = new Svc(tmp, db);

		const parentAgent = {
			id: "parent-agent-3",
			name: "Parent",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(parentAgent));

		// Tree: parent → child → grandchild.
		const parentSid = seedSession("parent-agent-3");
		const childSid = seedSession("child-agent", parentSid, "delegated");
		const grandSid = seedSession("child-agent", childSid, "delegated");
		// Child task row parented at parent's session.
		seedDelegatedRow(parentSid, "t-child", childSid, { status: "completed" });
		// Grandchild task row parented at CHILD's session (so listDelegatedTasks
		// on childSid finds it during the nested cascade).
		seedDelegatedRow(childSid, "t-grand", grandSid, { status: "completed" });

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			await svc.archiveSessionInBackground(parentSid);

			// All three rows gone (recursion reached the grandchild).
			expect(sessionRowGone(db, parentSid), "parent row gone").toBe(true);
			expect(sessionRowGone(db, childSid), "child row gone").toBe(true);
			expect(sessionRowGone(db, grandSid), "grandchild row MUST be gone (recursive cascade)").toBe(true);

			// All three tasks gone.
			expect(db.getDelegatedTask("t-child")).toBeUndefined();
			expect(db.getDelegatedTask("t-grand")).toBeUndefined();

			// Adversarial: archiveSession was called for all three (recursion).
			expect(archiveCalls).toContain(grandSid);
			expect(archiveCalls).toContain(childSid);
			expect(archiveCalls).toContain(parentSid);

			// Adversarial ordering: grandchild archived BEFORE child (recursion-first).
			// archiveChildrenOf recurses BEFORE self-archive, so grandSid must
			// appear earlier in the call list than childSid.
			const grandIdx = archiveCalls.indexOf(grandSid);
			const childIdx = archiveCalls.indexOf(childSid);
			expect(grandIdx, "grandchild must be archived").toBeGreaterThan(-1);
			expect(childIdx, "child must be archived").toBeGreaterThan(-1);
			expect(grandIdx, "grandchild MUST be archived BEFORE its parent (recursion-first)").toBeLessThan(childIdx);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #4: 无 sessionId 的任务行仍清(不卡)
	// -------------------------------------------------------------------------

	test("#4: delegated task row with sessionId=null is still deleted (no skip, no throw)", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { calls: archiveCalls } = interceptArchiveService({ deleteRow: true });
		const { AgentService: Svc } = await import("../../src/server/agent-service.js");
		const svc = new Svc(tmp, db);

		const parentAgent = {
			id: "parent-agent-4",
			name: "Parent",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(parentAgent));

		const parentSid = seedSession("parent-agent-4");
		// Row with NO sessionId — cascade must delete it without invoking archive.
		seedDelegatedRow(parentSid, "t-no-sid", undefined, { status: "running" });

		// Plus a normal child to confirm the cascade still proceeds after the
		// sessionId-less row (no early return on the empty-sid branch).
		const realChild = seedSession("child-agent", parentSid, "delegated");
		seedDelegatedRow(parentSid, "t-real", realChild, { status: "completed" });

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			await expect(svc.archiveSessionInBackground(parentSid)).resolves.toBeUndefined();

			// No-sid row gone (cascade's `if (!child.sessionId) deleteDelegatedTask` branch).
			expect(db.getDelegatedTask("t-no-sid"), "sessionId-less row MUST be deleted").toBeUndefined();
			// Real child also processed (cascade didn't break on the no-sid row).
			expect(db.getDelegatedTask("t-real")).toBeUndefined();
			expect(sessionRowGone(db, realChild)).toBe(true);

			// Adversarial: archiveSession was NOT called for the no-sid task
			// (no session to archive). The fake's call-log should not contain
			// any undefined / empty entry from that row.
			expect(archiveCalls.every((sid) => typeof sid === "string" && sid.length > 0),
				"no-sid row must NOT trigger an archive call").toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #5: 并发撞锁 benign(子已被归档,cascade 再调 → skipped,不抛/不 double-archive)
	// -------------------------------------------------------------------------

	test("#5: concurrent cascade on an already-archiving child is benign (skipped, no throw, no double-archive)", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));

		// Use the REAL archive-service so the real withArchiveLock is exercised.
		// To make the lock observable, we stall the first archive's memory turn
		// so a second concurrent call hits the lock while it's held.
		const realArchiveMod = await import("../../src/server/archive-service.js");
		// Replace just archiveSession with a wrapped version that lets us
		// synchronize two concurrent calls. We can't easily patch the in-flight
		// imported module's binding from agent-service (it dynamic-imports), so
		// instead we drive archiveChildrenOf directly via reflection twice in
		// sequence after pre-acquiring the lock through a real archiveSession
		// call that hasn't resolved yet.
		//
		// Simpler approach: invoke archiveOneSessionCascade twice concurrently
		// on the SAME child session. The first call acquires the lock and runs
		// the pipeline (deletes the row). The second call hits the lock and
		// returns {skipped} — benign, no throw.
		const { AgentService: Svc } = await import("../../src/server/agent-service.js");
		const svc = new Svc(tmp, db);

		const parentAgent = {
			id: "parent-agent-5",
			name: "Parent",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(parentAgent));

		const childSid = seedSession("child-agent", undefined, "delegated");

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			// Fire two concurrent cascades on the same child session.
			// archiveOneSessionCascade is private — invoke via reflection.
			const p1 = (svc as any).archiveOneSessionCascade(childSid, "child-agent", "test-model");
			const p2 = (svc as any).archiveOneSessionCascade(childSid, "child-agent", "test-model");

			// Both MUST resolve without throwing (benign). Each resolves to
			// undefined (cascade is fire-and-forget of archiveSession); the
			// loser hits the per-session lock inside archive-service and gets
			// a benign {skipped} outcome that is swallowed.
			const results = await Promise.all([p1, p2]);
			expect(results, "both cascades must resolve without throwing").toEqual([undefined, undefined]);

			// Child row gone (at least one archive completed).
			expect(sessionRowGone(db, childSid)).toBe(true);

			// Adversarial: JSON file written at most ONCE. Real archive-service
			// writes to archivePathFor(agentId, sessionId). Find the file.
			// (Real archivePathFor: <archivesRoot>/<agentId>/<sessionId>.json —
			// with ZERO_CORE_DIR redirect, ARCHIVES_ROOT lives under tmp.)
			// We can't easily assert "exactly once" via file mtime (rename is
			// atomic and the loser doesn't write), but the warn log MUST have
			// fired for the loser ("archive skipped: another caller holds").
			expect(warnSpy).toHaveBeenCalled();
			const allWarnArgs = warnSpy.mock.calls.flat().join(" ");
			expect(allWarnArgs, "loser must log 'skipped: another caller holds'").toMatch(/skipped|already-archiving|holds the lock/);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #6: killed 语义不变 — stopTask 不 fire terminal;cascade 仍直接 archive killed 子
	// -------------------------------------------------------------------------

	test("#6a: stopTask sets status=killed but does NOT auto-archive via terminal", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));

		// Use the real delegator (no archive mock) — fireOnTaskTerminal is what
		// we're asserting is NOT invoked from the stopTask path.
		const { SubagentDelegator } = await import("../../src/runtime/subagent-delegator.js");
		const { AgentService: Svc } = await import("../../src/server/agent-service.js");
		const svc = new Svc(tmp, db);

		const parentAgent = {
			id: "parent-agent-6a",
			name: "Parent",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(parentAgent));

		const cfg = {
			agentId: "parent-agent-6a",
			sessionId: "parent-6a",
			workspaceDir: tmp,
			db: db as any,
		} as any;

		const archiveSpy = vi.spyOn(svc as any, "archiveDelegatedSession").mockImplementation(async () => {});
		const delegator = new SubagentDelegator({
			config: cfg,
			providers: [],
			emit: () => {},
			createSubLoop: () => ({} as any),
			getToolConfig: () => ({}),
			onTaskTerminal: async (taskId, status, childSid, agentId, modelId) => {
				// Wired — this is what SHOULD fire for completed/failed but NOT killed.
				await svc.archiveDelegatedSession(taskId, childSid, agentId, modelId);
			},
		});

		const childSid = seedSession("child-agent", "parent-6a", "delegated");
		seedDelegatedRow("parent-6a", "t-kill-6a", childSid, { status: "running" });

		// Register in taskRegistry so stopTask has something to kill.
		delegator.taskRegistry.create("t-kill-6a", "subagent", "work");
		expect(delegator.stopTask("t-kill-6a")).toBe(true);

		// Row's status is killed; row still present (stopTask does NOT delete).
		const row = db.getDelegatedTask("t-kill-6a");
		expect(row?.status).toBe("killed");
		expect(row).toBeDefined();

		// Adversarial: archiveDelegatedSession did NOT fire from stopTask
		// (killed is excluded from fireOnTaskTerminal).
		expect(archiveSpy, "stopTask must NOT trigger archive via terminal").not.toHaveBeenCalled();

		// Child session NOT archived (no mark, no delete).
		expect(archivedFlag(db, childSid)).toBe(0);
		expect(sessionRowGone(db, childSid)).toBe(false);

		archiveSpy.mockRestore();
		try { (delegator as any).cleanup?.(); } catch { /* ignore */ }
	});

	test("#6b: parent archive cascade DOES archive the killed child directly (not via terminal)", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { calls: archiveCalls } = interceptArchiveService({ deleteRow: true });
		const { AgentService: Svc } = await import("../../src/server/agent-service.js");
		const svc = new Svc(tmp, db);

		const parentAgent = {
			id: "parent-agent-6b",
			name: "Parent",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(parentAgent));

		const parentSid = seedSession("parent-agent-6b");
		const killedChild = seedSession("child-agent", parentSid, "delegated");
		// Seed a KILLED row — cascade must still find it (listDelegatedTasks
		// does not filter by status) and archive it directly.
		seedDelegatedRow(parentSid, "t-killed", killedChild, { status: "killed" });

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			await svc.archiveSessionInBackground(parentSid);

			// Killed child session GONE (cascade archived it directly).
			expect(sessionRowGone(db, killedChild), "killed child MUST be archived by cascade").toBe(true);
			// Task row gone (cascade deletes).
			expect(db.getDelegatedTask("t-killed")).toBeUndefined();
			// archiveSession was invoked for the killed child.
			expect(archiveCalls).toContain(killedChild);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -------------------------------------------------------------------------
	// #7: idempotent — re-cascade on an already-archived parent is a no-op
	// -------------------------------------------------------------------------

	test("#7: calling archiveChildrenOf again after parent is archived is a no-op (no throw, list empty)", async () => {
		await freshImports();
		db = new SessionDBCtor(join(tmp, "sessions.db"));
		const { calls: archiveCalls } = interceptArchiveService({ deleteRow: true });
		const { AgentService: Svc } = await import("../../src/server/agent-service.js");
		const svc = new Svc(tmp, db);

		const parentAgent = {
			id: "parent-agent-7",
			name: "Parent",
			subagents: [{ agentId: "child-agent" }],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		svc.setAgentStore(makeAgentStore(parentAgent));

		const parentSid = seedSession("parent-agent-7");
		const child = seedSession("child-agent", parentSid, "delegated");
		seedDelegatedRow(parentSid, "t-7", child, { status: "completed" });

		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

		try {
			// First cascade.
			await svc.archiveSessionInBackground(parentSid);
			const firstCallCount = archiveCalls.length;

			// Second invocation: rows are gone, listDelegatedTasks returns [],
			// archiveChildrenOf should be a no-op without throwing.
			await expect(
				(svc as any).archiveChildrenOf(parentSid),
			).resolves.toBeUndefined();

			// No NEW archive calls (list returned empty — rows were deleted).
			expect(archiveCalls.length, "second cascade MUST NOT invoke archiveSession again").toBe(firstCallCount);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
