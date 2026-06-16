// 会话恢复与启动清理
//
// # 文件说明书
//
// ## 核心功能
// 启动时扫描中断的会话轮次，清理过期记录，辅助 AgentService 恢复未完成会话
//
// ## 输入
// SessionDB 实例
//
// ## 输出
// 不完整轮次列表（sessionId、turnSeq、phase）
//
// ## 定位
// src/server/ — 服务层，应用启动时的数据恢复机制
//
// ## 依赖
// session-db.ts、core/logger.ts
//
// ## 维护规则
// 新增中断场景需在此添加扫描逻辑
//
import type { SessionDB } from "./session-db.js";
import type { ProjectStore } from "./project-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { TaskStepStore } from "./task-step-store.js";
import type { CronAnalysisManager } from "./cron-analysis.js";
import type { AgentService } from "./agent-service.js";
import type { ProjectNotificationRouter } from "./project-notification-router.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Startup recovery — scan for interrupted turns and clean up stale records.
// Actual resume is driven by AgentService.recoverIncompleteSessions().
// Runs once at app startup after the database is initialized.
// ---------------------------------------------------------------------------

export function scanIncompleteTurns(sessionDb: SessionDB): Array<{ sessionId: string; turnSeq: number; phase: string }> {
	// Clean up old turn_state records (older than 24 hours)
	sessionDb.cleanOldTurnState(24 * 60 * 60 * 1000);

	const incomplete = sessionDb.getIncompleteTurns();
	if (incomplete.length === 0) {
		log.debug("recovery", "No interrupted turns found");
	} else {
		log.db(`Found ${incomplete.length} interrupted turn(s)`);
	}
	return incomplete;
}

// ---------------------------------------------------------------------------
// M5: Workflow state recovery
// Recover requirements in build/plan/verify status after a crash.
// All errors are caught and logged — recovery does not block startup.
// ---------------------------------------------------------------------------

export interface RecoveryDeps {
	projectStore: ProjectStore;
	requirementStore: RequirementStore;
	taskStepStore: TaskStepStore;
	cronManager: CronAnalysisManager;
	agentService: AgentService;
	// v0.8 (M3): notification router — used for startup backfill of any
	// ready/verify requirements whose notifications were lost in a crash.
	projectNotificationRouter?: ProjectNotificationRouter;
}

export function recoverWorkflowState(deps: RecoveryDeps): void {
	const { projectStore, requirementStore, taskStepStore, cronManager, agentService, projectNotificationRouter } = deps;

	try {
		// 1. Restore cron schedules for all active projects
		cronManager.restoreSchedules();

		// 2. Recover requirements in 'build' status
		const buildingReqs = requirementStore.listByStatus("build" as any);
		for (const req of buildingReqs) {
			try {
				// Mark running steps as failed
				const runningSteps = taskStepStore.listByRequirement(req.id)
					.filter(s => s.status === "running");

				for (const step of runningSteps) {
					taskStepStore.update(step.id, {
						status: "failed",
						error: "Session interrupted by crash",
						completedAt: new Date().toISOString(),
					} as any);
				}

				// Check if Lead session is still alive
				if (req.assignedLeadSessionId) {
					const session = agentService.getDB().getSession(req.assignedLeadSessionId);
					if (!session) {
						// Session lost — add recovery message
						requirementStore.addMessage(
							req.id,
							"system" as any,
							"Lead session lost due to unexpected shutdown. Manual recovery or re-pickup required.",
							"notification",
						);
					}
				}
			} catch (err) {
				log.error("recovery", `Failed to recover build requirement ${req.id}: ${(err as Error).message}`);
			}
		}

		// 3. Recover requirements in 'plan' status
		const planReqs = requirementStore.listByStatus("plan" as any);
		for (const req of planReqs) {
			try {
				if (req.assignedLeadSessionId) {
					const session = agentService.getDB().getSession(req.assignedLeadSessionId);
					if (!session) {
						// Lead session lost — reset to ready
						requirementStore.transitionStatus(
							req.id, "ready" as any, "system" as any,
							"Lead session lost due to unexpected shutdown, requirement reset to ready",
						);
						requirementStore.update(req.id, {
							assignedLeadSessionId: undefined,
						} as any);
					}
				}
			} catch (err) {
				log.error("recovery", `Failed to recover plan requirement ${req.id}: ${(err as Error).message}`);
			}
		}

		// 4. Recover requirements in 'verify' status
		const verifyReqs = requirementStore.listByStatus("verify" as any);
		for (const req of verifyReqs) {
			try {
				requirementStore.addMessage(
					req.id,
					"system" as any,
					"Verification was interrupted by restart. Re-trigger verification to proceed.",
					"notification",
				);
			} catch (err) {
				log.error("recovery", `Failed to recover verify requirement ${req.id}: ${(err as Error).message}`);
			}
		}

		const totalRecovered = buildingReqs.length + planReqs.length + verifyReqs.length;
		if (totalRecovered > 0) {
			log.debug("recovery", `Recovered ${totalRecovered} workflow requirement(s) (build:${buildingReqs.length} plan:${planReqs.length} verify:${verifyReqs.length})`);
		} else {
			log.debug("recovery", "No workflow requirements needed recovery");
		}

		// v0.8 (M3): backfill any missed ready/verify notifications across all
		// projects (cron fallback path runs at startup; the project-scoped cron
		// ticks then take over for runtime misses — decision 10).
		if (projectNotificationRouter) {
			for (const project of projectStore.list()) {
				try {
					projectNotificationRouter.backfillPendingNotifications(project.id).catch((err) => {
						log.debug("recovery", `backfill(${project.id}) failed: ${(err as Error).message}`);
					});
				} catch (err) {
					log.debug("recovery", `backfill(${project.id}) threw: ${(err as Error).message}`);
				}
			}
		}
	} catch (err) {
		log.error("recovery", `Workflow recovery failed: ${(err as Error).message}`);
	}
}
