// Cron 调度管理 (v0.8 M1 — cron 一等公民;P4 — 三模式 mode-aware firing)
//
// # 文件说明书
//
// ## 核心功能
// 扫描 cron 表 (CronStore) 为每条 enabled cron 按 schedule.mode 注册一个定时器,
// 按时触发并在 cron_runs 落一条审计记录、回写 last_run_at/last_status/next_run_at:
//   - once    → setTimeout 到 schedule.at;触发后 enabled=false + 摘定时器
//   - alarm   → setTimeout 到下一次满足 (time, days, tz);触发后滚动重算下一次
//   - interval→ setInterval(schedule.everyMs, min 60000)
//   1. cron.workingScope 即 session 上下文 bundle;
//   2. 带 projectId 的 cron 走 M0 的 resolveSessionByRoleProject 找/建
//      `{agentId, projectId}` session;不带 projectId 的观察 cron 走
//      agentId-keyed main session 找/建;
//   3. 调 AgentService.sendPrompt(prompt, agent, sessionId) 在该 session 跑。
//
// 同一个 agent 可以有多条 cron (各带不同 scope),M0 已删 AgentRecord.cronSchedule
// 字段,这里从「扫 agentStore.cronSchedule」彻底切到「扫 cron 表」(决策 6/41/42)。
//
// ## 输入
// - AgentService (跑 prompt)
// - CoreDatabase / ProjectStore (路由 helper 依赖)
// - CronStore (调度源)
// - CronRunStore (审计日志写入,P4)
// - AgentStore (取 agent record)
// - 可选 WikiRootResolver (默认占位,M2 全局 wiki 树接入)
//
// ## 输出
// - CronAnalysisManager 类
//
// ## 定位
// 服务层,被 server/index.ts / IPC core.ts 启动时实例化和恢复。
//
// ## 维护规则
// - 单次触发错误不取消调度,仅 catch + log + 落 cron_runs failed
// - enabled=false 的 cron 不注册定时器
// - interval 最小间隔 1 分钟 (60000ms),低于该值的会被夹到 60000
// - restoreSchedules() 扫描全部 enabled cron 逐条 scheduleCron;
//   missed once 不补(fireAt 已过 → enabled=false + 记 cron_runs missed)
//

