import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// MCP Server Configuration
// ---------------------------------------------------------------------------

export interface McpServerConfig {
	id: string;
	name: string;
	/** Transport type */
	transport: "stdio" | "sse" | "streamable-http";
	/** For stdio: command to run (e.g. "npx") */
	command?: string;
	/** For stdio: arguments array */
	args?: string[];
	/** For stdio: environment variables */
	env?: Record<string, string>;
	/** For sse / streamable-http: server URL */
	url?: string;
	/** For sse: optional headers */
	headers?: Record<string, string>;
	/** Whether this server is enabled */
	enabled: boolean;
	/** Agent IDs that can use this server's tools (empty = all agents) */
	agentIds?: string[];
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface McpStoreData {
	servers: McpServerConfig[];
}

export class McpStore {
	private filePath: string;
	private data: McpStoreData;

	constructor(filePath?: string) {
		this.filePath = filePath ?? join(homedir(), ".zero-core", "mcp-servers.json");
		this.data = this.load();
	}

	private load(): McpStoreData {
		if (existsSync(this.filePath)) {
			try {
				return JSON.parse(readFileSync(this.filePath, "utf-8"));
			} catch {
				// fall through
			}
		}

		const data: McpStoreData = { servers: [] };
		this.save(data);
		return data;
	}

	private save(data: McpStoreData): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
	}

	list(): McpServerConfig[] {
		return this.data.servers;
	}

	get(id: string): McpServerConfig | undefined {
		return this.data.servers.find((s) => s.id === id);
	}

	create(input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">): McpServerConfig {
		const now = new Date().toISOString();
		const record: McpServerConfig = {
			id: uuidv4(),
			...input,
			createdAt: now,
			updatedAt: now,
		};
		this.data.servers.push(record);
		this.save(this.data);
		return record;
	}

	update(id: string, input: Partial<Omit<McpServerConfig, "id" | "createdAt">>): McpServerConfig {
		const index = this.data.servers.findIndex((s) => s.id === id);
		if (index === -1) throw new Error(`MCP server not found: ${id}`);
		this.data.servers[index] = {
			...this.data.servers[index],
			...input,
			updatedAt: new Date().toISOString(),
		};
		this.save(this.data);
		return this.data.servers[index];
	}

	delete(id: string): void {
		this.data.servers = this.data.servers.filter((s) => s.id !== id);
		this.save(this.data);
	}
}
