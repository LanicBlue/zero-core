// Cron REST API 路由 (v0.8 M1;P4 加 cron_runs 读)
//
// # 文件说明书
//
// ## 核心功能
// 暴露 CronRecord 的 CRUD 接口,并联动 CronAnalysisManager 同步调度:
//   - GET    /             —— 列出 cron (?agentId / ?projectId / ?enabled 过滤)
//   - GET    /:id          —— 取单条 cron
//   - GET    /:id/runs     —— 取该 cron 的 cron_runs 审计记录 (newest-first)
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
// - CronRunStore (P4 §9.3 audit read)
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
// - ./cron-store (CronRunStore)
//

import { Router } from "express";
import type { ManagementService } from "./management-service.js";
import type { CronAnalysisManager } from "./cron-analysis.js";
import type { CronRunStore } from "./cron-store.js";
import type { CronRecord } from "../shared/types.js";

export function createCronRouter(deps: {
	management: ManagementService;
	cronManager: CronAnalysisManager;
	cronRunStore?: CronRunStore;
}): Router {
	const router = Router();
	const { management, cronManager, cronRunStore } = deps;

	/** GET / — list crons (?agentId / ?projectId / ?enabled filter, §9.4) */
	router.get("/", (req, res) => {
		const agentId = req.query.agentId as string | undefined;
		const projectId = req.query.projectId as string | undefined;
		const enabledRaw = req.query.enabled as string | undefined;
		const enabled = enabledRaw === undefined ? undefined : enabledRaw === "true";
		res.json(management.listCrons({
			...(agentId ? { agentId } : {}),
			...(projectId ? { projectId } : {}),
			...(enabled !== undefined ? { enabled } : {}),
		}));
	});

	/** GET /:id/runs — cron_runs audit log for one cron (newest-first). */
	router.get("/:id/runs", (req, res) => {
		if (!cronRunStore) return res.json([]);
		const limitRaw = parseInt((req.query.limit as string) ?? "50", 10);
		const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
		const rows = cronRunStore.listByCron(req.params.id).slice(0, limit);
		res.json(rows);
	});

	// platform-observability ③ (sub-6): GET /today is RETIRED. The ③ kanban now
	// reads today's planned cron fires via the unified dispatcher —
	// toolRun({tool:"Cron", input:{action:"today"}}) → the Cron tool's execute,
	// which calls cronManager.listTodaysFires() directly (registered as the
	// process-wide CronAnalysisManager singleton). The REST route is removed;
	// no IPC channel maps to it anymore. (The /:id route below now needs no
	// "/today" guard since today is no longer a path segment.)

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

	/** DELETE /:id — delete a cron entry (unbind, not cascade). P4 also
	 *  drops cron_runs rows (audit history for a now-gone schedule). */
	router.delete("/:id", (req, res) => {
		try {
			management.deleteCron(req.params.id);
			cronRunStore?.deleteByCron(req.params.id);
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
