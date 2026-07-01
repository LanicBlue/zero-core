// 需求状态流转 Hook (v0.8 P7 — 拉模型重做)
//
// ⚠️ LEGACY / RETIRED (Step 1B, hook-redesign §5.5): this module is no longer
// registered by the per-loop registry (registerHooksForLoop). Requirement
// status-machine logic is workflow-domain and does not belong on session hooks;
// it rides cron + project-work + the pull model instead. The file is kept so
// existing imports / tests keep compiling; it will be deleted once the workflow
// retirement lands. Do NOT add new callers.
//
// # 文件说明书
//
// ## 核心功能
// 注册 PostToolUse Hook 自动推进需求状态:**仅 plan→build**(lead 调 Orchestrate
// 工具,步骤>0 时 build)。
//
// ## v0.8 P7 重做要点(RFC §1.5 / §4)
// - 删 ProjectNotificationRouter 依赖(无中央路由,§1.5)。
// - 删 PostTurnComplete 自动 build→verify(verify 是 lead 显式提交,P3 的
//   verify 工具置 status=verify 并阻塞等 PM 判,§4.5)。
// - 删 verify_accept/verify_reject 推送(PM 判通过 → PM 委派/触发 archivist
//   合并;不通过 → 意见回 lead,lead 改计划重提;§4.6)。
// - 删 notify("ready") 推送(lead 完成上一需求 autoPickupIfIdle 自动领下一个
//   primary;cron 保底 fallback;§4.3)。
// - 删 M5 analyst 自动 verify 路径(verify 门由 PM 接管,§4.5)。
//
// ## 输入
// - hook-registry
// - requirement-store / task-step-store
//
// ## 输出
// - 注册的 PostToolUse hook(plan→build)
//
// ## 定位
// 服务层 Hook,被 server/index.ts 调用注册。
//
// ## 依赖
// - ../core/hook-registry
// - ./requirement-store, ./task-step-store
// - ../core/logger
//
// ## 维护规则
// - hook 逻辑幂等(同一事件多次触发无副作用)
// - 异常不阻塞主流程
//

import { HookRegistry } from "../core/hook-registry.js";
import type { RequirementStore } from "./requirement-store.js";
import type { TaskStepStore } from "./task-step-store.js";
import type { LeadService } from "./lead-service.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

/**
 * Register requirement status transition hooks (v0.8 P7 — pull model).
 *
 * Two hooks remain in the hook layer:
 *   1. PostToolUse (Orchestrate) → plan→build when lead records its first
 *      task step (§4.4).
 *   2. PostTurnComplete → lead auto-pickup chain: when a lead session's turn
 *      ends and the project has no active requirement, pick the next ready
 *      one (§4.3 — "完成上一任务后自动领下一个 primary;cron 保底 fallback").
 *
 * Everything else is now explicit:
 *   - build→verify: lead calls the verify tool (§4.5).
 *   - verify→closed: PmService.submitCoverageVerdict (driven by the verify
 *     tool's verdict) → archivist merge → status (§4.6).
 *   - cross-role: pull model — agents read requirement state on activation,
 *     no central router (§1.5).
 */
export function registerRequirementHooks(deps: {
	requirementStore: RequirementStore;
	taskStepStore: TaskStepStore;
	leadService: LeadService;
	hookRegistry?: HookRegistry;
}): void {
	const registry = deps.hookRegistry ?? HookRegistry.getInstance();

	// PostToolUse: track Orchestrate tool calls for plan→build transition.
	// v0.8 P7: lead's agentId is the global role agent id (no "Lead-<project>"
	// name prefix in v0.8 identity model — agents are global). We resolve the
	// requirement by the lead session it was assigned to, which is the
	// authoritative binding regardless of agent id shape.
	registry.register("PostToolUse", async (ctx) => {
		if (ctx.toolName !== "Orchestrate") return;

		const sessionId = ctx.sessionId;
		if (!sessionId) return;

		// Find the requirement assigned to this lead session in plan state.
		const planReqs = deps.requirementStore.listByStatus("plan" as any);
		const targetReq = planReqs.find((r) => r.assignedLeadSessionId === sessionId);
		if (!targetReq) return;

		const steps = deps.taskStepStore.listByRequirement(targetReq.id);
		if (steps.length > 0) {
			try {
				deps.requirementStore.transitionStatus(
					targetReq.id,
					"build",
					"lead",
					"Lead 开始执行步骤",
				);
			} catch (err) {
				// Transition may fail if already moved — idempotent, ignore.
				log.debug(
					"requirement-hooks",
					"plan→build transition failed:",
					(err as Error).message,
				);
			}
		}
	});

	// PostTurnComplete: lead auto-pickup chain (§4.3). After a lead session's
	// turn ends, if its project has no active (plan/build) requirement, pick
	// the next ready one. v0.8 P7 — pure pull-model chain (no notify("ready")
	// push). v0.8 P7 explicitly DROPPED the build→verify auto-transition
	// that used to live here (verify is now lead's explicit verify tool call,
	// §4.5), and the verify_accept push (covered → PmService drives archivist
	// merge directly, §4.6).
	registry.register("PostTurnComplete", async (ctx) => {
		const sessionId = ctx.sessionId;
		if (!sessionId) return;

		// Identify the project this lead session was working on. Look across
		// plan/build requirements assigned to this session — if any, the lead
		// is still mid-flight on one and we don't auto-pick.
		const planReqs = deps.requirementStore.listByStatus("plan" as any);
		const buildReqs = deps.requirementStore.listByStatus("build" as any);
		const stillActive = [...planReqs, ...buildReqs].some(
			(r) => r.assignedLeadSessionId === sessionId,
		);
		if (stillActive) return;

		// Find the project: the most recent requirement this session touched
		// (any status), so we know which project to chain into.
		const allReqs = deps.requirementStore.list();
		const lastForSession = allReqs
			.filter((r) => r.assignedLeadSessionId === sessionId)
			.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
		if (!lastForSession?.projectId) return;

		// Best-effort: pick the next ready requirement for this project.
		// Errors are non-fatal — cron fallback will cover any miss.
		try {
			await deps.leadService.autoPickupIfIdle(lastForSession.projectId);
		} catch (err) {
			log.debug(
				"requirement-hooks",
				"autoPickupIfIdle failed (cron will retry):",
				(err as Error).message,
			);
		}
	});
}
