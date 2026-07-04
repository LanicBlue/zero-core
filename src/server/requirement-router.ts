// 需求 REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 Requirement 的 Express REST API 路由。project-flow F4: transition /
// create / coverage-verdict 端点改调 FlowActions 公共后端(与 runtime Flow 工具
// 单源 —— 见 src/server/flow-actions.ts)。旧路径(requirementStore 直读写)
// 保留给未迁移的调用方。
//
// ## 输入
// HTTP 请求(GET/POST/PUT/DELETE)、RequirementStore、TaskStepStore、
// FlowActions(可选,F4 起 transition/create 走它)、PmService(可选,
// coverage-verdict verify 复合)。
//
// ## 输出
// Express Router,处理 Requirement CRUD + 状态流转 + 消息 API + 覆盖判断。
//
// ## 定位
// src/server/ — 服务层,为外部 API 提供 Requirement 管理端点
//
// ## 依赖
// express、requirement-store.ts、task-step-store.ts、flow-actions.ts
//
// ## 维护规则
// API 路径变更需同步更新前端调用
//

import { Router } from "express";
import type { RequirementStore } from "./requirement-store.js";
import type { TaskStepStore } from "./task-step-store.js";
import type { NotificationService } from "./notification-service.js";
import type { FlowActions } from "./flow-actions.js";
import type { RequirementStatus } from "../shared/types.js";

