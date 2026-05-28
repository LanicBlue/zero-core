import { ipcMain } from "electron";
import { join } from "path";
import type { IpcContext } from "./types.js";

export function registerKbHandlers(ctx: IpcContext): void {
	ipcMain.handle("kb:list", () => ctx.modulesReady ? ctx.kbStore.list() : []);
	ipcMain.handle("kb:get", (_e, id: string) => ctx.modulesReady ? ctx.kbStore.get(id) : undefined);
	ipcMain.handle("kb:create", (_e, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		return ctx.kbStore.create(input as any);
	});
	ipcMain.handle("kb:update", (_e, id: string, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try { return ctx.kbStore.update(id, input as any); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("kb:delete", (_e, id: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		ctx.kbDb.deleteKbChunks(id);
		ctx.kbStore.delete(id);
		return { success: true };
	});
	ipcMain.handle("kb:add-files", async (_e, kbId: string, filePaths: string[]) => {
		if (!ctx.modulesReady) return { error: "loading" };
		const kb = ctx.kbStore.get(kbId);
		if (!kb) return { error: "Knowledge base not found" };
		const results: { path: string; chunks: number; error?: string }[] = [];
		for (const fp of filePaths) {
			const { statSync } = require("node:fs");
			const { basename } = require("node:path");
			try {
				const stat = statSync(fp);
				const providers = ctx.providerStore.list();
				const embProv = providers.find((p: any) => p.enabled && p.type !== "ollama");
				const { createEmbeddingProvider } = await import(ctx.toFileURL(join(ctx.distServer, "kb-embeddings.js")));
				const { ingestFile } = await import(ctx.toFileURL(join(ctx.distServer, "kb-ingest.js")));
				const embedder = createEmbeddingProvider(kb.embeddingProvider, {
					baseUrl: kb.embeddingProvider === "ollama" ? "http://localhost:11434" : (embProv?.baseUrl ?? "https://api.openai.com/v1"),
					apiKey: kb.embeddingProvider === "ollama" ? "" : (embProv?.apiKey ?? ""),
					model: kb.embeddingModel,
				});
				const result = await ingestFile(kbId, fp, ctx.kbDb, embedder);
				if (result.chunks > 0) {
					ctx.kbStore.updateFile(kbId, {
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
		return results;
	});
	ipcMain.handle("kb:remove-file", async (_e, kbId: string, filePath: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		const { removeFile } = await import(ctx.toFileURL(join(ctx.distServer, "kb-ingest.js")));
		removeFile(kbId, filePath, ctx.kbDb);
		ctx.kbStore.removeFile(kbId, filePath);
		return { success: true };
	});
	ipcMain.handle("kb:search", async (_e, kbIds: string[], query: string) => {
		if (!ctx.modulesReady) return [];
		const { search: kbSearch } = await import(ctx.toFileURL(join(ctx.distServer, "kb-search.js")));
		const allKbs = ctx.kbStore.list();
		const targetKbs = allKbs.filter((kb: any) => kbIds.includes(kb.id));
		if (targetKbs.length === 0) return [];
		const providers = ctx.providerStore.list();
		const embProv = providers.find((p: any) => p.enabled && p.type !== "ollama");
		const kb = targetKbs[0];
		const { createEmbeddingProvider } = await import(ctx.toFileURL(join(ctx.distServer, "kb-embeddings.js")));
		const embedder = createEmbeddingProvider(kb.embeddingProvider, {
			baseUrl: kb.embeddingProvider === "ollama" ? "http://localhost:11434" : (embProv?.baseUrl ?? "https://api.openai.com/v1"),
			apiKey: kb.embeddingProvider === "ollama" ? "" : (embProv?.apiKey ?? ""),
			model: kb.embeddingModel,
		});
		return kbSearch(kbIds, query, embedder, ctx.kbDb, 5);
	});
	ipcMain.handle("kb:chunk-count", (_e, kbId: string) => {
		return ctx.kbDb.getChunkCount(kbId);
	});
}
