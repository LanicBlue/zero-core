import { ipcMain } from "electron";
import { homedir } from "node:os";
import type { IpcContext } from "./types.js";
import { ensureAgentService, getMainWindow } from "./core.js";

const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export function registerChatHandlers(ctx: IpcContext): void {
	ipcMain.handle("chat:send", async (_e, text: string, agentId?: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		const svc = await ensureAgentService();
		const agent = agentId ? ctx.agentStore.get(agentId) : undefined;

		const wsDir = expandHome(agent?.workspaceDir || ctx.workspaceConfig.workspaceDir);
		svc.setWorkspaceDir(wsDir);

		const providerConfigs = ctx.providerStore.list().map((p: any) => ({
			name: p.name,
			type: p.type,
			apiKey: p.apiKey,
			baseUrl: p.baseUrl,
			models: p.models.map((m: any) => ({
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
			})),
			enabled: p.enabled,
		}));
		svc.setProviders(providerConfigs, ctx.workspaceConfig.defaultModel, ctx.workspaceConfig.defaultProvider);

		const win = getMainWindow();
		svc.sendPrompt(text, agent).catch((err: any) => {
			if (win && !win.isDestroyed()) {
				win.webContents.send("agent:event", { type: "error", error: err.message, agentId: agentId ?? undefined });
			}
		});
		return { success: true };
	});

	ipcMain.handle("chat:abort", async () => {
		if (ctx.agentService) await ctx.agentService.abort();
		return { success: true };
	});

	ipcMain.handle("chat:state", (_e, agentId?: string) => ctx.agentService ? ctx.agentService.getState(agentId) : { isBusy: false });
}
