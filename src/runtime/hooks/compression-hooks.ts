// Compression hook handler
//
// PostTurnComplete handler: progressive compression (L1 summary + L2 memory extraction)
// Extracted from agent-loop per the hook-driven architecture.

import type { HookHandler } from "../../core/hook-types.js";
import { HookRegistry } from "../../core/hook-registry.js";
import { CompressionEngine } from "../compression-engine.js";
import type { SessionConfig, RuntimeProviderConfig } from "../types.js";
import type { AgentSession } from "../session.js";
import { log } from "../../core/logger.js";

export function registerCompressionHooks(): void {
	const registry = HookRegistry.getInstance();

	registry.register("PostTurnComplete", async (ctx) => {
		const config = ctx.config as SessionConfig;
		const compressionConfig = config.compression;
		if (!compressionConfig?.enabled) return;

		const session = ctx.session as AgentSession;
		const contextUsage = ctx.contextUsage as number;

		if (contextUsage <= (compressionConfig.l1Threshold ?? 0.7)) return;

		try {
			const providers = ctx.providers as RuntimeProviderConfig[];
			const engine = new CompressionEngine(
				providers,
				config.providerName,
				config.modelId,
			);

			const result = await engine.compressIfNeeded(
				session.getMessages(),
				contextUsage,
				{
					keepRecentTurns: compressionConfig.keepRecentTurns ?? 5,
					l1Threshold: compressionConfig.l1Threshold ?? 0.7,
					l2Threshold: compressionConfig.l2Threshold ?? 0.5,
					provider: compressionConfig.provider,
					model: compressionConfig.model,
				},
			);

			if (result.didCompress || result.didExtract) {
				session.replaceMessages(result.messages);
				session.saveToDb();

				if (result.memoryNodes.length > 0 && config.db) {
					try {
						const nodeStore = config.db.getMemoryNodeStore();
						if (nodeStore) {
							nodeStore.upsertNodes(session.getSessionId() ?? null, result.memoryNodes);
						}
					} catch (err) {
						log.warn("compression", "Memory node save failed:", (err as Error).message);
					}
				}

				log.debug("compression", "Compressed:", result.didCompress, "Extracted:", result.didExtract,
					"Memory nodes:", result.memoryNodes.length, "Messages:", result.messages.length);
			}
		} catch (err) {
			log.warn("compression", "Compression failed, skipping:", (err as Error).message);
		}
	});

	log.debug("hooks", "Compression hooks registered");
}
