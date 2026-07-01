// PostTurnComplete 钩子：触发渐进式压缩并同步 messages 表与 turns 表。
//
// # 文件说明书
//
// ## 核心功能
// registerCompressionHooks 在 PostTurnComplete 注册处理器：当 contextUsage 超过阈值时调用
// CompressionEngine.compressIfNeeded；若发生压缩或抽取，则 replaceMessages + saveToDb，再通过
// syncTurnsAfterCompression 重建 step-level turns（避免重启 rebuildFromSteps 时丢失压缩效果），
// 最后把抽出的记忆节点写入 MemoryNodeStore。
//
// ## 输入
// - Hook 上下文：config（SessionConfig.compression）、session、contextUsage、providers
// - CompressionEngine 输出的压缩 messages 与 memoryNodes
//
// ## 输出
// - 副作用：更新 session 内存态、DB messages、DB turns、memory-node 表
// - 无返回值；失败时仅 warn 不抛出
//
// ## 定位
// runtime/hooks 层，是 compression-engine 与 session/DB 之间的胶水；由 hooks/index.ts 统一注册。
//
// ## 依赖
// - core/hook-registry、core/hook-types、core/logger
// - runtime/compression-engine、runtime/types、runtime/session
// - server/memory-node-store、具备 hasStepSchema/replaceStepsFromMessages 的 DB
//
// ## 维护规则
// - 压缩阈值或 keepRecentTurns 默认值调整时，同步更新 types.ts 的 SessionConfig.compression 注释。
// - step-level turns 重建逻辑（syncTurnsAfterCompression）改动后必须验证重启 rebuildFromSteps
//   仍能还原压缩结果，否则会出现"重启后压缩消失"。
// - 任何新增的压缩后副作用都应放进本处理器，禁止把内联代码写回 agent-loop。

import type { HookHandler } from "../../core/hook-types.js";
import { HookRegistry } from "../../core/hook-registry.js";
import { CompressionEngine } from "../compression-engine.js";
import type { SessionConfig, RuntimeProviderConfig } from "../types.js";
import type { AgentSession } from "../session.js";
// v0.8 (M5): memory node migration — write to wiki tree (memory nodes) instead
// of legacy MemoryNodeStore. memoryTypeRootId is shared with extractor-a-service
// so all memory writes converge on the same parent layout.
import { memoryTypeRootId } from "../../server/wiki-node-store.js";
import { log } from "../../core/logger.js";

/**
 * Slugify a subject for use in the wiki memory node path. Duplicated from
 * extractor-a-service so compression-hooks doesn't need a circular import
 * (extractor-a-service imports the runtime layer via provider-factory; this
 * is the runtime layer importing back).
 */
function subjectSlug(subject: string): string {
	return subject
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64) || "unnamed";
}

/**
 * Wiki memory-type-root id, identical to the one exported from wiki-node-store
 * (kept as a local alias to avoid surprising renames if the export moves).
 */
function wikiMemoryTypeRootId(type: string): string {
	return memoryTypeRootId(type as any);
}

export function registerCompressionHooks(registry: HookRegistry = HookRegistry.getInstance()): void {

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
						// v0.8 (M5): memory nodes are migrated to the global wiki
						// tree (type=memory). The wiki tree is the canonical
						// location for content memory (decision 53); the legacy
						// MemoryNodeStore is kept for back-compat reads of
						// pre-M5 data, but new writes go to the wiki tree so
						// extractor A (which also writes there) sees them.
						//
						// If config.wikiStoreGlobal is unavailable (e.g. the
						// session wasn't created via agent-service in tests),
						// fall back to the legacy MemoryNodeStore so we don't
						// silently lose the extraction.
						const wikiGlobal = (config as any).wikiStoreGlobal;
						if (wikiGlobal) {
							for (const fact of result.memoryNodes) {
								try {
									// Reuse extractor A's write path so all
									// content memory goes through the same
									// global memory-type-root layout.
									wikiGlobal.ensureMemoryTypeRoot(fact.type);
									const parentId = wikiMemoryTypeRootId(fact.type);
									const path = `memory:${subjectSlug(fact.subject)}`;
									wikiGlobal.createMemoryNode({
										parentId,
										path,
										title: `${fact.subject} (${fact.type})`,
										summary: fact.content,
										detail: JSON.stringify({
											subject: fact.subject,
											type: fact.type,
											content: fact.content,
											sourceSessionId: session.getSessionId() ?? null,
											source: "compression-engine-L2",
										}, null, 2),
										provenance: "derived",
										lastUpdatedBy: "extractor-A",
									});
								} catch (err2) {
									log.warn("compression", `Memory node wiki write failed for ${fact.subject}:`, (err2 as Error).message);
								}
							}
						} else {
							const nodeStore = config.db.getMemoryNodeStore();
							if (nodeStore) {
								nodeStore.upsertNodes(session.getSessionId() ?? null, result.memoryNodes);
							}
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
