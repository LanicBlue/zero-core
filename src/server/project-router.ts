// 项目 REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 Project 的 Express REST API 路由
//
// ## 输入
// HTTP 请求（GET/POST/PUT/DELETE）、ProjectStore、RequirementStore、WikiStore
//
// ## 输出
// Express Router，处理 Project CRUD API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供 Project 管理端点
//
// ## 依赖
// express、project-store.ts、requirement-store.ts、project-wiki-store.ts
//
// ## 维护规则
// API 路径变更需同步更新前端调用
//
import { Router } from "express";
import type { ProjectStore } from "./project-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { ProjectWikiStore } from "./project-wiki-store.js";
import type { TaskStepStore } from "./task-step-store.js";

export function createProjectRouter(deps: {
	projectStore: ProjectStore;
	requirementStore: RequirementStore;
	wikiStore: ProjectWikiStore;
	taskStepStore: TaskStepStore;
}): Router {
	const router = Router();
	const { projectStore, requirementStore, wikiStore, taskStepStore } = deps;

	/** GET / — list projects (optional ?status= filter) */
	router.get("/", (req, res) => {
		const filter: { status?: string } = {};
		if (req.query.status) filter.status = req.query.status as string;
		res.json(projectStore.list(filter));
	});

	/** POST / — create project */
	router.post("/", (req, res) => {
		try {
			const existing = projectStore.getByPath(req.body.path);
			if (existing) {
				return res.status(409).json({ error: "Project with this path already exists" });
			}
			const p = projectStore.create(req.body);
			res.status(201).json(p);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	/** GET /:id — get project */
	router.get("/:id", (req, res) => {
		const p = projectStore.get(req.params.id);
		if (!p) return res.status(404).json({ error: "Project not found" });
		res.json(p);
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

	/** DELETE /:id — delete project (cascade) */
	router.delete("/:id", (req, res) => {
		const id = req.params.id;
		const project = projectStore.get(id);
		if (!project) return res.status(404).json({ error: "Project not found" });

		try {
			const db = (projectStore as any).store?.db;
			if (db) {
				const tx = db.transaction(() => {
					// Delete task_steps for this project's requirements
					const reqs = requirementStore.listByProject(id);
					for (const r of reqs) {
						taskStepStore.deleteByRequirement(r.id);
					}
					// Delete requirements (cascades to history + messages inside RequirementStore.delete)
					for (const r of reqs) {
						requirementStore.delete(r.id);
					}
					// Delete wiki nodes
					wikiStore.deleteByProject(id);
					// Delete project
					projectStore.delete(id);
				});
				tx();
			} else {
				// Fallback without transaction
				const reqs = requirementStore.listByProject(id);
				for (const r of reqs) {
					taskStepStore.deleteByRequirement(r.id);
				}
				for (const r of reqs) {
					requirementStore.delete(r.id);
				}
				wikiStore.deleteByProject(id);
				projectStore.delete(id);
			}
			res.status(204).end();
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	/** POST /:id/trigger-analysis — placeholder for M2 */
	router.post("/:id/trigger-analysis", (_req, res) => {
		res.status(202).json({ ok: true, message: "Analysis triggered", type: "full" });
	});

	return router;
}
