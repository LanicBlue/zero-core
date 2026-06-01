import { homedir } from "node:os";
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import { ensureAgentService, getMainWindow } from "./core.js";

const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export function registerChatHandlers(ctx: IpcContext): void {
	typedHandle("chat:send", ["agentService", "workspaceConfig"],
		async (_ctx, text, agentId, sessionId?) => {
			const svc = await ensureAgentService();
			const agent = agentId ? _ctx.agentStore.get(agentId) : undefined;

			const wsDir = expandHome(agent?.workspaceDir || _ctx.workspaceConfig.workspaceDir);
			svc.setWorkspaceDir(wsDir);

			const providerConfigs = _ctx.providerStore.list().map((p: any) => ({
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
				enableConcurrencyLimit: p.enableConcurrencyLimit ?? false,
				maxConcurrency: p.maxConcurrency ?? 1,
			}));
			svc.setProviders(providerConfigs, _ctx.workspaceConfig.defaultModel, _ctx.workspaceConfig.defaultProvider);

			const win = getMainWindow();
			svc.sendPrompt(text, agent, sessionId).catch((err: any) => {
				if (win && !win.isDestroyed()) {
					win.webContents.send("agent:event", { type: "error", error: err.message, agentId: agentId ?? undefined, sessionId });
				}
			});
			return { success: true as const };
		},
	);

	typedHandle("chat:abort", [],
		async (_ctx, agentId) => {
			if (_ctx.agentService) await _ctx.agentService.abort();
			return { success: true as const };
		},
	);

	typedHandle("chat:state", [],
		(_ctx, agentId) => _ctx.agentService ? _ctx.agentService.getState(agentId) : { isBusy: false, streamingText: "", toolCalls: [] },
	);
}