import type { AgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";

import type { ArchivistGit } from "./archivist-git.js";
import { isGitAwarePrompt, stripGitAwareSentinel, agentHasTool } from "./wiki-operations.js";
import type { CoreDatabase } from "./core-database.js";
import type { CronStore, CronRunStore } from "./cron-store.js";
import type {
	CronRecord,
	CronSchedule,
	CronScheduleAlarm,
	CronScheduleInterval,
	CronScheduleOnce,
	CronLastStatus,
	PlatformCronTodayItem,
	SessionContextBundle,
	AgentRecord,
} from "../shared/types.js";
import {
	resolveSessionByRoleProject,
	type WikiRootResolver,
} from "./session-context-router.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Mode-aware scheduling helpers
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 60 * 1000; // §9.2: interval floor = 1 minute

/**
 * Compute the next fire timestamp (epoch ms) for an `alarm` schedule, relative
 * to `nowMs`. Walks day-by-day from "today" (in the schedule's tz) forward up
 * to 8 days (covers every weekday filter), picking the first day that
 * (a) is in `days` (or `days` is empty = every day) and (b) whose [time]
 * is strictly after `nowMs`. Rolls over to the next matching weekday when
 * today's slot already passed.
 *
 * §9.2: alarm fires daily at `time` on the listed ISO weekday numbers
 * (1=Mon … 7=Sun; empty = every day); `tz` is IANA.
 *
 * TIME-REFERENCE INVARIANT: the returned value is a *real UTC epoch* (the
 * instant the wall-clock `time` strikes in `tz`), and the comparison against
 * `nowMs` (also a real UTC epoch) is therefore apples-to-apples. The internal
 * helper `nextSlotInTzAsEpoch` builds the slot directly as a UTC epoch via
 * Intl so neither side of the comparison is built in the host local zone —
 * this is what makes the math correct when `tz` ≠ host local tz.
 */
function nextAlarmMs(sched: CronScheduleAlarm, nowMs: number): number {
	const tz = sched.tz || undefined;
	// Wall-clock "today" in the schedule's tz, as Y/M/D fields plus the
	// weekday. We use Intl to decode now→tz-fields so the day-walk starts in
	// the *schedule's* local calendar, not the host's.
	const startFields = tzFields(nowMs, tz);

	for (let offset = 0; offset < 8; offset++) {
		// Build the candidate slot's wall-clock Y/M/D in tz by walking forward
		// from startFields using a real Date carrying those tz fields, then
		// convert the resulting wall-clock Y/M/D back to a real UTC epoch at
		// the requested (hh:mm). All epoch math goes through nextSlotInTzAsEpoch
		// so host-zone contamination can't sneak back in.
		const dayDate = new Date(
			Date.UTC(startFields.year, startFields.month - 1, startFields.day),
		);
		dayDate.setUTCDate(dayDate.getUTCDate() + offset);
		// ISO weekday: 1=Mon..7=Sun, derived from the UTC-date walk. Because
		// startFields comes from a tz-decoded "today" and the offset is a
		// whole-day shift, the weekday we read here is the weekday *in tz*
		// for the slot's calendar date.
		const isoWeekday = dayDate.getUTCDay() === 0 ? 7 : dayDate.getUTCDay();
		if (sched.days.length > 0 && !sched.days.includes(isoWeekday)) continue;

		const [hh, mm] = parseHHMM(sched.time);
		const slotMs = nextSlotInTzAsEpoch(
			dayDate.getUTCFullYear(),
			dayDate.getUTCMonth() + 1,
			dayDate.getUTCDate(),
			hh,
			mm,
			tz,
		);
		if (slotMs > nowMs) return slotMs;
	}
	// Should be unreachable (8-day scan covers every weekday). Fallback:
	// same time tomorrow, computed as a real UTC epoch.
	const [hh, mm] = parseHHMM(sched.time);
	const tomorrow = new Date(Date.UTC(startFields.year, startFields.month - 1, startFields.day));
	tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
	return nextSlotInTzAsEpoch(
		tomorrow.getUTCFullYear(),
		tomorrow.getUTCMonth() + 1,
		tomorrow.getUTCDate(),
		hh,
		mm,
		tz,
	);
}

/**
 * Decode a real UTC epoch (`nowMs`) into the wall-clock Y/M/D weekday fields
 * it represents in `tz`. Used so the day-walk in nextAlarmMs starts from the
 * schedule's local calendar day rather than the host's. Returns UTC-tagged
 * fields (1-based month, 1-based ISO weekday) — never touched by host-zone
 * setters.
 */
function tzFields(
	nowMs: number,
	tz: string | undefined,
): { year: number; month: number; day: number; weekday: number } {
	if (!tz) {
		const d = new Date(nowMs);
		const isoWeekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
		return {
			year: d.getUTCFullYear(),
			month: d.getUTCMonth() + 1,
			day: d.getUTCDate(),
			weekday: isoWeekday,
		};
	}
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			year: "numeric", month: "2-digit", day: "2-digit",
			weekday: "short",
			hour12: false,
		}).formatToParts(new Date(nowMs));
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
		const year = parseInt(get("year"), 10);
		const month = parseInt(get("month"), 10);
		const day = parseInt(get("day"), 10);
		// Re-derive the ISO weekday from the (year, month, day) calendar date
		// so we don't depend on Intl's localized weekday string. This is the
		// weekday of the slot's calendar date, which is what `days` filters on.
		const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
		const weekday = dow === 0 ? 7 : dow;
		return { year, month, day, weekday };
	} catch {
		const d = new Date(nowMs);
		const isoWeekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
		return {
			year: d.getUTCFullYear(),
			month: d.getUTCMonth() + 1,
			day: d.getUTCDate(),
			weekday: isoWeekday,
		};
	}
}

/**
 * Convert a wall-clock (year, month, day, hh, mm) in `tz` into the *real UTC
 * epoch ms* at which that wall-clock instant occurs. This is the inverse of
 * `tzFields` and is what keeps every epoch in nextAlarmMs anchored to UTC
 * rather than the host zone.
 *
 * Algorithm: we want the UTC instant whose tz-decoded wall-clock fields equal
 * the input. Start from the naive guess (treating the wall-clock fields AS
 * UTC), measure the tz offset at that guess via Intl, then correct. Because
 * tz offsets change only at whole-minute boundaries and the input fields are
 * minute-granular, two iterations are sufficient to converge — but we cap at
 * a handful of iterations with an epsilon guard to be defensive against
 * pathological tz data.
 */
function nextSlotInTzAsEpoch(
	year: number,
	month: number, // 1-based
	day: number,
	hh: number,
	mm: number,
	tz: string | undefined,
): number {
	const target = Date.UTC(year, month - 1, day, hh, mm, 0, 0);
	if (!tz) return target;
	try {
		let guess = target;
		// Converge: at each step, format `guess` into tz fields, measure how
		// far those tz fields are from the *target* wall-clock fields, and
		// subtract that delta from guess. The mapping is monotone with a
		// locally-constant offset, so this converges in 1-2 steps.
		for (let iter = 0; iter < 5; iter++) {
			const f = tzWallClockFields(guess, tz);
			const delta = f - target;
			if (Math.abs(delta) < 1000) return guess - delta;
			guess = guess - delta;
		}
		return guess;
	} catch {
		return target;
	}
}

/**
 * Format `epochMs` into the wall-clock fields it represents in `tz`, returned
 * as the equivalent "naive UTC epoch" you'd get by treating those fields AS
 * UTC (via Date.UTC). Subtracting this from `epochMs` yields the tz's UTC
 * offset in ms at that instant; comparing it to a target naive epoch tells
 * you whether `epochMs` is before/after the desired tz wall-clock instant.
 */
