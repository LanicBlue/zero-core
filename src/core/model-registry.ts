// 模型元数据注册表
//
// # 文件说明书
//
// ## 核心功能
// 从 OpenRouter API 或本地 fallback 数据库获取模型元数据（context window, max tokens）
//
// ## 输入
// - OpenRouter /api/v1/models 响应
// - 本地 KNOWN_MODELS fallback 数据库
// - 用户 fetch-from-API 拉取的模型列表（可能自带 context_length）
//
// ## 输出
// - enrichModels() — 为模型填充 contextWindow/maxTokens/multimodal
// - enrichInBackground() — 非阻塞版，完成后回调保存
//
// ## 定位
// src/core/ — 核心基础设施，被 IPC 和 server 层调用
//
// ## 依赖
// - node-fetch / native fetch
// - shared/types ProviderModel
//
// ## 维护规则
// 新模型发布时更新 KNOWN_MODELS；匹配策略变更需确保不破坏现有匹配
//
import type { ProviderModel } from "../shared/types.js";
import { log } from "./logger.js";

interface OpenRouterModel {
	id: string;
	context_length: number;
	architecture: {
		input_modalities: string[];
		output_modalities: string[];
	};
	top_provider: {
		max_completion_tokens: number | null;
	};
}

// ─── Local fallback database for models not in OpenRouter ─────────
// Key: regex pattern, Value: { contextWindow, maxTokens? }
const KNOWN_MODELS: { pattern: RegExp; contextWindow: number; maxTokens?: number }[] = [
	// MiniMax
	{ pattern: /^MiniMax-M3/i, contextWindow: 1_000_000, maxTokens: 128_000 },
	{ pattern: /^MiniMax-M2\.7/i, contextWindow: 200_000, maxTokens: 128_000 },
	{ pattern: /^MiniMax-M2\.5/i, contextWindow: 200_000, maxTokens: 128_000 },
	{ pattern: /^MiniMax-M2\.1/i, contextWindow: 200_000, maxTokens: 128_000 },
	{ pattern: /^MiniMax-M2$/i, contextWindow: 200_000, maxTokens: 128_000 },
	{ pattern: /^MiniMax-M1/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^abab/i, contextWindow: 128_000, maxTokens: 16_384 },
	// GLM / 智谱
	{ pattern: /^glm-5\.1/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^glm-5$/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^glm-4\.7/i, contextWindow: 205_000, maxTokens: 131_072 },
	{ pattern: /^glm-4\.6/i, contextWindow: 200_000, maxTokens: 16_384 },
	{ pattern: /^glm-4\.5/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^glm-4-long/i, contextWindow: 1_000_000, maxTokens: 16_384 },
	{ pattern: /^glm-4-flash/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^glm-4-air/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^glm-4$/i, contextWindow: 128_000, maxTokens: 16_384 },
	// DeepSeek
	{ pattern: /^deepseek-r1/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^deepseek-chat$/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^deepseek-v3/i, contextWindow: 128_000, maxTokens: 16_384 },
	// Qwen / 通义千问
	{ pattern: /^qwen-max/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^qwen-plus/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^qwen-turbo/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^qwen-long/i, contextWindow: 1_000_000, maxTokens: 16_384 },
	{ pattern: /^qwen2\.5-/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^qwen3-/i, contextWindow: 128_000, maxTokens: 16_384 },
	// Moonshot / 月之暗面
	{ pattern: /^moonshot-v1/i, contextWindow: 128_000, maxTokens: 16_384 },
	// Doubao / 豆包
	{ pattern: /^doubao/i, contextWindow: 128_000, maxTokens: 16_384 },
	// Yi / 零一万物
	{ pattern: /^yi-lightning/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^yi-large/i, contextWindow: 128_000, maxTokens: 16_384 },
	{ pattern: /^yi-vision/i, contextWindow: 128_000, maxTokens: 16_384 },
	// Hunyuan / 混元
	{ pattern: /^hunyuan/i, contextWindow: 128_000, maxTokens: 16_384 },
	// ERNIE / 文心
	{ pattern: /^ernie/i, contextWindow: 128_000, maxTokens: 16_384 },
	// Spark / 讯飞星火
	{ pattern: /^spark/i, contextWindow: 128_000, maxTokens: 16_384 },
];

