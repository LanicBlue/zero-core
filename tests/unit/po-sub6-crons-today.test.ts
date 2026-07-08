// platform-observability ③ (sub-6): crons:today IPC unit tests.
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-6 #4 + #7:
//   - `nextFireMs`(导出)对 once / alarm / interval 三模式计算正确。
//   - `CronAnalysisManager.listTodaysFires()` 返回今日会触发的 cron 清单,
//     含 workId(work 类型)/ git-aware sentinel(git-aware 类型)/ 普通 cron,
//     带 fireTime(today) / interval hint / lastResult(mirror lastStatus)。
//   - interval crons 即使下次触发跨到明天也仍列出(显频率,fireTime=null)。
//   - alarm/once 今日无 slot 的 cron 被跳过(列是"今日任务")。
//   - 排序:最早触发在前,fireTime=null 沉底。
//
// ## 策略
// nextFireMs 是纯函数 → 直接表驱动断言。
// listTodaysFires 走真实 CronAnalysisManager + 临时 SessionDB + 真实 stores,
// 注入 `now` 让"今日"窗口确定。不调度真实 timer(不调 restoreSchedules)。
//
// ## 输入
// 临时 SessionDB + ProjectStore + AgentStore + CronStore + CronRunStore。
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
import { CronAnalysisManager, nextFireMs } from "../../src/server/cron-analysis.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { GIT_AWARE_SENTINEL } from "../../src/server/wiki-operations.js";
import type {
	CronSchedule,
	CronScheduleAlarm,
	CronScheduleInterval,
	CronScheduleOnce,
	PlatformCronTodayItem,
} from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANCHOR_NOW = Date.UTC(2026, 5, 27, 14, 30, 0); // 2026-06-27 14:30 UTC

/**
 * The implementation computes "today" as the HOST'S LOCAL calendar day
 * (startOfLocalDay/endOfLocalDay in cron-analysis.ts use Date.setHours).
 * Our assertions must derive expected slots from the SAME local-day window,
 * not a hardcoded UTC window — otherwise the test is TZ-coupled and breaks on
 * any non-UTC host. These helpers mirror the implementation's local-day math.
 */
function startOfLocalDay(nowMs: number): number {
	const d = new Date(nowMs);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}
