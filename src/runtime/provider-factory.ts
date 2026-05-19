import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { RuntimeProviderConfig } from "./types.js";

// Cache provider instances by config fingerprint
const providerCache = new Map<string, (modelId: string) => any>();

function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function resolveModel(
	providers: RuntimeProviderConfig[],
	providerName: string,
	modelId: string,
): any {
	const normalized = normalizeName(providerName);
	const provider = providers.find((p) => normalizeName(p.name) === normalized);

	if (!provider || !provider.enabled || !provider.apiKey) {
		throw new Error(`Provider not found or not enabled: ${providerName}`);
	}

	const factory = getOrCreateProvider(provider);
	return factory(modelId);
}

export function getContextWindow(
	providers: RuntimeProviderConfig[],
	providerName: string,
	modelId: string,
): number {
	const normalized = normalizeName(providerName);
	const provider = providers.find((p) => normalizeName(p.name) === normalized);
	if (!provider) return 128000;
	const model = provider.models.find((m) => m.id === modelId);
	return model?.contextWindow ?? 128000;
}

function getOrCreateProvider(config: RuntimeProviderConfig): (modelId: string) => any {
	const cacheKey = `${config.type}:${config.apiKey}:${config.baseUrl}`;
	const cached = providerCache.get(cacheKey);
	if (cached) return cached;

	let factory: (modelId: string) => any;

	switch (config.type) {
		case "openai":
		case "openai-compatible":
		case "ollama": {
			const openai = createOpenAI({
				apiKey: config.apiKey || "unused",
				baseURL: config.baseUrl || undefined,
			});
			factory = (id: string) => openai.chat(id);
			break;
		}
		case "anthropic": {
			const provider = createAnthropic({ apiKey: config.apiKey });
			factory = (id: string) => provider(id);
			break;
		}
		case "gemini": {
			const provider = createGoogleGenerativeAI({ apiKey: config.apiKey });
			factory = (id: string) => provider(id);
			break;
		}
		default:
			throw new Error(`Unknown provider type: ${config.type}`);
	}

	providerCache.set(cacheKey, factory);
	return factory;
}

export function clearProviderCache(): void {
	providerCache.clear();
}
