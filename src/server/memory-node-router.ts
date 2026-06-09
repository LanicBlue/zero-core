// 记忆节点 REST API 路由
//
// 提供记忆节点的 Express REST API（搜索、列表、主体、删除）

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
