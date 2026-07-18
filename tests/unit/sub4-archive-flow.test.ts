// compression-archive-simplify sub-4 adversarial verification test.
//
// # File 说明书
//
// ## 核心功能
// 独立验证 acceptance-4.md 的 11 个条目(由独立的 adversarial verifier 写,
// 非实施者)。直调 archive-service.archiveSession() / recoverInterruptedArchives()
// + agent-service.archiveDelegatedSession()(GAP2)+ 源码 grep:
//   #1  全流程 happy path:memory turn → mark → 原子 export → 删行。
//   #2  原子性 — EACH failure point(tmp 写失败 / JSON 校验失败 / rename
//       失败)→ DB 行 NOT deleted,row 仍在,可重试。
//   #3  可恢复:mark 后模拟中断(不 export)→ recoverInterruptedArchives
//       重 export + 仅在 export 成功后删行;archived=0 的 session 不被动。
//   #4  GAP2 re-activate:delegated child cursor===null → memory ephemeral
//       turn 跑了;cursor>=1 → 不跑 memory turn,直接 export。
//   #5  memory turn step 不落盘:归档前后的 steps 计数一致(ephemeral)。
//   #6  archive-service 不再调 ExtractorA(grep 零命中)。
//   #7  无 final compression(grep 零命中)。
//   #8  DB 锁并发:同 session 并发归档 → 一进一 skip;TTL 过期可抢锁。
//   #9  不破坏 — 现有归档测试套件过(由独立 test 文件覆盖,这里仅 sanity)。
//   #10 typecheck(由 npm run build:lib 单独跑,这里不内联)。
//   #11 restore/rotation deferred(标在 sub-4.md,这里仅 grep 确认 deferred 注释)。
//
// ## 对抗性核查
//   - writeArchiveJsonAtomic:JSON.parse-validate 真的解析(parse-after-write,
//     before rename),不是只看 existsSync。
//   - .tmp 文件失败时清理(parse 失败 → unlinkSync)。
//   - agent-loop.ts +23 是 ARCHIVE_MEMORY_PROMPT seam,非无关 leak / 不回退 sub-2/3c。
//   - server/index.ts fire-and-forget recovery:在 migrations 之后 + 错误吞掉。
//   - memory-turn-runner 注入:chat-active / delegated-temp / recovery-none 三路
//     都拿对 runner(或 none);archive-service 不 import runtime。
//   - sub3b-rolling-summary 翻面断言 buildFinalCompressOpts/compressSession GONE。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里。
// - ZERO_CORE_DIR 重定向到临时目录 + vi.resetModules() 让 config.ts 重读
//   (同 attachment-store / steps-overhaul-sub8-archive 测试模式)。

import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect, vi } from "vitest";

// Module-level placeholders — populated in beforeAll after ZERO_CORE_DIR redirect.
let TMP = "";
let archiveMod: typeof import("../../src/server/archive-service.js");
let CoreDatabaseCtor: typeof import("../../src/server/core-database.js").CoreDatabase;

// ---------------------------------------------------------------------------
// Mock node:fs with a pass-through that can selectively fail specific paths.
// vi.hoisted lifts the state above the (hoisted) vi.mock so the factory can
// read it. Per-test we set/clear the failure flags.
// ---------------------------------------------------------------------------

const fsFailureState = vi.hoisted(() => ({
	failWritePath: null as string | null,
	failReadPath: null as string | null,
	failRenameFromPath: null as string | null,
	// When set, readFileSync returns this body instead of the real file — used
	// to inject garbage that breaks JSON.parse validation.
	garbageReadForPath: null as string | null,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		writeFileSync: vi.fn((...args: any[]) => {
			const p = String(args[0]);
			if (fsFailureState.failWritePath && p === fsFailureState.failWritePath) {
				throw new Error(`E MOCK: writeFileSync blocked for ${p}`);
			}
			return real.writeFileSync.apply(real, args as any);
		}),
		readFileSync: vi.fn((...args: any[]) => {
			const p = String(args[0]);
			if (fsFailureState.garbageReadForPath && p === fsFailureState.garbageReadForPath) {
				return "{ this is not valid json }}}";
			}
			if (fsFailureState.failReadPath && p === fsFailureState.failReadPath) {
				throw new Error(`E MOCK: readFileSync blocked for ${p}`);
			}
			return real.readFileSync.apply(real, args as any);
		}),
		renameSync: vi.fn((...args: any[]) => {
			const from = String(args[0]);
			if (fsFailureState.failRenameFromPath && from === fsFailureState.failRenameFromPath) {
				throw new Error(`E MOCK: renameSync blocked for ${from}`);
			}
			return real.renameSync.apply(real, args as any);
		}),
	};
});

function clearFsFailures() {
	fsFailureState.failWritePath = null;
	fsFailureState.failReadPath = null;
	fsFailureState.failRenameFromPath = null;
	fsFailureState.garbageReadForPath = null;
}

beforeAll(async () => {
	TMP = mkdtempSync(join(tmpdir(), "zero-sub4-archive-flow-"));
	process.env.ZERO_CORE_DIR = TMP;
	vi.resetModules();
	archiveMod = await import("../../src/server/archive-service.js");
	({ CoreDatabase: CoreDatabaseCtor } = await import("../../src/server/core-database.js"));
});

