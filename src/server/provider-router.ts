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

/**
 * platform-observability ② (sub-5): the agentService handle, narrowed to the
 * read-only provider-observation methods the /stats /usage /queue endpoints
 * need. AgentService implements PlatformObserver (listProviderStats /
 * getProviderUsageSeries / getProviderQueue). Optional — when absent (early
 * startup / tests) the endpoints return 503 instead of crashing.
 */
interface ProviderObservationHandle {
	listProviderStats(): any[];
	getProviderUsageSeries(provider: string, granularity: "hour" | "day", range: "24h" | "30d", model?: string): any;
	getProviderQueue(provider: string): any[];
}

export function createProviderRouter(providerStore: ProviderStore, onMutate?: () => void, agentService?: ProviderObservationHandle): Router {
	const router = Router();

	// 任何 provider 增删改后触发上层重新 setProviders —— 否则并发限制
	// (concurrencyManager.reconfigure) / apiKey / baseUrl / models 改了不生效,
	// 运行时一直用启动时载入的旧配置(并发限制"失效"的真因)。容错:reconfigure
	// 抛了也不能让写成功的 mutation 路由报错。
	const mutated = () => { try { onMutate?.(); } catch { /* ignore */ } };

	router.get("/", (_req, res) => {
		try {
			res.json(providerStore.list());
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// ─── platform-observability ② (sub-5): read-only provider observation ────
	// These MUST come before /:id to avoid param capture ("stats" / "usage" /
	// "queue" would otherwise be treated as a provider id). Same data the
	// Platform 'providerStats' resource (text) serves to agents — two faces of
	// one source. Backs the ③ kanban's KPI bar, stacked usage chart, queue list.
	router.get("/stats", (_req, res) => {
		if (!agentService) return res.status(503).json({ error: "Provider observation unavailable (agentService not injected)" });
		try { res.json(agentService.listProviderStats()); }
		catch (e) { res.status(500).json({ error: (e as Error).message }); }
	});
	router.get("/usage", (req, res) => {
		if (!agentService) return res.status(503).json({ error: "Provider observation unavailable (agentService not injected)" });
		try {
			const provider = String(req.query.provider ?? "");
			const granularity = (req.query.granularity === "day" ? "day" : "hour") as "hour" | "day";
			const range = (req.query.range === "30d" ? "30d" : "24h") as "24h" | "30d";
			const model = req.query.model ? String(req.query.model) : undefined;
			if (!provider) return res.status(400).json({ error: "provider query param required" });
			res.json(agentService.getProviderUsageSeries(provider, granularity, range, model));
		} catch (e) { res.status(500).json({ error: (e as Error).message }); }
	});
	router.get("/queue", (req, res) => {
		if (!agentService) return res.status(503).json({ error: "Provider observation unavailable (agentService not injected)" });
		try {
			const provider = String(req.query.provider ?? "");
			if (!provider) return res.status(400).json({ error: "provider query param required" });
			res.json(agentService.getProviderQueue(provider));
		} catch (e) { res.status(500).json({ error: (e as Error).message }); }
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
			mutated();
			res.status(201).json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	router.put("/:id", (req, res) => {
		try {
			const provider = providerStore.update(req.params.id, req.body);
			mutated();
			res.json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	router.delete("/:id", (req, res) => {
		try {
			providerStore.delete(req.params.id);
			mutated();
			res.json({ ok: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	router.post("/:id/models", (req, res) => {
		try {
			const provider = providerStore.addModel(req.params.id, req.body);
			mutated();
			res.json(provider);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	router.delete("/:id/models/:modelId", (req, res) => {
		try {
			const provider = providerStore.removeModel(req.params.id, req.params.modelId);
			mutated();
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
			try { providerStore.update(req.params.id, { models: enriched }); mutated(); } catch {}

			res.json(enriched);
		} catch {
			res.json([]);
		}
	});


	return router;
}
