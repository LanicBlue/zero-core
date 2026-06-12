// Runtime feature hooks — unified registration entry point
//
// All feature-specific hook handlers are registered here.
// Called once at startup from agent-service.ts, alongside registerDurableHooks().
// Registration order matters: notification → memory → rag → providerOptions.

import { registerCompressionHooks } from "./compression-hooks.js";
import { registerMemoryHooks } from "./memory-hooks.js";
import { registerNotificationHooks } from "./notification-hooks.js";
import { registerProviderOptionsHooks } from "./provider-options-hooks.js";
import { registerRagHooks } from "./rag-hooks.js";
import { registerTurnHooks } from "./turn-hooks.js";
import type { ISessionStore } from "../session-store-interface.js";
import { log } from "../../core/logger.js";

export function registerAllRuntimeHooks(db?: ISessionStore): void {
	if (db) registerTurnHooks(db);
	registerNotificationHooks();
	registerMemoryHooks();
	registerRagHooks();
	registerProviderOptionsHooks();
	registerCompressionHooks();
	log.debug("hooks", "All runtime feature hooks registered");
}
