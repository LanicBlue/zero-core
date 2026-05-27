import { join } from "node:path";
import { homedir } from "node:os";
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Agent Tool Entry
// ---------------------------------------------------------------------------

export interface AgentToolEntry {
	id: string;
	name: string;
	description?: string;
	type: "internal" | "external";
	enabled: boolean;
	agentId?: string;
	transport?: "cli" | "http";
	command?: string;
	argsTemplate?: string;
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	bodyTemplate?: string;
	responsePath?: string;
	timeout?: number;
	blocking?: boolean;
		auto_background_timeout?: number;
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "description" },
	{ key: "type" },
	{ key: "enabled", bool: true },
	{ key: "agentId", column: "agent_id" },
	{ key: "transport" },
	{ key: "command" },
	{ key: "argsTemplate", column: "args_template" },
	{ key: "url" },
	{ key: "method" },
	{ key: "headers", json: true },
	{ key: "bodyTemplate", column: "body_template" },
	{ key: "responsePath", column: "response_path" },
	{ key: "timeout" },
	{ key: "blocking", bool: true },
		{ key: "auto_background_timeout" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// AgentToolStore
// ---------------------------------------------------------------------------

export class AgentToolStore {
	private store: SqliteStore<AgentToolEntry>;

	constructor(db: Database.Database) {
		this.store = new SqliteStore<AgentToolEntry>(db, "agent_tools", COLUMNS);

		// Migrate from JSON if needed
		const jsonPath = join(homedir(), ".zero-core", "agent-tools.json");
		this.store.migrateFromJson(jsonPath, "entries");
	}

	list(): AgentToolEntry[] {
		return this.store.list();
	}

	get(id: string): AgentToolEntry | undefined {
		return this.store.get(id);
	}

	getByAgentId(agentId: string): AgentToolEntry | undefined {
		return this.store.list().find((e) => e.type === "internal" && e.agentId === agentId);
	}

	create(input: Omit<AgentToolEntry, "id" | "createdAt" | "updatedAt">): AgentToolEntry {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<AgentToolEntry, "id" | "createdAt">>): AgentToolEntry {
		return this.store.update(id, input as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}

	deleteByAgentId(agentId: string): void {
		const entries = this.store.list().filter(
			(e) => e.type === "internal" && e.agentId === agentId,
		);
		for (const e of entries) {
			this.store.delete(e.id);
		}
	}
}
