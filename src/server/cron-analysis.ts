// Cron 调度管理 (v0.8 M1 — cron 一等公民)
//
// # 文件说明书
//
// ## 核心功能
// 扫描 cron 表 (CronStore) 为每条 enabled cron 注册一个定时器,按时触发:
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
// - SessionDB / ProjectStore (路由 helper 依赖)
// - CronStore (调度源)
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
// - 单次触发错误不取消调度,仅 catch + log
// - schedule="off" 或 enabled=false 的 cron 不注册定时器
// - 最小间隔 1 分钟
// - restoreSchedules() 扫描全部 enabled cron,逐条 scheduleCron
//

import type { AgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";
import type { SessionDB } from "./session-db.js";
import type { CronStore } from "./cron-store.js";
import type { CronRecord, SessionContextBundle } from "../shared/types.js";
import {
	resolveSessionByRoleProject,
	type WikiRootResolver,
} from "./session-context-router.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Interval parsing
// ---------------------------------------------------------------------------

/**
 * 将 schedule 字符串映射为毫秒数。
 * 支持命名值 (off/hourly/daily/weekly) 和自定义毫秒数。
 * "off" 返回 0 (调用方视为不调度)。
 */
function parseSchedule(schedule: string): number {
	switch (schedule) {
		case "off":    return 0;
		case "hourly": return 60 * 60 * 1000;           // 1 hour
		case "daily":  return 24 * 60 * 60 * 1000;      // 24 hours
		case "weekly": return 7 * 24 * 60 * 60 * 1000;  // 7 days
		default: {
			const ms = parseInt(schedule, 10);
			if (!isNaN(ms) && ms >= 60 * 1000) return ms;  // min 1 min
			return 24 * 60 * 60 * 1000;                      // default 24h
		}
	}
}

// ---------------------------------------------------------------------------
// CronAnalysisManager
// ---------------------------------------------------------------------------

export interface CronAnalysisDeps {
	agentService: AgentService;
	agentStore: AgentStore;
	projectStore: ProjectStore;
	sessionDB: SessionDB;
	cronStore: CronStore;
	/** Optional override; defaults to M0's placeholder resolver. */
	resolveWikiRoot?: WikiRootResolver;
}

export class CronAnalysisManager {
	private deps: CronAnalysisDeps;
	/** cron.id → timer. One timer per enabled cron entry. */
	private scheduledJobs: Map<string, NodeJS.Timeout> = new Map();

	constructor(deps: CronAnalysisDeps) {
		this.deps = deps;
	}

	// ─── Public API ──────────────────────────────────────────────────

	/**
	 * 启动时恢复所有 enabled cron 的定时任务 (M1: 扫 cron 表,不再扫 project 表)。
	 */
	restoreSchedules(): void {
		const crons = this.deps.cronStore.listEnabled();
		for (const cron of crons) {
			this.scheduleCron(cron);
		}
		log.debug("cron", `Restored ${crons.length} enabled cron entr${crons.length === 1 ? "y" : "ies"}`);
	}

	/**
	 * 为单条 cron 注册定时触发。先清已有,再注册新的。
	 *
	 * v0.8 (P0 §3.4): schedule is now structured JSON (CronSchedule union), not
	 * a string. The full three-mode firing logic (interval / alarm / once) is
	 * P4's job — P0 only landed the type + columns. The branch below still
	 * reads `cron.schedule` as if it were a string sentinel so the file keeps
	 * compiling under the new type via `@ts-expect-error`; the actual firing
	 * semantics will be rewritten in P4. Until then, an enabled cron with a
	 * structured schedule may not fire — that's an accepted P0 interim.
	 */
	scheduleCron(cron: CronRecord): void {
		this.unscheduleCron(cron.id);

		if (!cron.enabled) {
			return;
		}
		// Legacy "off" sentinel check — no longer reachable under the new
		// structured type (off is now encoded as enabled=false). Kept as a
		// defensive no-op; the @ts-expect-error silences the type narrowing
		// that says schedule can't be "off" anymore.
		// @ts-expect-error — P0 §3.4: legacy string compare; P4 rewrites this.
		if (cron.schedule === "off") {
			return;
		}

		// P0 interim: parseSchedule still expects a string. CronSchedule is now
		// a structured object, so this returns the default 24h interval for
		// every row. The real three-mode firing lands in P4.
		const ms = parseSchedule(
			// @ts-expect-error — P0 §3.4: schedule is structured JSON now; P4 will
			// replace parseSchedule with mode-aware firing logic.
			cron.schedule,
		);
		if (ms <= 0) return;

		const timer = setInterval(() => {
			this.triggerCron(cron.id).catch((err) => {
				// Errors must not cancel the schedule — catch and continue.
				log.error("cron", `Trigger failed for cron ${cron.id}:`, (err as Error).message);
			});
		}, ms);

		// Prevent the timer from keeping the process alive.
		if (timer.unref) timer.unref();

		this.scheduledJobs.set(cron.id, timer);
		log.debug("cron", `Scheduled cron ${cron.id} (agent ${cron.agentId}, ${ms / 1000}s)`);
	}

	/** 移除一条 cron 的定时任务。 */
	unscheduleCron(cronId: string): void {
		const existing = this.scheduledJobs.get(cronId);
		if (existing) {
			clearInterval(existing);
			this.scheduledJobs.delete(cronId);
			log.debug("cron", `Unscheduled cron ${cronId}`);
		}
	}

	/**
	 * Reschedule after a cron row mutates (create/update/delete). Re-reads the
	 * row to pick up new schedule/enabled/scope; if gone, just unschedules.
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

	// ─── Legacy aliases (kept for project-router / IPC compat) ──────
	// v0.8 M0 left project-router / project-handlers wiring pointing at the
	// per-project API. M1 cron is agent-scoped, not project-scoped, but those
	// callers still exist; route them through the cron-table reconciliation so
	// they stay no-ops rather than referencing a removed API. These will be
	// cleaned up as project-router moves to cron-tool-driven flow.

	/** @deprecated M1 — cron is agent-scoped; use refreshAll(). Kept for callers. */
	restoreSchedulesForProjects(): void {
		this.refreshAll();
	}

	/** @deprecated M1 — use scheduleCron(cron) / refreshCron(cronId). */
	scheduleProject(_projectId: string, _interval: string): void {
		// No-op: project no longer owns a schedule. Cron entries own their own.
	}

	/** @deprecated M1. */
	unscheduleProject(_projectId: string): void {
		// No-op.
	}

	/** @deprecated M1. */
	rescheduleProject(_projectId: string, _newInterval: string): void {
		// No-op.
	}

	// ─── Trigger path ────────────────────────────────────────────────

	/**
	 * Fire one cron entry: resolve its workingScope → session, then run the
	 * cron's prompt (or a default observation prompt) on that session.
	 *
	 * - Project-scoped cron (workingScope.projectId set) routes via M0's
	 *   resolveSessionByRoleProject(agentId, projectId).
	 * - Observation cron (no projectId) finds/creates a non-project session
	 *   keyed by agentId (uses the agent's main session if present, else a
	 *   fresh session carrying the bundle).
	 */
	async triggerCron(cronId: string): Promise<void> {
		const cron = this.deps.cronStore.get(cronId);
		if (!cron) {
			this.unscheduleCron(cronId);
			return;
		}
		if (!cron.enabled) {
			// Defensive: row changed under us. (P0 §3.4: the legacy
			// `schedule === "off"` sentinel is gone — off is enabled=false now.)
			this.unscheduleCron(cronId);
			return;
		}

		const agent = this.deps.agentStore.get(cron.agentId);
		if (!agent) {
			log.warn("cron", `Agent ${cron.agentId} for cron ${cron.id} not found; skipping.`);
			return;
		}

		const sessionId = this.resolveSessionForCron(cron);
		const prompt = cron.prompt ?? this.defaultPromptFor(cron);

		log.debug("cron", `Triggering cron ${cron.id} → agent ${cron.agentId} session ${sessionId}`);
		await this.deps.agentService.sendPrompt(prompt, agent, sessionId);
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
