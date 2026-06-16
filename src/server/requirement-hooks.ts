// 需求状态流转 Hook
//
// # 文件说明书
//
// ## 核心功能
// 注册 PostToolUse 和 PostTurnComplete Hook，自动推进需求状态。
//
// ## 输入
// - PostToolUse Hook context
// - PostTurnComplete Hook context
//
// ## 输出
// - 需求状态自动流转（plan→build→verify）
//
// ## 定位
// 服务层 Hook，被 server/index.ts 调用注册。
//
// ## 依赖
// - hook-registry — Hook 注册
// - requirement-store — 需求存储
// - task-step-store — 步骤存储
// - lead-service — Lead 服务（用于自动领取）
//
// ## 维护规则
// - Hook 逻辑需幂等（同一事件多次触发不产生副作用）
// - 异常不阻塞主流程
//

import { HookRegistry } from "../core/hook-registry.js";
import type { RequirementStore } from "./requirement-store.js";
import type { TaskStepStore } from "./task-step-store.js";
import type { LeadService } from "./lead-service.js";
import type { AnalystService } from "./analyst-service.js";
import type { NotificationService } from "./notification-service.js";
import type { ProjectNotificationRouter } from "./project-notification-router.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

/**
 * Register requirement status transition hooks.
 *
 * PostToolUse: when Orchestrate tool is used by Lead, check if plan→build transition needed.
 * PostTurnComplete: when Lead session turn completes, check if all steps done → verify transition.
 *   M5: if reviewer='analyst', auto-trigger verifyRequirement + archiveRequirement.
 */
export function registerRequirementHooks(deps: {
	requirementStore: RequirementStore;
	taskStepStore: TaskStepStore;
	leadService: LeadService;
	hookRegistry?: HookRegistry;
	analystService?: AnalystService;
	notificationService?: NotificationService;
	// v0.8 (M3): project-scoped cross-role notification router (ready→lead,
	// verify→PM, accept→archivist). Falls back to NotificationService if absent
	// (legacy path).
	projectNotificationRouter?: ProjectNotificationRouter;
}): void {
	const registry = deps.hookRegistry ?? HookRegistry.getInstance();

	// Hook 1: PostToolUse — track Orchestrate tool calls for plan→build transition
	registry.register("PostToolUse", async (ctx) => {
		if (ctx.toolName !== "Orchestrate") return;

		// Guard: only Lead agents should trigger this hook
		const agentId = ctx.agentId ?? "";
		if (!agentId.startsWith("Lead-")) return;

		// Find the specific requirement assigned to this Lead session
		const sessionId = ctx.sessionId;
		const planReqs = deps.requirementStore.listByStatus("plan" as any);
		const targetReq = sessionId
			? planReqs.find(r => r.assignedLeadSessionId === sessionId)
			: planReqs[0]; // fallback: first plan requirement

		if (!targetReq) return;

		const steps = deps.taskStepStore.listByRequirement(targetReq.id);
		if (steps.length > 0) {
			try {
				deps.requirementStore.transitionStatus(targetReq.id, "build", "lead", "Lead 开始执行步骤");
			} catch (err) {
				// Transition may fail if already moved — ignore
				log.debug("requirement-hooks", "plan→build transition failed:", (err as Error).message);
			}

			// M5: Notify plan review required on plan→build transition
			if (deps.notificationService) {
				deps.notificationService.notifyPlanReviewRequired(
					targetReq.id,
					targetReq.projectId,
				).catch(() => {});
			}
		}
	});

	// Hook 2: PostTurnComplete — check step status when Lead session turn completes
	registry.register("PostTurnComplete", async (ctx) => {
		// Guard: only Lead agents should trigger this hook
		const agentId = ctx.agentId ?? "";
		if (!agentId.startsWith("Lead-")) return;

		// Find the specific requirement assigned to this Lead session
		const sessionId = ctx.sessionId;
		const buildReqs = deps.requirementStore.listByStatus("build" as any);
		const targetReq = sessionId
			? buildReqs.find(r => r.assignedLeadSessionId === sessionId)
			: buildReqs[0]; // fallback: first build requirement

		if (!targetReq) return;

		const steps = deps.taskStepStore.listByRequirement(targetReq.id);
		if (steps.length === 0) return;

		const allCompleted = steps.every(
			(s) => s.status === "completed" || s.status === "skipped",
		);
		const hasFailed = steps.some((s) => s.status === "failed");

		if (allCompleted) {
			try {
				deps.requirementStore.transitionStatus(targetReq.id, "verify", "system", "所有步骤已完成");
			} catch (err) {
				log.debug("requirement-hooks", "build→verify transition failed:", (err as Error).message);
			}

			// v0.8 (M3): notify PM session for coverage judgement (decision 10/34).
			// PM reads the latest Orchestrate manifest and judges coverage.
			// Non-blocking; cron fallback will retry if this notification fails.
			if (deps.projectNotificationRouter) {
				deps.projectNotificationRouter.notify("verify", targetReq.id, targetReq.projectId).catch(() => {});
			}

			// M5: Auto-verify if reviewer is 'analyst'
			if (targetReq.reviewer === "analyst" && deps.analystService) {
				log.agent("M5 auto-verify: reviewer=analyst, triggering verification for:", targetReq.id);
				// Non-blocking — don't await to avoid blocking the hook
				deps.analystService.verifyRequirement(targetReq.id).then((result) => {
					if (result.passed) {
						log.agent("M5 auto-verify: PASSED for:", targetReq.id);
						// v0.8 (M3): verify accept → notify archivist to merge
						// feature→main (RFC §2.9 / §2.15, acceptance-M3 item 6).
						// Decisions 10/25 — the archivist session owns the merge;
						// cron fallback retries if this notification is lost.
						// Fire BEFORE archiveRequirement closes the requirement so
						// the archivist still sees a verify-state requirement to
						// merge. Notifications are best-effort and never throw
						// (see ProjectNotificationRouter.notify catch-all).
						if (deps.projectNotificationRouter) {
							deps.projectNotificationRouter
								.notify("verify_accept", targetReq.id, targetReq.projectId)
								.catch(() => {});
						}
						log.agent("M5 auto-verify: PASSED, archiving:", targetReq.id);
						return deps.analystService!.archiveRequirement(targetReq.id);
					} else {
						log.agent("M5 auto-verify: FAILED for:", targetReq.id);
						// Notify verification failure
						if (deps.notificationService) {
							return deps.notificationService.notifyVerificationFailure(
								targetReq.id,
								targetReq.projectId,
								result.report,
							);
						}
					}
				}).catch((err) => {
					log.error("requirement-hooks", "M5 auto-verify error:", (err as Error).message);
				});
			}

			// After completing current requirement, auto-pickup next if idle
			// Don't await — non-blocking
			if (targetReq.projectId) {
				deps.leadService.autoPickupIfIdle(targetReq.projectId).catch(() => {});
			}
		} else if (hasFailed) {
			// M5: Notify step failure
			log.agent("Requirement has failed steps:", targetReq.id, targetReq.title);
			const failedSteps = steps.filter((s) => s.status === "failed");
			if (deps.notificationService) {
				for (const step of failedSteps) {
					deps.notificationService.notifyStepFailure(
						targetReq.id,
						targetReq.projectId,
						step,
					).catch(() => {});
				}
			}
		}
	});
}