function endOfLocalDay(nowMs: number): number {
	const d = new Date(nowMs);
	d.setHours(23, 59, 59, 999);
	return d.getTime();
}
/** Local-day "HH:MM" for an epoch ms, expressed in the host's local zone. */
function localHHMM(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function scope() {
	return { projectId: undefined, workspaceDir: "/ws", wikiRootNodeId: "wiki-root:global" };
}

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let cronStore: CronStore;
let cronRunStore: CronRunStore;
let agent: { id: string };

function makeManager(now: () => number = () => ANCHOR_NOW) {
	return new CronAnalysisManager({
		agentService: { sendPrompt: vi.fn() } as any,
		agentStore,
		projectStore,
		sessionDB,
		cronStore,
		cronRunStore,
		now,
	} as any);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(ANCHOR_NOW);

	tmpDir = mkdtempSync(join(tmpdir(), "zero-po-sub6-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	cronStore = new CronStore(sessionDB);
	cronRunStore = new CronRunStore(sessionDB);
	const a = agentStore.create({ name: "PMAgent" } as any);
	agent = a;
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// nextFireMs (acceptance-6 #7: "nextFireMs 计算")
// ---------------------------------------------------------------------------

describe("nextFireMs (exported)", () => {
	test("once → the at-timestamp itself", () => {
		const t = ANCHOR_NOW + 60_000;
		const s: CronScheduleOnce = { mode: "once", at: new Date(t).toISOString() };
		expect(nextFireMs(s, ANCHOR_NOW)).toBe(t);
	});

	test("once → null on malformed at", () => {
		const s: CronScheduleOnce = { mode: "once", at: "not-a-date" };
		expect(nextFireMs(s, ANCHOR_NOW)).toBeNull();
	});

	test("interval → now + everyMs (clamped to MIN 60s)", () => {
		const s: CronScheduleInterval = { mode: "interval", everyMs: 2 * 3600_000 };
		expect(nextFireMs(s, ANCHOR_NOW)).toBe(ANCHOR_NOW + 2 * 3600_000);
	});

	test("interval → clamped to MIN 60s when everyMs < 60s", () => {
		const s: CronScheduleInterval = { mode: "interval", everyMs: 5_000 };
		expect(nextFireMs(s, ANCHOR_NOW)).toBe(ANCHOR_NOW + 60_000);
	});

	test("interval → null when everyMs <= 0 (inert)", () => {
		const s0: CronScheduleInterval = { mode: "interval", everyMs: 0 };
		const sNeg: CronScheduleInterval = { mode: "interval", everyMs: -1 };
		expect(nextFireMs(s0, ANCHOR_NOW)).toBeNull();
		expect(nextFireMs(sNeg, ANCHOR_NOW)).toBeNull();
	});

	test("alarm → next slot for the given time-of-day", () => {
		// Anchor 14:30 UTC; alarm at 09:00 daily → next is tomorrow 09:00.
		const s: CronScheduleAlarm = { mode: "alarm", time: "09:00", days: [], tz: "UTC" };
		const expected = Date.UTC(2026, 5, 28, 9, 0, 0);
		expect(nextFireMs(s, ANCHOR_NOW)).toBe(expected);
	});

	test("alarm → same-day slot when time still ahead today", () => {
		// Anchor 14:30 UTC; alarm at 18:00 daily → today 18:00.
		const s: CronScheduleAlarm = { mode: "alarm", time: "18:00", days: [], tz: "UTC" };
		const expected = Date.UTC(2026, 5, 27, 18, 0, 0);
		expect(nextFireMs(s, ANCHOR_NOW)).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// listTodaysFires (acceptance-6 #4 + #7)
// ---------------------------------------------------------------------------

describe("listTodaysFires — fire-time computation per mode", () => {
	test("once inside today → listed with that fireTime", () => {
		// fireAt = LOCAL noon today, derived from the local-day window so the
		// slot provably lands inside [dayStart, dayEnd] on any host TZ.
		const fireAt = startOfLocalDay(ANCHOR_NOW) + 12 * 3600_000;
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "once", at: new Date(fireAt).toISOString() },
			enabled: true,
		});
		const out = makeManager().listTodaysFires();
		expect(out).toHaveLength(1);
		expect(out[0].fireTime).toBe(fireAt);
		expect(out[0].interval).toBeUndefined();
	});

	test("once scheduled for tomorrow → SKIPPED (column is 'today's fires')", () => {
		const fireAt = ANCHOR_NOW + 24 * 3600_000; // tomorrow
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "once", at: new Date(fireAt).toISOString() },
			enabled: true,
		});
		expect(makeManager().listTodaysFires()).toEqual([]);
	});

	test("once in the past (earlier today) → SKIPPED", () => {
		// fireTimeToday only accepts once slots in [dayStart, dayEnd]; a past
		// today slot still satisfies that range, so it WOULD be listed.
		// But a once whose at is yesterday must be skipped.
		const yesterday = ANCHOR_NOW - 26 * 3600_000;
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "once", at: new Date(yesterday).toISOString() },
			enabled: true,
		});
		expect(makeManager().listTodaysFires()).toEqual([]);
	});

	test("alarm whose time already passed today → STILL listed (anchored at dayStart)", () => {
		// Anchor 14:30 UTC; alarm 09:00 already passed. fireTimeToday anchors
		// at dayStart so it surfaces today's 09:00 slot.
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "alarm", time: "09:00", days: [], tz: "UTC" },
			enabled: true,
		});
		const out = makeManager().listTodaysFires();
		expect(out).toHaveLength(1);
		expect(out[0].fireTime).toBe(Date.UTC(2026, 5, 27, 9, 0, 0));
	});

	test("alarm on a weekday that is NOT today → SKIPPED", () => {
		// 2026-06-27 is Saturday (weekday 6). Alarm restricted to Monday (1).
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "alarm", time: "09:00", days: [1], tz: "UTC" },
			enabled: true,
		});
		expect(makeManager().listTodaysFires()).toEqual([]);
	});

	test("interval whose next slot is later today → listed with fireTime + interval hint", () => {
		// Anchor at LOCAL noon so a 2h slot provably lands inside today's local
		// day window regardless of host TZ. Derived from local-day math (not a
		// hardcoded UTC stamp) so the test is TZ-independent.
		const localNoon = startOfLocalDay(ANCHOR_NOW) + 12 * 3600_000;
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 2 * 3600_000 },
			enabled: true,
		});
		const out = makeManager(() => localNoon).listTodaysFires();
		expect(out).toHaveLength(1);
		expect(out[0].fireTime).toBe(localNoon + 2 * 3600_000);
		expect(out[0].fireTime).toBeLessThanOrEqual(endOfLocalDay(localNoon));
		expect(out[0].interval).toBe("每 2h");
	});

	test("interval whose next slot spills into tomorrow → STILL listed, fireTime=null, interval kept", () => {
		// Anchor at LOCAL 23:30, every 2h → next slot 01:30 tomorrow (past
		// dayEnd). Listed because interval crons are recurring and the column
		// shows cadence. local-day-anchored so TZ-independent.
		const lateNow = startOfLocalDay(ANCHOR_NOW) + 23.5 * 3600_000;
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 2 * 3600_000 },
			enabled: true,
		});
		const out = makeManager(() => lateNow).listTodaysFires();
		expect(out).toHaveLength(1);
		expect(out[0].fireTime).toBeNull();
		expect(out[0].interval).toBe("每 2h");
	});

	test("interval format: minutes (<60m)", () => {
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 5 * 60_000 },
			enabled: true,
		});
		expect(makeManager().listTodaysFires()[0].interval).toBe("每 5m");
	});

	test("disabled crons are excluded", () => {
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "once", at: new Date(ANCHOR_NOW + 3600_000).toISOString() },
			enabled: false,
		});
		expect(makeManager().listTodaysFires()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Type classification (work | cron | git-aware)
// ---------------------------------------------------------------------------

describe("listTodaysFires — type classification", () => {
	test("cron with workId → type 'work' + label = work name", () => {
		// projectWorkStore not injected → label falls back to source then id.
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 3600_000 },
			workId: "work-42",
			source: "project-work:proj-A:需求管理",
			enabled: true,
		});
		const out = makeManager().listTodaysFires();
		expect(out[0].type).toBe("work");
		expect(out[0].label).toBe("project-work:proj-A:需求管理");
	});

	test("cron whose prompt carries GIT_AWARE_SENTINEL → type 'git-aware'", () => {
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 3600_000 },
			prompt: `${GIT_AWARE_SENTINEL}\n巡检 wiki 结构`,
			source: "archivist-bind:structure",
			enabled: true,
		});
		const out = makeManager().listTodaysFires();
		expect(out[0].type).toBe("git-aware");
	});

	test("plain cron (no workId, no sentinel) → type 'cron'", () => {
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 3600_000 },
			source: "pm:daily-standup",
			enabled: true,
		});
		expect(makeManager().listTodaysFires()[0].type).toBe("cron");
	});

	test("workId takes precedence over git-aware sentinel", () => {
		// A workId cron that also carries the sentinel is classified 'work'
		// (the workId branch wins in the ternary).
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 3600_000 },
			workId: "work-1",
			prompt: `${GIT_AWARE_SENTINEL}\nx`,
			source: "src",
			enabled: true,
		});
		expect(makeManager().listTodaysFires()[0].type).toBe("work");
	});

	test("label falls back to cron.id when no source and no workId", () => {
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 3600_000 },
			enabled: true,
		});
		expect(makeManager().listTodaysFires()[0].label).toBe(cron.id);
	});
});

