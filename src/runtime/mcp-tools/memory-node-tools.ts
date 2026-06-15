// 记忆节点 wiki 工具：暴露给 agent 的 MemoryRecall（只读检索）与 MemoryNote（增删改）。
//
// # 文件说明书
//
// ## 核心功能
// 通过 buildTool 注册两个工具：
// - MemoryRecall：search / recent / subject 三种动作从 MemoryNodeStore 检索节点。
// - MemoryNote：create / update / delete / link 四种动作写入节点或建立 subject 间关系。
// 替代旧的知识图谱工具（MemoryRead/MemoryWrite），采用 wiki 风格的记忆节点系统。
//
// ## 输入
// - 工具入参（zod schema 校验）：action、query、subject、type、content、nodeId、relation、targetSubject 等
// - ctx.db：用于取出 MemoryNodeStore；ctx.sessionId 用于关联节点来源
//
// ## 输出
// - 字符串形式的人类可读结果（命中节点列表或写入/删除/链接确认）
//
// ## 定位
// runtime/mcp-tools 层，把记忆 wiki 暴露为 agent 可调用工具；底层复用 server/memory-node-store。
//
// ## 依赖
// - zod、runtime/tools/tool-factory（buildTool）
// - server/memory-node-store（MemoryNodeStore 类型与实现）
//
// ## 维护规则
// - 节点类型集合（event/decision/discovery/status_change/preference）若扩展，需同步
//   compression-engine L2 prompt、memory-recall 渲染与 docs。
// - 工具 prompt 文案调整后注意验证 agent 是否仍能在正确场景下选用本工具。

import { z } from "zod";
import { buildTool } from "../tools/tool-factory.js";
import type { MemoryNodeStore } from "../../server/memory-node-store.js";

function getStore(db: any): MemoryNodeStore | null {
	return db?.getMemoryNodeStore?.() ?? null;
}

export const memoryRecallTool = buildTool({
	name: "MemoryRecall",
	description: "Search and recall memories about people, projects, concepts, and past decisions.",
	prompt: "Search the persistent memory wiki for information about a specific subject or topic.\n\n" +
		"Actions:\n" +
		"- search: find memory nodes by keyword. Returns matching nodes with subject, type, and content.\n" +
		"- recent: return the most recently created/updated memory nodes.\n" +
		"- subject: get all memory nodes for a specific subject (person, project, concept).\n\n" +
		"When to use:\n" +
		"- Looking up past decisions or discoveries about a project\n" +
		"- Recalling user preferences or project context from earlier sessions\n" +
		"- Checking what you know about a person, tool, or concept\n\n" +
		"Memory nodes are shared across all agents and persist across sessions.",
	meta: { category: "memory", isReadOnly: true },
	inputSchema: z.object({
		action: z.enum(["search", "recent", "subject"]).describe("'search' to find by keyword, 'recent' for latest nodes, 'subject' for all nodes about a subject"),
		query: z.string().optional().describe("Search query or subject name"),
		limit: z.number().optional().default(10).describe("Max results to return"),
	}),
	execute: async ({ action, query, limit }, ctx: any) => {
		const store = getStore(ctx.db);
		if (!store) return "Error: Memory node store not available.";

		switch (action) {
			case "search": {
				if (!query) return "Error: query is required for 'search' action.";
				const results = store.searchNodes(query, limit);
				if (results.length === 0) return "No memory nodes found matching the query.";
				return results.map(r =>
					`**${r.node.subject}** (${r.node.type}): ${r.node.content} [${r.node.updatedAt.slice(0, 10)}]`
				).join("\n");
			}
			case "recent": {
				const nodes = store.getRecentNodes(limit);
				if (nodes.length === 0) return "No memory nodes found.";
				return nodes.map(n =>
					`**${n.subject}** (${n.type}): ${n.content} [${n.updatedAt.slice(0, 10)}]`
				).join("\n");
			}
			case "subject": {
				if (!query) return "Error: query (subject name) is required for 'subject' action.";
				const nodes = store.getNodesForSubject(query);
				if (nodes.length === 0) return `No memory nodes found for subject: ${query}`;
				const subject = store.getSubject(query);
				const header = subject
					? `Subject: ${subject.subject} (${subject.nodeCount} nodes, kind: ${subject.kind ?? "unknown"})\n\n`
					: "";
				return header + nodes.map(n =>
					`- [${n.type}] ${n.content} (${n.updatedAt.slice(0, 10)})`
				).join("\n");
			}
		}
		return "Unknown action.";
	},
});

export const memoryNoteTool = buildTool({
	name: "MemoryNote",
	description: "Create or update memory notes about people, projects, concepts, and decisions.",
	prompt: "Manually save a memory note to the persistent wiki.\n\n" +
		"Actions:\n" +
		"- create: add a new memory node. If a node with the same subject+type exists, it will be updated (evolved).\n" +
		"- update: update an existing node by ID.\n" +
		"- delete: delete a memory node by ID.\n" +
		"- link: create a relationship between two subjects.\n\n" +
		"Node types: event, decision, discovery, status_change, preference\n" +
		"Subjects can be: person names, project names, concept names, tool names, etc.\n\n" +
		"Use this when:\n" +
		"- User explicitly asks you to remember something\n" +
		"- You discover an important fact worth preserving across sessions\n" +
		"- A decision is made that future sessions should know about",
	meta: { category: "memory", isReadOnly: false, isDestructive: false, isConcurrencySafe: false },
	inputSchema: z.object({
		action: z.enum(["create", "update", "delete", "link"]).describe("Action to perform"),
		subject: z.string().optional().describe("Who/what this memory is about (required for 'create')"),
		type: z.enum(["event", "decision", "discovery", "status_change", "preference"]).optional().describe("Node type (required for 'create')"),
		content: z.string().optional().describe("The memory content (required for 'create')"),
		nodeId: z.string().optional().describe("Node ID for update/delete"),
		relation: z.string().optional().describe("Relation type for 'link' action"),
		targetSubject: z.string().optional().describe("Target subject for 'link' action"),
	}),
	execute: async (input, ctx: any) => {
		const store = getStore(ctx.db);
		if (!store) return "Error: Memory node store not available.";

		const sessionId = ctx.sessionId ?? null;

		switch (input.action) {
			case "create": {
				if (!input.subject || !input.type || !input.content) {
					return "Error: subject, type, and content are required for 'create' action.";
				}
				const node = store.upsertNode(sessionId, {
					subject: input.subject,
					type: input.type,
					content: input.content,
				});
				return `Memory node saved: **${node.subject}** (${node.type}): ${node.content}`;
			}
			case "update": {
				if (!input.nodeId) return "Error: nodeId is required for 'update' action.";
				const existing = store.getNode(input.nodeId);
				if (!existing) return `Error: Node ${input.nodeId} not found.`;
				const updated = store.upsertNode(sessionId, {
					subject: existing.subject,
					type: existing.type,
					content: input.content ?? existing.content,
				});
				return `Memory node updated: **${updated.subject}** (${updated.type}): ${updated.content}`;
			}
			case "delete": {
				if (!input.nodeId) return "Error: nodeId is required for 'delete' action.";
				store.deleteNode(input.nodeId);
				return `Memory node ${input.nodeId} deleted.`;
			}
			case "link": {
				if (!input.subject || !input.targetSubject || !input.relation) {
					return "Error: subject, targetSubject, and relation are required for 'link' action.";
				}
				store.createEdge(input.subject, input.targetSubject, input.relation);
				return `Linked: ${input.subject} —[${input.relation}]→ ${input.targetSubject}`;
			}
		}
		return "Unknown action.";
	},
});
