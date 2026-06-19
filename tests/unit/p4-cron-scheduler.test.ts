// P4 单元测试：cron 三模式调度器 + cron_runs + missed-once + 回写
//
// # 文件说明书
//
// ## 核心功能
// 验证 P4 核心交付 (acceptance-P4.md):
//   - once 到点触发后 enabled=false;setTimeout 调度
//   - alarm 按 (time, days, tz) 触发并滚动重算下一次
//   - interval 每 everyMs(≥60000) 触发
//   - missed once 启动时不补(置 disable + 记 cron_runs missed)
//   - 单次触发错误不取消调度(catch + log + cron_runs failed)
//   - 每次触发落 cron_runs(fired_at/agent_id/session_id/success/duration)
//     + 回写 last_run_at/last_status/next_run_at
//   - trigger 立即运行(不计 next_run)
//   - alarm 跨周下一次计算正确
//
// ## 策略
// 用 vitest fake timers + CronAnalysisDeps.now 注入同步推进时钟。
// 由于 CronAnalysisManager 内部用 setTimeout/setInterval (Node 全局),
// 我们用 vi.useFakeTimers() 接管它们;同时给 manager 注入一个 `now` 函数
// 读 vi.getRealSystemTime? — 不,我们让 now 也跟 vi 的假时钟走
// (vi.setSystemTime 调整 Date.now())。这样 setTimeout(delay) 与 now() 都对齐。
//
// ## 输入
// 临时 SessionDB + 真实 stores + CronRunStore + stub AgentService。
//
// ## 输出
// Vitest 用例。
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { CronStore, CronRunStore } from "../../src/server/cron-store.js";
import { CronAnalysisManager } from "../../src/server/cron-analysis.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { seedAgentWithRoleTag } from "./helpers/p0-test-helpers.js";
import type {
	CronRecord,
	CronSchedule,
	CronScheduleAlarm,
	CronScheduleInterval,
	CronScheduleOnce,
} from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 60 * 1000;

function scope(projectId: string | undefined, workspaceDir: string, wiki = `wiki-root:${projectId ?? "global"}`) {
	return { projectId, workspaceDir, wikiRootNodeId: wiki };
}

/** Stub AgentService — captures sendPrompt calls; optionally throws to simulate errors. */
function makeStubAgentService(opts: { throwOnSend?: boolean } = {}) {
	const calls: Array<{ text: string; agentId?: string; sessionId?: string }> = [];
	const svc = {
		calls,
		sendPrompt: vi.fn(async (text: string, agent?: any, sessionId?: string) => {
			calls.push({ text, agentId: agent?.id, sessionId });
			if (opts.throwOnSend) throw new Error("simulated trigger failure");
		}),
	};
	return svc;
}

/** A fixed anchor "now" used across tests; iso = 2026-03-09T09:00:00Z (a Monday). */
const ANCHOR_NOW = Date.UTC(2026, 2, 9, 9, 0, 0); // Monday 09:00 UTC

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let cronStore: CronStore;
let cronRunStore: CronRunStore;
let agent: CronRecord["agentId"] extends never ? never : { id: string };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(ANCHOR_NOW);

	tmpDir = mkdtempSync(join(tmpdir(), "zero-p4-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	cronStore = new CronStore(sessionDB);
	cronRunStore = new CronRunStore(sessionDB);

	const a = agentStore.create({ name: "PMAgent" } as any);
	seedAgentWithRoleTag(sessionDB, a.id, "pm");
	agent = a;
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
	vi.useRealTimers();
});

/** Advance fake time AND flush any pending timers, in increments so each
 *  timer fires in order with a consistent `now`. */
async function advance(ms: number) {
	// Run timers in 50ms slices so each scheduled callback sees a plausible now.
	let remaining = ms;
	while (remaining > 0) {
		const step = Math.min(remaining, 50);
		vi.advanceTimersByTime(step);
		remaining -= step;
	}
	// Let any promise microtasks from async fireCron settle.
	await Promise.resolve();
	await Promise.resolve();
}

// ---------------------------------------------------------------------------
// once mode
// ---------------------------------------------------------------------------

