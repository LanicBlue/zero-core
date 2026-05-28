import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { McpServerConfig } from "../shared/types.js";

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

	constructor(sessionDB: SessionDB) {
		this.store = new SqliteStore<McpServerConfig>(sessionDB.getDb(), "mcp_servers", COLUMNS);
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