function tzWallClockFields(epochMs: number, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit",
		hour12: false,
	}).formatToParts(new Date(epochMs));
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
	const hourRaw = get("hour");
	const hour = hourRaw === "24" ? 0 : parseInt(hourRaw, 10);
	return Date.UTC(
		parseInt(get("year"), 10),
		parseInt(get("month"), 10) - 1,
		parseInt(get("day"), 10),
		hour,
		parseInt(get("minute"), 10),
		parseInt(get("second"), 10),
	);
}

function parseHHMM(time: string): [number, number] {
	const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
	if (!m) return [9, 0];
	const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
	const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
	return [h, mm];
}

/**
 * Compute the next fire timestamp (epoch ms) for any schedule relative to
 * `nowMs`. Returns null for inert schedules (interval everyMs<=0 with enabled
 * handled by caller, or malformed shapes) — caller treats null as "no fire".
 *
 * platform-observability ③ (sub-6): exported so the `crons:today` IPC can
 * compute today's fire times without duplicating the mode-aware math. The
 * kanban's "今日任务" column walks enabled crons and calls this per cron.
 */
export function nextFireMs(sched: CronSchedule, nowMs: number): number | null {
	switch (sched.mode) {
		case "once": {
			const t = Date.parse(sched.at);
			return Number.isFinite(t) ? t : null;
		}
		case "alarm":
			return nextAlarmMs(sched, nowMs);
		case "interval": {
			if (!sched.everyMs || sched.everyMs <= 0) return null;
			const ms = Math.max(MIN_INTERVAL_MS, sched.everyMs);
			return nowMs + ms;
		}
		default:
			return null;
	}
}

/** Format an epoch ms as ISO 8601 for telemetry columns. */
function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// ─── platform-observability ③ (sub-6): today-fire helpers ───────────────────
// Used by listTodaysFires (CronAnalysisManager) to compute each cron's next
// slot inside today's local calendar day. Kept module-local — only
// listTodaysFires consumes them.

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

/**
 * Compute this cron's next fire slot that lands inside today's local day
 * [dayStart, dayEnd]. Returns null when no slot lands today.
 *   - once    → its single at-timestamp if it falls inside today.
 *   - alarm   → nextFireMs from dayStart (so an already-passed morning alarm
 *               still surfaces as "fired today"); accept if it lands in today.
 *   - interval→ nextFireMs from now; the column shows the next upcoming slot
 *               (multiple same-day fires are summarized via the `interval` hint,
 *               not enumerated).
 *
 * Acceptance-6 #4: "interval 型显频率" — interval crons are listed with their
 * interval hint even when the next slot is later today; fireTime is the next
 * upcoming slot (or null only if everyMs<=0 / inert).
 */
function fireTimeToday(sched: CronSchedule, nowMs: number, dayStart: number, dayEnd: number): number | null {
	switch (sched.mode) {
		case "once": {
			const t = Date.parse(sched.at);
			if (!Number.isFinite(t)) return null;
			return t >= dayStart && t <= dayEnd ? t : null;
		}
		case "alarm": {
			// Anchor at dayStart so an alarm whose time already passed today
			// still resolves to today's slot (not tomorrow's).
			const fromDayStart = nextFireMs(sched, dayStart);
			if (fromDayStart === null) return null;
			return fromDayStart >= dayStart && fromDayStart <= dayEnd ? fromDayStart : null;
		}
		case "interval": {
			if (!sched.everyMs || sched.everyMs <= 0) return null;
			// Next upcoming slot from now; if it spills past today, the cron's
			// next fire is tomorrow — show null but the row still lists with the
			// interval hint so the user sees the recurring cadence.
			const next = nextFireMs(sched, nowMs);
			if (next === null) return null;
			return next <= dayEnd ? next : null;
		}
		default:
			return null;
	}
}

/** Render everyMs as a short Chinese-frequency hint (e.g. "每 2h" / "每 30m"). */
function formatEveryMs(everyMs: number): string {
	const ms = Math.max(MIN_INTERVAL_MS, everyMs);
	const min = Math.round(ms / 60000);
	if (min < 60) return `每 ${min}m`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `每 ${hr}h`;
	const day = Math.round(hr / 24);
	return `每 ${day}d`;
}

// ---------------------------------------------------------------------------
// CronAnalysisManager
// ---------------------------------------------------------------------------

export interface CronAnalysisDeps {
	agentService: AgentService;
	agentStore: AgentStore;
	projectStore: ProjectStore;
	sessionDB: CoreDatabase;
	cronStore: CronStore;
	/** P4: per-fire audit log sink. Optional so legacy callers still build. */
	cronRunStore?: CronRunStore;
	/** Optional override; defaults to M0's placeholder resolver. */
	resolveWikiRoot?: WikiRootResolver;
	/**
	 * v0.8 archivist 长期绑定:project-scoped cron 用 sendProjectPrompt 注入
	 * wikiStore/projectContext(去-role)。未注入时 project cron 退回 sendPrompt
	 * (无 wiki 维护能力,仅观察/巡检)。
	 */
	
