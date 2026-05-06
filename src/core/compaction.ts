import type { ZeroCoreConfig } from "./config.js";

export function shouldCompact(
	config: ZeroCoreConfig,
	tokensBefore: number,
	contextWindow: number,
): boolean {
	if (config.compaction.strategy === "pi-default") {
		// Let Pi handle it
		return false;
	}
	const reserve = config.compaction.reserveTokens ?? 16384;
	return tokensBefore > contextWindow - reserve;
}

export function buildCompactionInstructions(config: ZeroCoreConfig): string | undefined {
	if (config.compaction.strategy !== "custom") return undefined;
	return config.compaction.customInstructions;
}
