// 全局 Wiki 记忆树浏览器 REST API 路由 (v0.8 P8 §10.9)
//
// # 文件说明书
//
// ## 核心功能
// 暴露 wiki 浏览器所需的 4 个端点,镜像 wiki-handlers.ts 的 typedHandle 版本
// (逻辑正确,unit 已证;本文件只是同样的逻辑搬到 Express 路由,使 IPC proxy
// ROUTE_MAP 能正确路由到后端):
//   - POST /api/wiki/list-by-anchors       → WikiStore.listVisibleFromAnchors
//   - GET  /api/wiki/nodes/:nodeId/detail  → WikiStore.readNodeDetail
//   - GET  /api/wiki/search                → 子串搜索, scope = anchors
//   - GET  /api/projects/:projectId/workspace-doc  → 沙箱读项目源文件
//
// 注意 workspace-doc 挂在 /api/projects/ 下 (语义上是 project-scoped 资源,
// 需要先 projectStore.get 拿 workspaceDir,再沙箱 resolve+relative 防逃逸)。
// 其它三个挂在 /api/wiki/ 下。
//
// ## 输入
// - deps.wikiStore: WikiStore (全局记忆树,server/index.ts 里构造的 wikiStoreGlobal)
// - deps.projectStore: ProjectStore (拿 workspaceDir)
// - HTTP 请求:body/query/params
//
// ## 输出
// - createWikiRouter(): Express Router (3 个 wiki-tree 端点)
// - createWorkspaceDocHandler(): RequestHandler (project-scoped workspace-doc 端点)
// - 各端点 JSON 响应;错误统一 { error: string }
//
// ## 定位
// src/server/ — REST 服务层路由,被 src/server/index.ts 挂到 /api/wiki 与
// /api/projects/:projectId/workspace-doc。wiki-handlers.ts 的 typedHandle 版本
// 保留作 in-process 备用与参考,生产路径走本文件 (经 ipc-proxy ROUTE_MAP → fetch)。
//
// ## 依赖
// - express
// - ./wiki-node-store.js — WikiStore (listVisibleFromAnchors / readNodeDetail)
// - ./project-store.js — ProjectStore (get → workspaceDir)
// - node:path / node:fs — 沙箱读取项目源文件
//
// ## 维护规则
// - buildReq 参数顺序与 preload 暴露的方法保持一致 (ipc-proxy.ts ROUTE_MAP)
// - 沙箱检查不能松:resolve + relative 防 `../` 逃逸 (与 wiki-handlers.ts 同款)
// - listVisibleFromAnchors / readNodeDetail 已在 WikiStore 实现且被 unit 覆盖,
//   本文件只是 REST 适配,不做额外逻辑
//

import { Router, type RequestHandler } from "express";
import { resolve, relative, isAbsolute } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { WikiStore } from "./wiki-node-store.js";
import type { ProjectStore } from "./project-store.js";

/**
 * Build the 3 wiki-tree endpoints (list-by-anchors / nodes/:id/detail / search).
 * Mounted under /api/wiki by src/server/index.ts.
 *
 * Mirrors wiki-handlers.ts `wiki:listByAnchors` / `wiki:readDetail` /
 * `wiki:search` typedHandle (logic identical; this is the REST port so the
 * IPC proxy ROUTE_MAP can route to the backend).
 */