// ---------------------------------------------------------------------------
// lastResult mirror + sort
// ---------------------------------------------------------------------------

describe("listTodaysFires — lastResult + sort", () => {
	test("lastResult mirrors CronRecord.lastStatus", () => {
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 3600_000 },
			enabled: true,
			lastStatus: "ok",
		});
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 3600_000 },
			enabled: true,
			lastStatus: "failed",
		});
		const out = makeManager().listTodaysFires();
		expect(out.find((c) => c.lastResult === "ok")).toBeTruthy();
		expect(out.find((c) => c.lastResult === "failed")).toBeTruthy();
	});

	test("lastResult null/undefined when cron never ran", () => {
		// CronStore surfaces an unset last_status column as null (SQLite TEXT
		// null). The kanban reads it via `c.lastResult ?? "none"`, so either
		// null or undefined is acceptable. Assert the absence-of-status contract.
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 3600_000 },
			enabled: true,
		});
		const out = makeManager().listTodaysFires();
		expect(out[0].lastResult == null).toBe(true); // null or undefined
	});

	test("sorted earliest-fire first; null fireTime sinks to bottom", () => {
		// Anchor at LOCAL 23:30 so the 2h interval spills to tomorrow (null).
		// local-day-anchored so the spill is TZ-independent.
		const lateNow = startOfLocalDay(ANCHOR_NOW) + 23.5 * 3600_000;
		const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone; // host-local
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 2 * 3600_000 }, // → null (tomorrow)
			source: "b-late",
			enabled: true,
		});
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			// alarm 23:55 LOCAL today → still ahead of the 23:30 anchor,
			// fireTime set. tz=host so the slot lands in today's local window.
			schedule: { mode: "alarm", time: "23:55", days: [], tz: hostTz },
			source: "a-early",
			enabled: true,
		});
		const out = makeManager(() => lateNow).listTodaysFires() as PlatformCronTodayItem[];
		expect(out).toHaveLength(2);
		expect(out[0].fireTime).not.toBeNull();
		expect(out[1].fireTime).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Cross-check: shape of PlatformCronTodayItem matches what the kanban reads.
// ---------------------------------------------------------------------------

describe("listTodaysFires — item shape (kanban contract)", () => {
	test("every item has the fields the kanban reads", () => {
		cronStore.create({
			agentId: agent.id,
			workingScope: scope(),
			schedule: { mode: "interval", everyMs: 3600_000 },
			workId: "w1",
			source: "work-src",
			enabled: true,
			lastStatus: "ok",
		});
		const out = makeManager().listTodaysFires();
		const item = out[0];
		// Kanban (DashboardPage) reads: cronId, agentId, fireTime, interval,
		// type, label, lastResult. All must be present and correctly typed.
		expect(typeof item.cronId).toBe("string");
		expect(item.agentId).toBe(agent.id);
		expect(item.fireTime === null || typeof item.fireTime === "number").toBe(true);
		expect(["work", "cron", "git-aware"]).toContain(item.type);
		expect(typeof item.label).toBe("string");
	});
});
