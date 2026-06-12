// Compression hook handler
//
// PostTurnComplete handler: progressive compression (L1 summary + L2 memory extraction)
// Extracted from agent-loop per the hook-driven architecture.
//
// Cross-layer concern: after compression, both messages table AND turns table
// must be synced. Step-level storage makes turns the authoritative source for
// rebuildFromSteps(), so unsynced turns = compression lost on restart.

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

				// Sync turns table with compressed messages for step-level storage.
				// Without this, rebuildFromSteps() on next restart would read
				// the pre-compression turns, losing the compression effect.
				if (config.db && config.sessionId && config.db.hasStepSchema()) {
					syncTurnsAfterCompression(config.db, config.sessionId, session);
				}

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

/**
 * Rebuild step-level turns from compressed messages.
 * Each message becomes a step row; user and assistant messages alternate.
 * Tool messages are merged into the preceding assistant step's blocks.
 */
function syncTurnsAfterCompression(db: any, sessionId: string, session: AgentSession): void {
	try {
		const messages = session.getMessages();
		const steps: Array<{
			seq: number; turnGroup: number; role: string;
			content: string | null;
		}> = [];

		let seq = 0;
		let turnGroup = 0;
		let pendingToolBlocks: any[] = [];

		for (const msg of messages) {
			const role = (msg as any).role;
			if (role === "user") {
				const content = typeof (msg as any).content === "string"
					? (msg as any).content
					: JSON.stringify((msg as any).content);
				turnGroup = seq;
				steps.push({ seq, turnGroup, role: "user", content });
				seq++;
			} else if (role === "assistant") {
				const content = (msg as any).content;
				const blocks: any[] = [];

				if (typeof content === "string") {
					blocks.push({ type: "text", text: content });
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (part.type === "text" && part.text) {
							blocks.push({ type: "text", text: part.text });
						} else if (part.type === "tool-call") {
							blocks.push({
								type: "tool",
								name: part.toolName,
								args: part.input ?? part.args,
								status: "done",
								toolCallId: part.toolCallId,
							});
						}
					}
				}

				// Merge pending tool results into blocks
				for (const tb of pendingToolBlocks) {
					const matchIdx = blocks.findIndex(
						(b: any) => b.type === "tool" && b.toolCallId === tb.toolCallId,
					);
					if (matchIdx >= 0) {
						blocks[matchIdx].result = tb.result;
					}
				}
				pendingToolBlocks = [];

				if (blocks.length > 0) {
					steps.push({ seq, turnGroup, role: "assistant", content: JSON.stringify(blocks) });
					seq++;
				}
			} else if (role === "tool") {
				// Collect tool results to merge into the assistant step
				const parts = (msg as any).content;
				if (Array.isArray(parts)) {
					for (const p of parts) {
						if (p.type === "tool-result") {
							let result: string;
							if (typeof p.output === "string") result = p.output;
							else if (p.output?.type === "text") result = p.output.value;
							else result = JSON.stringify(p.output);
							pendingToolBlocks.push({ toolCallId: p.toolCallId, result });
						}
					}
				}
			}
		}

		db.replaceStepsFromMessages(sessionId, steps);
		log.debug("compression", `Synced ${steps.length} step(s) to turns table after compression`);
	} catch (err) {
		log.warn("compression", "Failed to sync turns after compression:", (err as Error).message);
	}
}
