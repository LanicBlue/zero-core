// 从全局 memory wiki 用 FTS5 召回与当前 user 消息相关的记忆节点，并格式化为注入文本。
//
// # 文件说明书
//
// ## 核心功能
// MemoryRecall.recall 调用 MemoryNodeStore.searchNodes 做 FTS5 检索，去重汇总涉及 subject；
// formatForContext 把节点渲染成 "- **subject** (type): content [date]" 列表供 context-message 注入。
//
// ## 输入
// - userMessage：最近一条用户消息文本，作为 FTS5 查询
// - limit：返回节点上限，默认 10
//
// ## 输出
// - MemoryRecallResult：命中的 nodes + 涉及的 subjects（带 nodeCount）
// - formatForContext 输出可直接塞进 ## Recalled Memories 的字符串，或 null
//
// ## 定位
// runtime 层薄包装，处于 hooks/memory-hooks 与 server/memory-node-store 之间；自身不读写 DB。
//
// ## 依赖
// - server/memory-node-store（MemoryNodeStore / MemoryNode / MemorySubject 类型与 FTS5 实现）
// - core/logger（失败时降级为 debug 日志）
//
// ## 维护规则
// - 召回排序/过滤规则调整后，应同时确认 hooks/memory-hooks 注入与 mcp-tools MemoryRecall 工具
//   的展示一致性。
// - 节点类型集合若扩展，需同步更新 formatForContext 与 compression-engine L2 prompt 的 type 枚举。

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
