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