	/**
	 * v0.8 阶段3 git-aware cron:触发前用 archivistGit.getCurrentMainRef 检查
	 * git main ref 变化,无变化跳过(实现"git 变更即时响应",复用 cron 轮询)。
	 */
	archivistGit?: ArchivistGit;
	/**
	 * v0.8 project-work 系统:带 workId 的 cron 触发时,agent + actionPrompt 从
	 * work 解析(覆盖 cron 自带的)。未注入时 workId cron 退回 cron 自带 prompt。
	 */
	projectWorkStore?: import("./project-work-store.js").ProjectWorkStore;
	/**
	 * Optional clock override (defaults to Date.now). Injected by tests to
	 * drive the scheduler without waiting on real time; production callers
	 * leave it unset.
	 */
	now?: () => number;
}

// tool-decoupling sub-6: process-wide CronAnalysisManager singleton.
// Cron tool's 'today' action reads this directly (no ctx injection), same
// pattern as getAgentService / getManagementService. server/index.ts calls
// setCronAnalysisManager(inst) right after construction, before any tool call
// (well before restoreAllSessions / REST mount). headless / non-zero session
// → undefined → the 'today' action degrades to a friendly error (no crash).
let _cronAnalysisManager: CronAnalysisManager | undefined;
export function getCronAnalysisManager(): CronAnalysisManager | undefined {
	return _cronAnalysisManager;
}
export function setCronAnalysisManager(m: CronAnalysisManager | undefined): void {
	_cronAnalysisManager = m;
}


export class CronAnalysisManager {
	private deps: CronAnalysisDeps;
	/** cron.id → timer. One timer per enabled cron entry. */
	private scheduledJobs: Map<string, NodeJS.Timeout> = new Map();
	private now: () => number;

	constructor(deps: CronAnalysisDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
	}

	// ─── Public API ──────────────────────────────────────────────────

	/**
	 * 启动时恢复所有 enabled cron 的定时任务 (M1: 扫 cron 表;P4: mode-aware
	 * firing + missed-once 不补)。
	 *
	 * For each enabled cron:
	 *   - once whose fireAt already passed → mark enabled=false, write a
	 *     cron_runs row with status="missed", and do NOT register a timer
	 *     (§9.2: missed once is not back-filled).
	 *   - alarm/interval → scheduleCron recomputes the next future slot; past
	 *     alarms/intervals just roll forward (no back-fill).
	 */
	restoreSchedules(): void {
		const crons = this.deps.cronStore.listEnabled();
		let restored = 0;
		let missed = 0;
		for (const cron of crons) {
			if (cron.schedule.mode === "once") {
				const fireAt = Date.parse(cron.schedule.at);
				if (Number.isFinite(fireAt) && fireAt <= this.now()) {
					// missed once — disable + audit + skip scheduling.
					this.handleMissedOnce(cron, fireAt);
					missed++;
					continue;
				}
			}
			this.scheduleCron(cron);
			restored++;
		}
		log.debug(
			"cron",
			`Restored ${restored} enabled cron entr${restored === 1 ? "y" : "ies"}${missed > 0 ? `; ${missed} missed once disabled` : ""}`,
		);
	}

	/**
	 * platform-observability ③ (sub-6): today's planned cron fires, for the
	 * kanban's "今日任务" column via the `crons:today` IPC. Walks enabled crons
	 * and computes each one's next fire slot that lands inside TODAY's local
	 * calendar day. Returns one PlatformCronTodayItem per cron (fireTime=null
	 * when the cron won't fire today). Type tag: work (cron.workId) /
	 * git-aware (prompt sentinel) / cron (default). label = work name when a
	 * workId cron resolves, else cron.source or cron.id.
	 *
	 * "Today" = the host's local calendar day (startOfDay..endOfDay), in line
	 * with how the user reads the kanban. For interval crons the next slot is
	 * reported once plus an `interval` hint (e.g. "每 2h") — multiple same-day
	 * fires are not enumerated to keep the column readable.
	 */
	listTodaysFires(): PlatformCronTodayItem[] {
		const now = this.now();
		const dayStart = startOfLocalDay(now);
		const dayEnd = endOfLocalDay(now);
		const workStore = this.deps.projectWorkStore;
		const crons = this.deps.cronStore.listEnabled();
		const out: PlatformCronTodayItem[] = [];
		for (const cron of crons) {
			const fireTime = fireTimeToday(cron.schedule, now, dayStart, dayEnd);
			if (fireTime === null && cron.schedule.mode !== "interval") {
				// alarm/once that has no slot today → still list with null so the
				// user sees the cron exists but isn't firing today? Per design the
				// column is "today's fires" — skip crons that won't fire today.
				continue;
			}
			const type: PlatformCronTodayItem["type"] = cron.workId
				? "work"
				: isGitAwarePrompt(cron.prompt)
					? "git-aware"
					: "cron";
			let label: string;
			if (cron.workId) {
				const work = workStore?.get(cron.workId);
				label = work?.name ?? cron.source ?? cron.id;
			} else if (cron.source) {
				label = cron.source;
			} else {
				label = cron.id;
			}
			out.push({
				cronId: cron.id,
				agentId: cron.agentId,
				fireTime,
				interval: cron.schedule.mode === "interval" && cron.schedule.everyMs > 0
					? formatEveryMs(cron.schedule.everyMs)
					: undefined,
				type,
				label,
				lastResult: cron.lastStatus,
			});
		}
		// Earliest-fire first; nulls (won't fire today) sink to the bottom.
		out.sort((a, b) => {
			if (a.fireTime === null && b.fireTime === null) return a.label.localeCompare(b.label);
			if (a.fireTime === null) return 1;
			if (b.fireTime === null) return -1;
			return a.fireTime - b.fireTime;
		});
		return out;
	}

