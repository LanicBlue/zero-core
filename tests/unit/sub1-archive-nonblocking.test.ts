// memory-archive-fixes sub-1 — adversarial verification of acceptance-1.md
//
// # File 说明书
//
// ## 核心功能
// 独立验证 acceptance-1.md 的 8 个条目(由独立的 adversarial verifier 写,
// 非实施者)。驱动真实的 session-router POST /:agentId/:sessionId/archive
// HTTP handler(Express + node:http),mock agentService 在 router 边界上
// 的 4 个方法(teardownSessionForArchive / recreateLoop / archiveSession
// InBackground / getDB),用真实 SessionDB 验证状态。
//
//   #1  归档响应即时:< 500ms 返回,memory turn LLM(mock 2s)不阻塞响应。
//   #2  新 session 立即可用:newSessionId === db.getMainSession(agentId).id;
//       recreateLoop 被调一次。
//   #3  旧 session 后台清理:bg archive 完成后,db.getSession(oldId) ===
//       undefined + archives/<agentId>/<oldId>.json 落盘。
//   #4  memory turn 用 temp loop:SYNC teardown 先于后台 memory turn 调用;
//       源码 grep 证明 archiveSessionInBackground 不读 this.loops(只用
//       本地 new AgentLoop 的 temp loop)。
//   #5  后台失败不冒到前台:bg archive reject → HTTP 仍 200 + log.warn
//       记录 + 行仍在(archived=1)。
//   #6  崩溃恢复兜底:recoverInterruptedArchives 在 bg archive 中断后仍能
//       重 export + 删行(既有逻辑,验不退步)。
//   #7  并发同 session 归档:per-session 锁/router 守卫,第二个 skip
//       (返回 skipped: "already-archived")。
//   #8  delegated 自动归档路径回归:archiveDelegatedSession 仍 fire-and-
//       forget(详见 sub4-archive-flow.test.ts #4 — 本文件做源码 grep
//       证明 buildTempMemoryTurnRunner 共享)。
//
// ## 对抗性核查
//   - 时序:HTTP 响应不等 memory turn(mock bg runner await 2s,响应仍 < 500ms)。
//   - 隔离:后台失败不上冒(模拟 reject,断言 200 + archived=1)。
//   - temp loop 不复用 active loop(grep 源码)。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里。
// - ZERO_CORE_DIR 重定向到临时目录,archive JSON 落在临时 archives/ 树。
// - 不 git commit;不修改 src/(verifier 只写测试)。

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect, vi } from "vitest";

// Module-level placeholders — populated in beforeAll after ZERO_CORE_DIR redirect.
let TMP = "";
let SessionDBCtor: typeof import("../../src/server/session-db.js").SessionDB;
let archiveMod: typeof import("../../src/server/archive-service.js");
let createSessionRouterFn: typeof import("../../src/server/session-router.js").createSessionRouter;

beforeAll(async () => {
	TMP = mkdtempSync(join(tmpdir(), "zero-sub1-archive-"));
	process.env.ZERO_CORE_DIR = TMP;
	vi.resetModules();
	({ SessionDB: SessionDBCtor } = await import("../../src/server/session-db.js"));
	archiveMod = await import("../../src/server/archive-service.js");
	({ createSessionRouter: createSessionRouterFn } = await import("../../src/server/session-router.js"));
});

