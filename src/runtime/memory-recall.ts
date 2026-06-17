// 从全局 memory wiki 召回与当前 user 消息相关的记忆节点，并格式化为注入文本。
//
// # 文件说明书
//
// ## 核心功能
// MemoryRecall.recall 做检索，去重汇总涉及 subject；
// formatForContext 把节点渲染成 "- **subject** (type): content [date]" 列表供 context-message 注入。
//
// v0.8 (M5): memory 节点已迁到全局 wiki 树 type=memory 节点(决策 53)。本类
// 现在优先从 WikiStore.searchMemoryNodes 读(新数据),并回退到旧 MemoryNodeStore
// (pre-M5 数据)。两个来源的结果合并去重后返回。
//
// ## 输入
// - userMessage：最近一条用户消息文本，作为查询
// - limit：返回节点上限，默认 10
//
// ## 输出
// - MemoryRecallResult：命中的 nodes + 涉及的 subjects（带 nodeCount）
// - formatForContext 输出可直接塞进 ## Recalled Memories 的字符串，或 null
//
// ## 定位
// runtime 层薄包装，处于 hooks/memory-hooks 与 server/*-store 之间；自身不读写 DB。
//
// ## 依赖
// - server/memory-node-store（MemoryNodeStore / MemoryNode / MemorySubject 类型与 FTS5 实现）
// - server/wiki-node-store（WikiStore.searchMemoryNodes — M5 新数据源）
// - core/logger（失败时降级为 debug 日志）
//
// ## 维护规则
// - 召回排序/过滤规则调整后，应同时确认 hooks/memory-hooks 注入与 mcp-tools MemoryRecall 工具
//   的展示一致性。
// - 节点类型集合若扩展，需同步更新 formatForContext 与 extractor-a-service prompt 的 type 枚举。
//

import type { MemoryNodeStore, MemorySubject } from "../server/memory-node-store.js";
import type { WikiStore } from "../server/wiki-node-store.js";
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

export interface MemoryRecallOptions {
	/** Legacy FTS5 store (pre-M5 data). Optional — null skips legacy recall. */
	legacyStore?: MemoryNodeStore | null;
	/** M5 wiki tree store (new data — extractor A's writes). */
	wikiStore?: WikiStore | null;
}

export class MemoryRecall {
	constructor(
		private store: MemoryNodeStore | null,
		private opts?: MemoryRecallOptions,
	) {}

	/**
	 * Find relevant memory nodes for a user message.
	 *
	 * v0.8 (M5): searches the wiki tree first (new memory written by extractor
	 * A), then falls back to the legacy FTS5 store. Results merged + deduped
	 * by (subject, type). Wiki tree wins on conflict (newer truth).
	 */
	async recall(userMessage: string, limit: number = 10): Promise<MemoryRecallResult | null> {
		try {
			// New path: wiki tree memory nodes.
			const wikiNodes = this.opts?.wikiStore
				? this.opts.wikiStore.searchMemoryNodes(userMessage, limit)
				: [];

			// Legacy path: FTS5 store.
			const legacyResults = this.store
				? this.store.searchNodes(userMessage, limit)
				: [];

			if (wikiNodes.length === 0 && legacyResults.length === 0) return null;

			// Merge + dedupe by (subject, type).
			const seen = new Set<string>();
			const nodes: MemoryRecallResult["nodes"] = [];
			const subjects: MemoryRecallResult["subjects"] = [];

			for (const n of wikiNodes) {
				// M5 wiki memory nodes carry (subject, type, content) in their
				// `detail` JSON (written by extractor A). Fall back to title.
				let subject = n.title ?? "(unknown)";
				let type = "memory";
				let content = n.summary ?? "";
				try {
					const parsed = JSON.parse(n.detail ?? "{}");
					if (parsed.subject) subject = String(parsed.subject);
					if (parsed.type) type = String(parsed.type);
					if (parsed.content) content = String(parsed.content);
				} catch { /* detail not JSON — use title/summary as-is */ }
				const key = `${subject}|${type}`;
				if (seen.has(key)) continue;
				seen.add(key);
				nodes.push({ subject, type, content, updatedAt: n.updatedAt });
			}

			for (const r of legacyResults) {
				const key = `${r.node.subject}|${r.node.type}`;
				if (seen.has(key)) continue;
				seen.add(key);
				nodes.push({
					subject: r.node.subject,
					type: r.node.type,
					content: r.node.content,
					updatedAt: r.node.updatedAt,
				});
				if (r.subject) {
					subjects.push({ subject: r.subject.subject, nodeCount: r.subject.nodeCount });
				}
			}

			const dedupedSubjects = subjects.filter(
				(v, i, a) => a.findIndex(x => x.subject === v.subject) === i,
			);

			if (nodes.length === 0) return null;
			return { nodes: nodes.slice(0, limit), subjects: dedupedSubjects };
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
