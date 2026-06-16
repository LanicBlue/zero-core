// Orchestrate 计划确认 + 清单 REST 路由 (v0.8 M3)
//
// # 文件说明书
//
// ## 核心功能
// 暴露 Orchestrate confirm 门的外部触发路径 + manifest 查询:
//   POST /api/orchestrate/plans/:id/confirm        — 确认 pending plan → 引擎 run
//   POST /api/orchestrate/plans/:id/reject         — 驳回 pending plan(reason)
//   GET  /api/orchestrate/plans                    — 列出 plan(可按 projectId/state 过滤)
//   GET  /api/orchestrate/plans/:id                — 单个 plan 详情
//   GET  /api/orchestrate/manifests?requirementId= — 最新/全部 manifest
//   GET  /api/orchestrate/manifests/:id            — 单个 manifest 详情
//   GET  /api/orchestrate/pending?projectId=       — 看板用:列出 pending plan
//
// 确认/驳回实现 = 调 ConfirmRegistry.confirm / .reject,resolve 那个 await 中
// 的工具 Promise(决策 11 关键 —— 「停住不占资源」的唤醒端)。
//
// ## 输入
// HTTP 请求 + OrchestratePlanStore / OrchestrateManifestStore
//
// ## 输出
// Express Router
//
// ## 定位
// 服务层 REST,被 server/index.ts 挂在 /api/orchestrate。
//
// ## 依赖
// - express
// - ./orchestrate-store (OrchestratePlanStore, OrchestrateManifestStore, ConfirmRegistry)
//
// ## 维护规则
// - confirm/reject 不抛错,plan 不存在或不在 pending 状态返回 409
// - 驳回需带 reason 存进 plan.rejectionReason
//

import { Router } from "express";
import type { OrchestratePlanStore, OrchestrateManifestStore } from "./orchestrate-store.js";
import { ConfirmRegistry } from "./orchestrate-store.js";
import type { OrchestrateConfirmState } from "../shared/types.js";

export function createOrchestrateRouter(deps: {
	planStore: OrchestratePlanStore;
	manifestStore: OrchestrateManifestStore;
}): Router {
	const router = Router();
	const { planStore, manifestStore } = deps;
	const registry = ConfirmRegistry.getInstance();

	/** GET /plans — list plans, optional filters: projectId / state / requirementId */
	router.get("/plans", (req, res) => {
		const filter: { projectId?: string; state?: OrchestrateConfirmState; requirementId?: string } = {};
		if (req.query.projectId) filter.projectId = req.query.projectId as string;
		if (req.query.state) filter.state = req.query.state as OrchestrateConfirmState;
		if (req.query.requirementId) filter.requirementId = req.query.requirementId as string;
		res.json(planStore.list(filter));
	});

	/** GET /plans/:id — single plan */
	router.get("/plans/:id", (req, res) => {
		const plan = planStore.get(req.params.id);
		if (!plan) return res.status(404).json({ error: "plan not found" });
		res.json(plan);
	});

	/** GET /pending — kanban entry: plans currently in confirm-gate pending state */
	router.get("/pending", (req, res) => {
		const projectId = req.query.projectId as string | undefined;
		const filter: { state: OrchestrateConfirmState; projectId?: string } = { state: "pending" };
		if (projectId) filter.projectId = projectId;
		res.json(planStore.list(filter));
	});

	/** POST /plans/:id/confirm — confirm a pending plan → unblocks the awaiting tool */
	router.post("/plans/:id/confirm", (req, res) => {
		const plan = planStore.get(req.params.id);
		if (!plan) return res.status(404).json({ error: "plan not found" });
		if (plan.state !== "pending") {
			return res.status(409).json({ error: `plan not pending (state=${plan.state})` });
		}
		// Persist transition; the ConfirmRegistry.confirm() resolves the
		// awaiting tool promise so the engine proceeds to run.
		planStore.setState(plan.id, "confirmed");
		const ok = registry.confirm(plan.id);
		if (!ok) {
			// No active awaiter (e.g. server restarted while plan was pending).
			// cron fallback will re-surface, or the lead loop is no longer alive.
			return res.json({ success: false, reason: "no active awaiter (lead loop gone? cron will retry)" });
		}
		res.json({ success: true, planId: plan.id });
	});

	/** POST /plans/:id/reject — reject a pending plan with a reason → tool returns false:reason */
	router.post("/plans/:id/reject", (req, res) => {
		const plan = planStore.get(req.params.id);
		if (!plan) return res.status(404).json({ error: "plan not found" });
		if (plan.state !== "pending") {
			return res.status(409).json({ error: `plan not pending (state=${plan.state})` });
		}
		const reason = (req.body?.reason as string) || "(no reason given)";
		planStore.setState(plan.id, "rejected", { rejectionReason: reason });
		const ok = registry.reject(plan.id);
		if (!ok) {
			return res.json({ success: false, reason: "no active awaiter (lead loop gone?)" });
		}
		res.json({ success: true, planId: plan.id, reason });
	});

	/** GET /manifests — list manifests, optional filter: requirementId / planId / projectId */
	router.get("/manifests", (req, res) => {
		const filter: { requirementId?: string; planId?: string; projectId?: string } = {};
		if (req.query.requirementId) filter.requirementId = req.query.requirementId as string;
		if (req.query.planId) filter.planId = req.query.planId as string;
		if (req.query.projectId) filter.projectId = req.query.projectId as string;
		res.json(manifestStore.list(filter));
	});

	/** GET /manifests/:id — single manifest */
	router.get("/manifests/:id", (req, res) => {
		const m = manifestStore.get(req.params.id);
		if (!m) return res.status(404).json({ error: "manifest not found" });
		res.json(m);
	});

	return router;
}
