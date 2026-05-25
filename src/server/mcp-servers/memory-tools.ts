import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { buildTool } from "../../runtime/tools/tool-factory.js";

// ---------------------------------------------------------------------------
// Knowledge Graph Memory — persistent entity-relation graph
// ---------------------------------------------------------------------------

interface Entity {
	name: string;
	entityType: string;
	observations: string[];
}

interface Relation {
	from: string;
	to: string;
	relationType: string;
}

interface KnowledgeGraph {
	entities: Entity[];
	relations: Relation[];
}

const MEMORY_PATH = join(homedir(), ".zero-core", "memory.json");

function loadGraph(): KnowledgeGraph {
	if (!existsSync(MEMORY_PATH)) {
		return { entities: [], relations: [] };
	}
	try {
		return JSON.parse(readFileSync(MEMORY_PATH, "utf-8"));
	} catch {
		return { entities: [], relations: [] };
	}
}

function saveGraph(graph: KnowledgeGraph): void {
	const dir = dirname(MEMORY_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(MEMORY_PATH, JSON.stringify(graph, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Consolidated memory tools: memory_read + memory_write
// ---------------------------------------------------------------------------

export function createMemoryTools() {
	return {
		memory_read: buildTool({
			name: "memory_read",
			description:
				"Read from the knowledge graph memory. Use action 'search' to find entities/relations by query, " +
				"or 'graph' to read the entire knowledge graph.",
			meta: { category: "memory", isReadOnly: true },
			inputSchema: z.object({
				action: z.enum(["search", "graph"]).describe("'search' to find by query, 'graph' to read everything"),
				query: z.string().optional().describe("Search query (required for 'search' action)"),
			}),
			execute: async ({ action, query }) => {
				if (action === "graph") {
					return JSON.stringify(loadGraph(), null, 2);
				}
				// search
				if (!query) return "Error: query is required for search action.";
				const graph = loadGraph();
				const q = query.toLowerCase();
				const entities = graph.entities.filter(
					(e) =>
						e.name.toLowerCase().includes(q) ||
						e.entityType.toLowerCase().includes(q) ||
						e.observations.some((o) => o.toLowerCase().includes(q)),
				);
				const names = new Set(entities.map((e) => e.name));
				const relations = graph.relations.filter((r) => names.has(r.from) && names.has(r.to));
				return JSON.stringify({ entities, relations }, null, 2);
			},
		}),

		memory_write: buildTool({
			name: "memory_write",
			description:
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
			execute: async (input) => {
				const { action } = input;
				const graph = loadGraph();

				switch (action) {
					case "create_entities": {
						const existing = new Set(graph.entities.map((e) => e.name));
						const created: Entity[] = [];
						for (const e of (input.entities ?? [])) {
							if (!existing.has(e.name)) {
								const entity: Entity = { name: e.name, entityType: e.entityType, observations: e.observations ?? [] };
								graph.entities.push(entity);
								created.push(entity);
							}
						}
						if (created.length > 0) saveGraph(graph);
						return JSON.stringify(created, null, 2);
					}
					case "create_relations": {
						const names = new Set(graph.entities.map((e) => e.name));
						const existingRel = new Set(graph.relations.map((r) => JSON.stringify(r)));
						const created: Relation[] = [];
						for (const r of (input.relations ?? [])) {
							if (!names.has(r.from) || !names.has(r.to)) continue;
							const key = JSON.stringify(r);
							if (!existingRel.has(key)) {
								graph.relations.push(r);
								created.push(r);
							}
						}
						if (created.length > 0) saveGraph(graph);
						return JSON.stringify(created, null, 2);
					}
					case "add_observations": {
						const results: { entityName: string; added: string[] }[] = [];
						for (const o of (input.observations ?? [])) {
							const entity = graph.entities.find((e) => e.name === o.entityName);
							if (!entity) continue;
							const added = o.contents.filter((c: string) => !entity.observations.includes(c));
							entity.observations.push(...added);
							results.push({ entityName: o.entityName, added });
						}
						saveGraph(graph);
						return JSON.stringify(results, null, 2);
					}
					case "delete_entities": {
						const toDelete = new Set(input.entityNames ?? []);
						graph.entities = graph.entities.filter((e) => !toDelete.has(e.name));
						graph.relations = graph.relations.filter((r) => !toDelete.has(r.from) && !toDelete.has(r.to));
						saveGraph(graph);
						return "Entities deleted";
					}
					case "delete_relations": {
						const toDelete = new Set((input.relations ?? []).map((r: Relation) => JSON.stringify(r)));
						graph.relations = graph.relations.filter((r: Relation) => !toDelete.has(JSON.stringify(r)));
						saveGraph(graph);
						return "Relations deleted";
					}
					default:
						return `Unknown action: ${action}`;
				}
			},
		}),
	};
}
