import type Database from "better-sqlite3";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/logger.js";
import { ZERO_CORE_DIR } from "../core/config.js";

// ---------------------------------------------------------------------------
// MemoryStore — knowledge graph persistence over SQLite
// Replaces memory.json with memory_entities + memory_relations tables.
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

export class MemoryStore {
	private db: Database.Database;

	private getEntityStmt: Database.Statement;
	private listEntitiesStmt: Database.Statement;
	private upsertEntityStmt: Database.Statement;
	private deleteEntityStmt: Database.Statement;
	private searchEntitiesStmt: Database.Statement;

	private listRelationsStmt: Database.Statement;
	private getRelationsForEntityStmt: Database.Statement;
	private insertRelationStmt: Database.Statement;
	private deleteRelationsStmt: Database.Statement;
	private deleteRelationsForEntityStmt: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		this.init();

		this.getEntityStmt = this.db.prepare("SELECT name, entity_type, observations FROM memory_entities WHERE name = ?");
		this.listEntitiesStmt = this.db.prepare("SELECT name, entity_type, observations FROM memory_entities");
		this.upsertEntityStmt = this.db.prepare(
			"INSERT INTO memory_entities (name, entity_type, observations, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET entity_type = excluded.entity_type, observations = excluded.observations, updated_at = excluded.updated_at",
		);
		this.deleteEntityStmt = this.db.prepare("DELETE FROM memory_entities WHERE name = ?");
		this.searchEntitiesStmt = this.db.prepare(
			"SELECT name, entity_type, observations FROM memory_entities WHERE name LIKE ? OR entity_type LIKE ? OR observations LIKE ?",
		);

		this.listRelationsStmt = this.db.prepare("SELECT from_entity, to_entity, relation_type FROM memory_relations");
		this.getRelationsForEntityStmt = this.db.prepare(
			"SELECT from_entity, to_entity, relation_type FROM memory_relations WHERE from_entity = ? OR to_entity = ?",
		);
		this.insertRelationStmt = this.db.prepare(
			"INSERT INTO memory_relations (from_entity, to_entity, relation_type) VALUES (?, ?, ?)",
		);
		this.deleteRelationsStmt = this.db.prepare(
			"DELETE FROM memory_relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ?",
		);
		this.deleteRelationsForEntityStmt = this.db.prepare(
			"DELETE FROM memory_relations WHERE from_entity = ? OR to_entity = ?",
		);
	}

	private init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memory_entities (
				name        TEXT PRIMARY KEY,
				entity_type TEXT NOT NULL,
				observations TEXT NOT NULL DEFAULT '[]',
				updated_at  TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS memory_relations (
				id            INTEGER PRIMARY KEY AUTOINCREMENT,
				from_entity   TEXT NOT NULL,
				to_entity     TEXT NOT NULL,
				relation_type TEXT NOT NULL,
				FOREIGN KEY (from_entity) REFERENCES memory_entities(name) ON DELETE CASCADE,
				FOREIGN KEY (to_entity) REFERENCES memory_entities(name) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_entity);
			CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_entity);
		`);
	}

	// ─── Full graph ──────────────────────────────────────

	loadGraph(): KnowledgeGraph {
		const entities = this.listEntities();
		const relations = this.listRelations();
		return { entities, relations };
	}

	// ─── Entities ────────────────────────────────────────

	listEntities(): Entity[] {
		const rows = this.listEntitiesStmt.all() as any[];
		return rows.map((r) => ({
			name: r.name,
			entityType: r.entity_type,
			observations: JSON.parse(r.observations),
		}));
	}

	getEntity(name: string): Entity | null {
		const row = this.getEntityStmt.get(name) as any;
		if (!row) return null;
		return { name: row.name, entityType: row.entity_type, observations: JSON.parse(row.observations) };
	}

	upsertEntity(entity: Entity): void {
		const now = new Date().toISOString();
		this.upsertEntityStmt.run(entity.name, entity.entityType, JSON.stringify(entity.observations), now);
	}

	createEntities(entities: Entity[]): Entity[] {
		const created: Entity[] = [];
		const tx = this.db.transaction(() => {
			for (const e of entities) {
				if (this.getEntity(e.name)) continue;
				this.upsertEntity(e);
				created.push(e);
			}
		});
		tx();
		return created;
	}

	deleteEntities(names: string[]): void {
		const tx = this.db.transaction(() => {
			for (const name of names) {
				this.deleteRelationsForEntityStmt.run(name, name);
				this.deleteEntityStmt.run(name);
			}
		});
		tx();
	}

	addObservations(items: Array<{ entityName: string; contents: string[] }>): Array<{ entityName: string; added: string[] }> {
		const results: Array<{ entityName: string; added: string[] }> = [];
		const tx = this.db.transaction(() => {
			for (const item of items) {
				const entity = this.getEntity(item.entityName);
				if (!entity) continue;
				const added = item.contents.filter((c) => !entity.observations.includes(c));
				entity.observations.push(...added);
				this.upsertEntity(entity);
				results.push({ entityName: item.entityName, added });
			}
		});
		tx();
		return results;
	}

	searchEntities(query: string): Entity[] {
		const pattern = `%${query}%`;
		const rows = this.searchEntitiesStmt.all(pattern, pattern, pattern) as any[];
		return rows.map((r) => ({
			name: r.name,
			entityType: r.entity_type,
			observations: JSON.parse(r.observations),
		}));
	}

	// ─── Relations ───────────────────────────────────────

	listRelations(): Relation[] {
		const rows = this.listRelationsStmt.all() as any[];
		return rows.map((r) => ({ from: r.from_entity, to: r.to_entity, relationType: r.relation_type }));
	}

	createRelations(relations: Relation[]): Relation[] {
		const entityNames = new Set(this.listEntities().map((e) => e.name));
		const created: Relation[] = [];
		const existing = new Set(this.listRelations().map((r) => `${r.from}|${r.to}|${r.relationType}`));
		const tx = this.db.transaction(() => {
			for (const r of relations) {
				if (!entityNames.has(r.from) || !entityNames.has(r.to)) continue;
				const key = `${r.from}|${r.to}|${r.relationType}`;
				if (existing.has(key)) continue;
				this.insertRelationStmt.run(r.from, r.to, r.relationType);
				created.push(r);
				existing.add(key);
			}
		});
		tx();
		return created;
	}

	deleteRelations(relations: Relation[]): void {
		const tx = this.db.transaction(() => {
			for (const r of relations) {
				this.deleteRelationsStmt.run(r.from, r.to, r.relationType);
			}
		});
		tx();
	}

	// ─── Migration ───────────────────────────────────────

	migrateFromJson(jsonPath?: string): boolean {
		const path = jsonPath ?? join(ZERO_CORE_DIR, "memory.json");

		// Skip if entities already exist
		if (this.listEntities().length > 0) return false;
		if (!existsSync(path)) return false;

		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as KnowledgeGraph;
			if (!raw.entities?.length && !raw.relations?.length) return false;

			const tx = this.db.transaction(() => {
				for (const e of raw.entities ?? []) {
					this.upsertEntity({
						name: e.name,
						entityType: e.entityType,
						observations: e.observations ?? [],
					});
				}
				for (const r of raw.relations ?? []) {
					this.insertRelationStmt.run(r.from, r.to, r.relationType);
				}
			});
			tx();

			try { renameSync(path, path + ".migrated.bak"); } catch { /* keep both */ }

			log.db(`Migrated memory graph: ${(raw.entities ?? []).length} entities, ${(raw.relations ?? []).length} relations`);
			return true;
		} catch {
			return false;
		}
	}
}