	/**
	 * §9.2: missed once policy — fireAt already in the past at startup. Mark
	 * the row disabled, set lastStatus="missed", and drop a cron_runs row so
	 * the audit trail records that the once-shot was lost (not silently).
	 */
	private handleMissedOnce(cron: CronRecord, fireAt: number): void {
		try {
			this.deps.cronStore.update(cron.id, {
				enabled: false,
				lastRunAt: iso(this.now()),
				lastStatus: "missed",
				nextRunAt: undefined,
			} as any);
			this.deps.cronRunStore?.create({
				cronId: cron.id,
				firedAt: iso(this.now()),
				agentId: cron.agentId,
				success: false,
				error: `missed once: scheduled fireAt ${iso(fireAt)} already passed at startup`,
			} as any);
		} catch (err) {
			log.error("cron", `Failed to record missed-once for ${cron.id}: ${(err as Error).message}`);
		}
	}

	/**
	 * 为单条 cron 注册定时触发 (mode-aware)。先清已有,再按 mode 注册新 timer。
	 *
	 * - once    → setTimeout 到 fireAt;fireCron 内会置 enabled=false + 摘 timer。
	 * - alarm   → setTimeout 到下一次满足 (time, days, tz);fireCron 内滚动重算。
	 * - interval→ setInterval(everyMs, min 60000)。
	 *
	 * 单次触发错误不取消调度 (catch + log + 落 cron_runs failed)。
	 */
	scheduleCron(cron: CronRecord): void {
		this.unscheduleCron(cron.id);

		if (!cron.enabled) return;

		const nowMs = this.now();
		const next = nextFireMs(cron.schedule, nowMs);
		if (next === null) {
			// Inert schedule (e.g. interval everyMs=0). Nothing to arm.
			this.persistNextRunAt(cron.id, undefined);
			return;
		}

		switch (cron.schedule.mode) {
			case "once":
				this.armOnce(cron, next);
				break;
			case "alarm":
				this.armAlarm(cron, next);
				break;
			case "interval":
				this.armInterval(cron, cron.schedule);
				break;
		}
	}

	private armOnce(cron: CronRecord, fireAt: number): void {
		const delay = Math.max(0, fireAt - this.now());
		const timer = setTimeout(() => {
			void this.fireCron(cron.id, cron.schedule).catch((err) => {
				// Errors must not crash the runtime; fireCron already logged +
				// recorded cron_runs failed. Belt-and-suspenders here.
				log.error("cron", `once timer error for ${cron.id}: ${(err as Error).message}`);
			});
		}, delay);
		if (timer.unref) timer.unref();
		this.scheduledJobs.set(cron.id, timer);
		this.persistNextRunAt(cron.id, iso(fireAt));
		log.debug("cron", `Scheduled cron ${cron.id} (once @ ${iso(fireAt)}, agent ${cron.agentId})`);
	}

	private armAlarm(cron: CronRecord, fireAt: number): void {
		const delay = Math.max(0, fireAt - this.now());
		const timer = setTimeout(() => {
			void this.fireCron(cron.id, cron.schedule).catch((err) => {
				log.error("cron", `alarm timer error for ${cron.id}: ${(err as Error).message}`);
			});
		}, delay);
		if (timer.unref) timer.unref();
		this.scheduledJobs.set(cron.id, timer);
		this.persistNextRunAt(cron.id, iso(fireAt));
		log.debug("cron", `Scheduled cron ${cron.id} (alarm @ ${iso(fireAt)}, agent ${cron.agentId})`);
	}

	private armInterval(cron: CronRecord, sched: CronScheduleInterval): void {
		const ms = Math.max(MIN_INTERVAL_MS, sched.everyMs ?? 0);
		if (ms <= 0) return;
		const timer = setInterval(() => {
			void this.fireCron(cron.id, cron.schedule).catch((err) => {
				log.error("cron", `interval timer error for ${cron.id}: ${(err as Error).message}`);
			});
		}, ms);
		if (timer.unref) timer.unref();
		this.scheduledJobs.set(cron.id, timer);
		this.persistNextRunAt(cron.id, iso(this.now() + ms));
		log.debug("cron", `Scheduled cron ${cron.id} (interval ${ms / 1000}s, agent ${cron.agentId})`);
	}

