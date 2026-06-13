// 项目 Wiki REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 ProjectWiki 的 Express REST API 路由
//
// ## 输入
// HTTP 请求（GET/POST/PUT/DELETE）、ProjectWikiStore
//
// ## 输出
// Express Router，处理 Wiki 节点 CRUD API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供 Wiki 管理端点
//
// ## 依赖
// express、project-wiki-store.ts
//
// ## 维护规则
// API 路径变更需同步更新前端调用
//
import { Router } from "express";
import type { ProjectWikiStore } from "./project-wiki-store.js";

export function createWikiRouter(deps: {
	wikiStore: ProjectWikiStore;
}): Router {
	const router = Router();
	const { wikiStore } = deps;

	/** GET /:projectId/nodes — list wiki nodes for a project */
	router.get("/:projectId/nodes", (req, res) => {
		const filter: { projectId: string; parentId?: string; nodeType?: string } = {
			projectId: req.params.projectId,
		};
		if (req.query.parentId !== undefined) {
			filter.parentId = req.query.parentId as string;
		}
		if (req.query.nodeType) {
			filter.nodeType = req.query.nodeType as string;
		}
		res.json(wikiStore.list(filter));
	});

	/** GET /node/:id — get single wiki node */
	router.get("/node/:id", (req, res) => {
		const node = wikiStore.get(req.params.id);
		if (!node) return res.status(404).json({ error: "Wiki node not found" });
		res.json(node);
	});

	/** POST /:projectId/nodes — create wiki node */
	router.post("/:projectId/nodes", (req, res) => {
		try {
			const input = {
				...req.body,
				projectId: req.params.projectId,
			};
			// Check for path conflict
			const existing = wikiStore.getByPath(req.params.projectId, input.path);
			if (existing) {
				return res.status(409).json({
					error: `Wiki node with path '${input.path}' already exists in this project`,
				});
			}
			const node = wikiStore.create(input);
			res.status(201).json(node);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	/** PUT /node/:id — update wiki node */
	router.put("/node/:id", (req, res) => {
		try {
			const node = wikiStore.update(req.params.id, req.body);
			res.json(node);
		} catch (e) {
			res.status(404).json({ error: (e as Error).message });
		}
	});

	/** DELETE /node/:id — delete wiki node (cascade children) */
	router.delete("/node/:id", (req, res) => {
		const node = wikiStore.get(req.params.id);
		if (!node) return res.status(404).json({ error: "Wiki node not found" });
		wikiStore.delete(req.params.id);
		res.status(204).end();
	});

	return router;
}
