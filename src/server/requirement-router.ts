// 需求 REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 Requirement 的 Express REST API 路由
//
// ## 输入
// HTTP 请求（GET/POST/PUT/DELETE）、RequirementStore、TaskStepStore
//
// ## 输出
// Express Router，处理 Requirement CRUD + 状态流转 + 消息 API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供 Requirement 管理端点
//
// ## 依赖
// express、requirement-store.ts、task-step-store.ts
//
// ## 维护规则
// API 路径变更需同步更新前端调用
//
import { Router } from "express";
import type { RequirementStore } from "./requirement-store.js";
import type { TaskStepStore } from "./task-step-store.js";
import type { NotificationService } from "./notification-service.js";

export function createRequirementRouter(deps: {
	requirementStore: RequirementStore;
	taskStepStore: TaskStepStore;
	notificationService?: NotificationService;
}): Router {
	const router = Router();
	const { requirementStore, taskStepStore, notificationService } = deps;

	/** GET / — list requirements (optional ?projectId=&status=) */
	router.get("/", (req, res) => {
		const filter: { projectId?: string; status?: string; priority?: string } = {};
		if (req.query.projectId) filter.projectId = req.query.projectId as string;
		if (req.query.status) filter.status = req.query.status as string;
		if (req.query.priority) filter.priority = req.query.priority as string;
		res.json(requirementStore.list(filter));
	});

	/** POST / — create requirement */
	router.post("/", (req, res) => {
		try {
			const r = requirementStore.create(req.body);
			// M5: Notify critical/high priority requirements
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

	/** PUT /:id/status — transition status (validates state machine) */
	router.put("/:id/status", (req, res) => {
		try {
			const { toStatus, triggeredBy, comment } = req.body;
			if (!toStatus || !triggeredBy) {
				return res.status(400).json({ error: "toStatus and triggeredBy are required" });
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