	/** 移除一条 cron 的定时任务 (任意 mode)。 */
	unscheduleCron(cronId: string): void {
		const existing = this.scheduledJobs.get(cronId);
		if (existing) {
			// clearTimeout and clearInterval both work on either kind of timer
			// in Node; clearTimeout keeps the call shape-agnostic.
			clearTimeout(existing);
			this.scheduledJobs.delete(cronId);
			log.debug("cron", `Unscheduled cron ${cronId}`);
		}
	}

	/**
	 * Reschedule after a cron row mutates (create/update/delete). Re-reads the
	 * row to pick up new schedule/enabled/scope; if gone, just unschedules.
	 * §9.4: update tool → refreshCron → next_run 重算。
	 */
	refreshCron(cronId: string): void {
		const cron = this.deps.cronStore.get(cronId);
		if (!cron) {
			this.unscheduleCron(cronId);
			return;
		}
		this.scheduleCron(cron);
	}

	/** Re-scan all cron rows and reconcile timers (add new, drop stale). */
	refreshAll(): void {
		const enabledIds = new Set<string>();
		for (const cron of this.deps.cronStore.listEnabled()) {
			enabledIds.add(cron.id);
			this.scheduleCron(cron);
		}
		// Drop timers for crons no longer enabled/present.
		for (const id of Array.from(this.scheduledJobs.keys())) {
			if (!enabledIds.has(id)) this.unscheduleCron(id);
		}
	}

	/** 获取当前已调度的 cron ID 列表。 */
	getScheduledCronIds(): string[] {
		return Array.from(this.scheduledJobs.keys());
	}

	// ─── Trigger path ────────────────────────────────────────────────

	/**
	 * Fire one cron entry on the schedule path (called by once/alarm/interval
	 * timers). Mirrors triggerCron() but also writes cron_runs, updates the
	 * telemetry columns (last_run_at/last_status/next_run_at), and rolls the
	 * next timer forward for alarm/interval. once → disable + unschedule.
	 *
	 * Single-fire errors do NOT cancel the schedule: catch + log + record
	 * cron_runs failed + (for alarm/interval) leave the rolling timer intact
	 * to fire again next slot.
	 *
	 * NOTE on token/cost: AgentService.sendPrompt does not return token usage
	 * or cost in P4. We record durationMs (wall-clock) and leave tokens/cost
	 * undefined on the cron_runs row — a later phase that surfaces run metrics
	 * can patch those columns (cron_runs.updatedAt bumps on patch).
	 */
	private async fireCron(cronId: string, schedule: CronSchedule): Promise<void> {
		const cron = this.deps.cronStore.get(cronId);
		if (!cron) {
			this.unscheduleCron(cronId);
			return;
		}
		if (!cron.enabled) {
			this.unscheduleCron(cronId);
			return;
		}

		const firedAt = iso(this.now());
		const start = this.now();
		let status: CronLastStatus = "ok";
		let errorMsg: string | undefined;
		let sessionId: string | undefined;

		try {
			const agent = this.deps.agentStore.get(cron.agentId);
			if (!agent) {
				throw new Error(`Agent ${cron.agentId} for cron ${cron.id} not found`);
			}
			sessionId = this.resolveSessionForCron(cron);
			const prompt = cron.prompt ?? this.defaultPromptFor(cron);
			log.debug("cron", `Triggering cron ${cron.id} → agent ${cron.agentId} session ${sessionId}`);
			await this.fireAgent(cron, agent, prompt, sessionId);
		} catch (err) {
			status = "failed";
			errorMsg = (err as Error).message;
			log.error("cron", `Trigger failed for cron ${cron.id}: ${errorMsg}`);
		}

		const durationMs = this.now() - start;

		// Compute next fire (for telemetry + re-arm). once disables after fire;
		// alarm/interval roll forward.
		let nextAt: string | undefined;
		let nextEnabled: boolean = cron.enabled;
		if (status === "ok" || status === "failed") {
			if (schedule.mode === "once") {
				nextEnabled = false;
				this.unscheduleCron(cronId);
				nextAt = undefined;
			} else {
				const next = nextFireMs(schedule, this.now());
				nextAt = next === null ? undefined : iso(next);
			}
		}

		// Persist telemetry + audit row.
		try {
			// `null` (not `undefined`) clears a field: SqliteStore now treats
			// undefined as "leave untouched", so an ok run must null lastError
			// and a once-fire must null nextRunAt explicitly.
			this.deps.cronStore.update(cron.id, {
				enabled: nextEnabled,
				lastRunAt: firedAt,
				lastStatus: status,
				lastError: errorMsg ?? null,
				nextRunAt: nextAt ?? null,
			} as any);
		} catch (err) {
			log.error("cron", `Failed to update telemetry for ${cron.id}: ${(err as Error).message}`);
		}
		try {
			this.deps.cronRunStore?.create({
				cronId: cron.id,
				firedAt,
				agentId: cron.agentId,
				sessionId,
				success: status === "ok",
				error: errorMsg,
				durationMs,
			} as any);
		} catch (err) {
			log.error("cron", `Failed to write cron_runs for ${cron.id}: ${(err as Error).message}`);
		}

		// Re-arm rolling timers (alarm/interval) for the next slot. We only
		// get here from inside the fired timer, so re-scheduling is safe and
		// idempotent (scheduleCron clears the now-fired timer first). once
		// already unscheduled above and is now disabled, so it won't re-arm.
		if (nextEnabled && schedule.mode !== "once") {
			// Read the (possibly updated) row to pick up the new enabled flag.
			const refreshed = this.deps.cronStore.get(cron.id);
			if (refreshed && refreshed.enabled) this.scheduleCron(refreshed);
		}
	}

