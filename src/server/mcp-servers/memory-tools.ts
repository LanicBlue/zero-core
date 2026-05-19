import { tool } from "ai";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

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

export function createMemoryTools() {
	return {
		memory_create_entities: tool({
			description: "Create entities in the knowledge graph. Skips existing entities.",
			inputSchema: z.object({
				entities: z.array(z.object({
					name: z.string().describe("Entity name"),
					entityType: z.string().describe("Entity type"),
					observations: z.array(z.string()).optional().default([]).describe("Observations"),
				})).describe("Entities to create"),
			}),
			execute: async ({ entities }) => {
				const graph = loadGraph();
				const existing = new Set(graph.entities.map((e) => e.name));
				const created: Entity[] = [];
				for (const e of entities) {
					if (!existing.has(e.name)) {
						const entity: Entity = { name: e.name, entityType: e.entityType, observations: e.observations ?? [] };
						graph.entities.push(entity);
						created.push(entity);
					}
				}
				if (created.length > 0) saveGraph(graph);
				return JSON.stringify(created, null, 2);
			},
		}),
		memory_create_relations: tool({
			description: "Create relations between existing entities. Both entities must exist.",
			inputSchema: z.object({
				relations: z.array(z.object({
					from: z.string(),
					to: z.string(),
					relationType: z.string(),
				})),
			}),
			execute: async ({ relations }) => {
				const graph = loadGraph();
				const names = new Set(graph.entities.map((e) => e.name));
				const created: Relation[] = [];
				const existing = new Set(graph.relations.map((r) => JSON.stringify(r)));
				for (const r of relations) {
					if (!names.has(r.from) || !names.has(r.to)) continue;
					const key = JSON.stringify(r);
					if (!existing.has(key)) {
						graph.relations.push(r);
						created.push(r);
					}
				}
				if (created.length > 0) saveGraph(graph);
				return JSON.stringify(created, null, 2);
			},
		}),
		memory_add_observations: tool({
			description: "Add observations to existing entities. Skips duplicates.",
			inputSchema: z.object({
				observations: z.array(z.object({
					entityName: z.string(),
					contents: z.array(z.string()),
				})),
			}),
			execute: async ({ observations }) => {
				const graph = loadGraph();
				const results: { entityName: string; added: string[] }[] = [];
				for (const o of observations) {
					const entity = graph.entities.find((e) => e.name === o.entityName);
					if (!entity) continue;
					const added = o.contents.filter((c) => !entity.observations.includes(c));
					entity.observations.push(...added);
					results.push({ entityName: o.entityName, added });
				}
				saveGraph(graph);
				return JSON.stringify(results, null, 2);
			},
		}),
		memory_delete_entities: tool({
			description: "Delete entities and their associated relations.",
			inputSchema: z.object({
				entityNames: z.array(z.string()),
			}),
			execute: async ({ entityNames }) => {
				const graph = loadGraph();
				const toDelete = new Set(entityNames);
				graph.entities = graph.entities.filter((e) => !toDelete.has(e.name));
				graph.relations = graph.relations.filter((r) => !toDelete.has(r.from) && !toDelete.has(r.to));
				saveGraph(graph);
				return "Entities deleted";
			},
		}),
		memory_delete_relations: tool({
			description: "Delete specific relations.",
			inputSchema: z.object({
				relations: z.array(z.object({
					from: z.string(),
					to: z.string(),
					relationType: z.string(),
				})),
			}),
			execute: async ({ relations }) => {
				const graph = loadGraph();
				const toDelete = new Set(relations.map((r) => JSON.stringify(r)));
				graph.relations = graph.relations.filter((r) => !toDelete.has(JSON.stringify(r)));
				saveGraph(graph);
				return "Relations deleted";
			},
		}),
		memory_read_graph: tool({
			description: "Read the entire knowledge graph.",
			inputSchema: z.object({}),
			execute: async () => {
				return JSON.stringify(loadGraph(), null, 2);
			},
		}),
		memory_search_nodes: tool({
			description: "Search entities and relations by query string.",
			inputSchema: z.object({
				query: z.string().describe("Search query"),
			}),
			execute: async ({ query }) => {
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
	};
}
