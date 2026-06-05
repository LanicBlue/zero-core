// 知识库 REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供知识库的 Express REST API 路由（列表、导入、搜索、删除）
//
// ## 输入
// HTTP 请求、KbStore、KbDB、ProviderStore
//
// ## 输出
// Express Router，处理知识库管理 API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供知识库管理端点
//
// ## 依赖
// express、kb-store.ts、kb-db.ts、kb-ingest.ts、kb-search.ts
//
// ## 维护规则
// 知识库 API 路径变更需同步更新前端调用
//
import { Router } from "express";
import { statSync } from "node:fs";
import { basename } from "node:path";
import type { KbStore } from "./kb-store.js";
import type { KbDB } from "./kb-db.js";
import type { ProviderStore } from "./provider-store.js";
import { ingestFile, removeFile } from "./kb-ingest.js";
import { search as kbSearch } from "./kb-search.js";
import { createEmbeddingProvider } from "./kb-embeddings.js";
import { DEFAULT_URLS } from "../core/constants.js";

export function createKbRouter(kbStore: KbStore, kbDb: KbDB, providerStore: ProviderStore): Router {
	const router = Router();

	/**
	 * Resolve an EmbeddingProvider using the KB's configured provider/model
	 * and the first enabled non-ollama provider for API key resolution.
	 */
	function resolveEmbedder(kb: { embeddingProvider: string; embeddingModel: string }) {
		const providers = providerStore.list();
		const embProv = providers.find((p: any) => p.enabled && p.type !== "ollama");
		return createEmbeddingProvider(kb.embeddingProvider, {
			baseUrl: kb.embeddingProvider === "ollama"
				? DEFAULT_URLS.ollama
				: (embProv?.baseUrl ?? DEFAULT_URLS.openai),
			apiKey: kb.embeddingProvider === "ollama" ? "" : (embProv?.apiKey ?? ""),
			model: kb.embeddingModel,
		});
	}

	// kb:list — list all knowledge bases
	router.get("/", (_req, res) => {
		try {
			res.json(kbStore.list());
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// kb:get — get a single knowledge base
	router.get("/:id", (req, res) => {
		try {
			const kb = kbStore.get(req.params.id);
			if (!kb) {
				res.status(404).json({ error: "Knowledge base not found" });
				return;
			}
			res.json(kb);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// kb:create — create a knowledge base
	router.post("/", (req, res) => {
		try {
			const kb = kbStore.create(req.body);
			res.status(201).json(kb);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// kb:update — update a knowledge base
	router.put("/:id", (req, res) => {
		try {
			const kb = kbStore.update(req.params.id, req.body);
			res.json(kb);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// kb:delete — delete KB chunks + store entry
	router.delete("/:id", (req, res) => {
		try {
			kbDb.deleteKbChunks(req.params.id);
			kbStore.delete(req.params.id);
			res.json({ success: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// kb:add-files — add files to a knowledge base
	router.post("/:id/files", async (req, res) => {
		try {
			const kb = kbStore.get(req.params.id);
			if (!kb) {
				res.status(404).json({ error: "Knowledge base not found" });
				return;
			}

			const { filePaths } = req.body as { filePaths: string[] };
			if (!Array.isArray(filePaths)) {
				res.status(400).json({ error: "filePaths must be an array" });
				return;
			}

			const results: { path: string; chunks: number; error?: string }[] = [];

			for (const fp of filePaths) {
				try {
					const stat = statSync(fp);
					const embedder = resolveEmbedder(kb);
					const result = await ingestFile(kb.id, fp, kbDb, embedder);

					if (result.chunks > 0) {
						kbStore.updateFile(kb.id, {
							path: fp,
							name: basename(fp),
							size: stat.size,
							chunks: result.chunks,
							ingestedAt: new Date().toISOString(),
						});
					}

					results.push({ path: fp, chunks: result.chunks, error: result.error });
				} catch (err: any) {
					results.push({ path: fp, chunks: 0, error: err.message });
				}
			}

			res.json(results);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// kb:remove-file — remove a file from a knowledge base
	router.delete("/:id/files/:filePath", (req, res) => {
		try {
			const filePath = decodeURIComponent(req.params.filePath);
			removeFile(req.params.id, filePath, kbDb);
			kbStore.removeFile(req.params.id, filePath);
			res.json({ success: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// kb:search — search across knowledge bases
	router.post("/search", async (req, res) => {
		try {
			const { kbIds, query } = req.body as { kbIds: string[]; query: string };
			if (!Array.isArray(kbIds) || kbIds.length === 0 || !query?.trim()) {
				res.json([]);
				return;
			}

			const allKbs = kbStore.list();
			const targetKbs = allKbs.filter((kb) => kbIds.includes(kb.id));
			if (targetKbs.length === 0) {
				res.json([]);
				return;
			}

			// Use the first matching KB's embedding config
			const kb = targetKbs[0];
			const embedder = resolveEmbedder(kb);
			const results = await kbSearch(kbIds, query, embedder, kbDb, 5);
			res.json(results);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// kb:chunk-count — get chunk count for a knowledge base
	router.get("/:id/chunk-count", (req, res) => {
		try {
			const count = kbDb.getChunkCount(req.params.id);
			res.json({ count });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}
