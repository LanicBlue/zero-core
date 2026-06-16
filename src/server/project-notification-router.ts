// Project 跨角色通知路由 (v0.8 M3)
//
// # 文件说明书
//
// ## 核心功能
// 实现决策 10 / RFC §2.9 表 —— requirement 状态转移时跨角色边界通知:
//   ready         → lead session       (pickup)
//   verify        → PM session         (覆盖判断)
//   verify accept → archivist session  (合并 main)
//
// 目标 = {角色, projectId} → session,通过 M0 的 resolveSessionByRoleProject
// (找/建)。角色→agentId 映射通过 roleTag 扫 AgentStore(全局角色,见 M0)。每条
// 通知 = resolve session → 发一个提示词给该 session,驱动该角色推进工作。
//
// ## pickup 幂等(决策 OQ5)
// ready 通知复用 LeadService.pickupRequirement —— 它本身在 req.assignedLeadSessionId
// 已写时抛错(视为已领取)。本路由器捕获该错误,记录「已领取」并视为成功(no-op)。
//
// ## cron 兜底(决策 10)
// 本路由器若找不到角色 agent 或 session 创建失败,**不**重试。对应角色的 cron
// (scope=该 project)在下次 tick 时扫到 ready/verify 的 requirement 自然补上。
// 这是设计上的「通知为主 + cron 兜底」分离。
//
// ## 输入
// - requirementId / projectId / event kind
// - LeadService (pickup 复用)
// - ProjectStore / SessionDB (路由 helper 依赖)
// - AgentStore (角色→agentId 扫描)
// - AgentService (跑 prompt)
// - 可选 manifestSummary(verify 时给 PM)
//
// ## 输出
// - ProjectNotificationRouter 类
// - notify*() 方法均返回 void,内部 try/catch 不抛
//
// ## 定位
// 服务层,被 requirement-hooks / IPC 触发。
//
// ## 依赖
// - ./session-context-router (resolveSessionByRoleProject)
// - ./agent-store, ./project-store, ./session-db, ./agent-service
// - ./lead-service (pickup 复用 + 幂等)
//
// ## 维护规则
// - 角色扫描通过 roleTag;一个 project 同 roleTag 只取第一个全局 agent
// - 不抛异常到调用方(状态转移不应被通知失败回滚)
//

