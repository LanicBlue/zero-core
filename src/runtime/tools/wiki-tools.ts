// Wiki 工具
//
// # 文件说明书
//
// ## 核心功能
// 提供项目 Wiki 节点的查询和更新工具，用于 Analyst Agent 维护代码知识树。
//
// ## 输入
// - ToolExecutionContext（需包含 wikiStore + projectId）
//
// ## 输出
// - ExpandNode — 只读，读取节点详情
// - UpdateWikiNode — 写入，创建或更新节点（upsert）
//
// ## 定位
// Runtime 工具，被工作流 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - ./tool-factory - 工具工厂
//
// ## 维护规则
// - 新增 Wiki 操作工具时在此添加
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";

// ---------------------------------------------------------------------------
// ExpandNode — read a Wiki node's detail
// ---------------------------------------------------------------------------

export const expandNodeTool = buildTool({
	name: "ExpandNode",
	description: "Read a Wiki node's detailed content. Use to深入了解某个文件或模块。",
	prompt: "Expand a Wiki node to read its detailed content.\n\n" +
		"Use when you need to understand a specific file, module, or component in depth.\n" +
		"Input: { path } — the Wiki node path (e.g. 'src/runtime/agent-loop.ts').\n" +
		"Returns: the node's detail field, or a summary if detail is not yet expanded.",
	meta: { category: "agent", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },

	inputSchema: z.object({
		path: z.string().describe("Wiki node path, e.g. 'src/runtime/agent-loop.ts'"),
	}),

	execute: async (input, ctx) => {
		if (!ctx.wikiStore || !ctx.projectId) {
			return "Error: Wiki context not available";
		}
		const node = ctx.wikiStore.getByPath(ctx.projectId, input.path);
		if (!node) {
			return `Wiki node not found: ${input.path}`;
		}
		if (node.detail) {
			return node.detail;
		}
		return `Node: ${node.title}\nPath: ${node.path}\nSummary: ${node.summary || "No summary"}\n\n(Detail not yet expanded. Use UpdateWikiNode to add detail.)`;
	},
});

// ---------------------------------------------------------------------------
// UpdateWikiNode — create or update a Wiki node (upsert)
// ---------------------------------------------------------------------------

export const updateWikiNodeTool = buildTool({
	name: "UpdateWikiNode",
	description: "Create or update a Wiki node. Use for cold-start knowledge tree creation or incremental updates. Upsert semantics.",
	prompt: "Create or update a Wiki node in the project knowledge tree.\n\n" +
		"Upsert semantics: if a node at the given path already exists, it is updated; otherwise a new node is created.\n\n" +
		"Inputs:\n" +
		"- path (required) — node path, e.g. 'src/runtime/' or 'src/runtime/agent-loop.ts'\n" +
		"- title — display title (defaults to last path segment)\n" +
		"- nodeType — 'directory' | 'file' | 'function' | 'class' | 'section'\n" +
		"- parentId — parent node ID\n" +
		"- summary — shallow summary (2-3 sentences)\n" +
		"- detail — detailed content",
	meta: { category: "agent", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },

	inputSchema: z.object({
		path: z.string().describe("Node path"),
		title: z.string().optional().describe("Node title"),
		nodeType: z.enum(["directory", "file", "function", "class", "section"]).optional().describe("Node type"),
		parentId: z.string().optional().describe("Parent node ID"),
		summary: z.string().optional().describe("Shallow summary"),
		detail: z.string().optional().describe("Detailed content"),
	}),

	execute: async (input, ctx) => {
		if (!ctx.wikiStore || !ctx.projectId) {
			return "Error: Wiki context not available";
		}
		const existing = ctx.wikiStore.getByPath(ctx.projectId, input.path);
		if (existing) {
			const updates: Record<string, any> = { lastUpdatedBy: ctx.agentRole || "analyst" };
			if (input.summary !== undefined) updates.summary = input.summary;
			if (input.detail !== undefined) updates.detail = input.detail;
			if (input.title !== undefined) updates.title = input.title;
			ctx.wikiStore.update(existing.id, updates);
			return `Wiki node updated: ${input.path}`;
		} else {
			ctx.wikiStore.create({
				projectId: ctx.projectId,
				path: input.path,
				title: input.title || input.path.split("/").pop() || input.path,
				nodeType: input.nodeType || "section",
				parentId: input.parentId,
				summary: input.summary,
				detail: input.detail,
				lastUpdatedBy: ctx.agentRole || "analyst",
			});
			return `Wiki node created: ${input.path}`;
		}
	},
});
