// Provider options hook handler
//
// PreLLMCall handler: inject provider-specific options (e.g. thinking budget).
// Extracted from agent-loop's buildProviderOptions() per the hook-driven architecture.

import { HookRegistry } from "../../core/hook-registry.js";
import type { SessionConfig } from "../types.js";
import { log } from "../../core/logger.js";

export function registerProviderOptionsHooks(): void {
	HookRegistry.getInstance().register("PreLLMCall", async (ctx) => {
		const config = ctx.config as SessionConfig;
		if (!config.thinkingLevel || config.thinkingLevel === "none") return;

		const budgetTokens = ({ low: 4096, medium: 16384, high: 32768 } as Record<string, number>)[config.thinkingLevel] ?? 16384;
		return { providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens } } } };
	});

	log.debug("hooks", "Provider options hook registered");
}
