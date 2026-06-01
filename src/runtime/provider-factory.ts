import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { wrapLanguageModel } from "ai";
import type { RuntimeProviderConfig } from "./types.js";
import type { ProviderConcurrencyManager } from "./provider-concurrency-manager.js";
import { log } from "../core/logger.js";

// Cache provider instances by config fingerprint
const providerCache = new Map<string, (modelId: string) => any>();
let _concurrencyManager: import("./provider-concurrency-manager.js").ProviderConcurrencyManager | undefined;

function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function setConcurrencyManager(mgr: import("./provider-concurrency-manager.js").ProviderConcurrencyManager | undefined): void { _concurrencyManager = mgr; }

export function resolveModel(
	providers: RuntimeProviderConfig[],
	providerName: string,
	modelId: string,
	concurrencyManager?: ProviderConcurrencyManager,
): any {
	const normalized = normalizeName(providerName);
	const provider = providers.find((p) => normalizeName(p.name) === normalized);

	if (!provider || !provider.enabled || !provider.apiKey) {
		throw new Error(`Provider not found or not enabled: ${providerName}`);
	}

	const factory = getOrCreateProvider(provider);
	const model = factory(modelId);

	const queue = _concurrencyManager?.getQueue(providerName);
	if (queue) {
		log.debug("concurrency", `Wrapping model with queue for ${providerName}`);
		return wrapLanguageModel({
			model,
			middleware: {
				specificationVersion: "v3",
				wrapStream: async ({ doStream }) => {
					await queue.acquire();
					log.debug("concurrency", `Acquired for ${providerName}`);
					try {
						const result = await doStream();
						// Wrap the ReadableStream to release when fully consumed
						const originalStream = result.stream;
						const releaseOnEnd = new TransformStream({
							transform(chunk, controller) {
								controller.enqueue(chunk);
							},
							flush() {
								queue.release();
								log.debug("concurrency", `Released for ${providerName} (stream end)`);
							},
						});
						result.stream = originalStream.pipeThrough(releaseOnEnd);
						return result;
					} catch (err) {
						queue.release();
						log.debug("concurrency", `Released for ${providerName} (error)`);
						throw err;
					}
				},
				wrapGenerate: async ({ doGenerate }) => {
					await queue.acquire();
					try {
						const result = await doGenerate();
						queue.release();
						log.debug("concurrency", `Released for ${providerName} (generate done)`);
						return result;
					} catch (err) {
						queue.release();
						throw err;
					}
				},
			},
		});
	}

	return model;
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