function lookupLocal(modelId: string): { contextWindow: number; maxTokens?: number } | null {
	for (const entry of KNOWN_MODELS) {
		if (entry.pattern.test(modelId)) return entry;
	}
	return null;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let cachedRegistry: Map<string, OpenRouterModel> | null = null;
let cacheTimestamp = 0;

async function fetchRegistry(): Promise<Map<string, OpenRouterModel>> {
	const now = Date.now();
	if (cachedRegistry && now - cacheTimestamp < CACHE_TTL_MS) {
		return cachedRegistry;
	}

	try {
		const resp = await fetch(OPENROUTER_URL, {
			signal: AbortSignal.timeout(15000),
			headers: { "User-Agent": "zero-core/1.0" },
		});
		if (!resp.ok) {
			log.warn("model-registry", `OpenRouter API returned ${resp.status}`);
			return cachedRegistry ?? new Map();
		}
		const json = (await resp.json()) as { data: OpenRouterModel[] };
		const map = new Map<string, OpenRouterModel>();
		for (const m of json.data) {
			const modelPart = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
			map.set(modelPart, m);
			map.set(modelPart.toLowerCase(), m);
			map.set(m.id, m);
		}
		cachedRegistry = map;
		cacheTimestamp = now;
		log.debug("model-registry", `Loaded ${map.size} model entries from OpenRouter`);
		return map;
	} catch (err) {
		log.warn("model-registry", "Failed to fetch OpenRouter registry:", (err as Error).message);
		return cachedRegistry ?? new Map();
	}
}

function findMatch(modelId: string, registry: Map<string, OpenRouterModel>): OpenRouterModel | null {
		// 0. Try lowercase first (handles MiniMax-M2.7 vs minimax-m2.7)
		const lower = modelId.toLowerCase();
		const lowerMatch = registry.get(lower);
		if (lowerMatch) return lowerMatch;

		// 1. Exact match
		const exact = registry.get(modelId);
		if (exact) return exact;

		// 2. Date-suffix strip: "claude-sonnet-4-20250514" → "claude-sonnet-4"
		const noDate = modelId.replace(/-d{6,}$/, "");
		if (noDate !== modelId) {
			const stripped = registry.get(noDate) || registry.get(noDate.toLowerCase());
			if (stripped) return stripped;
		}

		// 3. Case-insensitive substring match
		let bestMatch: OpenRouterModel | null = null;
		let bestLen = 0;
		for (const [key, model] of registry) {
			if (key.length <= bestLen) continue;
			if (lower.includes(key.toLowerCase()) && key.length >= lower.length * 0.5) {
				bestMatch = model;
				bestLen = key.length;
			}
		}
		return bestMatch;
	}

export interface RawModel {
	id: string;
	name: string;
	group?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export async function enrichModels(models: RawModel[]): Promise<ProviderModel[]> {
	const registry = await fetchRegistry();
	return models.map((m): ProviderModel => {
		// 1. If provider API already gave us contextWindow, keep it
		if (m.contextWindow) {
			return { id: m.id, name: m.name, group: m.group, contextWindow: m.contextWindow, maxTokens: m.maxTokens };
		}

		// 2. Try OpenRouter
		const match = findMatch(m.id, registry);
		if (match) {
			return {
				id: m.id,
				name: m.name,
				group: m.group,
				contextWindow: match.context_length || undefined,
				maxTokens: match.top_provider?.max_completion_tokens ?? undefined,
				multimodal: match.architecture?.input_modalities?.includes("image") ?? undefined,
			};
		}

		// 3. Try local fallback database
		const local = lookupLocal(m.id);
		if (local) {
			return { id: m.id, name: m.name, group: m.group, contextWindow: local.contextWindow, maxTokens: local.maxTokens };
		}

		return { id: m.id, name: m.name, group: m.group };
	});
}

/**
 * Enrich models in the background and persist the enriched data via a callback.
 * Returns immediately; the callback fires when enrichment completes with the enriched models.
 */
export function enrichInBackground(
	models: RawModel[],
	onEnriched: (enriched: ProviderModel[]) => void,
): void {
	enrichModels(models).then(onEnriched).catch(() => {});
}
