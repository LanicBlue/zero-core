// Cron 巡检调度
//
// # 文件说明书
//
// ## 核心功能
// 为每个活跃项目注册定时巡检，调用 AnalystService.runIncrementalAnalysis()。
//
// ## 输入
// - AnalystService — 分析服务
// - ProjectStore — 项目数据
//
// ## 输出
// - CronAnalysisManager 类
//
// ## 定位
// 服务层，被 server/index.ts 启动时实例化和恢复。
//
// ## 依赖
// - analyst-service.ts
// - project-store.ts
//
// ## 维护规则
// - setInterval 错误不取消调度，仅 catch + log
// - 最小间隔 1 分钟
//

import type { AnalystService } from "./analyst-service.js";
import type { ProjectStore } from "./project-store.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Interval parsing
// ---------------------------------------------------------------------------

/**
 * 将 interval 字符串映射为毫秒数。
 * 支持命名值 (hourly/daily/weekly) 和自定义毫秒数。
 */
function parseInterval(interval: string): number {
	switch (interval) {
		case "hourly": return 60 * 60 * 1000;           // 1 hour
		case "daily":  return 24 * 60 * 60 * 1000;      // 24 hours
		case "weekly": return 7 * 24 * 60 * 60 * 1000;  // 7 days
		default: {
			const ms = parseInt(interval, 10);
			if (!isNaN(ms) && ms >= 60 * 1000) return ms;  // min 1 min
			return 24 * 60 * 60 * 1000;                      // default 24h
		}
	}
}

// ---------------------------------------------------------------------------
// CronAnalysisManager
// ---------------------------------------------------------------------------

export class CronAnalysisManager {
	private analystService: AnalystService;
	private projectStore: ProjectStore;
	private scheduledJobs: Map<string, NodeJS.Timeout>;  // projectId → timer

	constructor(deps: {
		analystService: AnalystService;
		projectStore: ProjectStore;
	}) {
		this.analystService = deps.analystService;
		this.projectStore = deps.projectStore;
		this.scheduledJobs = new Map();
	}

	// ─── Public API ──────────────────────────────────────────────────

	/**
	 * 启动时恢复所有活跃项目的定时任务。
	 * 读取 projectStore.listActive()，为每个项目注册 setInterval。
	 */
	restoreSchedules(): void {
		const activeProjects = this.projectStore.listActive();
		for (const project of activeProjects) {
			this.scheduleProject(project.id, project.analysisInterval);
		}
		log.debug("cron", `Restored schedules for ${activeProjects.length} active project(s)`);
	}

	/**
	 * 为项目注册定时巡检。
	 * 先清除已有的，再注册新的。
	 */
	scheduleProject(projectId: string, interval: string): void {
		this.unscheduleProject(projectId);

		const ms = parseInterval(interval);

		const timer = setInterval(async () => {
			try {
				const project = this.projectStore.get(projectId);
				if (!project || project.status !== "active") {
					this.unscheduleProject(projectId);
					return;
				}
				await this.analystService.runIncrementalAnalysis(projectId);
			} catch (err) {
				// Errors must not cancel the schedule — catch and continue
				log.error("cron", `Analysis failed for ${projectId}:`, (err as Error).message);
			}
		}, ms);

		// Prevent the timer from keeping the process alive
		if (timer.unref) timer.unref();

		this.scheduledJobs.set(projectId, timer);
		log.debug("cron", `Scheduled analysis for project ${projectId} every ${ms / 1000}s`);
	}

	/**
	 * 移除项目定时任务。
	 */
	unscheduleProject(projectId: string): void {
		const existing = this.scheduledJobs.get(projectId);
		if (existing) {
			clearInterval(existing);
			this.scheduledJobs.delete(projectId);
			log.debug("cron", `Unscheduled analysis for project ${projectId}`);
		}
	}

	/**
	 * 更新项目巡检间隔（先取消再重新注册）。
	 */
	rescheduleProject(projectId: string, newInterval: string): void {
		this.scheduleProject(projectId, newInterval);
	}

	/**
	 * 获取当前已调度的项目 ID 列表。
	 */
	getScheduledProjectIds(): string[] {
		return Array.from(this.scheduledJobs.keys());
	}
}
