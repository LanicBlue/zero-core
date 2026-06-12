// Memory recall hook handler
//
// PreLLMCall handler: FTS5 search for relevant memory nodes, inject into context.
// Extracted from agent-loop per the hook-driven architecture.

import { HookRegistry } from "../../core/hook-registry.js";
import { MemoryRecall } from "../memory-recall.js";
import type { SessionConfig } from "../types.js";
import type { AgentSession } from "../session.js";
import type { MemoryNodeStore } from "../../server/memory-node-store.js";
import { log } from "../../core/logger.js";

export function registerMemoryHooks(): void {
	const registry = HookRegistry.getInstance();

	registry.register("PreLLMCall", async (ctx) => {
		const config = ctx.config as SessionConfig;
		if (!config.memory?.enabled || config.memory.autoRecall === false) return;
		if (!config.db) return;

		const session = ctx.session as AgentSession;
		const nodeStore = (config.db as any).getMemoryNodeStore?.() as MemoryNodeStore | undefined;
		if (!nodeStore) return;

		const userMsgs = session.getMessages().filter((m: any) => m.role === "user");
		const lastUser = userMsgs[userMsgs.length - 1];
		if (!lastUser) return;

		const text = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
		try {
			const recall = new MemoryRecall(nodeStore);
			const result = await recall.recall(text, config.memory?.recallLimit);
			if (result) {
				return { memoryContext: recall.formatForContext(result) ?? undefined };
			}
		} catch {
			// recall failure is non-fatal
		}
	});

	log.debug("hooks", "Memory hooks registered");
}
