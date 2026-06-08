// 记忆召回
//
// 从全局 memory wiki 中检索与当前用户消息相关的记忆节点，
// 注入到 context message 中。

import type { MemoryNodeStore, MemoryNode, MemorySubject } from "../server/memory-node-store.js";
import { log } from "../core/logger.js";

export interface MemoryRecallResult {
	nodes: Array<{
		subject: string;
		type: string;
		content: string;
		updatedAt: string;
	}>;
	subjects: Array<{
		subject: string;
		nodeCount: number;
	}>;
}

export class MemoryRecall {
	constructor(private store: MemoryNodeStore) {}

	/**
	 * Find relevant memory nodes for a user message using FTS5.
	 */
	async recall(userMessage: string, limit: number = 10): Promise<MemoryRecallResult | null> {
		try {
			const results = this.store.searchNodes(userMessage, limit);
			if (results.length === 0) return null;

			return {
				nodes: results.map(r => ({
					subject: r.node.subject,
					type: r.node.type,
					content: r.node.content,
					updatedAt: r.node.updatedAt,
				})),
				subjects: results
					.map(r => r.subject)
					.filter((s): s is MemorySubject => s !== null)
					.map(s => ({ subject: s.subject, nodeCount: s.nodeCount }))
					.filter((v, i, a) => a.findIndex(x => x.subject === v.subject) === i),
			};
		} catch (err) {
			log.debug("memory-recall", "Recall failed:", (err as Error).message);
			return null;
		}
	}

	/**
	 * Format recalled memories into a text block for context injection.
	 */
	formatForContext(recall: MemoryRecallResult): string | null {
		if (recall.nodes.length === 0) return null;

		const lines = recall.nodes.map(n =>
			`- **${n.subject}** (${n.type}): ${n.content} [${n.updatedAt.slice(0, 10)}]`
		);
		return lines.join("\n");
	}
}