export function createRequirementRouter(deps: {
	requirementStore: RequirementStore;
	taskStepStore: TaskStepStore;
	notificationService?: NotificationService;
	/**
	 * project-flow F4: shared FlowActions backend. When supplied, the
	 * transition / create / coverage-verdict endpoints route through it (the
	 * same object the runtime Flow tool uses via ctx.flowActions — single
	 * source). When absent, the endpoints fall back to the legacy direct-store
	 * path (back-compat for tests / not-yet-migrated callers).
	 */
	flowActions?: FlowActions;
}): Router {
	const router = Router();
	const { requirementStore, taskStepStore, notificationService, flowActions } = deps;

	/** GET / — list requirements (optional ?projectId=&status=) */
	router.get("/", (req, res) => {
		const filter: { projectId?: string; status?: string; priority?: string } = {};
		if (req.query.projectId) filter.projectId = req.query.projectId as string;
		if (req.query.status) filter.status = req.query.status as string;
		if (req.query.priority) filter.priority = req.query.priority as string;
		res.json(requirementStore.list(filter));
	});

	/** POST / — create requirement (project-flow F4: routes through FlowActions when wired) */
	router.post("/", (req, res) => {
		try {
			if (flowActions) {
				// Single source with the runtime Flow tool: create + write Intent
				// doc section + (natural) created signal. REST create is a user
				// action → source "user".
				const { requirement: r } = flowActions.create({
					projectId: req.body.projectId,
					title: req.body.title,
					description: req.body.description,
					priority: req.body.priority,
					impactScope: req.body.impactScope,
					source: "user",
				});
				// M5: Notify critical/high priority requirements
				if (notificationService && (r.priority === "critical" || r.priority === "high")) {
					notificationService.notifyCriticalRequirement(r).catch(() => {});
				}
				return res.status(201).json(r);
			}
			// Legacy direct-store path (back-compat).
			const r = requirementStore.create(req.body);
			if (notificationService && (r.priority === "critical" || r.priority === "high")) {
				notificationService.notifyCriticalRequirement(r).catch(() => {});
			}
			res.status(201).json(r);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	/** GET /:id — get requirement */
	router.get("/:id", (req, res) => {
		const r = requirementStore.get(req.params.id);
		if (!r) return res.status(404).json({ error: "Requirement not found" });
		res.json(r);
	});

	/** PUT /:id — update requirement (not status — use PUT /:id/status) */
	router.put("/:id", (req, res) => {
		try {
			// Strip status from body to prevent bypassing state machine
			const { status: _status, ...body } = req.body;
			const r = requirementStore.update(req.params.id, body);
			res.json(r);
		} catch (e) {
			res.status(404).json({ error: (e as Error).message });
		}
	});

	/**
	 * PUT /:id/status — transition status (validates state machine).
	 *
	 * project-flow F4: when flowActions is wired, the transition is routed
	 * through the shared backend so the doc-section write + named hook signal
	 * fire identically to the runtime Flow tool. The `action` is derived from
	 * the target status; the section body (Summary / Plan / Coverage) is
	 * optional and pulled from `req.body.section`.
	 */
	router.put("/:id/status", (req, res) => {
		try {
			const { toStatus, triggeredBy, comment } = req.body;
			if (!toStatus || !triggeredBy) {
				return res.status(400).json({ error: "toStatus and triggeredBy are required" });
			}

			if (flowActions) {
				const action = flowActionForTarget(toStatus as RequirementStatus);
				const req0 = requirementStore.get(req.params.id);
				if (action && req0) {
					try {
						const result = flowActions.transition({
							id: req.params.id,
							action,
							body: req.body.section,
							projectId: req0.projectId,
						});
						return res.json({
							requirement: result.requirement,
							historyEntry: requirementStore.getStatusHistory(req.params.id)[0],
						});
					} catch (e) {
						const msg = (e as Error).message;
						if (msg.includes("Invalid transition")) {
							const err = e as Error & { validTargets?: string[] };
							return res.status(400).json({
								error: msg,
								...(err.validTargets ? { validTargets: err.validTargets } : {}),
							});
						}
						if (msg.includes("not found")) {
							return res.status(404).json({ error: msg });
						}
						return res.status(500).json({ error: msg });
					}
				}
				// No action mapping for this target (e.g. cancelled, rework
				// verify→build, plan→ready) — fall through to the legacy direct
				// -store path so non-Flow transitions still work.
			}

			const result = requirementStore.transitionStatus(
				req.params.id, toStatus, triggeredBy, comment,
			);
			res.json(result);
		} catch (e) {
			const msg = (e as Error).message;
			if (msg.includes("Invalid transition")) {
				const err = e as Error & { validTargets?: string[] };
				return res.status(400).json({
					error: msg,
					...(err.validTargets ? { validTargets: err.validTargets } : {}),
				});
			}
			if (msg.includes("not found")) {
				return res.status(404).json({ error: msg });
			}
			res.status(500).json({ error: msg });
		}
	});

	/**
	 * POST /:id/coverage-verdict — project-flow F4 verify (user path).
	 *
	 * The user supplies the verdict directly (UI modal); no PM delegation. The
	 * shared FlowActions.verify runs the compound close (APPROVED → archivist
	 * merge + closed + Decision Log + verified signal; REJECTED → rework build
	 * + Decision Log + rejected signal). Mirrors the runtime verify action
	 * modulo the verdict source.
	 */
	router.post("/:id/coverage-verdict", async (req, res) => {
		try {
			if (!flowActions) {
				return res.status(503).json({ error: "FlowActions backend not wired" });
			}
			const req0 = requirementStore.get(req.params.id);
			if (!req0) return res.status(404).json({ error: "Requirement not found" });
			if (req0.status !== "verify") {
				return res.status(400).json({ error: `verify requires status='verify' (got '${req0.status}')` });
			}
			const result = await flowActions.verify({
				id: req.params.id,
				projectId: req0.projectId,
				source: {
					kind: "verdict",
					covered: !!req.body?.covered,
					reason: req.body?.reason,
				},
			});
			res.json({ ok: result.applied, requirement: result.requirement, text: result.text });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	/** GET /:id/history — get status change history */
	router.get("/:id/history", (req, res) => {
		res.json(requirementStore.getStatusHistory(req.params.id));
	});

	/** GET /:id/messages — get messages */
	router.get("/:id/messages", (req, res) => {
		res.json(requirementStore.getMessages(req.params.id));
	});

	/** POST /:id/messages — add message */
	router.post("/:id/messages", (req, res) => {
		try {
			const { sender, content, messageType } = req.body;
			if (!sender || !content) {
				return res.status(400).json({ error: "sender and content are required" });
			}
			const msg = requirementStore.addMessage(
				req.params.id, sender, content, messageType,
			);
			res.status(201).json(msg);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	/** GET /:id/steps — get task steps */
	router.get("/:id/steps", (req, res) => {
		res.json(taskStepStore.listByRequirement(req.params.id));
	});

	return router;
}

/**
 * Map a target status to its Flow transition action (project-flow §2). Each
 * target maps to exactly one action; targets with no Flow action (cancelled,
 * verify→build rework, plan→ready) return undefined and the caller falls
 * through to the legacy direct-store path.
 */
function flowActionForTarget(toStatus: RequirementStatus):
	| "pick" | "ready" | "plan" | "startBuild" | "finishBuild" | undefined {
	switch (toStatus) {
		case "discuss": return "pick";
		case "ready": return "ready";
		case "plan": return "plan";
		case "build": return "startBuild";
		case "verify": return "finishBuild";
		default: return undefined;
	}
}
