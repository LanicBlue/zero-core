import { z } from "zod";
import { buildTool } from "../tools/tool-factory.js";

function getMemoryStore(db: any): any {
	return db?.getMemoryStore?.() ?? null;
}

export const memoryReadTool = buildTool({
	name: "MemoryRead",
	description: "Read from the knowledge graph memory. Search entities/relations or read the full graph.",
	prompt:
		"Read from the knowledge graph memory. Use action 'search' to find entities/relations by query, " +
		"or 'graph' to read the entire knowledge graph.",
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
	prompt:
		"Write to the knowledge graph memory. Actions: " +
		"'create_entities' to add entities, 'create_relations' to link entities, " +
		"'add_observations' to append observations, 'delete_entities' to remove entities, " +
		"'delete_relations' to remove relations.",
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
