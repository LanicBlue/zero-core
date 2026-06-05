// 知识图谱记忆工具
//
// # 文件说明书
//
// ## 核心功能
// 提供知识图谱的读写操作，支持实体/关系的搜索、创建和删除
//
// ## 输入
// 查询条件、实体数据、关系数据
//
// ## 输出
// 知识图谱查询结果、实体列表、关系列表
//
// ## 定位
// src/runtime/mcp-tools/ — 内置 MCP 工具，为 agent 提供持久化记忆
//
// ## 依赖
// zod、tools/tool-factory.ts、server/memory-store
//
// ## 维护规则
// 图谱 schema 变更需确保数据迁移兼容
//
import { z } from "zod";
import { buildTool } from "../tools/tool-factory.js";

function getMemoryStore(db: any): any {
	return db?.getMemoryStore?.() ?? null;
}

export const memoryReadTool = buildTool({
	name: "MemoryRead",
	description: "Read from the knowledge graph memory. Search entities/relations or read the full graph.",
	prompt: "Read from the persistent knowledge graph memory. Data persists across sessions.\n\n" +
		"Actions:\n" +
		"- search: find entities by name/keyword. Returns matching entities and their relations. Requires query.\n" +
		"- graph: return the entire knowledge graph. Use sparingly.\n\n" +
		"When to use memory:\n" +
		"- Recalling user preferences or project context from earlier sessions\n" +
		"- Looking up entity relationships\n" +
		"- Checking stored observations about a component or concept\n\n" +
		"Results are returned as JSON with entities and relations arrays.",
	meta: { category: "memory", isReadOnly: true },
	inputSchema: z.object({
		action: z.enum(["search", "graph"]).describe("'search' to find by query, 'graph' to read everything"),
		query: z.string().optional().describe("Search query (required for 'search' action)"),
	}),
	execute: async ({ action, query }, ctx: any) => {
		const store = getMemoryStore(ctx.db);
		if (!store) return "Error: Memory store not available.";

		if (action === "graph") {
			return JSON.stringify(store.loadGraph(), null, 2);
		}
		if (!query) return "Error: query is required for search action.";
		const entities = store.searchEntities(query);
		const names = new Set(entities.map((e: any) => e.name));
		const allRelations = store.listRelations();
		const relations = allRelations.filter((r: any) => names.has(r.from) && names.has(r.to));
		return JSON.stringify({ entities, relations }, null, 2);
	},
});

export const memoryWriteTool = buildTool({
	name: "MemoryWrite",
	description: "Write to the knowledge graph memory. Create/delete entities, relations, and observations.",
	prompt: "Write to the persistent knowledge graph memory. Data persists across sessions.\n\n" +
		"Actions:\n" +
		"- create_entities: add new entities with name, type, and optional observations\n" +
		"- create_relations: link two entities with a relation type\n" +
		"- add_observations: append new observations to an existing entity\n" +
		"- delete_entities: remove entities by name\n" +
		"- delete_relations: remove relations\n\n" +
		"When to save to memory:\n" +
		"- User explicitly asks you to remember something\n" +
		"- Important project decisions or architecture choices\n" +
		"- Key facts about the codebase, team, or workflows\n\n" +
		"Example entities: [{ name: \"AuthService\", entityType: \"service\", observations: [\"Handles JWT\"] }]\n" +
		"Example relations: [{ from: \"AuthService\", to: \"UserDB\", relationType: \"depends_on\" }]",
	meta: { category: "memory", isReadOnly: false, isDestructive: true, isConcurrencySafe: false },
	inputSchema: z.object({
		action: z.enum([
			"create_entities",
			"create_relations",
			"add_observations",
			"delete_entities",
			"delete_relations",
		]).describe("The write operation to perform"),
		entities: z.array(z.object({
			name: z.string(),
			entityType: z.string(),
			observations: z.array(z.string()).optional().default([]),
		})).optional().describe("Entities (for create_entities)"),
		relations: z.array(z.object({
			from: z.string(),
			to: z.string(),
			relationType: z.string(),
		})).optional().describe("Relations (for create_relations / delete_relations)"),
		observations: z.array(z.object({
			entityName: z.string(),
			contents: z.array(z.string()),
		})).optional().describe("Observations to add (for add_observations)"),
		entityNames: z.array(z.string()).optional().describe("Entity names to delete (for delete_entities)"),
	}),
	execute: async (input: any, ctx: any) => {
		const store = getMemoryStore(ctx.db);
		if (!store) return "Error: Memory store not available.";

		const { action } = input;

		switch (action) {
			case "create_entities": {
				const created = store.createEntities((input.entities ?? []).map((e: any) => ({
					name: e.name,
					entityType: e.entityType,
					observations: e.observations ?? [],
				})));
				return JSON.stringify(created, null, 2);
			}
			case "create_relations": {
				const created = store.createRelations((input.relations ?? []).map((r: any) => ({
					from: r.from,
					to: r.to,
					relationType: r.relationType,
				})));
				return JSON.stringify(created, null, 2);
			}
			case "add_observations": {
				const results = store.addObservations((input.observations ?? []).map((o: any) => ({
					entityName: o.entityName,
					contents: o.contents,
				})));
				return JSON.stringify(results, null, 2);
			}
			case "delete_entities": {
				store.deleteEntities(input.entityNames ?? []);
				return "Entities deleted";
			}
			case "delete_relations": {
				store.deleteRelations((input.relations ?? []).map((r: any) => ({
					from: r.from,
					to: r.to,
					relationType: r.relationType,
				})));
				return "Relations deleted";
			}
			default:
				return `Unknown action: ${action}`;
		}
	},
});