	/**
	 * Manually fire a cron once (test/debug). §9.4: trigger does NOT advance
	 * next_run_at — it's an out-of-band run on top of the normal schedule.
	 * Still records a cron_runs row + last_run_at so the audit trail is
	 * accurate, but leaves the schedule (and nextRunAt) untouched.
	 */
	async triggerCron(cronId: string): Promise<void> {
		const cron = this.deps.cronStore.get(cronId);
		if (!cron) {
			this.unscheduleCron(cronId);
			return;
		}
		if (!cron.enabled) {
			this.unscheduleCron(cronId);
			return;
		}

		const firedAt = iso(this.now());
		const start = this.now();
		let status: CronLastStatus = "ok";
		let errorMsg: string | undefined;
		let sessionId: string | undefined;

		try {
			const agent = this.deps.agentStore.get(cron.agentId);
			if (!agent) {
				throw new Error(`Agent ${cron.agentId} for cron ${cron.id} not found`);
			}
			sessionId = this.resolveSessionForCron(cron);
			const prompt = cron.prompt ?? this.defaultPromptFor(cron);
			log.debug("cron", `Manually triggering cron ${cron.id} → agent ${cron.agentId} session ${sessionId}`);
			await this.fireAgent(cron, agent, prompt, sessionId);
		} catch (err) {
			status = "failed";
			errorMsg = (err as Error).message;
			log.error("cron", `Manual trigger failed for cron ${cron.id}: ${errorMsg}`);
		}

		const durationMs = this.now() - start;
		// Manual trigger does NOT touch next_run_at (§9.4). last_run_at +
		// cron_runs are still recorded for audit accuracy.
		try {
			this.deps.cronStore.update(cron.id, {
				lastRunAt: firedAt,
				lastStatus: status,
				lastError: errorMsg,
			} as any);
		} catch (err) {
			log.error("cron", `Failed to update telemetry for ${cron.id}: ${(err as Error).message}`);
		}
		try {
			this.deps.cronRunStore?.create({
				cronId: cron.id,
				firedAt,
				agentId: cron.agentId,
				sessionId,
				success: status === "ok",
				error: errorMsg,
				durationMs,
			} as any);
		} catch (err) {
			log.error("cron", `Failed to write cron_runs for ${cron.id}: ${(err as Error).message}`);
		}
	}

	/** Write next_run_at without disturbing the rest of the row. */
	private persistNextRunAt(cronId: string, value: string | undefined): void {
		try {
			// `null` (not `undefined`) is the explicit "clear" signal: SqliteStore
			// now treats `undefined` as "leave the field untouched", so an absent
			// next run must be written as null to actually blank the column.
			this.deps.cronStore.update(cronId, { nextRunAt: value ?? null } as any);
		} catch (err) {
			log.debug("cron", `Skipped next_run_at write for ${cronId}: ${(err as Error).message}`);
		}
	}

