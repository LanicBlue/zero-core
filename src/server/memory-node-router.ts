// 记忆节点 REST API 路由
//
// 提供记忆节点的 Express REST API（搜索、列表、主体、删除）
//
// # 文件说明书
//
// ## 核心功能
// 围绕 MemoryNodeStore 暴露全局记忆 wiki 的查询能力:列出最近节点、按主体(subject)聚合、读取某主体的全部节点、FTS5 全文搜索以及按 id 删除节点。
//
// ## 输入
// - 注入 MemoryNodeStore 实例
// - GET /nodes query: { limit? }、GET /subject/:name、GET /search query: { q, limit? }、DELETE /nodes/:id
//
// ## 输出
// - /nodes 返回 MemoryNode[]
// - /subjects 返回 { subject, nodeCount, latestUpdate }[]
// - /subject/:name 返回 { nodes, subject }
// - /search 返回精简后的搜索结果数组 { id, subject, type, content, updatedAt }
// - /nodes/:id 删除返回 { success: true }
//
// ## 定位
// src/server/ 服务层,挂载于 /api/memory-nodes,服务于渲染进程的记忆/历史面板以及 agent 上下文查询。
//
// ## 依赖
// - express Router
// - ./memory-node-store(MemoryNodeStore)
//
// ## 维护规则
// - 节点的写入由 agent 运行时(hook)直接调用 store 完成,本路由只负责读与删除;新增写接口需评估权限边界。
// - 搜索/列表的 limit 默认值改动需同步前后端契约。
// - 主体聚合逻辑前端依赖 latestUpdate 排序,避免破坏字段名。
//


import { Router } from "express";
import type { MemoryNodeStore } from "./memory-node-store.js";

export function createMemoryNodeRouter(store: MemoryNodeStore): Router {
	const router = Router();

	// memory-nodes:nodes — list recent nodes
	router.get("/nodes", (req, res) => {
		try {
			const limit = parseInt(req.query.limit as string, 10) || 20;
			const nodes = store.getRecentNodes(limit);
			res.json(nodes);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// memory-nodes:subjects — list all subjects with node counts
	router.get("/subjects", (_req, res) => {
		try {
			const nodes = store.getRecentNodes(1000);
			const subjectMap = new Map<string, { subject: string; nodeCount: number; latestUpdate: string }>();
			for (const n of nodes) {
				const existing = subjectMap.get(n.subject);
				if (existing) {
					existing.nodeCount++;
					if (n.updatedAt > existing.latestUpdate) existing.latestUpdate = n.updatedAt;
				} else {
					subjectMap.set(n.subject, { subject: n.subject, nodeCount: 1, latestUpdate: n.updatedAt });
				}
			}
			const subjects = Array.from(subjectMap.values()).sort(
				(a, b) => b.latestUpdate.localeCompare(a.latestUpdate),
			);
			res.json(subjects);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// memory-nodes:subject-nodes — get all nodes for a subject
	router.get("/subject/:name", (req, res) => {
		try {
			const name = decodeURIComponent(req.params.name);
			const nodes = store.getNodesForSubject(name);
			const subject = store.getSubject(name);
			res.json({ nodes, subject });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// memory-nodes:search — FTS5 search
	router.get("/search", (req, res) => {
		try {
			const q = req.query.q as string;
			if (!q?.trim()) {
				res.json([]);
				return;
			}
			const limit = parseInt(req.query.limit as string, 10) || 20;
			const results = store.searchNodes(q, limit);
			res.json(results.map((r) => ({
				id: r.node.id,
				subject: r.node.subject,
				type: r.node.type,
				content: r.node.content,
				updatedAt: r.node.updatedAt,
			})));
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// memory-nodes:delete — delete a node
	router.delete("/nodes/:id", (req, res) => {
		try {
			store.deleteNode(req.params.id);
			res.json({ success: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	return router;
}
