// 项目 REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 Project 的 Express REST API 路由
//
// ## 输入
// HTTP 请求(GET/POST/PUT/DELETE)、ProjectStore、RequirementStore、WikiStore、
// CronStore、TaskStepStore、ManagementService(容器视图聚合)
//
// ## 输出
// Express Router,处理 Project CRUD + 容器视图 API
//
// ## 定位
// src/server/ — 服务层,为外部 API 提供 Project 管理端点
//
// ## 依赖
// express、project-store.ts、requirement-store.ts、project-wiki-store.ts、
// cron-store.ts、management-service.ts
//
// ## 维护规则
// API 路径变更需同步更新前端调用
// v0.8 (P5 §8.6): POST /:id/trigger-analysis 已删 — 扫描归 archivist
// (create 副作用 + merge 后增量扫描,§8.3)。
// v0.8 (P5 §8.6): DELETE 级联补「删该 projectId 的 crons」(原先漏)。
//
import { Router } from "express";
import type { ProjectStore } from "./project-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { ProjectWikiStore } from "./project-wiki-store.js";
import type { TaskStepStore } from "./task-step-store.js";
import type { CronStore } from "./cron-store.js";
import type { ManagementService } from "./management-service.js";

export function createProjectRouter(deps: {
	projectStore: ProjectStore;
	requirementStore: RequirementStore;
	wikiStore: ProjectWikiStore;
	taskStepStore: TaskStepStore;
	cronStore?: CronStore;
	management?: ManagementService;
}): Router {
	const router = Router();
	const { projectStore, requirementStore, wikiStore, taskStepStore, cronStore, management } = deps;

	/** GET / — list projects */
	router.get("/", (_req, res) => {
		// v0.8 (M0): status filter removed (ProjectRecord slimmed)
		res.json(projectStore.list());
	});

	/** POST / — create project */
	router.post("/", (req, res) => {
		try {
			// v0.8 (M0): workspaceDir is the unique key (was: path)
			const workspaceDir = req.body.workspaceDir ?? req.body.path;
			if (!workspaceDir) {
				return res.status(400).json({ error: "workspaceDir is required" });
			}
			const existing = projectStore.getByWorkspaceDir(workspaceDir);
			if (existing) {
				return res.status(409).json({ error: "Project with this workspaceDir already exists" });
			}
			// v0.8 (P5 §8.3): create through ManagementService when available
			// so the wiki subtree root + archivist background scan fire. Fall
			// back to the bare store when management isn't wired (tests).
			const p = management
				? management.createProject({ name: req.body.name, workspaceDir })
				: projectStore.create({ name: req.body.name, workspaceDir });
			res.status(201).json(p);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	/**
	 * GET /:id — get project metadata, or the container view when
	 * `?includeContext=1` (v0.8 P5 §8.4).
	 */
	router.get("/:id", (req, res) => {
		const p = projectStore.get(req.params.id);
		if (!p) return res.status(404).json({ error: "Project not found" });
		if (req.query.includeContext && management) {
			try {
				return res.json(management.getProjectContainerView(p.id));
			} catch (e) {
				return res.status(500).json({ error: (e as Error).message });
			}
		}
		res.json(p);
	});

	/** GET /:id/resource-usage — v0.8 P5 §8.5 (sessions token/cost SUM by projectId). */
	router.get("/:id/resource-usage", (req, res) => {
		const p = projectStore.get(req.params.id);
		if (!p) return res.status(404).json({ error: "Project not found" });
		if (!management) {
			return res.status(503).json({ error: "ManagementService not available" });
		}
		try {
			res.json(management.getProjectResourceUsage(p.id));
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	/** PUT /:id — update project */
	router.put("/:id", (req, res) => {
		try {
			const p = projectStore.update(req.params.id, req.body);
			res.json(p);
		} catch (e) {
			res.status(404).json({ error: (e as Error).message });
		}
	});

	/**
	 * DELETE /:id — delete project (cascade).
	 *
	 * v0.8 (P5 §8.6): cascade now also deletes the project's crons (previously
	 * missing). Full cascade:
	 *   - requirements → task_steps + status_history + messages (inside
	 *     RequirementStore.delete)
	 *   - wiki subtree (deleteByProject)
	 *   - **crons whose workingScope.projectId matches (P5 补)**
	 *   - the project row itself
	 */
	router.delete("/:id", (req, res) => {
		const id = req.params.id;
		const project = projectStore.get(id);
		if (!project) return res.status(404).json({ error: "Project not found" });

		try {
			// v0.8 §8.6: delegate the cascade to ManagementService so the REST
			// path and the Project tool share one source of truth (no drift).
			// The inline fallback below only runs when management isn't wired
			// (tests).
			if (management) {
				management.deleteProject(id);
			} else {
				const reqs = requirementStore.listByProject(id);
				for (const r of reqs) taskStepStore.deleteByRequirement(r.id);
				for (const r of reqs) requirementStore.delete(r.id);
				wikiStore.deleteByProject(id);
				if (cronStore) {
					for (const c of cronStore.list()) {
						if (c.workingScope?.projectId === id) cronStore.delete(c.id);
					}
				}
				projectStore.delete(id);
			}
			res.status(204).end();
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}