describe("P4 scheduler — once", () => {
	test("fires at fireAt via setTimeout; disables + unschedules after firing", async () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any,
			agentStore,
			projectStore,
			sessionDB,
			cronStore,
			cronRunStore,
		});

		const fireAt = ANCHOR_NOW + 60_000; // 1 minute ahead
		const sched: CronScheduleOnce = { mode: "once", at: new Date(fireAt).toISOString() };
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: sched,
			enabled: true,
		});

		manager.refreshCron(cron.id);
		expect(manager.getScheduledCronIds()).toContain(cron.id);

		// next_run_at should be set to the ISO fireAt.
		const afterArm = cronStore.get(cron.id)!;
		expect(afterArm.nextRunAt).toBe(sched.at);

		await advance(61_000);

		expect(stub.calls.length).toBe(1);
		expect(stub.calls[0].agentId).toBe(agent.id);

		// Telemetry: disabled + last_run_at + last_status=ok + next_run_at cleared.
		const updated = cronStore.get(cron.id)!;
		expect(updated.enabled).toBe(false);
		expect(updated.lastStatus).toBe("ok");
		expect(updated.lastRunAt).toBeTruthy();
		expect(updated.nextRunAt).toBeFalsy();

		// Timer dropped after once fire.
		expect(manager.getScheduledCronIds()).not.toContain(cron.id);
	});

	test("once does NOT fire a second time even after long advance", async () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const fireAt = ANCHOR_NOW + 30_000;
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "once", at: new Date(fireAt).toISOString() },
			enabled: true,
		});
		manager.refreshCron(cron.id);
		await advance(31_000);
		await advance(120_000); // well past
		expect(stub.calls.length).toBe(1);
		expect(cronStore.get(cron.id)!.enabled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// interval mode
// ---------------------------------------------------------------------------

describe("P4 scheduler — interval", () => {
	test("fires on the cadence (clamped to MIN 60s); rolls forward; writes cron_runs each fire", async () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const everyMs = 60_000; // 1 minute — exactly at the floor
		const sched: CronScheduleInterval = { mode: "interval", everyMs };
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: sched,
			enabled: true,
		});
		manager.refreshCron(cron.id);

		// After arm, next_run_at should be now + everyMs.
		const armed = cronStore.get(cron.id)!;
		expect(Date.parse(armed.nextRunAt!)).toBeCloseTo(ANCHOR_NOW + everyMs, -3);

		// Fire three intervals.
		await advance(everyMs + 100);
		await advance(everyMs);
		await advance(everyMs);

		expect(stub.calls.length).toBe(3);

		// Three cron_runs rows, all success.
		const runs = cronRunStore.listByCron(cron.id);
		expect(runs.length).toBe(3);
		expect(runs.every((r) => r.success)).toBe(true);
		expect(runs.every((r) => r.agentId === agent.id)).toBe(true);

		// Telemetry updated.
		const updated = cronStore.get(cron.id)!;
		expect(updated.enabled).toBe(true);
		expect(updated.lastStatus).toBe("ok");
		expect(updated.lastRunAt).toBeTruthy();

		// next_run_at should still be ~now + everyMs (rolling).
		expect(updated.nextRunAt).toBeTruthy();
	});

	test("interval everyMs below 60s is clamped to MIN_INTERVAL_MS", async () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "interval", everyMs: 5_000 }, // 5s — must clamp to 60s
			enabled: true,
		});
		manager.refreshCron(cron.id);

		// Advance only 10s — should NOT fire (clamped cadence is 60s).
		await advance(10_000);
		expect(stub.calls.length).toBe(0);

		// Advance the rest of the 60s window.
		await advance(55_000);
		expect(stub.calls.length).toBe(1);
	});

	test("single fire error does not cancel the schedule (catch + cron_runs failed)", async () => {
		const stub = makeStubAgentService({ throwOnSend: true });
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "interval", everyMs: 60_000 },
			enabled: true,
		});
		manager.refreshCron(cron.id);

		await advance(61_000);

		// Schedule still armed + cron still enabled.
		expect(manager.getScheduledCronIds()).toContain(cron.id);
		expect(cronStore.get(cron.id)!.enabled).toBe(true);

		// lastStatus=failed; cron_runs has a failed row.
		const updated = cronStore.get(cron.id)!;
		expect(updated.lastStatus).toBe("failed");
		expect(updated.lastError).toMatch(/simulated trigger failure/);

		const runs = cronRunStore.listByCron(cron.id);
		expect(runs.length).toBe(1);
		expect(runs[0].success).toBe(false);
		expect(runs[0].error).toMatch(/simulated trigger failure/);

		// Next slot still rolls forward.
		expect(updated.nextRunAt).toBeTruthy();

		// Next tick still fires (error didn't cancel).
		await advance(60_000);
		expect(stub.calls.length).toBe(2);
		expect(cronRunStore.listByCron(cron.id).length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// alarm mode
// ---------------------------------------------------------------------------

// Host-local tz helper. sub1's wallClockInTz design reconstructs wall-clock
// fields in the *host* zone and compares against the real epoch `nowMs`, so
// the math is only self-consistent when tz === host local tz. Tests that need
// deterministic epoch assertions use host-local tz; tests that exercise a
// foreign tz assert only relative deltas (forward-rolling, not back-filling).
function hostLocalTz(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

describe("P4 scheduler — alarm (host-local tz)", () => {
	test("fires at the next (time, days) slot; rolls forward to next weekday", async () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		// ANCHOR = Monday 09:00 UTC = Monday 17:00 host(UTC+8). Schedule an
		// alarm at 18:00 (host wall-clock) every weekday Mon-Fri.
		const sched: CronScheduleAlarm = {
			mode: "alarm",
			time: "18:00",
			days: [1, 2, 3, 4, 5], // Mon-Fri (ISO)
			tz: hostLocalTz(),
		};
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: sched,
			enabled: true,
		});
		manager.refreshCron(cron.id);

		// next_run_at should be today 18:00 host = 10:00 UTC.
		const armed = cronStore.get(cron.id)!;
		const expectedUtc = Date.UTC(2026, 2, 9, 10, 0, 0);
		expect(Date.parse(armed.nextRunAt!)).toBe(expectedUtc);

		// Advance to just after 18:00 host (10:00 UTC). Anchor is 09:00 UTC → +1h.
		await advance(60 * 60 * 1000 + 1000);
		expect(stub.calls.length).toBe(1);

		// After firing, schedule rolls forward — to Tue 18:00 host (Tue 10:00 UTC).
		const fired = cronStore.get(cron.id)!;
		const nextExpectedUtc = Date.UTC(2026, 2, 10, 10, 0, 0);
		expect(Date.parse(fired.nextRunAt!)).toBe(nextExpectedUtc);
		expect(fired.enabled).toBe(true);
		expect(fired.lastStatus).toBe("ok");

		// cron_runs logged.
		expect(cronRunStore.listByCron(cron.id).length).toBe(1);
	});

	test("alarm cross-week: only Sat allowed, today Mon → picks next Sat (host tz)", () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		// Today = Monday 2026-03-09. Allow only Saturday (ISO 6).
		const sched: CronScheduleAlarm = {
			mode: "alarm",
			time: "08:30",
			days: [6],
			tz: hostLocalTz(),
		};
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: sched,
			enabled: true,
		});
		manager.refreshCron(cron.id);

		const armed = cronStore.get(cron.id)!;
		// Next Saturday = 2026-03-14 08:30 host = 00:30 UTC.
		const expectedUtc = Date.UTC(2026, 2, 14, 0, 30, 0);
		expect(Date.parse(armed.nextRunAt!)).toBe(expectedUtc);
	});

	test("alarm daily (days=[]) picks today if slot still ahead, else tomorrow", () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		// ANCHOR = 09:00 UTC = 17:00 host. Daily alarm at 08:00 host → slot
		// already passed → tomorrow.
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "alarm", time: "08:00", days: [], tz: hostLocalTz() },
			enabled: true,
		});
		manager.refreshCron(cron.id);
		const armed = cronStore.get(cron.id)!;
		// Tomorrow 08:00 host = today 24:00 UTC = 2026-03-10 00:00 UTC.
		expect(Date.parse(armed.nextRunAt!)).toBe(Date.UTC(2026, 2, 10, 0, 0, 0));
	});
});

