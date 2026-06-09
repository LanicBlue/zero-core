// RAG context hook handler
//
// PreLLMCall handler: inject Knowledge Base RAG context into the ephemeral context message.
// Extracted from agent-loop per the hook-driven architecture.

import { HookRegistry } from "../../core/hook-registry.js";
import type { SessionConfig } from "../types.js";
import { log } from "../../core/logger.js";

export function registerRagHooks(): void {
	const registry = HookRegistry.getInstance();

	registry.register("PreLLMCall", async (ctx) => {
		const config = ctx.config as SessionConfig;
		if (!config.getRagContext) return;

		try {
			const ragContext = await config.getRagContext(config.agentId, "");
			if (ragContext) {
				ctx.ragContext = ragContext;
			}
		} catch {
			// RAG failure is non-fatal
		}
	});

	log.debug("hooks", "RAG hooks registered");
}