export function createWikiRouter(deps: {
	wikiStore: WikiStore;
	/** v0.8 §2.13: lazy summary materialization on expand (optional). */
	archivistService?: import("./wiki-skeleton-service.js").WikiSkeletonService;
}): Router {
	const router = Router();
	const { wikiStore, archivistService } = deps;

	/**
	 * POST /api/wiki/list-by-anchors
	 * body: { anchorIds: string[] }
	 *
	 * Returns the UNION of each anchor's subtree (or the whole tree when
	 * WIKI_GLOBAL_ROOT_ID is in the set). This is the multi-anchor visibility
	 * the v0.8 spec calls for (zero sees everything; project roles see only
	 * their project subtree ∪ their memory anchor).
	 */
	router.post("/list-by-anchors", (req, res) => {
		try {
			const anchorIds: string[] = Array.isArray(req.body?.anchorIds)
				? req.body.anchorIds
				: [];
			const nodes = wikiStore.listVisibleFromAnchors(anchorIds);
			res.json(nodes);
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	/**
	 * GET /api/wiki/nodes/:nodeId/children
	 *
	 * Returns the DIRECT children of a node (indexed by idx_wiki_parent). This
	 * is the lazy tree-load primitive: the renderer fetches only the root's
	 * children initially, then a node's children on expand — instead of pulling
	 * the whole subtree in one shot.
	 */
	router.get("/nodes/:nodeId/children", (req, res) => {
		try {
			const nodes = wikiStore.getChildren(req.params.nodeId);
			res.json(nodes);
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	/**
	 * GET /api/wiki/nodes/:nodeId/detail
	 *
	 * Reads a node's on-disk body content (the "expand" path). detail is NOT on
	 * the row (lives on disk); this loads it lazily for the detail panel.
	 * Returns { nodeId, detail } — detail is undefined when the node has no
	 * body file.
	 */
	router.get("/nodes/:nodeId/detail", (req, res) => {
		try {
			const nodeId = req.params.nodeId;
			const detail = wikiStore.readNodeDetail(nodeId);
			// Materialize the rich summary lazily on first expand (scan leaves
			// it empty so it doesn't readFileSync every file at startup).
			const summary = archivistService?.ensureSummary(nodeId);
			res.json({ nodeId, detail, summary });
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	/**
	 * GET /api/wiki/search?query=<q>[&anchorIds=a,b]
	 *
	 * Substring search scoped to caller's anchors (empty/missing anchors → whole
	 * tree). P3 simple match over title/summary/path. ROUTE_MAP buildReq
	 * serializes anchorIds as `anchorIds.join(",")` under `query`; Express
	 * exposes them as req.query.anchorIds (a string); we split on comma.
	 * Empty/missing string → [].
	 */
	router.get("/search", (req, res) => {
		try {
			const query = ((req.query.query as string | undefined) ?? "").toLowerCase();
			if (!query) {
				res.json([]);
				return;
			}
			const anchorIdsRaw = (req.query.anchorIds as string | undefined) ?? "";
			const anchorIds = anchorIdsRaw
				? anchorIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
				: [];
			const pool = anchorIds.length > 0
				? wikiStore.listVisibleFromAnchors(anchorIds)
				: wikiStore.list();
			const limit = 200;
			const hits = pool.filter(
				(n) =>
					(n.title?.toLowerCase().includes(query) ?? false) ||
					(n.summary?.toLowerCase().includes(query) ?? false) ||
					(n.path?.toLowerCase().includes(query) ?? false),
			);
			res.json(hits.slice(0, limit));
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	return router;
}

/**
 * Build the workspace-doc handler. Mounted at
 * GET /api/projects/:projectId/workspace-doc?relPath=<relPath> (project-scoped,
 * NOT under /api/wiki — needs projectStore.get to resolve workspaceDir).
 *
 * Mirrors wiki-handlers.ts `wiki:readWorkspaceDoc` typedHandle (same `../`
 * sandbox check). Returns { content } on success (truncated at 50k chars with a
 * marker), or { error } on missing project / missing workspaceDir / path escape
 * / file not found / read failure.
 */
export function createWorkspaceDocHandler(deps: { projectStore: ProjectStore }): RequestHandler {
	const { projectStore } = deps;
	return (req, res) => {
		try {
			const projectId = String(req.params.projectId);
			const relPath = req.query.relPath as string | undefined;
			if (!relPath) {
				res.status(400).json({ error: "relPath query parameter is required" });
				return;
			}
			const project = projectStore.get(projectId);
			if (!project) {
				res.status(404).json({ error: `project not found: ${projectId}` });
				return;
			}
			const workspaceDir = project.workspaceDir;
			if (!workspaceDir) {
				res.status(400).json({ error: "project has no workspaceDir" });
				return;
			}
			const abs = resolve(workspaceDir, relPath);
			const relCheck = relative(workspaceDir, abs);
			if (isAbsolute(relCheck) || relCheck.startsWith("..")) {
				res.status(400).json({ error: `path outside workspace: ${relPath}` });
				return;
			}
			if (!existsSync(abs)) {
				res.status(404).json({ error: `file not found: ${relPath}` });
				return;
			}
			try {
				const content = readFileSync(abs, "utf-8");
				const max = 50000;
				if (content.length <= max) {
					res.json({ content });
				} else {
					res.json({
						content: content.slice(0, max) + `\n\n[truncated: ${content.length} → ${max} chars]`,
					});
				}
			} catch (e) {
				res.status(500).json({ error: (e as Error).message });
			}
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	};
}
