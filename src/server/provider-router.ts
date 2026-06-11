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
