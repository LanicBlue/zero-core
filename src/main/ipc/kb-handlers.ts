// 知识库 IPC handlers
//
// # 文件说明书
//
// ## 核心功能
// 处理知识库（Knowledge Base）的 CRUD 和搜索 IPC 请求
//
// ## 输入
// KnowledgeBase、CreateKbInput、UpdateKbInput、搜索查询
//
// ## 输出
// 知识库列表、搜索结果、CRUD 操作结果
//
// ## 定位
// src/main/ipc/ — 主进程 IPC 层，管理知识库数据
//
// ## 依赖
// typed-ipc.ts、kbStore、kbDb、core/constants.ts
//
// ## 维护规则
// 知识库删除需要同时清理 kbDb 数据
//
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { KnowledgeBase, CreateKbInput, UpdateKbInput } from "../../shared/types.js";
import { DEFAULT_URLS } from "../../core/constants.js";

export function registerKbHandlers(ctx: IpcContext): void {
	// KB has custom delete (needs kbDb), so all handlers are manual.
	typedHandle("kb:list", "kbStore",
		(_ctx) => _ctx.kbStore.list(),
	);

	typedHandle("kb:get", "kbStore",
		(_ctx, id) => _ctx.kbStore.get(id),
	);

	typedHandle("kb:create", "kbStore",
		(_ctx, input) => _ctx.kbStore.create(input),
	);

	typedHandle("kb:update", "kbStore",
		(_ctx, id, input) => {
			try { return _ctx.kbStore.update(id, input); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("kb:delete", ["kbStore", "kbDb"],
		async (_ctx, id) => {
			_ctx.kbDb.deleteKbChunks(id);
			_ctx.kbStore.delete(id);
			return { success: true as const };
		},
	);

	typedHandle("kb:add-files", ["kbStore", "kbDb", "providerStore"],
		async (_ctx, kbId, filePaths) => {
			const kb = _ctx.kbStore.get(kbId);
			if (!kb) return filePaths.map((fp) => ({ path: fp, chunks: 0, error: "Knowledge base not found" }));
			const results: { path: string; chunks: number; error?: string }[] = [];
			const { statSync } = require("node:fs");
			const { basename } = require("node:path");
			const { join } = require("node:path");
			for (const fp of filePaths) {
				try {
					const stat = statSync(fp);
					const providers = _ctx.providerStore.list();
					const embProv = providers.find((p) => p.enabled && p.type !== "ollama");
					const { createEmbeddingProvider } = await import(_ctx.toFileURL(join(_ctx.distServer, "kb-embeddings.js")));
					const { ingestFile } = await import(_ctx.toFileURL(join(_ctx.distServer, "kb-ingest.js")));
					const embedder = createEmbeddingProvider(kb.embeddingProvider, {
						baseUrl: kb.embeddingProvider === "ollama" ? DEFAULT_URLS.ollama : (embProv?.baseUrl ?? DEFAULT_URLS.openai),
						apiKey: kb.embeddingProvider === "ollama" ? "" : (embProv?.apiKey ?? ""),
						model: kb.embeddingModel,
					});
					const result = await ingestFile(kbId, fp, _ctx.kbDb, embedder);
					if (result.chunks > 0) {
						_ctx.kbStore.updateFile(kbId, {
							path: fp, name: basename(fp), size: stat.size,
							chunks: result.chunks, ingestedAt: new Date().toISOString(),
						});
					}
					results.push({ path: fp, chunks: result.chunks, error: result.error });
				} catch (err: any) {
					results.push({ path: fp, chunks: 0, error: err.message });
				}
			}
			return results;
		},
	);

	typedHandle("kb:remove-file", ["kbStore", "kbDb"],
		async (_ctx, kbId, filePath) => {
			const { join } = require("node:path");
			const { removeFile } = await import(_ctx.toFileURL(join(_ctx.distServer, "kb-ingest.js")));
			removeFile(kbId, filePath, _ctx.kbDb);
			_ctx.kbStore.removeFile(kbId, filePath);
			return { success: true as const };
		},
	);

	typedHandle("kb:search", ["kbStore", "kbDb", "providerStore"],
		async (_ctx, kbIds, query) => {
			const { join } = require("node:path");
			const { search: kbSearch } = await import(_ctx.toFileURL(join(_ctx.distServer, "kb-search.js")));
			const allKbs = _ctx.kbStore.list();
			const targetKbs = allKbs.filter((kb) => kbIds.includes(kb.id));
			if (targetKbs.length === 0) return [];
			const providers = _ctx.providerStore.list();
			const embProv = providers.find((p) => p.enabled && p.type !== "ollama");
			const kb = targetKbs[0];
			const { createEmbeddingProvider } = await import(_ctx.toFileURL(join(_ctx.distServer, "kb-embeddings.js")));
			const embedder = createEmbeddingProvider(kb.embeddingProvider, {
				baseUrl: kb.embeddingProvider === "ollama" ? DEFAULT_URLS.ollama : (embProv?.baseUrl ?? DEFAULT_URLS.openai),
				apiKey: kb.embeddingProvider === "ollama" ? "" : (embProv?.apiKey ?? ""),
				model: kb.embeddingModel,
			});
			return kbSearch(kbIds, query, embedder, _ctx.kbDb, 5);
		},
	);

	typedHandle("kb:chunk-count", "kbDb",
		(_ctx, kbId) => _ctx.kbDb.getChunkCount(kbId),
	);
}
