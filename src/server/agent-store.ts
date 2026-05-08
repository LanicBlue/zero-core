import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Agent Record — replaces PersonaRecord
// ---------------------------------------------------------------------------

export interface AgentRecord {
	id: string;
	// ─── Persona (character) ─────────────────────
	name: string;
	role: string;
	traits: string[];
	expertise: string[];
	communicationStyle: string;
	customInstructions?: string;
	// ─── Runtime config ──────────────────────────
	workspaceDir?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	// ─── Context config ──────────────────────────
	contextConfig?: {
		injectProjectContext?: boolean;
		maxDirectoryDepth?: number;
		excludePatterns?: string[];
		additionalFiles?: string[];
	};
	// ─── Metadata ────────────────────────────────
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface AgentStoreData {
	agents: AgentRecord[];
}

const DEFAULT_AGENT: Omit<AgentRecord, "id" | "createdAt" | "updatedAt"> = {
	name: "Zero",
	role: "Expert coding assistant with deep system design knowledge",
	traits: ["concise", "thorough", "pragmatic"],
	expertise: ["TypeScript", "system-design", "DevOps"],
	communicationStyle: "professional",
};

export class AgentStore {
	private filePath: string;
	private data: AgentStoreData;

	constructor(filePath?: string) {
		this.filePath = filePath ?? join(homedir(), ".zero-core", "agents.json");
		this.data = this.load();
	}

	private load(): AgentStoreData {
		// Migration: personas.json → agents.json
		const personaPath = join(homedir(), ".zero-core", "personas.json");
		if (!existsSync(this.filePath) && existsSync(personaPath)) {
			this.migrateFromPersonas(personaPath);
		}

		if (existsSync(this.filePath)) {
			try {
				const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
				// Backfill workspaceDir for agents created before the field existed
				let dirty = false;
				const defaultWs = join(homedir(), ".zero-core", "workspace");
				for (const a of data.agents) {
					if (!a.workspaceDir) {
						a.workspaceDir = defaultWs;
						dirty = true;
					} else if (a.workspaceDir.startsWith("~")) {
						a.workspaceDir = a.workspaceDir.replace(/^~/, require("os").homedir());
						dirty = true;
					}
				}
				if (dirty) this.save(data);
				return data;
			} catch {
				// fall through
			}
		}

		const defaultData: AgentStoreData = {
			agents: [this.createRecord(DEFAULT_AGENT)],
		};
		this.save(defaultData);
		return defaultData;
	}

	private migrateFromPersonas(personaPath: string): void {
		try {
			const raw = JSON.parse(readFileSync(personaPath, "utf-8"));
			const personas: Record<string, unknown>[] = raw.personas ?? raw.agents ?? [];
			const agents: AgentRecord[] = personas.map((p) => ({
				id: p.id as string,
				name: p.name as string,
				role: p.role as string,
				traits: (p.traits as string[]) ?? [],
				expertise: (p.expertise as string[]) ?? [],
				communicationStyle: (p.communicationStyle as string) ?? "professional",
				customInstructions: p.customInstructions as string | undefined,
				workspaceDir: (p.workspaceDir as string) || join(homedir(), ".zero-core", "workspace"),
				createdAt: p.createdAt as string,
				updatedAt: p.updatedAt as string,
			}));
			this.save({ agents });
			// Rename old file as backup
			try { renameSync(personaPath, personaPath + ".bak"); } catch { /* keep both */ }
			console.log(`[agent-store] Migrated ${agents.length} persona(s) to agents.json`);
		} catch (err) {
			console.error("[agent-store] Migration failed:", (err as Error).message);
		}
	}

	private save(data: AgentStoreData): void {
		const dir = join(this.filePath, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
	}

	private createRecord(
		input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">,
	): AgentRecord {
		const now = new Date().toISOString();
		const raw = input.workspaceDir || join(homedir(), ".zero-core", "workspace");
		const workspaceDir = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
		return { id: uuidv4(), ...input, workspaceDir, createdAt: now, updatedAt: now };
	}

	list(): AgentRecord[] {
		return this.data.agents;
	}

	get(id: string): AgentRecord | undefined {
		return this.data.agents.find((a) => a.id === id);
	}

	create(input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">): AgentRecord {
		const record = this.createRecord(input);
		this.data.agents.push(record);
		this.save(this.data);
		return record;
	}

	update(id: string, input: Partial<Omit<AgentRecord, "id" | "createdAt">>): AgentRecord {
		const index = this.data.agents.findIndex((a) => a.id === id);
		if (index === -1) throw new Error(`Agent not found: ${id}`);
		const patched = { ...input };
		if (patched.workspaceDir?.startsWith("~")) {
			patched.workspaceDir = patched.workspaceDir.replace(/^~/, homedir());
		}
		this.data.agents[index] = {
			...this.data.agents[index],
			...patched,
			updatedAt: new Date().toISOString(),
		};
		this.save(this.data);
		return this.data.agents[index];
	}

	delete(id: string): void {
		this.data.agents = this.data.agents.filter((a) => a.id !== id);
		this.save(this.data);
	}
}
