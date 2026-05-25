import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Agent Tool Entry — unified config for internal/external agent tools
// ---------------------------------------------------------------------------

export interface AgentToolEntry {
	id: string;
	name: string;            // tool name (kebab-case)
	description?: string;    // LLM-visible tool description
	type: "internal" | "external";
	enabled: boolean;
	// internal: reference a local agent
	agentId?: string;
	// external transport
	transport?: "cli" | "http";
	// cli fields
	command?: string;        // e.g. "claude"
	argsTemplate?: string;   // e.g. "--print {{task}}"
	// http fields
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	bodyTemplate?: string;   // JSON template with {{task}}
	responsePath?: string;   // dot-path to extract from response
	// common
	timeout?: number;
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface AgentToolStoreData {
	entries: AgentToolEntry[];
}

export class AgentToolStore {
	private filePath: string;
	private data: AgentToolStoreData;

	constructor(filePath?: string) {
		this.filePath = filePath ?? join(homedir(), ".zero-core", "agent-tools.json");
		this.data = this.load();
	}

	private load(): AgentToolStoreData {
		if (existsSync(this.filePath)) {
			try {
				return JSON.parse(readFileSync(this.filePath, "utf-8"));
			} catch { /* fall through */ }
		}
		const empty: AgentToolStoreData = { entries: [] };
		this.save(empty);
		return empty;
	}

	private save(data: AgentToolStoreData): void {
		const dir = join(this.filePath, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
	}

	list(): AgentToolEntry[] {
		return this.data.entries;
	}

	get(id: string): AgentToolEntry | undefined {
		return this.data.entries.find((e) => e.id === id);
	}

	getByAgentId(agentId: string): AgentToolEntry | undefined {
		return this.data.entries.find((e) => e.type === "internal" && e.agentId === agentId);
	}

	create(input: Omit<AgentToolEntry, "id" | "createdAt" | "updatedAt">): AgentToolEntry {
		const now = new Date().toISOString();
		const entry: AgentToolEntry = {
			id: uuidv4(),
			...input,
			createdAt: now,
			updatedAt: now,
		};
		this.data.entries.push(entry);
		this.save(this.data);
		return entry;
	}

	update(id: string, input: Partial<Omit<AgentToolEntry, "id" | "createdAt">>): AgentToolEntry {
		const index = this.data.entries.findIndex((e) => e.id === id);
		if (index === -1) throw new Error(`Agent tool not found: ${id}`);
		this.data.entries[index] = {
			...this.data.entries[index],
			...input,
			updatedAt: new Date().toISOString(),
		};
		this.save(this.data);
		return this.data.entries[index];
	}

	delete(id: string): void {
		this.data.entries = this.data.entries.filter((e) => e.id !== id);
		this.save(this.data);
	}

	deleteByAgentId(agentId: string): void {
		this.data.entries = this.data.entries.filter(
			(e) => !(e.type === "internal" && e.agentId === agentId),
		);
		this.save(this.data);
	}
}