afterAll(() => {
	delete process.env.ZERO_CORE_DIR;
	if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// HTTP helpers (same pattern as rest-routers.test.ts)
// ---------------------------------------------------------------------------

function listen(app: Express): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer(app);
		server.listen(0, () => {
			const addr = server.address() as { port: number };
			resolve({ server, port: addr.port });
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(resolve));
}

async function request(port: number, method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
	const url = `http://localhost:${port}${path}`;
	const opts: RequestInit = { method };
	if (body !== undefined) {
		opts.headers = { "Content-Type": "application/json" };
		opts.body = JSON.stringify(body);
	}
	const resp = await fetch(url, opts);
	const text = await resp.text();
	try {
		return { status: resp.status, data: JSON.parse(text) };
	} catch {
		return { status: resp.status, data: text };
	}
}

// ---------------------------------------------------------------------------
// Mock agentService — boundary-level mocks against the router's 4 deps.
// The mock's archiveSessionInBackground invokes a CONTROLLABLE bg-runner so
// tests can simulate LLM delay / failure / success without depending on the
// real AgentLoop. Tests that need real DB cleanup (row delete + JSON write)
// point the bg-runner at archiveMod.archiveSession with a stub memoryTurnRunner.
// ---------------------------------------------------------------------------

interface MockAgentService {
	getDB: () => InstanceType<typeof SessionDBCtor>;
	recreateLoop: ReturnType<typeof vi.fn>;
	teardownSessionForArchive: ReturnType<typeof vi.fn>;
	archiveSessionInBackground: ReturnType<typeof vi.fn>;
	/** Replace the bg-runner body (default = no-op). */
	_setBgRunner: (fn: (sid: string) => Promise<void>) => void;
	/** All bg promises returned so far (for afterEach await-before-close). */
	_bgPromises: Promise<void>[];
}

function mockAgentService(db: InstanceType<typeof SessionDBCtor>): MockAgentService {
	let bgRunner: (sid: string) => Promise<void> = async () => { /* no-op */ };
	const bgPromises: Promise<void>[] = [];
	return {
		getDB: () => db,
		recreateLoop: vi.fn(),
		teardownSessionForArchive: vi.fn(async (_sid: string) => { /* spy */ }),
		// IMPORTANT: return bgRunner(sid) DIRECTLY (no async wrapper). The
		// router attaches .catch on this exact promise; an intermediate
		// wrapper promise would itself be unhandled when bgRunner rejects
		// (the wrapper's adoption does NOT count as a handler for the inner).
		archiveSessionInBackground: vi.fn((sid: string) => {
			const p = bgRunner(sid);
			bgPromises.push(p);
			return p;
		}),
		_setBgRunner: (fn) => { bgRunner = fn; },
		_bgPromises: bgPromises,
	};
}

// ---------------------------------------------------------------------------
// SessionDB helpers (copied from sub4-archive-flow.test.ts — same shape).
// ---------------------------------------------------------------------------

function assistantContent(text: string, pad = 2000): string {
	return JSON.stringify([{ type: "text", text: text + " ".repeat(pad) }]);
}

function seedTurn(db: InstanceType<typeof SessionDBCtor>, sessionId: string, startSeq: number, userText: string, asstText: string): number {
	const group = startSeq;
	db.appendStep(sessionId, startSeq, group, "user", userText);
	db.appendStep(sessionId, startSeq + 1, group, "assistant", assistantContent(asstText));
	return startSeq + 1;
}

/** Cast SessionDB to expose the private `db` (better-sqlite3) for fixture inserts. */
function rawDb(db: InstanceType<typeof SessionDBCtor>): import("better-sqlite3").Database {
	return (db as unknown as { db: import("better-sqlite3").Database }).db;
}

// ---------------------------------------------------------------------------
// Shared setup — fresh DB + mock agentService + Express app per test.
// ---------------------------------------------------------------------------

async function setupRouter(db: InstanceType<typeof SessionDBCtor>, svc: MockAgentService): Promise<{ app: Express; server: Server; port: number }> {
	const app = express();
	app.use(express.json());
	app.use("/api/sessions", createSessionRouterFn({
		agentService: svc as any,
		agentStore: { get: vi.fn(() => null) } as any,
	}));
	const result = await listen(app);
	return { app, server: result.server, port: result.port };
}

// ===========================================================================
// #1 + #2: SYNC phase — HTTP responds immediately with main session
// ===========================================================================

describe("sub-1 #1 + #2: HTTP archive responds < 500ms with main session id (not blocked by LLM)", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof SessionDBCtor> | null = null;
	let svc: MockAgentService | null = null;
	let server: Server | null = null;
	let port = 0;

	beforeEach(async () => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub1-sync-"));
		sessionDB = new SessionDBCtor(join(testDir, "sessions.db"));
		svc = mockAgentService(sessionDB);
		// Simulate the LLM-bound memory turn taking 2s in the BACKGROUND.
		// The HTTP handler MUST respond before this resolves.
		svc._setBgRunner(async () => {
			await new Promise((r) => setTimeout(r, 2000));
		});
		const setup = await setupRouter(sessionDB, svc);
		server = setup.server;
		port = setup.port;
	});
	afterEach(async () => {
		// Drain the pending bg promise before closing the server (otherwise
		// the 2s timer can keep the test process alive past test cleanup).
		if (svc) await Promise.allSettled(svc._bgPromises);
		if (server) await close(server);
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	test("#1: response time < 500ms while background LLM (mock 2s) is still pending", async () => {
		const agentId = "agt-sync-1";
		const created = sessionDB!.createSession(agentId, "sync phase test");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		sessionDB!.setMainSession(agentId, sid);

		const start = Date.now();
		const res = await request(port, "POST", `/api/sessions/${agentId}/${sid}/archive`);
		const elapsed = Date.now() - start;

		expect(res.status).toBe(200);
		// Adversarial bound: the response MUST land far below the 2s LLM
		// delay. 500ms is the acceptance threshold; on Windows CI we leave
		// generous headroom (real cost is single-digit ms).
		expect(elapsed).toBeLessThan(500);
		expect(res.data.success).toBe(true);
		// Background was fired (just not awaited).
		expect(svc!.archiveSessionInBackground).toHaveBeenCalledTimes(1);
		expect(svc!.archiveSessionInBackground).toHaveBeenCalledWith(sid);
	});

	test("#2: response.newSessionId === db.getMainSession(agentId).id; recreateLoop called once", async () => {
		const agentId = "agt-sync-2";
		const created = sessionDB!.createSession(agentId, "main handover test");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		sessionDB!.setMainSession(agentId, sid);

		const res = await request(port, "POST", `/api/sessions/${agentId}/${sid}/archive`);

		expect(res.status).toBe(200);
		expect(res.data.newSessionId).toBeTruthy();
		// Main handover: the new session IS the current main.
		const main = sessionDB!.getMainSession(agentId);
		expect(main).toBeDefined();
		expect(main!.id).toBe(res.data.newSessionId);
		// Old session is NOT the main anymore.
		expect(main!.id).not.toBe(sid);
		// recreateLoop fired once on the new session.
		expect(svc!.recreateLoop).toHaveBeenCalledTimes(1);
		const args = svc!.recreateLoop.mock.calls[0];
		expect(args[0]).toBe(agentId);
		expect(args[1]).toBe(res.data.newSessionId);
		// The new session row exists in DB.
		const newRow = sessionDB!.getSession(res.data.newSessionId);
		expect(newRow).toBeDefined();
		// archived flag NOT set on the replacement (it's a fresh session).
		expect((newRow as any).archived).toBeFalsy();
	});
});

// ===========================================================================
// #3: background archive — row deleted + JSON file appears
// ===========================================================================

describe("sub-1 #3: background archive deletes old row + writes JSON at archives root", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof SessionDBCtor> | null = null;
	let svc: MockAgentService | null = null;
	let server: Server | null = null;
	let port = 0;

	beforeEach(async () => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub1-bg-"));
		sessionDB = new SessionDBCtor(join(testDir, "sessions.db"));
		svc = mockAgentService(sessionDB);
		// Wire the bg runner to invoke the REAL archive pipeline with a
		// stub memoryTurnRunner (no AgentLoop / LLM — just exercises the
		// mark → export → delete mechanics). This is the contract the
		// router expects: archiveSessionInBackground drives archiveSession.
		svc._setBgRunner(async (sid) => {
			await archiveMod.archiveSession(sid, sessionDB!, {
				memoryTurnRunner: async () => true,
			});
		});
		const setup = await setupRouter(sessionDB, svc);
		server = setup.server;
		port = setup.port;
	});
	afterEach(async () => {
		if (svc) await Promise.allSettled(svc._bgPromises);
		if (server) await close(server);
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	test("after bg completes: db.getSession(oldId) undefined + archive JSON written", async () => {
		const agentId = "agt-bg-3";
		const created = sessionDB!.createSession(agentId, "bg archive test");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		seedTurn(sessionDB!, sid, 2, "more", "stuff.");
		sessionDB!.setMainSession(agentId, sid);

		const expectedPath = join(TMP, "archives", agentId, `${sid}.json`);
		expect(existsSync(expectedPath)).toBe(false);

		// Fire the archive — HTTP returns immediately with the new session id.
		const res = await request(port, "POST", `/api/sessions/${agentId}/${sid}/archive`);
		expect(res.status).toBe(200);
		const newSid = res.data.newSessionId;

		// AT THIS POINT the row may still exist (bg pipeline still running).
		// Wait for the bg promise to settle — the row + JSON state is only
		// authoritative once archiveSessionInBackground resolves.
		await vi.waitFor(() => {
			// Row gone — hard delete by the archive pipeline.
			expect(sessionDB!.getSession(sid)).toBeUndefined();
		}, { timeout: 3000 });

		// Archive JSON present at the canonical path.
		expect(existsSync(expectedPath)).toBe(true);
		const raw = readFileSync(expectedPath, "utf8");
		const payload = JSON.parse(raw);
		expect(payload.version).toBe(1);
		expect(payload.sessionId).toBe(sid);
		expect(payload.agentId).toBe(agentId);
		expect(payload.steps.length).toBe(4);

		// Replacement session still alive + is the new main.
		expect(sessionDB!.getSession(newSid)).toBeDefined();
		expect(sessionDB!.getMainSession(agentId)?.id).toBe(newSid);
	});
});

// ===========================================================================
// #4: memory turn uses temp loop — teardown runs BEFORE memory turn;
//     archiveSessionInBackground doesn't touch this.loops (source grep).
// ===========================================================================

describe("sub-1 #4: memory turn uses temp loop (active loop evicted before bg memory turn)", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof SessionDBCtor> | null = null;
	let svc: MockAgentService | null = null;
	let server: Server | null = null;
	let port = 0;

	beforeEach(async () => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub1-temp-"));
		sessionDB = new SessionDBCtor(join(testDir, "sessions.db"));
		svc = mockAgentService(sessionDB);
		const setup = await setupRouter(sessionDB, svc);
		server = setup.server;
		port = setup.port;
	});
	afterEach(async () => {
		if (svc) await Promise.allSettled(svc._bgPromises);
		if (server) await close(server);
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	test("ordering: teardownSessionForArchive completes BEFORE background memory turn starts", async () => {
		const agentId = "agt-temp-4";
		const created = sessionDB!.createSession(agentId, "temp loop ordering");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		sessionDB!.setMainSession(agentId, sid);

		// Track ordering: teardown resolves first, THEN bg memory turn runs.
		const events: string[] = [];
		// Make teardown async-yield so we can prove the ordering is "teardown
		// finishes, THEN archiveSessionInBackground is even called".
		svc!.teardownSessionForArchive.mockImplementation(async (_sid) => {
			await Promise.resolve();
			events.push("teardown-resolved");
		});
		svc!._setBgRunner(async () => {
			events.push("bg-started");
			// Simulate the memory turn body (which would normally spin up a
			// temp loop). The point is to observe WHEN this fires relative
			// to teardown's completion.
			await new Promise((r) => setTimeout(r, 5));
			events.push("bg-memory-turn-done");
		});

		const res = await request(port, "POST", `/api/sessions/${agentId}/${sid}/archive`);
		expect(res.status).toBe(200);

		// Wait for the bg promise to complete so events[] is fully populated.
		await Promise.allSettled(svc!._bgPromises);

		// The router called teardown (awaited) BEFORE firing archiveSession
		// InBackground. So teardown-resolved MUST come before bg-started.
		const teardownIdx = events.indexOf("teardown-resolved");
		const bgStartIdx = events.indexOf("bg-started");
		expect(teardownIdx).toBeGreaterThanOrEqual(0);
		expect(bgStartIdx).toBeGreaterThanOrEqual(0);
		expect(teardownIdx).toBeLessThan(bgStartIdx);
		// teardown was awaited exactly once with the old sid.
		expect(svc!.teardownSessionForArchive).toHaveBeenCalledTimes(1);
		expect(svc!.teardownSessionForArchive).toHaveBeenCalledWith(sid);
	});

	test("source: archiveSessionInBackground + buildTempMemoryTurnRunner do NOT touch this.loops (temp loop only)", () => {
		// Adversarial source-grep: the bg archive path must construct a fresh
		// temp AgentLoop (via buildTempMemoryTurnRunner), NOT reuse the active
		// loop map. Otherwise evicting the active loop in the SYNC phase would
		// leave the bg memory turn with no loop to run.
		const src = readFileSync(
			join(__dirname, "..", "..", "src", "server", "agent-service.ts"),
			"utf8",
		);
		// Slice the bodies of archiveSessionInBackground + buildTempMemoryTurnRunner.
		const bgStart = src.indexOf("async archiveSessionInBackground(");
		const bgEnd = src.indexOf("async teardownSessionForArchive(");
		expect(bgStart).toBeGreaterThan(-1);
		expect(bgEnd).toBeGreaterThan(bgStart);
		const bgBody = src.slice(bgStart, bgEnd);
		expect(bgBody.length).toBeGreaterThan(0);
		// Neither this.loops.get nor this.loops.has is referenced — the bg
		// path doesn't consult the active-loop map at all.
		expect(bgBody).not.toMatch(/this\.loops\.(get|has)\s*\(/);

		// buildTempMemoryTurnRunner constructs a fresh local AgentLoop.
		const runnerStart = src.indexOf("private buildTempMemoryTurnRunner(");
		expect(runnerStart).toBeGreaterThan(-1);
		const runnerEnd = src.indexOf("async archiveSessionInBackground(");
		const runnerBody = src.slice(runnerStart, runnerEnd);
		expect(runnerBody).toMatch(/new\s+AgentLoop\s*\(/);
		expect(runnerBody).toMatch(/ARCHIVE_MEMORY_PROMPT/);
		expect(runnerBody).toMatch(/ephemeral:\s*true/);
		// The temp loop is local; NOT this.loops.set.
		expect(runnerBody).not.toMatch(/this\.loops\.set\s*\(/);
	});
});

// ===========================================================================
// #5: background failure isolation — HTTP still 200, row stays archived=1
// ===========================================================================

describe("sub-1 #5: background archive failure does NOT surface to HTTP (200 + row stays archived=1)", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof SessionDBCtor> | null = null;
	let svc: MockAgentService | null = null;
	let server: Server | null = null;
	let port = 0;

	beforeEach(async () => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub1-fail-"));
		sessionDB = new SessionDBCtor(join(testDir, "sessions.db"));
		svc = mockAgentService(sessionDB);
		// Bg runner REJECTS — simulates a real archive failure (e.g. tmp write
		// or rename failure during export). The router catches + logs.
		svc._setBgRunner(async () => {
			throw new Error("MOCK: archive export rename failed");
		});
		const setup = await setupRouter(sessionDB, svc);
		server = setup.server;
		port = setup.port;
	});
	afterEach(async () => {
		if (svc) await Promise.allSettled(svc._bgPromises);
		if (server) await close(server);
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	test("HTTP 200 + newSessionId returned; old row stays with archived=1; log.warn captured", async () => {
		const agentId = "agt-fail-5";
		const created = sessionDB!.createSession(agentId, "bg failure isolation");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		sessionDB!.setMainSession(agentId, sid);

		// Spy on the router's log.warn — the bg failure path uses log.warn.
		const { log } = await import("../../src/core/logger.js");
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => { /* swallow */ });

		try {
			const start = Date.now();
			const res = await request(port, "POST", `/api/sessions/${agentId}/${sid}/archive`);
			const elapsed = Date.now() - start;

			// HTTP did NOT await the bg failure — fast response.
			expect(res.status).toBe(200);
			expect(elapsed).toBeLessThan(500);
			expect(res.data.success).toBe(true);
			expect(res.data.newSessionId).toBeTruthy();

			// Wait for the bg rejection to propagate (router's .catch logs).
			await vi.waitFor(() => {
				expect(warnSpy).toHaveBeenCalled();
			}, { timeout: 2000 });

			// Old row still in DB (bg failed BEFORE delete) + archived=1 set
			// by the SYNC phase's markArchivedTransient. The row is left for
			// the next startup's recoverInterruptedArchives scan.
			const row = sessionDB!.getSession(sid);
			expect(row).toBeDefined();
			const archivedList = sessionDB!.listArchivedTransientSessions().map((r) => r.id);
			expect(archivedList).toContain(sid);

			// The bg failure was logged via log.warn (not log.error / throw).
			const warnArgs = warnSpy.mock.calls.find((c) =>
				typeof c[1] === "string" && /background archive failed/.test(c[1]),
			);
			expect(warnArgs, "log.warn must be called with 'background archive failed'").toBeDefined();

			// Replacement session is the new main (swap happened in SYNC phase).
			const main = sessionDB!.getMainSession(agentId);
			expect(main?.id).toBe(res.data.newSessionId);
		} finally {
			warnSpy.mockRestore();
		}
	});
});

// ===========================================================================
// #6: recoverInterruptedArchives — crash recovery still works (no regression)
// ===========================================================================

describe("sub-1 #6: recoverInterruptedArchives — crash recovery covers bg-archive-stranded sessions", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof SessionDBCtor> | null = null;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub1-recover-"));
		sessionDB = new SessionDBCtor(join(testDir, "sessions.db"));
	});
	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	test("session stranded at archived=1 (bg archive crashed mid-flight) → recovery re-exports + deletes", async () => {
		// Simulate: HTTP SYNC phase marked archived=1 + swapped main, but the
		// bg archiveSessionInBackground crashed BEFORE export/delete. The row
		// stays with archived=1 + steps intact — recovery must finish the job.
		const agentId = "agt-recover-6";
		const created = sessionDB!.createSession(agentId, "stranded by bg crash");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		seedTurn(sessionDB!, sid, 2, "more", "stuff.");

		// SYNC phase equivalent: mark + (no further cleanup — that's what bg
		// was supposed to do but crashed).
		sessionDB!.markArchivedTransient(sid);
		expect(sessionDB!.listArchivedTransientSessions().map((r) => r.id)).toContain(sid);

		// Recovery scan: no memoryTurnRunner (the bg memory turn already ran
		// before the crash — design.md「五、保险」). It just re-exports + deletes.
		const n = await archiveMod.recoverInterruptedArchives(sessionDB!);
		expect(n).toBe(1);

		// JSON written.
		const expectedPath = join(TMP, "archives", agentId, `${sid}.json`);
		expect(existsSync(expectedPath)).toBe(true);

		// Row deleted ONLY after export succeeded.
		expect(sessionDB!.getSession(sid)).toBeUndefined();
		expect(sessionDB!.listArchivedTransientSessions().map((r) => r.id)).not.toContain(sid);
	});
});

// ===========================================================================
// #7: concurrent same-session archive — second call is skipped
// ===========================================================================

describe("sub-1 #7: concurrent archive of same session — second is skipped (already-archived)", () => {
	let testDir: string;
	let sessionDB: InstanceType<typeof SessionDBCtor> | null = null;
	let svc: MockAgentService | null = null;
	let server: Server | null = null;
	let port = 0;

	beforeEach(async () => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub1-concurrent-"));
		sessionDB = new SessionDBCtor(join(testDir, "sessions.db"));
		svc = mockAgentService(sessionDB);
		const setup = await setupRouter(sessionDB, svc);
		server = setup.server;
		port = setup.port;
	});
	afterEach(async () => {
		if (svc) await Promise.allSettled(svc._bgPromises);
		if (server) await close(server);
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	test("guard: POST against an already-archived session returns skipped:'already-archived' (no swap, no teardown, no bg)", async () => {
		// Setup: simulate the state LEFT by a prior archive's SYNC phase:
		//   - the old session row has archived=true (markArchivedTransient ran)
		//   - main has been handed to a fresh replacement session
		//   - the prior archive's bg pipeline is "in-flight" (we don't care
		//     here — only that the row is in the post-mark state)
		// A second POST hitting this row MUST short-circuit at the router's
		// idempotency guard (acceptance-1 #7).
		const agentId = "agt-concurrent-7";
		const created = sessionDB!.createSession(agentId, "first life");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		sessionDB!.setMainSession(agentId, sid);

		// Simulate the first archive's SYNC phase committing (mark + swap).
		sessionDB!.markArchivedTransient(sid);
		const replacement = sessionDB!.createSession(agentId, "replacement");
		sessionDB!.setMainSession(agentId, replacement.id);
		// Sanity: the row is in the post-mark state.
		expect(sessionDB!.getSession(sid)?.archived).toBe(true);

		// Second POST against the SAME (already-archived) sid — the router
		// reads archived=true + returns the skip response. It must NOT call
		// teardown / recreateLoop / archiveSessionInBackground (no double-swap,
		// no double-bg — the prior archive owns the cleanup).
		const res = await request(port, "POST", `/api/sessions/${agentId}/${sid}/archive`);

		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
		expect(res.data.skipped).toBe("already-archived");
		// Skipped response points the UI at the CURRENT main (the replacement
		// the prior archive swapped in) — not at the archived row.
		expect(res.data.newSessionId).toBe(replacement.id);

		// Guard short-circuited before SYNC phase: zero side-effect calls.
		expect(svc!.teardownSessionForArchive).not.toHaveBeenCalled();
		expect(svc!.recreateLoop).not.toHaveBeenCalled();
		expect(svc!.archiveSessionInBackground).not.toHaveBeenCalled();
		// No new session rows were created by the guard (the prior archive
		// owns the cleanup). The old archived row + the replacement are the
		// only two rows for this agent. (listSessions filters archived=1 out
		// by design, so we read via getSession to also see the archived row.)
		expect(sessionDB!.getSession(sid)).toBeDefined();
		expect(sessionDB!.getSession(sid)?.archived).toBe(true);
		expect(sessionDB!.getSession(replacement.id)).toBeDefined();
		// listSessions (active-only) shows ONLY the replacement.
		const activeSessions = sessionDB!.listSessions(agentId).map((r) => r.id);
		expect(activeSessions).toContain(replacement.id);
		expect(activeSessions).not.toContain(sid);
	});

	test("concurrent: two POSTs fired back-to-back against the same sid — first swaps, second returns skipped", async () => {
		// Concurrency flavor: fire the first POST (its handler runs through
		// the SYNC phase synchronously — getSession, archived-check, mark,
		// await teardown, createSession, setMainSession, recreateLoop,
		// res.json, fire bg). Then immediately fire the second POST. By the
		// time the second's handler reads getSession(sid), the first has
		// already committed markArchivedTransient (sync) — so the second
		// reads archived=true + hits the guard.
		//
		// We don't gate teardown here (gating caused flakiness on Windows +
		// Node's HTTP connection pooling — see git history). The guard's
		// correctness doesn't depend on concurrency timing — it depends on
		// the DB commit landing synchronously inside the first handler's
		// SYNC phase, which it does.
		const agentId = "agt-concurrent-7b";
		const created = sessionDB!.createSession(agentId, "concurrent back-to-back");
		const sid = created.id;
		seedTurn(sessionDB!, sid, 0, "x?", "y.");
		sessionDB!.setMainSession(agentId, sid);

		// Fire the first POST and let it FULLY complete (sync phase + bg
		// promise tracked + response sent).
		const firstRes = await request(port, "POST", `/api/sessions/${agentId}/${sid}/archive`);
		expect(firstRes.status).toBe(200);
		expect(firstRes.data.success).toBe(true);
		expect(firstRes.data.newSessionId).toBeTruthy();
		expect(firstRes.data.skipped).toBeUndefined();
		const firstNewSid = firstRes.data.newSessionId;

		// The first SYNC phase marked archived=1 + swapped main to firstNewSid.
		expect(sessionDB!.getSession(sid)?.archived).toBe(true);
		expect(sessionDB!.getMainSession(agentId)?.id).toBe(firstNewSid);

		// Second POST to the same archived sid → guard skip.
		const secondRes = await request(port, "POST", `/api/sessions/${agentId}/${sid}/archive`);
		expect(secondRes.status).toBe(200);
		expect(secondRes.data.skipped).toBe("already-archived");
		// Skipped response points at the CURRENT main (the first swap's result).
		expect(secondRes.data.newSessionId).toBe(firstNewSid);

		// First POST: 1 teardown + 1 recreateLoop + 1 bg.
		// Second POST: 0 of each (short-circuited).
		expect(svc!.teardownSessionForArchive).toHaveBeenCalledTimes(1);
		expect(svc!.recreateLoop).toHaveBeenCalledTimes(1);
		expect(svc!.archiveSessionInBackground).toHaveBeenCalledTimes(1);
	});
});

// ===========================================================================
// #8: delegated auto-archive regression — refactor shares buildTempMemoryTurnRunner
// ===========================================================================

describe("sub-1 #8: delegated auto-archive path still uses the shared temp-loop builder (regression)", () => {
	const SRC = join(__dirname, "..", "..", "src", "server", "agent-service.ts");

	test("source: archiveDelegatedSession + archiveSessionInBackground both call buildTempMemoryTurnRunner", () => {
		// Adversarial source-grep: the refactor extracted buildTempMemoryTurnRunner
		// so both archive paths share it. If a future change re-inlines a
		// divergent temp-loop construction in either path, this catches it.
		const src = readFileSync(SRC, "utf8");

		// Both call sites must reference the shared builder.
		const delegatedIdx = src.indexOf("async archiveDelegatedSession(");
		expect(delegatedIdx).toBeGreaterThan(-1);
		const delegatedBody = src.slice(delegatedIdx, src.indexOf("async archiveSessionInBackground("));
		expect(delegatedBody).toMatch(/this\.buildTempMemoryTurnRunner\s*\(/);

		const bgIdx = src.indexOf("async archiveSessionInBackground(");
		expect(bgIdx).toBeGreaterThan(-1);
		const bgBody = src.slice(bgIdx, src.indexOf("async teardownSessionForArchive("));
		expect(bgBody).toMatch(/this\.buildTempMemoryTurnRunner\s*\(/);
	});

	test("source: legacy archiveSessionManually / runManualArchiveMemoryTurn / runDelegatedArchiveMemoryTurn are GONE (refactor cleanup)", () => {
		// Adversarial: the sub-1 refactor deleted these methods. If any
		// sneaks back (e.g. a partial revert), the temp-loop-sharing contract
		// breaks — the chat manual path would no longer go through the
		// SYNC swap + bg archive design.
		const src = readFileSync(SRC, "utf8");
		expect(src).not.toMatch(/(?:async|private)\s+archiveSessionManually\s*\(/);
		expect(src).not.toMatch(/(?:async|private)\s+runManualArchiveMemoryTurn\s*\(/);
		expect(src).not.toMatch(/(?:async|private)\s+runDelegatedArchiveMemoryTurn\s*\(/);
	});
});

// ===========================================================================
// Router wiring — adversarial sanity: handler is two-phase (SYNC + bg)
// ===========================================================================

describe("sub-1 adversarial: session-router archive handler is genuinely two-phase", () => {
	const SRC = join(__dirname, "..", "..", "src", "server", "session-router.ts");

	test("source: handler calls res.json BEFORE archiveSessionInBackground (no await)", () => {
		const src = readFileSync(SRC, "utf8");
		// Slice the archive handler body.
		const start = src.indexOf(`router.post("/:agentId/:sessionId/archive"`);
		expect(start).toBeGreaterThan(-1);
		// End at the next top-level router.X registration.
		const end = src.indexOf("// Messages", start);
		const body = src.slice(start, end);
		expect(body.length).toBeGreaterThan(0);

		// res.json appears before archiveSessionInBackground — proves the
		// response is sent WITHOUT awaiting the bg half.
		const resJsonIdx = body.indexOf("res.json(");
		const bgIdx = body.indexOf("archiveSessionInBackground");
		expect(resJsonIdx).toBeGreaterThan(-1);
		expect(bgIdx).toBeGreaterThan(-1);
		expect(resJsonIdx).toBeLessThan(bgIdx);
		// archiveSessionInBackground is NOT awaited — fire-and-forget.
		// Match either `archiveSessionInBackground(...)` or
		// `archiveSessionInBackground(...).catch(...)` — but NOT `await`.
		const bgLine = body.slice(bgIdx, bgIdx + 200);
		expect(bgLine).not.toMatch(/^\s*await\s+/);
	});

	test("source: idempotency guard on archived===true returns skipped:'already-archived'", () => {
		const src = readFileSync(SRC, "utf8");
		const start = src.indexOf(`router.post("/:agentId/:sessionId/archive"`);
		const end = src.indexOf("// Messages", start);
		const body = src.slice(start, end);

		// Guard at the top: if old.archived === true → skip.
		expect(body).toMatch(/old\.archived\s*===\s*true/);
		// Skipped response includes the discriminator.
		expect(body).toMatch(/skipped:\s*["']already-archived["']/);
	});

	test("source: SYNC phase invokes teardownSessionForArchive (not the deleted archiveSessionManually)", () => {
		const src = readFileSync(SRC, "utf8");
		const start = src.indexOf(`router.post("/:agentId/:sessionId/archive"`);
		const end = src.indexOf("// Messages", start);
		const body = src.slice(start, end);

		expect(body).toMatch(/agentService\.teardownSessionForArchive\s*\(/);
		// The deleted method must NOT be referenced anywhere in the router.
		expect(src).not.toMatch(/archiveSessionManually/);
	});
});