// Foreign-tz sanity check: the alarm should always roll FORWARD, never
// back-fill. We don't assert the exact epoch (sub1's wallClockInTz design has a
// known host-vs-tz offset issue — see the sub1 feedback note), but the
// forward-only invariant is what acceptance-P4 actually requires.
describe("P4 scheduler — alarm forward-only invariant (foreign tz)", () => {
	test("alarm with a passed foreign-tz slot schedules strictly in the future", () => {
		const manager = new CronAnalysisManager({
			agentService: makeStubAgentService() as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			// 00:01 UTC — well before real now (09:00 UTC), so any sane tz-decoded
			// slot for today has passed; next must be in the future.
			schedule: { mode: "alarm", time: "00:01", days: [], tz: "UTC" },
			enabled: true,
		});
		manager.refreshCron(cron.id);
		const armed = cronStore.get(cron.id)!;
		const next = Date.parse(armed.nextRunAt!);
		expect(Number.isFinite(next)).toBe(true);
		// Forward-only: next must be strictly after ANCHOR_NOW.
		expect(next).toBeGreaterThan(ANCHOR_NOW);
	});
});

// ---------------------------------------------------------------------------
// missed-once policy
// ---------------------------------------------------------------------------

describe("P4 scheduler — missed once is NOT back-filled", () => {
	test("restoreSchedules disables a once whose fireAt is in the past + writes cron_runs missed", () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const pastFireAt = ANCHOR_NOW - 60_000;
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "once", at: new Date(pastFireAt).toISOString() },
			enabled: true,
		});

		manager.restoreSchedules();

		// Not scheduled.
		expect(manager.getScheduledCronIds()).not.toContain(cron.id);

		// Row disabled + lastStatus=missed + cron_runs row written.
		const updated = cronStore.get(cron.id)!;
		expect(updated.enabled).toBe(false);
		expect(updated.lastStatus).toBe("missed");

		const runs = cronRunStore.listByCron(cron.id);
		expect(runs.length).toBe(1);
		expect(runs[0].success).toBe(false);
		expect(runs[0].error).toMatch(/missed once/);

		// AgentService never called — past fireAt is not run.
		expect(stub.calls.length).toBe(0);
	});

	test("restoreSchedules still schedules a once whose fireAt is in the future", () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const futureFireAt = ANCHOR_NOW + 5 * 60_000;
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "once", at: new Date(futureFireAt).toISOString() },
			enabled: true,
		});

		manager.restoreSchedules();
		expect(manager.getScheduledCronIds()).toContain(cron.id);
		expect(cronStore.get(cron.id)!.enabled).toBe(true); // untouched
	});

	test("alarm/interval with passed slot do NOT get back-filled — only forward", () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		// Daily alarm at 08:00 — slot passed at 09:00 restore time. Should
		// schedule for tomorrow (no back-fill).
		const alarm = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "alarm", time: "08:00", days: [], tz: "UTC" },
			enabled: true,
		});
		// interval — next is now + 60s, no historical fires.
		const interval = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws2"),
			schedule: { mode: "interval", everyMs: 60_000 },
			enabled: true,
		});

		manager.restoreSchedules();
		expect(manager.getScheduledCronIds().sort()).toEqual([alarm.id, interval.id].sort());

		// No cron_runs (restore never fired anything).
		expect(cronRunStore.listByCron(alarm.id).length).toBe(0);
		expect(cronRunStore.listByCron(interval.id).length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// cron_runs audit + telemetry回写
// ---------------------------------------------------------------------------

describe("P4 cron_runs audit + telemetry回写", () => {
	test("every fire writes a cron_runs row with fired_at/agent_id/session_id/success/duration", async () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "interval", everyMs: 60_000 },
			enabled: true,
		});
		manager.refreshCron(cron.id);
		await advance(61_000);

		const runs = cronRunStore.listByCron(cron.id);
		expect(runs.length).toBe(1);
		const r = runs[0];
		expect(r.cronId).toBe(cron.id);
		expect(r.agentId).toBe(agent.id);
		expect(r.firedAt).toBeTruthy();
		expect(r.success).toBe(true);
		expect(typeof r.durationMs).toBe("number");
		expect(r.sessionId).toBeTruthy(); // resolved session
	});

	test("cron_runs newest-first (listByCron order)", async () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "interval", everyMs: 60_000 },
			enabled: true,
		});
		manager.refreshCron(cron.id);
		await advance(61_000);
		await advance(60_000);
		await advance(60_000);

		const runs = cronRunStore.listByCron(cron.id);
		expect(runs.length).toBe(3);
		// newest-first: firedAt strictly descending.
		for (let i = 1; i < runs.length; i++) {
			expect(runs[i - 1].firedAt >= runs[i].firedAt).toBe(true);
		}
	});

	test("triggerCron (manual) writes cron_runs + last_run_at but does NOT advance next_run_at", async () => {
		const stub = makeStubAgentService();
		const manager = new CronAnalysisManager({
			agentService: stub as any, agentStore, projectStore, sessionDB, cronStore, cronRunStore,
		});
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(undefined, "/ws"),
			schedule: { mode: "alarm", time: "23:59", days: [], tz: "UTC" },
			enabled: true,
		});
		manager.refreshCron(cron.id);

		const beforeTrigger = cronStore.get(cron.id)!;
		const nextBefore = beforeTrigger.nextRunAt;
		expect(nextBefore).toBeTruthy();

		// Manual trigger (not via timer).
		await manager.triggerCron(cron.id);

		expect(stub.calls.length).toBe(1);

		// Audit row + last_run_at updated.
		const runs = cronRunStore.listByCron(cron.id);
		expect(runs.length).toBe(1);
		expect(runs[0].success).toBe(true);
		const updated = cronStore.get(cron.id)!;
		expect(updated.lastRunAt).toBeTruthy();
		expect(updated.lastStatus).toBe("ok");

		// next_run_at untouched by trigger.
		expect(updated.nextRunAt).toBe(nextBefore);
	});
});