import type { AgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { SessionDB } from "./session-db.js";
import type { LeadService } from "./lead-service.js";
import type { OrchestrateManifestStore } from "./orchestrate-store.js";
import {
	resolveSessionByRoleProject,
	type WikiRootResolver,
} from "./session-context-router.js";
import { log } from "../core/logger.js";

export type NotificationKind = "ready" | "verify" | "verify_accept" | "verify_reject" | "plan_reject";

export interface ProjectNotificationRouterDeps {
	agentService: AgentService;
	agentStore: AgentStore;
	projectStore: ProjectStore;
	requirementStore: RequirementStore;
	sessionDB: SessionDB;
	leadService: LeadService;
	manifestStore?: OrchestrateManifestStore;
	resolveWikiRoot?: WikiRootResolver;
}

/**
 * Find the global role agent for a (roleTag, project) pair. RFC v0.8: roles are
 * global; one project uses one agent per role. If multiple agents carry the
 * same roleTag, the first (by createdAt) wins — that's the canonical setup.
 */
function findRoleAgent(agentStore: AgentStore, roleTag: string) {
	const matches = agentStore.list().filter((a) => a.roleTag === roleTag);
	if (matches.length === 0) return undefined;
	matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return matches[0];
}

export class ProjectNotificationRouter {
	private deps: ProjectNotificationRouterDeps;

	constructor(deps: ProjectNotificationRouterDeps) {
		this.deps = deps;
	}

	/**
	 * Top-level dispatch: routes a workflow notification to the right role's
	 * session. Used by requirement state-transition hooks.
	 */
	async notify(kind: NotificationKind, requirementId: string, projectId: string, extra?: { reason?: string }): Promise<void> {
		try {
			switch (kind) {
				case "ready":
					return await this.notifyReadyForPickup(requirementId, projectId);
				case "verify":
					return await this.notifyVerifyReadyForCoverage(requirementId, projectId);
				case "verify_accept":
					return await this.notifyAcceptedForMerge(requirementId, projectId);
				case "verify_reject":
					return await this.notifyCoverageRejected(requirementId, projectId, extra?.reason);
				case "plan_reject":
					return await this.notifyPlanRejected(requirementId, projectId, extra?.reason);
			}
		} catch (err) {
			// Catch-all: notifications must not roll back the state transition.
			// cron fallback will pick it up on next tick.
			log.warn("notification", `notify(${kind}) failed for ${requirementId}: ${(err as Error).message}`);
		}
	}

	// ─── ready → lead (pickup) ──────────────────────────────────────────

	/**
	 * Decision 10 / OQ5: ready → lead session pickup. Pickup is idempotent —
	 * LeadService.pickupRequirement throws if assignedLeadSessionId is already
	 * set, which we treat as "already picked up" success.
	 */
	async notifyReadyForPickup(requirementId: string, projectId: string): Promise<void> {
		try {
			const sessionId = await this.deps.leadService.pickupRequirement(requirementId);
			log.agent(`notification(ready): picked up ${requirementId} → lead session ${sessionId}`);
		} catch (err: any) {
			const msg = (err as Error).message || "";
			if (/already assigned/i.test(msg)) {
				log.debug("notification", `ready→lead: ${requirementId} already picked up (idempotent no-op)`);
				return;
			}
			throw err;
		}
	}

	// ─── verify → PM (coverage judgement) ───────────────────────────────

	/**
	 * Decision 34: verify → PM session. PM reads the latest manifest and judges
	 * whether changes+tests cover the requirement intent. Routes to the PM
	 * session via resolveSessionByRoleProject, then sends a coverage prompt.
	 */
	async notifyVerifyReadyForCoverage(requirementId: string, projectId: string): Promise<void> {
		const pmAgent = findRoleAgent(this.deps.agentStore, "pm");
		if (!pmAgent) {
			log.debug("notification", `verify→PM: no pm agent registered; cron will retry`);
			return;
		}

		const resolved = resolveSessionByRoleProject(
			{
				sessionDB: this.deps.sessionDB,
				projectStore: this.deps.projectStore,
				resolveWikiRoot: this.deps.resolveWikiRoot,
			},
			pmAgent.id,
			projectId,
		);

		const manifest = this.deps.manifestStore?.findLatestForRequirement(requirementId);
		const manifestSummary = manifest?.summary ?? "(no manifest available)";
		const prompt =
			`Requirement ${requirementId} entered verify. Judge whether the changes ` +
			`and tests cover the original requirement intent (product-level coverage, not technical).\n\n` +
			`Manifest:\n${manifestSummary}\n\n` +
			`Reply with: COVERAGE_OK or COVERAGE_FAIL <reason>.`;

		await this.deps.agentService.sendPrompt(prompt, pmAgent, resolved.session.id);
		log.agent(`notification(verify): ${requirementId} → PM session ${resolved.session.id}`);
	}

	// ─── verify accept → archivist (merge main) ─────────────────────────

	/**
	 * Decision 25: PM verified → archivist merges feature branch → main, then
	 * the requirement transitions to closed. Routes to the archivist session
	 * via resolveSessionByRoleProject.
	 */
	async notifyAcceptedForMerge(requirementId: string, projectId: string): Promise<void> {
		const archivistAgent = findRoleAgent(this.deps.agentStore, "archivist");
		if (!archivistAgent) {
			log.debug("notification", `accept→archivist: no archivist agent registered; cron will retry`);
			return;
		}

		const resolved = resolveSessionByRoleProject(
			{
				sessionDB: this.deps.sessionDB,
				projectStore: this.deps.projectStore,
				resolveWikiRoot: this.deps.resolveWikiRoot,
			},
			archivistAgent.id,
			projectId,
		);

		const prompt =
			`Requirement ${requirementId} passed PM coverage judgement. ` +
			`Merge its feature branch (req-${shortId(requirementId)}) to main, then clean up the worktree. ` +
			`After the merge, refresh your project wiki subtree structure for traceability.`;

		await this.deps.agentService.sendPrompt(prompt, archivistAgent, resolved.session.id);
		log.agent(`notification(accept): ${requirementId} → archivist session ${resolved.session.id}`);
	}

	// ─── verify reject → lead (补) ──────────────────────────────────────

	/**
	 * Decision 11: coverage judgement failed → PM notifies lead to补. The lead
	 * self-replans (resubmit Orchestrate with mode=run after fixing).
	 */
	async notifyCoverageRejected(requirementId: string, projectId: string, reason?: string): Promise<void> {
		const leadAgent = findRoleAgent(this.deps.agentStore, "lead");
		if (!leadAgent) {
			log.debug("notification", `reject→lead: no lead agent registered; cron will retry`);
			return;
		}

		const resolved = resolveSessionByRoleProject(
			{
				sessionDB: this.deps.sessionDB,
				projectStore: this.deps.projectStore,
				resolveWikiRoot: this.deps.resolveWikiRoot,
			},
			leadAgent.id,
			projectId,
		);

		const prompt =
			`PM rejected coverage for requirement ${requirementId}. Reason: ${reason ?? "(unspecified)"}.\n` +
			`Adjust the plan and resubmit an Orchestrate flow (mode=run if you've already had one confirmed).`;

		await this.deps.agentService.sendPrompt(prompt, leadAgent, resolved.session.id);
		log.agent(`notification(reject→lead): ${requirementId} → lead session ${resolved.session.id}`);
	}

	// ─── plan reject → lead (自重 Orchestrate) ──────────────────────────

	/**
	 * Decision 11: plan门 rejected → lead takes the feedback and self-reauthors
	 * the Orchestrate flow (same role, no cross-role notification needed).
	 *
	 * This is mostly informational — the ConfirmRegistry already resolved the
	 * awaiting tool call to false, so the lead loop continues with the rejection
	 * result in context. We surface it as a notification event for the kanban
	 * history log only.
	 */
	async notifyPlanRejected(_requirementId: string, _projectId: string, _reason?: string): Promise<void> {
		// No cross-role notification; lead loop already received the rejection
		// result from the Orchestrate tool (false: <reason>). Self-reauthoring
		// happens in-loop. Logged for completeness.
		log.agent(`notification(plan_reject): lead will self-reauthor Orchestrate (in-loop, no cross-role notification)`);
	}

	// ─── cron fallback — scan + backfill missed notifications (decision 10) ──

	/**
	 * Cron fallback: for one project, scan requirements whose state implies a
	 * notification should have fired but didn't (notification lost, role agent
	 * not registered yet, server restart). Re-fires the appropriate notify().
	 *
	 * Idempotent — pickup is idempotent (OQ5); PM/archivist prompts are
	 * role-session-resolved so duplicate sends just appear as repeats in the
	 * session history, no state corruption.
	 *
	 * Designed to be called from a project-scoped lead/pm cron tick (decision 10
	 * "ready/verify 交接点若通知漏掉,对应角色的 cron(scope=该 project)扫到就补上").
	 */
	async backfillPendingNotifications(projectId: string): Promise<{ pickedUp: number; verifyNotified: number }> {
		let pickedUp = 0;
		let verifyNotified = 0;
		try {
			// ready → lead: pickup unassigned ready requirements (idempotent).
			const readyReqs = this.deps.requirementStore
				.listByProject(projectId)
				.filter((r) => r.status === "ready" && !r.assignedLeadSessionId);
			for (const r of readyReqs) {
				try {
					await this.notifyReadyForPickup(r.id, projectId);
					pickedUp++;
				} catch (err) {
					log.debug("notification", `backfill ready→lead failed for ${r.id}: ${(err as Error).message}`);
				}
			}

			// verify → PM: re-notify verify-status requirements.
			const verifyReqs = this.deps.requirementStore
				.listByProject(projectId)
				.filter((r) => r.status === "verify");
			for (const r of verifyReqs) {
				try {
					await this.notifyVerifyReadyForCoverage(r.id, projectId);
					verifyNotified++;
				} catch (err) {
					log.debug("notification", `backfill verify→PM failed for ${r.id}: ${(err as Error).message}`);
				}
			}
		} catch (err) {
			log.warn("notification", `backfillPendingNotifications(${projectId}) failed: ${(err as Error).message}`);
		}
		if (pickedUp > 0 || verifyNotified > 0) {
			log.agent(`notification backfill(${projectId}): pickedUp=${pickedUp} verifyNotified=${verifyNotified}`);
		}
		return { pickedUp, verifyNotified };
	}
}

function shortId(id: string): string {
	return id.substring(0, 8);
}
