// Provider REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 LLM Provider 的 Express REST API 路由（列表、创建、更新、删除、模型查询）
//
// ## 输入
// HTTP 请求、ProviderStore
//
// ## 输出
// Express Router，处理 Provider CRUD API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供 Provider 管理端点
//
// ## 依赖
// express、provider-store.ts
//
// ## 维护规则
// Provider API 路径变更需同步更新前端调用
//
import { Router } from "express";
import type { ProviderStore } from "./provider-store.js";

export function createProviderRouter(providerStore: ProviderStore): Router {
	const router = Router();

	// providers:list — list all providers
	router.get("/", (_req, res) => {
		try {
			res.json(providerStore.list());
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// providers:get — get a single provider
	router.get("/:id", (req, res) => {
		try {
			const provider = providerStore.get(req.params.id);
			if (!provider) {
				res.status(404).json({ error: "Provider not found" });
				return;
			}
			res.json(provider);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// providers:create — create a new provider
	router.post("/", (req, res) => {
		try {
			const provider = providerStore.create(req.body);
			res.status(201).json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// providers:update — update an existing provider
	router.put("/:id", (req, res) => {
		try {
			const provider = providerStore.update(req.params.id, req.body);
			res.json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// providers:delete — delete a provider
	router.delete("/:id", (req, res) => {
		try {
			providerStore.delete(req.params.id);
			res.json({ ok: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// providers:add-model — add a model to a provider
	router.post("/:id/models", (req, res) => {
		try {
			const provider = providerStore.addModel(req.params.id, req.body);
			res.json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// providers:remove-model — remove a model from a provider
	router.delete("/:id/models/:modelId", (req, res) => {
		try {
			const provider = providerStore.removeModel(req.params.id, req.params.modelId);
			res.json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// providers:fetch-models — fetch available models from the provider's API
	router.get("/:id/fetch-models", async (req, res) => {
		try {
			const provider = providerStore.get(req.params.id);
			if (!provider || !provider.apiKey) {
				res.json([]);
				return;
			}

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
			if (!resp.ok) {
				res.json([]);
				return;
			}

			const json = await resp.json() as any;
			const rawModels = json.data || json.models || [];
			const models = rawModels.map((m: any) => ({
				id: m.id || m.name,
				name: m.name || m.id || m.display_name,
				group: m.owned_by || undefined,
			}));

			res.json(models);
		} catch {
			res.json([]);
		}
	});

	// models:list — list all models from all enabled providers
	router.get("/models", (_req, res) => {
		try {
			const providers = providerStore.list();
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
			res.json(models);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}
