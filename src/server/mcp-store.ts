import { join } from "node:path";
import { homedir } from "node:os";
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// MCP Server Configuration
// ---------------------------------------------------------------------------

export interface McpServerConfig {
	id: string;
	name: string;
	transport: "stdio" | "sse" | "streamable-http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	enabled: boolean;
	agentIds?: string[];
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "transport" },
	{ key: "command" },
	{ key: "args", json: true },
	{ key: "env", json: true },
	{ key: "url" },
	{ key: "headers", json: true },
	{ key: "enabled", bool: true },
	{ key: "agentIds", column: "agent_ids", json: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// McpStore
// ---------------------------------------------------------------------------

export class McpStore {
	private store: SqliteStore<McpServerConfig>;

	constructor(db: Database.Database) {
		this.store = new SqliteStore<McpServerConfig>(db, "mcp_servers", COLUMNS);

		// Migrate from JSON if needed
		const jsonPath = join(homedir(), ".zero-core", "mcp-servers.json");
		this.store.migrateFromJson(jsonPath, "servers");
	}

	list(): McpServerConfig[] {
		return this.store.list();
	}

	get(id: string): McpServerConfig | undefined {
		return this.store.get(id);
	}

	create(input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">): McpServerConfig {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<McpServerConfig, "id" | "createdAt">>): McpServerConfig {
		return this.store.update(id, input as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}