	/**
	 * 触发执行(去-role 分支):
	 * - 阶段3 git-aware:prompt 带 sentinel + 注入了 archivistGit → 触发前检查
	 *   git main ref,与 cron.lastGitRef 相同则跳过(无变化);有变化则 strip sentinel
	 *   跑,跑成功后回写 lastGitRef(下次同 ref 跳过)。
	 * - project-scoped cron + 注入了 wikiStore → sendProjectPrompt(注入
	 *   wikiStore/projectContext,archivist 长期绑定能干 wiki 维护活的关键)。
	 * - 否则(观察 cron 或未注入 wikiStore) → sendPrompt(原行为)。
	 */
	private async fireAgent(cron: CronRecord, agent: AgentRecord, prompt: string, sessionId: string): Promise<void> {
		const scope = cron.workingScope;
		// project-work:带 workId 的 cron → agent + actionPrompt 从 work 解析
		// (覆盖 cron 自带)。work 空岗/禁用/缺工具 → 跳过。
		let activeAgent: AgentRecord = agent;
		let basePrompt = prompt;
		if (cron.workId && this.deps.projectWorkStore) {
			const work = this.deps.projectWorkStore.get(cron.workId);
			if (!work) {
				log.warn("cron", `cron ${cron.id} work ${cron.workId} not found; skipping`);
				return;
			}
			if (!work.enabled || !work.agentId) {
				log.debug("cron", `cron ${cron.id} work ${cron.workId} skipped: ${!work.enabled ? "disabled" : "vacant"}`);
				return;
			}
			const workAgent = this.deps.agentStore.get(work.agentId);
			if (!workAgent) {
				log.warn("cron", `cron ${cron.id} work agent ${work.agentId} not found; skipping`);
				return;
			}
			if (Array.isArray(work.requiredTools)) {
				for (const tool of work.requiredTools) {
					if (!agentHasTool(workAgent, tool)) {
						log.warn("cron", `cron ${cron.id} work ${cron.workId} skipped: agent "${workAgent.name}" missing required tool ${tool}`);
						return;
					}
				}
			}
			activeAgent = workAgent;
			const project = scope.projectId ? this.deps.projectStore.get(scope.projectId) : undefined;
			const resolved = (work.actionPrompt ?? "").replaceAll("{projectName}", project?.name ?? "");
			if (resolved.trim()) basePrompt = resolved;
		}

		let effectivePrompt = basePrompt;
		let newGitRef: string | undefined;
		if (isGitAwarePrompt(prompt) && this.deps.archivistGit && scope.workspaceDir) {
			const ref = await this.deps.archivistGit.getCurrentMainRef(scope.workspaceDir);
			if (ref && ref === cron.lastGitRef) {
				log.debug("cron", `git-aware cron ${cron.id} skipped: no git changes (ref=${ref})`);
				return;
			}
			effectivePrompt = stripGitAwareSentinel(basePrompt);
			newGitRef = ref; // 跑成功后回写
		}
		if (scope.projectId) {
			const project = this.deps.projectStore.get(scope.projectId);
			const result = await this.deps.agentService.sendProjectPrompt(activeAgent.id, sessionId, effectivePrompt, {
				projectId: scope.projectId,
				projectPath: project?.workspaceDir ?? scope.workspaceDir,
				projectName: project?.name ?? "",
				
				workId: cron.workId,
			}, "cron");
			// A 方案:session 正在跑 → skip,且不更新 lastGitRef(下次 cron 再试,避免漏处理变更)。
			if (result?.skipped === "busy") {
				log.debug("cron", `cron ${cron.id} skipped: session ${sessionId} busy(上一 turn 未完成),不更新 lastGitRef`);
				newGitRef = undefined;
			}
		} else {
			await this.deps.agentService.sendPrompt(effectivePrompt, activeAgent, sessionId, "cron");
		}
		if (newGitRef) {
			try {
				this.deps.cronStore.update(cron.id, { lastGitRef: newGitRef } as any);
			} catch (e) {
				log.warn("cron", `git-aware lastGitRef update failed for ${cron.id}: ${(e as Error).message}`);
			}
		}
	}

	/**
	 * Resolve the workingScope to a session id. Project-scoped cron goes
	 * through the M0 router; observation cron reuses the agent's main session
	 * or creates one carrying the bundle.
	 */
	private resolveSessionForCron(cron: CronRecord): string {
		const scope: SessionContextBundle = cron.workingScope;

		if (scope.projectId) {
			// Project cron — M0 routing (find-or-create by agentId + projectId).
			const resolved = resolveSessionByRoleProject(
				{
					sessionDB: this.deps.sessionDB,
					projectStore: this.deps.projectStore,
					resolveWikiRoot: this.deps.resolveWikiRoot,
				},
				cron.agentId,
				scope.projectId,
				// workingScope already carries workspaceDir / wikiRootNodeId —
				// pass them as the per-call bundle override so the router honors
				// the cron's explicit scope (e.g. observation cron pointed at a
				// project subtree root, or a narrowed workspace subdir).
				{ bundleOverride: { workspaceDir: scope.workspaceDir, wikiRootNodeId: scope.wikiRootNodeId } },
			);
			return resolved.session.id;
		}

		// Observation cron — no projectId. Prefer the agent's existing main
		// session; otherwise create a fresh one carrying the bundle.
		const existing = this.deps.sessionDB.getMainSession(cron.agentId);
		if (existing) return existing.id;

		const created = this.deps.sessionDB.createSession(
			cron.agentId,
			`${cron.agentId}:observation`,
			scope,
		);
		return created.id;
	}

	private defaultPromptFor(cron: CronRecord): string {
		if (cron.workingScope.projectId) {
			return `Scheduled check-in on project ${cron.workingScope.projectId}. Review current state, identify any pending work or blockers, and surface anything that needs attention.`;
		}
		return `Scheduled global observation pass. Review overall workspace state and surface anything that needs attention.`;
	}
}