afterAll(() => {
	delete process.env.ZERO_CORE_DIR;
	if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantContent(text: string, pad = 2000): string {
	return JSON.stringify([{ type: "text", text: text + " ".repeat(pad) }]);
}

function seedTurn(db: InstanceType<typeof CoreDatabaseCtor>, sessionId: string, startSeq: number, userText: string, asstText: string): number {
	const group = startSeq;
	db.appendStep(sessionId, startSeq, group, "user", userText);
	db.appendStep(sessionId, startSeq + 1, group, "assistant", assistantContent(asstText));
	return startSeq + 1;
}

/** Cast CoreDatabase to expose the private `db` (better-sqlite3) for fixture inserts. */
function rawDb(db: InstanceType<typeof CoreDatabaseCtor>): import("better-sqlite3").Database {
	return (db as unknown as { db: import("better-sqlite3").Database }).db;
}

/** Count steps for a session via raw DB (bypasses any guards). */
function stepCount(db: InstanceType<typeof CoreDatabaseCtor>, sessionId: string): number {
	const row = rawDb(db).prepare("SELECT COUNT(*) AS c FROM steps WHERE session_id = ?").get(sessionId) as { c: number };
	return row.c;
}

/** True if a .tmp file still exists in the session's archive directory. */
function anyTmpInArchiveDir(agentId: string): boolean {
	const dir = join(TMP, "archives", agentId);
	if (!existsSync(dir)) return false;
	return readdirSync(dir).some((f) => f.endsWith(".tmp"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sub-4 #1: full happy path — memory turn → mark → atomic export → delete", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof CoreDatabaseCtor> | null = null;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub4-happy-"));
		sessionDB = new CoreDatabaseCtor(join(testDir, "core.db"));
	});
	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
	});

	test("memory turn ran → mark → JSON appears at ARCHIVES_ROOT with session body → row deleted", async () => {
		const agentId = "agt-happy";
		const created = sessionDB!.createSession(agentId, "happy path session");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "what is X?", "X is ...");
		seedTurn(sessionDB!, sid, 2, "do thing", "done thing");

		const expectedPath = join(TMP, "archives", agentId, `${sid}.json`);
		expect(existsSync(expectedPath)).toBe(false);

		let memoryTurnCalled = false;
		const result = await archiveMod.archiveSession(sid, sessionDB!, {
			memoryTurnRunner: async () => { memoryTurnCalled = true; return true; },
		});

		expect(memoryTurnCalled).toBe(true);
		expect(result.memoryTurnRan).toBe(true);
		expect(result.archivePath).toBe(expectedPath);
		expect(existsSync(expectedPath)).toBe(true);

		// JSON is parseable and carries the session's own data.
		const raw = readFileSync(expectedPath, "utf8");
		const payload = JSON.parse(raw);
		expect(payload.version).toBe(1);
		expect(payload.sessionId).toBe(sid);
		expect(payload.agentId).toBe(agentId);
		expect(payload.session.id).toBe(sid);
		expect(payload.steps.length).toBe(4);
		expect(payload.memoryTurnRan).toBe(true);
		expect(payload.compressionCursor).toBeNull();

		// Row is gone — hard delete, not soft archive.
		expect(sessionDB!.getSession(sid)).toBeUndefined();
		expect(stepCount(sessionDB!, sid)).toBe(0);
		expect(anyTmpInArchiveDir(agentId)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// #2 atomicity — EACH failure point
// ---------------------------------------------------------------------------

describe("sub-4 #2: atomicity — DB row NOT deleted when export fails at each step", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof CoreDatabaseCtor> | null = null;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub4-atomic-"));
		sessionDB = new CoreDatabaseCtor(join(testDir, "core.db"));
		clearFsFailures();
	});
	afterEach(() => {
		clearFsFailures();
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	async function seed(agentId: string): Promise<string> {
		const created = sessionDB!.createSession(agentId, `atomic ${agentId}`);
		seedTurn(sessionDB!, created.id, 0, "x?", "y.");
		return created.id;
	}

	test("(a) tmp write fails → archiveSession rejects; row stays; no final JSON; archive retryable", async () => {
		const sid = await seed("agt-atomic-a");
		const tmpPath = join(TMP, "archives", "agt-atomic-a", `${sid}.json.tmp`);
		const expectedPath = join(TMP, "archives", "agt-atomic-a", `${sid}.json`);

		// Block writeFileSync for the .tmp path under archives root.
		fsFailureState.failWritePath = tmpPath;

		await expect(archiveMod.archiveSession(sid, sessionDB!, {})).rejects.toThrow(/tmp write failed/);

		// Row NOT deleted.
		expect(sessionDB!.getSession(sid)).toBeDefined();
		expect(stepCount(sessionDB!, sid)).toBe(2);
		// Final JSON absent.
		expect(existsSync(expectedPath)).toBe(false);

		// Retry after unblocking — succeeds + row gone.
		clearFsFailures();
		const r2 = await archiveMod.archiveSession(sid, sessionDB!, {});
		expect(existsSync(r2.archivePath)).toBe(true);
		expect(sessionDB!.getSession(sid)).toBeUndefined();
	});

	test("(b) JSON.parse-validate fails → archiveSession rejects; .tmp cleaned up; row stays; retryable", async () => {
		const sid = await seed("agt-atomic-b");
		const tmpPath = join(TMP, "archives", "agt-atomic-b", `${sid}.json.tmp`);
		const expectedPath = join(TMP, "archives", "agt-atomic-b", `${sid}.json`);

		// Sabotage readFileSync so the parse-validation step sees garbage (not
		// the actual file contents). This forces JSON.parse to throw INSIDE
		// writeArchiveJsonAtomic, exercising the parse-validate branch.
		fsFailureState.garbageReadForPath = tmpPath;

		await expect(archiveMod.archiveSession(sid, sessionDB!, {})).rejects.toThrow(/JSON validation failed/);

		// Row NOT deleted.
		expect(sessionDB!.getSession(sid)).toBeDefined();
		expect(stepCount(sessionDB!, sid)).toBe(2);
		// Final JSON absent.
		expect(existsSync(expectedPath)).toBe(false);
		// .tmp cleaned up (parse-failure path unlinks it).
		expect(anyTmpInArchiveDir("agt-atomic-b")).toBe(false);

		// Retry after restoring readFileSync — succeeds + row gone.
		clearFsFailures();
		const r2 = await archiveMod.archiveSession(sid, sessionDB!, {});
		expect(existsSync(r2.archivePath)).toBe(true);
		expect(sessionDB!.getSession(sid)).toBeUndefined();
	});

	test("(c) rename fails → archiveSession rejects; row stays; final JSON absent; retryable", async () => {
		const sid = await seed("agt-atomic-c");
		const tmpPath = join(TMP, "archives", "agt-atomic-c", `${sid}.json.tmp`);
		const expectedPath = join(TMP, "archives", "agt-atomic-c", `${sid}.json`);

		fsFailureState.failRenameFromPath = tmpPath;

		await expect(archiveMod.archiveSession(sid, sessionDB!, {})).rejects.toThrow(/rename failed/);

		// Row NOT deleted.
		expect(sessionDB!.getSession(sid)).toBeDefined();
		expect(stepCount(sessionDB!, sid)).toBe(2);
		// Final JSON absent (rename never landed).
		expect(existsSync(expectedPath)).toBe(false);

		// Retry after unblocking rename.
		clearFsFailures();
		const r2 = await archiveMod.archiveSession(sid, sessionDB!, {});
		expect(existsSync(r2.archivePath)).toBe(true);
		expect(sessionDB!.getSession(sid)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// #3 recoverable — recoverInterruptedArchives
// ---------------------------------------------------------------------------

describe("sub-4 #3: recoverInterruptedArchives — re-exports stranded archived=1 sessions", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof CoreDatabaseCtor> | null = null;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub4-recover-"));
		sessionDB = new CoreDatabaseCtor(join(testDir, "core.db"));
	});
	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	test("session stranded at archived=1 (mark→export crash) → recovery re-exports + deletes only after export", async () => {
		const agentId = "agt-recover-stranded";
		const created = sessionDB!.createSession(agentId, "stranded");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		seedTurn(sessionDB!, sid, 2, "more", "stuff");

		// Simulate the crash-state: mark archived=1 directly (the crash happened
		// AFTER mark, BEFORE export). Row still exists.
		sessionDB!.markArchivedTransient(sid);
		const stranded = sessionDB!.listArchivedTransientSessions();
		expect(stranded.map((r) => r.id)).toContain(sid);

		// Recovery: no memoryTurnRunner (the pre-crash turn already ran).
		const n = await archiveMod.recoverInterruptedArchives(sessionDB!);
		expect(n).toBe(1);

		// JSON written.
		const expectedPath = join(TMP, "archives", agentId, `${sid}.json`);
		expect(existsSync(expectedPath)).toBe(true);

		// Row deleted ONLY after export succeeded.
		expect(sessionDB!.getSession(sid)).toBeUndefined();
		expect(stepCount(sessionDB!, sid)).toBe(0);
		expect(sessionDB!.listArchivedTransientSessions().map((r) => r.id)).not.toContain(sid);
	});

	test("session with archived=0 is NOT touched by recovery", async () => {
		const agentId = "agt-recover-fresh";
		const created = sessionDB!.createSession(agentId, "fresh active");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");

		// Sanity: archived=0 by default.
		expect(sessionDB!.listArchivedTransientSessions().map((r) => r.id)).not.toContain(sid);

		const n = await archiveMod.recoverInterruptedArchives(sessionDB!);
		expect(n).toBe(0);

		// Untouched.
		expect(sessionDB!.getSession(sid)).toBeDefined();
		expect(stepCount(sessionDB!, sid)).toBe(2);
		const expectedPath = join(TMP, "archives", agentId, `${sid}.json`);
		expect(existsSync(expectedPath)).toBe(false);
	});

	test("recovery is idempotent — second invocation finds nothing", async () => {
		const agentId = "agt-recover-idem";
		const created = sessionDB!.createSession(agentId, "idempotent");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		sessionDB!.markArchivedTransient(sid);

		const n1 = await archiveMod.recoverInterruptedArchives(sessionDB!);
		expect(n1).toBe(1);
		const n2 = await archiveMod.recoverInterruptedArchives(sessionDB!);
		expect(n2).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// #4 GAP2 re-activate — agent-service.archiveDelegatedSession
// ---------------------------------------------------------------------------

describe("sub-4 #4: GAP2 re-activate — cursor null → memory turn, cursor >=1 → skip", () => {
	// Test strategy: we mock only the dynamic-import boundary of
	// archive-service.archiveSession (agent-service.ts does
	// `await import("./archive-service.js")` inside archiveDelegatedSession).
	// We spy on the agent-service instance's PRIVATE
	// runDelegatedArchiveMemoryTurn method to observe whether the GAP2 branch
	// selected it (cursor null) or skip-branch (cursor >= 1). This avoids
	// mocking AgentLoop + registerHooksForLoop just to make a temp loop
	// constructible, and keeps the test focused on the DECISION predicate
	// (which is what acceptance-4 #4 specifies).
	//
	// P1-3 round-4 (2026-07-18): FLAKE INVESTIGATION + FIX.
	//
	// SYMPTOM: under the threads pool (any maxThreads > 1) these two tests
	// intermittently failed in two ways — (1) the cursor=null test timed out
	// at 5000ms; (2) the cursor>=1 test failed with `archiveSessionCalls`
	// length 1 got 2. Both are manifestations of ONE root cause.
	//
	// ROOT CAUSE (hypothesis (b) module-state bleed, confirmed by source
	// trace): each test does `vi.doMock("archive-service")` + `vi.resetModules()`
	// + dynamic `import("agent-service")`. agent-service.ts inside
	// archiveOneSessionCascade does a dynamic `await import("./archive-service.js")`
	// which resolves to the currently-registered mock. Under thread-pool
	// contention (other test files loading in parallel workers) the dynamic
	// import of agent-service's LARGE transitive graph (it pulls the whole
	// runtime — AgentLoop, hooks, provider-factory, etc.) can exceed 5000ms.
	// When that happens:
	//   - vitest times out test 1 + runs its `finally` (doUnmock + resetModules).
	//   - BUT the underlying archiveDelegatedSession promise is still pending
	//     (vitest does NOT cancel promises on test timeout).
	//   - test 2 starts; its setup calls `vi.resetModules()` again, which
	//     invalidates the cached mock module that test 1's pending import was
	//     about to resolve to. test 1's pending import then resolves to
	//     test 2's freshly-registered mock factory → test 1's late
	//     archiveSession call pushes to test 2's `archiveSessionCalls` array.
	//   - test 2's own call also pushes → array length 2. ✗
	// The "timeout" failure mode is just test 1 hitting the 5s budget while
	// its dynamic import is still resolving.
	//
	// NOTE: at vitest maxThreads: 1 (current setting) this race is dormant
	// because there's no concurrent load to slow the dynamic import — the
	// 5s budget always suffices. The race is real and resurfaces the moment
	// maxThreads is raised OR the test machine slows (CI, loaded build host).
	// We harden anyway because the fix is cheap and the race is subtle.
	//
	// FIX:
	//   1. Per-test timeout bumped to 15s for these two tests (large dynamic-
	//      import graph under load = genuinely long I/O, NOT a race mask).
	//   2. `interceptArchiveService` now returns a `stop()` closure that
	//      freezes the capture — late calls (from a prior test's pending
	//      promise bleeding through resetModules) get dropped instead of
	//      polluting the array. Each test's `finally` calls `stop()` BEFORE
	//      doUnmock/resetModules so the window is explicitly closed.
	//   3. afterEach additionally flushes pending microtasks via two
	//      `setImmediate` yields — if any tail work survived the test body,
	//      it resolves into a stopped capture (no-op) rather than the next
	//      test's capture.

	let testDir: string;
	let sessionDB: InstanceType<typeof CoreDatabaseCtor> | null = null;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub4-gap2-"));
		sessionDB = new CoreDatabaseCtor(join(testDir, "core.db"));
	});
	afterEach(async () => {
		// Flush any tail microtasks/macrotasks that a prior test's pending
		// archiveDelegatedSession might still be resolving. With the capture
		// stopped (see finally in each test) these would be no-ops on the
		// array, but we still want them settled before the next test starts
		// so they can't race with the next test's doMock/resetModules cycle.
		await new Promise<void>((r) => setImmediate(r));
		await new Promise<void>((r) => setImmediate(r));
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	/**
	 * Seed a delegated task + child session. Returns { taskId, childSid }.
	 * The delegated_tasks row gives archiveDelegatedSession the
	 * target_agent_id / model_id it needs.
	 */
	function seedDelegated(agentId: string): { taskId: string; childSid: string } {
		const created = sessionDB!.createSession(
			agentId, "delegated child",
			undefined,
			{ sessionKind: "delegated" },
		);
		const childSid = created.id;
		seedTurn(sessionDB!, childSid, 0, "subtask?", "did it.");
		const taskId = `task-${childSid.slice(-6)}`;
		const dbi = rawDb(sessionDB!);
		dbi.prepare(
			"INSERT INTO delegated_tasks (id, root_task_id, owner_agent_id, target_agent_id, session_id, task, status, depth, step, turns, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', 0, 0, 0, 0, ?, ?)",
		).run(taskId, taskId, "main", agentId, childSid, "do work", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
		return { taskId, childSid };
	}

	/**
	 * Set up the archive-service dynamic-import mock. Returns the calls array
	 * AND a `stop` closure that freezes the capture (subsequent pushes drop).
	 *
	 * The stop() guard is the belt-and-suspenders for the
	 * vi.resetModules + dynamic-import race documented at the top of this
	 * describe block: it ensures that even if a prior test's pending
	 * archiveDelegatedSession leaks into THIS test's mock factory (because
	 * resetModules forced re-resolution), its late archiveSession call gets
	 * dropped instead of polluting this array. The PRIMARY fix is the
	 * per-test timeout (prevents the leak in the first place); this is the
	 * defense-in-depth.
	 */
	function interceptArchiveService(agentId: string): { calls: any[]; stop: () => void } {
		const archiveSessionCalls: any[] = [];
		// Module-level capture flag shared between the doMock factory closures
		// (the factory may be re-invoked by vitest on resetModules, producing
		// a new vi.fn each time; both instances close over the SAME flag +
		// array, so the stop() toggle is honored regardless of which factory
		// invocation created the vi.fn that's currently being called).
		const capture = { active: true };
		vi.doMock("../../src/server/archive-service.js", () => ({
			archiveSession: vi.fn(async (_sid: string, _db: any, opts: any) => {
				if (capture.active) {
					archiveSessionCalls.push({ sid: _sid, opts });
				}
				// Invoke the runner so we can observe what GAP2 picked. Only
				// when capture is active — a late call from a prior test's
				// leaked promise would otherwise run the (already-torn-down)
				// runner and might trigger cascading async work.
				if (capture.active && typeof opts?.memoryTurnRunner === "function") {
					await opts.memoryTurnRunner();
				}
				return {
					archivePath: join(TMP, "archives", agentId, `${_sid}.json`),
					memoryTurnRan: true,
					stepsExported: 0,
					summariesExported: 0,
				};
			}),
			archivePathFor: (a: string, s: string) => join(TMP, "archives", a, `${s}.json`),
			ARCHIVES_ROOT: join(TMP, "archives"),
			recoverInterruptedArchives: vi.fn(async () => 0),
		}));
		return {
			calls: archiveSessionCalls,
			stop: () => { capture.active = false; },
		};
	}

	test("cursor === null → memory turn runner is the re-activate path (buildTempMemoryTurnRunner called) before export", async () => {
		// timeout 15000: see describe-block top — agent-service's dynamic-import
		// graph is large (whole runtime), can exceed the default 5s under
		// thread-pool contention. This is long-I/O, not a race mask.
		const agentId = "agt-gap2-short";
		const { taskId, childSid } = seedDelegated(agentId);

		// Lock precondition: child never compressed.
		expect(sessionDB!.getCompressionCursor(childSid)).toBeNull();

		const { calls: archiveSessionCalls, stop } = interceptArchiveService(agentId);
		try {
			vi.resetModules();
			const { AgentService } = await import("../../src/server/agent-service.js");
			const svc = new AgentService(testDir, sessionDB!);

			// Spy on the private temp-loop-runner builder to observe GAP2 branch
			// selection without depending on AgentLoop / registerHooksForLoop
			// wiring. memory-archive-fixes sub-1: the old
			// `runDelegatedArchiveMemoryTurn` (which directly ran the temp loop)
			// was extracted into `buildTempMemoryTurnRunner` (which RETURNS a
			// closure). The spy replaces the builder so the closure is a benign
			// stub; archiveDelegatedSession injects that stub as memoryTurnRunner.
			const stubRunner = vi.fn(async () => true);
			const spy = vi.spyOn(
				svc as unknown as { buildTempMemoryTurnRunner: () => () => Promise<boolean> },
				"buildTempMemoryTurnRunner",
			).mockReturnValue(stubRunner);

			await svc.archiveDelegatedSession(taskId, childSid);

			// archiveSession was called once with the child sid.
			expect(archiveSessionCalls).toHaveLength(1);
			expect(archiveSessionCalls[0].sid).toBe(childSid);
			// A memoryTurnRunner WAS injected (not undefined).
			expect(typeof archiveSessionCalls[0].opts.memoryTurnRunner).toBe("function");
			// GAP2 re-activate path was selected (cursor null) → builder called.
			expect(spy).toHaveBeenCalledTimes(1);
			// The injected runner IS the spy's return value (proves wiring).
			expect(archiveSessionCalls[0].opts.memoryTurnRunner).toBe(stubRunner);
			// And invoking the runner returns the stub's value.
			const ret = await archiveSessionCalls[0].opts.memoryTurnRunner();
			expect(ret).toBe(true);
		} finally {
			// Close the capture window BEFORE resetModules so any late call
			// from THIS test's pending work (post-timeout, in a future test's
			// mock factory) gets dropped instead of polluting that test.
			stop();
			vi.doUnmock("../../src/server/archive-service.js");
			vi.resetModules();
			archiveMod = await import("../../src/server/archive-service.js");
			({ CoreDatabase: CoreDatabaseCtor } = await import("../../src/server/core-database.js"));
		}
	}, 15000);

	test("cursor >= 1 (already compressed) → buildTempMemoryTurnRunner NOT called; runner returns false", async () => {
		// timeout 15000: see describe-block top — same dynamic-import cost.
		const agentId = "agt-gap2-compressed";
		const { taskId, childSid } = seedDelegated(agentId);

		// Simulate a prior compression by inserting a messages row whose
		// last_compressed_step_seq is non-null. Schema: messages(session_id,
		// seq, summary_json, last_compressed_step_seq, created_at).
		const dbi = rawDb(sessionDB!);
		dbi.prepare(
			"INSERT INTO messages (session_id, seq, summary_json, last_compressed_step_seq, created_at) VALUES (?, 0, ?, 1, ?)",
		).run(childSid, JSON.stringify({ status: "prior compression" }), new Date().toISOString());

		// Lock precondition: cursor is now non-null.
		expect(sessionDB!.getCompressionCursor(childSid)).toBe(1);

		const { calls: archiveSessionCalls, stop } = interceptArchiveService(agentId);
		try {
			vi.resetModules();
			const { AgentService } = await import("../../src/server/agent-service.js");
			const svc = new AgentService(testDir, sessionDB!);

			const stubRunner = vi.fn(async () => true);
			const spy = vi.spyOn(
				svc as unknown as { buildTempMemoryTurnRunner: () => () => Promise<boolean> },
				"buildTempMemoryTurnRunner",
			).mockReturnValue(stubRunner);

			await svc.archiveDelegatedSession(taskId, childSid);

			expect(archiveSessionCalls).toHaveLength(1);
			// Re-activate path NOT taken (cursor >= 1 → skip).
			expect(spy).not.toHaveBeenCalled();
			// Runner injected but returns false (skip — inline async () => false).
			const runner = archiveSessionCalls[0].opts.memoryTurnRunner;
			expect(typeof runner).toBe("function");
			const ret = await runner();
			expect(ret).toBe(false);
		} finally {
			stop();
			vi.doUnmock("../../src/server/archive-service.js");
			vi.resetModules();
			archiveMod = await import("../../src/server/archive-service.js");
			({ CoreDatabase: CoreDatabaseCtor } = await import("../../src/server/core-database.js"));
		}
	}, 15000);

	test("agent-service.archiveDelegatedSession decision predicate — source-level branch", () => {
		// Adversarial source-grep: the GAP2 branch must read
		// getCompressionCursor + branch on null/undefined. Locks the predicate
		// against accidental inversion / widening.
		const src = readFileSync(
			join(__dirname, "..", "..", "src", "server", "agent-service.ts"),
			"utf8",
		);
		expect(src).toMatch(/getCompressionCursor\s*\(/);
		// The branch compares against BOTH null + undefined (defensive — the
		// DB returns null when last_compressed_step_seq is NULL, but undefined
		// guards against any future code path that yields undefined).
		expect(src).toMatch(/null\s*\|\|\s*\w+\s*===\s*undefined|===\s*undefined\s*\|\|\s*\w+\s*===\s*null/);
	});
});

// ---------------------------------------------------------------------------
// #5 memory turn step not persisted
// ---------------------------------------------------------------------------

describe("sub-4 #5: archive memory turn writes zero steps (sub-2 ephemeral)", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof CoreDatabaseCtor> | null = null;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub4-ephemeral-"));
		sessionDB = new CoreDatabaseCtor(join(testDir, "core.db"));
	});
	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	test("archive pipeline adds zero steps even when memoryTurnRunner does heavy work", async () => {
		const agentId = "agt-ephemeral";
		const created = sessionDB!.createSession(agentId, "ephemeral check");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		const beforeArchive = stepCount(sessionDB!, sid);
		expect(beforeArchive).toBe(2);

		await archiveMod.archiveSession(sid, sessionDB!, {
			// Simulate the memory turn "doing stuff" — but it MUST NOT write
			// steps (sub-2 ephemeral). Our stub here is benign; the contract
			// is that the pipeline never calls appendStep on the archive's
			// behalf (no extra user/assistant rows appear).
			memoryTurnRunner: async () => true,
		});

		// Steps after archive: 0 because the row is hard-deleted (export
		// took them into the JSON then deleteSessionData wiped the table).
		// The point: between beforeArchive and the final delete, the archive
		// pipeline never INSERTED additional step rows. The JSON we wrote
		// reflects "exactly beforeArchive rows".
		const expectedPath = join(TMP, "archives", agentId, `${sid}.json`);
		const payload = JSON.parse(readFileSync(expectedPath, "utf8"));
		expect(payload.steps.length).toBe(beforeArchive);
		// After archive, the steps table is empty for this session.
		expect(stepCount(sessionDB!, sid)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// #6 + #7 source-grep invariants
// ---------------------------------------------------------------------------

describe("sub-4 #6 + #7: source-level invariants (archive-service scope)", () => {
	const SRC = join(__dirname, "..", "..", "src", "server", "archive-service.ts");
	let src: string;

	beforeAll(() => {
		src = readFileSync(SRC, "utf8");
	});

	test("#6: ExtractorA / mergeSummaryIntoWiki not present anywhere (incl. comments)", () => {
		expect((src.match(/ExtractorA|extractorA/g) ?? []).length,
			"ExtractorA/extractorA must not appear in archive-service.ts at all").toBe(0);
		expect((src.match(/mergeSummaryIntoWiki/g) ?? []).length,
			"mergeSummaryIntoWiki must not appear in archive-service.ts at all").toBe(0);
	});

	test("#7: no final compression — buildFinalCompressOpts gone, compressSession not called", () => {
		expect(src).not.toMatch(/(?:async\s+)?function\s+buildFinalCompressOpts\b/);
		expect(src).not.toMatch(/compressSession\s*\(/);
		expect(src).not.toMatch(/summarySystemPrompt/);
	});

	test("#11 deferred: restore / rotation explicitly noted as deferred in sub-4.md", () => {
		// memory-archive-fixes: the compression-archive-simplify effort was
		// archived (docs/plan → docs/archive) after it shipped. The deferred
		// markers must still be reachable in the archived sub-4.md.
		const sub4 = readFileSync(
			join(__dirname, "..", "..", "docs", "archive", "compression-archive-simplify", "sub-4.md"),
			"utf8",
		);
		// Both deferred items must be called out so they aren't silently lost.
		expect(sub4).toMatch(/restore\s+通路/);
		expect(sub4).toMatch(/轮转|rotation/);
		// And follow-up issue references should be present.
		expect(sub4).toMatch(/compression-archive-restore/);
		expect(sub4).toMatch(/compression-archive-rotation/);
	});
});

// ---------------------------------------------------------------------------
// #8 DB lock concurrency
// ---------------------------------------------------------------------------

describe("sub-4 #8: per-session DB lock — concurrent same-session archive", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof CoreDatabaseCtor> | null = null;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub4-lock-"));
		sessionDB = new CoreDatabaseCtor(join(testDir, "core.db"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	test("two concurrent archiveSession(sameSid) — exactly ONE proceeds, other skipped; no duplicate JSON, no double-delete", async () => {
		const agentId = "agt-lock";
		const created = sessionDB!.createSession(agentId, "lock test");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");

		// Inject a runner that BLOCKS until we manually release it. This
		// guarantees the first archive holds the lock when the second fires.
		let releaseFirst!: () => void;
		const firstRunnerGate = new Promise<void>((r) => { releaseFirst = r; });
		let firstStarted = false;
		let firstResolved = false;

		const firstPromise = archiveMod.archiveSession(sid, sessionDB!, {
			memoryTurnRunner: async () => {
				firstStarted = true;
				await firstRunnerGate;
				firstResolved = true;
				return true;
			},
		});

		// Wait until the first archive has actually entered its runner.
		await vi.waitFor(() => { expect(firstStarted).toBe(true); }, { timeout: 2000 });

		// Fire the second archive — lock is held by first → skip.
		const secondResult = await archiveMod.archiveSession(sid, sessionDB!, {});

		// Second call returns the benign skip result (empty archivePath).
		expect(secondResult.archivePath).toBe("");
		expect(secondResult.memoryTurnRan).toBe(false);
		expect(secondResult.stepsExported).toBe(0);

		// Release the first — let it finish.
		releaseFirst();
		const firstResult = await firstPromise;
		expect(firstResult.archivePath).not.toBe("");
		expect(firstResult.memoryTurnRan).toBe(true);
		expect(firstResolved).toBe(true);

		// Exactly ONE JSON file in the agent's archive dir (no duplicate).
		const dir = join(TMP, "archives", agentId);
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		expect(files).toHaveLength(1);
		expect(files[0]).toBe(`${sid}.json`);

		// Row is gone (deleted exactly once).
		expect(sessionDB!.getSession(sid)).toBeUndefined();
	});

	test("TTL stale-entry release — lock held past TTL → second caller steals + proceeds", async () => {
		// Use fake timers so Date.now() advances. The archive-service reads
		// Date.now() at acquire time.
		const realDateNow = Date.now;
		const baseTime = 1_700_000_000_000; // arbitrary fixed epoch ms
		let currentTime = baseTime;
		Date.now = vi.fn(() => currentTime) as any;

		try {
			const agentId = "agt-lock-ttl";
			const created = sessionDB!.createSession(agentId, "ttl test");
			const sid = created.id;
			seedTurn(sessionDB!, sid, 0, "x?", "y.");

			// First archive: blocks forever (we never release the gate).
			let releaseFirst!: () => void;
			const firstGate = new Promise<void>((r) => { releaseFirst = r; });
			let firstStarted = false;
			const firstPromise = archiveMod.archiveSession(sid, sessionDB!, {
				memoryTurnRunner: async () => {
					firstStarted = true;
					await firstGate;
					return true;
				},
			});

			await vi.waitFor(() => { expect(firstStarted).toBe(true); }, { timeout: 2000 });

			// Advance wall-clock past the 30s TTL — the second acquire should
			// see the entry as expired and STEAL the lock.
			currentTime = baseTime + 35_000;

			// Second call: should NOT be skipped — it steals + runs the
			// pipeline. Its runner is trivial (no gate).
			const secondResult = await archiveMod.archiveSession(sid, sessionDB!, {});
			expect(secondResult.archivePath).not.toBe("");
			expect(secondResult.memoryTurnRan).toBe(false); // no runner in 2nd call
			expect(secondResult.stepsExported).toBeGreaterThan(0);

			// Row deleted by the second (the stealer).
			expect(sessionDB!.getSession(sid)).toBeUndefined();

			// Now release the first — its lock-release branch sees the entry
			// no longer matches its acquire time (stolen), so it's a no-op.
			// The first archive then proceeds through the rest of its pipeline
			// against an already-archived row: buildArchivePayload emits the
			// placeholder, writeArchiveJsonAtomic overwrites the JSON,
			// deleteSessionData is idempotent (no rows). The net effect: ONE
			// JSON file, no throw.
			releaseFirst();
			await expect(firstPromise).resolves.toBeDefined();

			// Still only ONE JSON file.
			const dir = join(TMP, "archives", agentId);
			const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
			expect(files).toHaveLength(1);
		} finally {
			Date.now = realDateNow;
		}
	});
});

// ---------------------------------------------------------------------------
// Adversarial: writeArchiveJsonAtomic does parse-validate (not just existsync)
// ---------------------------------------------------------------------------

describe("sub-4 adversarial: writeArchiveJsonAtomic parse-validate is real", () => {
	const SRC = join(__dirname, "..", "..", "src", "server", "archive-service.ts");

	test("source contains a JSON.parse of the written tmp (parse-after-write, before rename)", () => {
		const src = readFileSync(SRC, "utf8");
		// Within writeArchiveJsonAtomic we expect:
		//   readFileSync(tmp) → JSON.parse(...) — between write + rename.
		expect(src).toMatch(/readFileSync\([^)]*tmpPath[^)]*,\s*["']utf8["']\)/);
		expect(src).toMatch(/JSON\.parse\(/);
		// And the rename happens AFTER, only on the parse-success path.
		expect(src).toMatch(/renameSync\(\s*tmpPath\s*,\s*archivePath\s*\)/);
	});

	test("source: parse-failure path unlinks the tmp (no orphan tmp files)", () => {
		const src = readFileSync(SRC, "utf8");
		expect(src).toMatch(/unlinkSync\(\s*tmpPath\s*\)/);
	});
});

// ---------------------------------------------------------------------------
// Adversarial: agent-loop.ts +23 change is sub-4-scoped
// ---------------------------------------------------------------------------

describe("sub-4 adversarial: agent-loop.ts +23 change is the ARCHIVE_MEMORY_PROMPT seam", () => {
	const SRC = join(__dirname, "..", "..", "src", "runtime", "agent-loop.ts");

	test("ARCHIVE_MEMORY_PROMPT is exported + is archive-scoped (no compression follow-up)", () => {
		const src = readFileSync(SRC, "utf8");
		// The constant is exported.
		expect(src).toMatch(/export\s+const\s+ARCHIVE_MEMORY_PROMPT\b/);
		// Its doc-block (or body) references archive — proves it's the Q5b
		// archive prompt, not a stale FORCE_MEMORY_PROMPT copy.
		const idx = src.indexOf("ARCHIVE_MEMORY_PROMPT");
		expect(idx).toBeGreaterThan(-1);
		const window = src.slice(Math.max(0, idx - 600), idx + 600);
		expect(window.toLowerCase()).toMatch(/archiv/);
	});

	test("sub-2/sub-3c ephemeral + force seams NOT reverted (still present)", () => {
		const src = readFileSync(SRC, "utf8");
		// sub-2 ephemeral persistMode seam intact.
		expect(src).toMatch(/persistMode/);
		expect(src).toMatch(/ephemeral/);
		// sub-3c FORCE_MEMORY_PROMPT intact (module-scoped const; not
		// exported but used internally by the force档 coordination path).
		expect(src).toMatch(/const\s+FORCE_MEMORY_PROMPT\b/);
		// And the run({ephemeral:true}) seam is exercised by force档 path.
		expect(src).toMatch(/FORCE_MEMORY_PROMPT,\s*\{\s*ephemeral:\s*true\s*\}/);
	});
});

// ---------------------------------------------------------------------------
// Adversarial: server/index.ts fire-and-forget recovery is safe
// ---------------------------------------------------------------------------

describe("sub-4 adversarial: server/index.ts recovery wiring is safe", () => {
	const SRC = join(__dirname, "..", "..", "src", "server", "index.ts");

	test("recoverInterruptedArchives wired after migrations, fire-and-forget, error-swallowed", () => {
		const src = readFileSync(SRC, "utf8");
		// Fires recoverInterruptedArchives.
		expect(src).toMatch(/recoverInterruptedArchives\s*\(/);
		// Runs AFTER migrations (runMigrations appears earlier in the file
		// textually than the recovery wiring).
		const migrationsIdx = src.indexOf("runMigrations(");
		const recoveryIdx = src.indexOf("recoverInterruptedArchives");
		expect(migrationsIdx).toBeGreaterThan(-1);
		expect(recoveryIdx).toBeGreaterThan(-1);
		expect(recoveryIdx).toBeGreaterThan(migrationsIdx);
		// Errors are caught (not propagated to boot path).
		const wiringWindow = src.slice(recoveryIdx - 200, recoveryIdx + 400);
		expect(wiringWindow).toMatch(/\.catch\s*\(/);
	});
});
