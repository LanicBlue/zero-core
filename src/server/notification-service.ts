// 分级通知服务
//
// # 文件说明书
//
// ## 核心功能
// Agent 判断内容重要性后的通知分发。
// 通知存储到 requirement_messages 表，同时通过 WebSocket 广播到渲染进程。
//
// ## 输入
// - RequirementRecord / TaskStepRecord — 触发通知的数据
// - WebSocketServer — 广播通道
//
// ## 输出
// - NotificationService 类
//
// ## 定位
// 服务层，被 requirement-hooks、analyst-service、lead-service 调用。
//
// ## 依赖
// - ws (WebSocket)
// - requirement-store.ts
//
// ## 维护规则
// - 通知写入和 WebSocket 广播不应阻塞主流程
// - WebSocket 发送失败不影响通知存储
//

import type { WebSocketServer } from "ws";
import type { RequirementStore } from "./requirement-store.js";
import type { RequirementRecord, TaskStepRecord } from "../shared/types.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationEvent {
	type: string;
	requirementId: string;
	projectId: string;
	priority: "info" | "warning" | "critical";
	title: string;
	message: string;
	actionUrl?: string;
	timestamp: string;
}

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

export class NotificationService {
	private wss: WebSocketServer | null;
	private requirementStore: RequirementStore;

	constructor(deps: {
		wss: WebSocketServer | null;
		requirementStore: RequirementStore;
	}) {
		this.wss = deps.wss;
		this.requirementStore = deps.requirementStore;
	}

	// ─── Public notification methods ─────────────────────────────────

	/**
	 * 关键需求通知（high/critical 优先级）。
	 */
	async notifyCriticalRequirement(requirement: RequirementRecord): Promise<void> {
		const priority: NotificationEvent["priority"] =
			requirement.priority === "critical" ? "critical" : "warning";

		this.emit({
			type: "requirement_notification",
			requirementId: requirement.id,
			projectId: requirement.projectId,
			priority,
			title: `New requirement: ${requirement.title}`,
			message: requirement.description || "",
			actionUrl: `/requirements?id=${requirement.id}`,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * 步骤失败通知。
	 */
	async notifyStepFailure(
		requirementId: string,
		projectId: string,
		step: TaskStepRecord,
	): Promise<void> {
		this.emit({
			type: "step_failure",
			requirementId,
			projectId,
			priority: "warning",
			title: `Step failed: ${step.title}`,
			message: `Role ${step.role} execution failed: ${step.error || "Unknown error"}`,
			actionUrl: `/requirements?id=${requirementId}`,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * 验证失败通知。
	 */
	async notifyVerificationFailure(
		requirementId: string,
		projectId: string,
		report: string,
	): Promise<void> {
		this.emit({
			type: "verification_failure",
			requirementId,
			projectId,
			priority: "warning",
			title: "Requirement verification failed",
			message: report.substring(0, 200),
			actionUrl: `/requirements?id=${requirementId}`,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * 执行计划待审批通知。
	 */
	async notifyPlanReviewRequired(
		requirementId: string,
		projectId: string,
	): Promise<void> {
		this.emit({
			type: "plan_review_required",
			requirementId,
			projectId,
			priority: "info",
			title: "Execution plan pending review",
			message: "Lead has created an execution plan. Review required to proceed.",
			actionUrl: `/requirements?id=${requirementId}`,
			timestamp: new Date().toISOString(),
		});
	}

	// ─── Private helpers ─────────────────────────────────────────────

	/**
	 * 通过 WebSocket 广播通知并存储到 requirement_messages。
	 */
	private emit(event: NotificationEvent): void {
		// 1. Store in requirement_messages
		try {
			this.requirementStore.addMessage(
				event.requirementId,
				"system" as any,
				event.message,
				"notification",
			);
		} catch (err) {
			log.error("notification", `Failed to store notification: ${(err as Error).message}`);
		}

		// 2. WebSocket broadcast
		if (this.wss) {
			try {
				const data = JSON.stringify(event);
				for (const client of this.wss.clients) {
					if ((client as any).readyState === 1) {  // WebSocket.OPEN
						client.send(data);
					}
				}
			} catch (err) {
				log.error("notification", `WebSocket broadcast failed: ${(err as Error).message}`);
			}
		}

		log.debug("notification", `[${event.priority}] ${event.type}: ${event.title}`);
	}
}
