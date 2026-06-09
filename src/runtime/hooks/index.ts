// Runtime feature hooks — unified registration entry point
//
// All feature-specific hook handlers are registered here.
// Called once at startup from agent-service.ts, alongside registerDurableHooks().

import { registerCompressionHooks } from "./compression-hooks.js";
import { registerMemoryHooks } from "./memory-hooks.js";
import { registerRagHooks } from "./rag-hooks.js";
import { log } from "../../core/logger.js";

export function registerAllRuntimeHooks(): void {
	registerCompressionHooks();
	registerMemoryHooks();
	registerRagHooks();
	log.debug("hooks", "All runtime feature hooks registered");
}
