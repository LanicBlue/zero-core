// Cron REST API 路由 (v0.8 M1)
//
// # 文件说明书
//
// ## 核心功能
// 暴露 CronRecord 的 CRUD 接口,并联动 CronAnalysisManager 同步调度:
//   - GET    /             —— 列出 cron (可选 ?agentId 过滤)
//   - GET    /:id          —— 取单条 cron
//   - POST   /             —— 创建 cron (校验 agent + project 引用)
//   - PUT    /:id          —— 更新 cron (scope / schedule / prompt / enabled)
//   - DELETE /:id          —— 删除 cron (解绑,不级联删 agent)
//   - POST   /:id/trigger  —— 立即手动触发一次 (测试/调试用)
//
// 创建/更新/删除后调 cronManager.refreshCron(id) 让定时器与持久化状态同步。
//
// ## 输入
// - ManagementService (cron CRUD + 校验) (P3: renamed from ZeroAdminService)
// - CronAnalysisManager (调度同步)
//
// ## 输出
// - Express Router,挂载于 /api/crons
//
// ## 定位
// src/server/ — REST 路由
//
// ## 依赖
// - express
// - ./management-service (P3: renamed from ./zero-admin-service)
// - ./cron-analysis
//

import { Router } from "express";
import type { ManagementService } from "./management-service.js";
import type { CronAnalysisManager } from "./cron-analysis.js";
import type { CronRecord } from "../shared/types.js";

export function createCronRouter(deps: {
	management: ManagementService;
	cronManager: CronAnalysisManager;
}): Router {
	const router = Router();
	const { management, cronManager } = deps;

	/** GET / — list crons (optional ?agentId filter) */
	router.get("/", (req, res) => {
		const agentId = req.query.agentId as string | undefined;
		res.json(management.listCrons(agentId ? { agentId } : undefined));
	});

	/** GET /:id — get a single cron */
	router.get("/:id", (req, res) => {
		const cron = management.getCron(req.params.id);
		if (!cron) return res.status(404).json({ error: `Cron not found: ${req.params.id}` });
		res.json(cron);
	});

	/** POST / — create a cron entry */
	router.post("/", (req, res) => {
		try {
			const input = pickCreateInput(req.body);
			const cron = management.createCron(input);
			cronManager.refreshCron(cron.id);
			res.status(201).json(cron);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	/** PUT /:id — update a cron entry */
	router.put("/:id", (req, res) => {
		try {
			const input = pickUpdateInput(req.body);
			const cron = management.updateCron(req.params.id, input);
			cronManager.refreshCron(cron.id);
			res.json(cron);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	/** DELETE /:id — delete a cron entry (unbind, not cascade) */
	router.delete("/:id", (req, res) => {
		try {
			management.deleteCron(req.params.id);
			cronManager.refreshCron(req.params.id); // unschedules
			res.status(204).end();
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	/** POST /:id/trigger — manually fire a cron once (test/debug) */
	router.post("/:id/trigger", async (req, res) => {
		try {
			await cronManager.triggerCron(req.params.id);
			res.json({ ok: true });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}

function pickCreateInput(body: any) {
	const input: any = { agentId: body?.agentId, workingScope: body?.workingScope, schedule: body?.schedule };
	if (body?.prompt !== undefined) input.prompt = body.prompt;
	if (body?.enabled !== undefined) input.enabled = body.enabled;
	return input;
}

function pickUpdateInput(body: any) {
	const input: any = {};
	if (body?.workingScope !== undefined) input.workingScope = body.workingScope;
	if (body?.schedule !== undefined) input.schedule = body.schedule;
	if (body?.prompt !== undefined) input.prompt = body.prompt;
	if (body?.enabled !== undefined) input.enabled = body.enabled;
	return input;
}

// Re-export for type narrowing in callers.
export type { CronRecord };
