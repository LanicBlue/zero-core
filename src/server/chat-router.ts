import { Router } from "express";
import { homedir } from "node:os";
import type { createAgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProviderStore } from "./provider-store.js";

const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export function createChatRouter(deps: {
	agentService: ReturnType<typeof createAgentService>;
	agentStore: AgentStore;
	providerStore: ProviderStore;
	workspaceConfig: any;
}): Router {
	const router = Router();
	const { agentService, agentStore, providerStore, workspaceConfig } = deps;

	router.post("/send", async (req, res) => {
		const { text, agentId, sessionId } = req.body;
		const agent = agentId ? agentStore.get(agentId) : undefined;

		const wsDir = expandHome(agent?.workspaceDir || workspaceConfig.workspaceDir);
		agentService.setWorkspaceDir(wsDir);

		const providerConfigs = providerStore.list().map((p: any) => ({
			name: p.name,
			type: p.type,
			apiKey: p.apiKey,
			baseUrl: p.baseUrl,
			models: p.models.map((m: any) => ({
				id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
			})),
			enabled: p.enabled,
			enableConcurrencyLimit: p.enableConcurrencyLimit ?? false,
			maxConcurrency: p.maxConcurrency ?? 1,
		}));
		agentService.setProviders(providerConfigs, workspaceConfig.defaultModel, workspaceConfig.defaultProvider);

		agentService.sendPrompt(text, agent, sessionId).catch(() => {
			// Error events are forwarded via WebSocket
		});

		res.json({ success: true });
	});

	router.post("/abort", async (_req, res) => {
		await agentService.abort();
		res.json({ success: true });
	});

	return router;
}
