// LLM Provider 请求/响应适配器
//
// # 文件说明书
//
// ## 核心功能
// 统一不同 LLM provider 的请求格式和响应处理适配
//
// ## 输入
// ZeroCoreConfig、provider 名称、请求参数
//
// ## 输出
// ProviderAdapterResult，包含系统提示附加内容、token 限制等适配参数
//
// ## 定位
// src/core/ — 核心层，隔离 provider 差异性
//
// ## 依赖
// config.ts
//
// ## 维护规则
// 新增 provider 支持时需在此添加适配逻辑
//
import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Provider request/response adapter
// ---------------------------------------------------------------------------

export interface ProviderAdapterResult {
	systemPromptAppend?: string;
	maxSystemPromptTokens?: number;
	stripThinkingTags?: boolean;
}

/**
 * Look up provider-specific compatibility settings from config.
 * Called from extension hooks to adapt requests per provider.
 */
export function getProviderAdapter(
	config: ZeroCoreConfig,
	provider: string,
): ProviderAdapterResult {
	const compat = config.providerAdapter.compatibility?.[provider];
	if (!compat) return {};
	return { ...compat };
}
