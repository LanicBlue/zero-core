import { ipcMain } from "electron";
import type { IpcContext } from "./types.js";

export function registerProviderHandlers(ctx: IpcContext): void {
	ipcMain.handle("providers:list", () => ctx.modulesReady ? ctx.providerStore.list() : []);
	ipcMain.handle("providers:get", (_e, id: string) => ctx.modulesReady ? ctx.providerStore.get(id) : undefined);
	ipcMain.handle("providers:create", (_e, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		return ctx.providerStore.create(input as any);
	});
	ipcMain.handle("providers:update", (_e, id: string, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try { return ctx.providerStore.update(id, input as any); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("providers:delete", (_e, id: string) => {
		if (ctx.modulesReady) ctx.providerStore.delete(id);
		return { success: true };
	});
	ipcMain.handle("providers:add-model", (_e, providerId: string, model: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try { return ctx.providerStore.addModel(providerId, model as any); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("providers:remove-model", (_e, providerId: string, modelId: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try { return ctx.providerStore.removeModel(providerId, modelId); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("providers:fetch-models", async (_e, providerId: string) => {
		if (!ctx.modulesReady) return [];
		const provider = ctx.providerStore.get(providerId);
		if (!provider || !provider.apiKey) return [];
		try {
			const baseUrl = provider.baseUrl.replace(/\/+$/, "");
			const url = provider.type === "anthropic"
				? `${baseUrl}/v1/models`
				: `${baseUrl}/models`;
			const headers: Record<string, string> = {};
			if (provider.type === "anthropic") {
				headers["x-api-key"] = provider.apiKey;
				headers["anthropic-version"] = "2023-06-01";
			} else {
				headers["Authorization"] = `Bearer ${provider.apiKey}`;
			}
			const resp = await fetch(url, { headers });
			if (!resp.ok) return [];
			const json = await resp.json() as any;
			const rawModels = json.data || json.models || [];
			return rawModels.map((m: any) => ({
				id: m.id || m.name,
				name: m.name || m.id || m.display_name,
				group: m.owned_by || undefined,
			}));
		} catch {
			return [];
		}
	});

	ipcMain.handle("models:list", () => {
		if (!ctx.modulesReady) return [];
		const providers = ctx.providerStore.list();
		const models: { provider: string; id: string; name: string; contextWindow?: number; maxTokens?: number }[] = [];
		for (const p of providers) {
			if (!p.enabled) continue;
			for (const m of p.models) {
				models.push({
					provider: p.name,
					id: m.id,
					name: m.name || m.id,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
				});
			}
		}
		return models;
	});
}
