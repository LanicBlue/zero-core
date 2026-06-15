// LLM Provider 与模型清单的 CRUD REST 入口,并支持从远端拉取可用模型
//
// # 文件说明书
//
// ## 核心功能
// 提供 provider 的列表、详情、增删改、模型增删、跨 provider 聚合的模型列表,以及 /:id/fetch-models:用 provider 的 apiKey 实际请求远端 /v1/models(Anthropic)或 /models(OpenAI 兼容),把返回的模型经 enrichModels(OpenRouter 元数据补全)后落库。
//
// ## 输入
// - 注入 ProviderStore
// - POST/PUT 请求体: Provider 字段;POST/DELETE /:id/models 操作单个模型
// - fetch-models 用 provider.type 区分请求头(x-api-key vs Authorization)
//
// ## 输出
// - GET /、GET /:id、GET /models 返回 Provider / 模型数组
// - POST / 返回 201 与新建 Provider
// - fetch-models 返回 enrich 后的模型数组(失败时返回 [])
//
// ## 定位
// src/server/ 服务层,挂载于 /api/providers,服务于设置页的 Provider 管理与 chat 前的模型选择。
//
// ## 依赖
// - express Router、全局 fetch
// - ./provider-store、../core/model-registry(enrichModels)
// - ../shared/types
//
// ## 维护规则
// - fetch-models 失败一律返回 [] 而不是 500,前端按空数组提示用户。
// - 远端响应字段映射(context_length / max_tokens 等多种命名)扩展时同步更新 mapped 字段。
// - 任何会改动 Provider 配置的接口都要保证 agentService 能在下次发请求时拿到最新 provider(由上层重新 setProviders)。
//

import { Router } from "express";
import type { ProviderStore } from "./provider-store.js";
import { enrichModels } from "../core/model-registry.js";

export function createProviderRouter(providerStore: ProviderStore): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		try {
			res.json(providerStore.list());
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});


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

	router.post("/", (req, res) => {
		try {
			const provider = providerStore.create(req.body);
			res.status(201).json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	router.put("/:id", (req, res) => {
		try {
			const provider = providerStore.update(req.params.id, req.body);
			res.json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	router.delete("/:id", (req, res) => {
		try {
			providerStore.delete(req.params.id);
			res.json({ ok: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	router.post("/:id/models", (req, res) => {
		try {
			const provider = providerStore.addModel(req.params.id, req.body);
			res.json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	router.delete("/:id/models/:modelId", (req, res) => {
		try {
			const provider = providerStore.removeModel(req.params.id, req.params.modelId);
			res.json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

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
			const mapped = rawModels.map((m: any) => ({
				id: m.id || m.name,
				name: m.name || m.id || m.display_name,
				group: m.owned_by || undefined,
				contextWindow: m.context_length || m.context_window || m.max_context_length || undefined,
				maxTokens: m.max_tokens || m.max_completion_tokens || m.max_output_tokens || undefined,
			}));

			// Enrich with context window / max tokens from OpenRouter + local fallback
			const enriched = await enrichModels(mapped);
			try { providerStore.update(req.params.id, { models: enriched }); } catch {}

			res.json(enriched);
		} catch {
			res.json([]);
		}
	});


	return router;
}
