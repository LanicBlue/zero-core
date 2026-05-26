import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type Database from "better-sqlite3";
import { buildDefaultPrompt } from "../core/default-prompt.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Agent Record
// ---------------------------------------------------------------------------

export interface AgentRecord {
	id: string;
	name: string;
	workspaceDir?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	contextConfig?: {
		useDeviceContext?: boolean;
		useGuidelines?: boolean;
		useMemoryContext?: boolean;
	};
	systemPrompt?: string;
	toolPolicy?: {
		autoApprove?: string[];
		blockedTools?: string[];
		tools?: Record<string, { enabled: boolean }>;
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
		readScope?: "filesystem" | "workspace";
	};
	skillPolicy?: {
		enabledSkills?: string[];
	};
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "workspaceDir", column: "workspace_dir" },
	{ key: "model" },
	{ key: "provider" },
	{ key: "thinkingLevel", column: "thinking_level" },
	{ key: "contextConfig", column: "context_config", json: true },
	{ key: "systemPrompt", column: "system_prompt" },
	{ key: "toolPolicy", column: "tool_policy", json: true },
	{ key: "skillPolicy", column: "skill_policy", json: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_AGENT: Omit<AgentRecord, "id" | "createdAt" | "updatedAt"> = {
	name: "Zero",
	systemPrompt: buildDefaultPrompt("Zero"),
};

function normalizeWorkspaceDir(dir: string | undefined): string | undefined {
	if (!dir) return join(homedir(), ".zero-core", "workspace");
	let d = dir.startsWith("~") ? dir.replace(/^~/, homedir()) : dir;
	const sep = process.platform === "win32" ? "\\" : "/";
	d = d.replace(/[/\\]+/g, sep);
	return d;
}

// ---------------------------------------------------------------------------
// AgentStore
// ---------------------------------------------------------------------------

export class AgentStore {
	private store: SqliteStore<AgentRecord>;
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		this.store = new SqliteStore<AgentRecord>(db, "agents", COLUMNS);

		// Migrate from JSON: agents.json
		const jsonPath = join(homedir(), ".zero-core", "agents.json");
		this.store.migrateFromJson(jsonPath, "agents", (raw: any) => {
			const normalized = { ...raw };
			normalized.workspaceDir = normalizeWorkspaceDir(raw.workspaceDir);
			// Migrate old persona fields → systemPrompt
			if (!normalized.systemPrompt && (raw.role || raw.traits || raw.customInstructions)) {
				const parts: string[] = [];
				if (normalized.name && raw.role) parts.push("Your name is " + normalized.name + ". " + raw.role);
				if ((raw.traits as string[])?.length) parts.push("Personality traits: " + (raw.traits as string[]).join(", "));
				if ((raw.expertise as string[])?.length) parts.push("Areas of expertise: " + (raw.expertise as string[]).join(", "));
				if (raw.communicationStyle) parts.push("Communication style: " + raw.communicationStyle);
				if (raw.customInstructions) parts.push(raw.customInstructions);
				normalized.systemPrompt = parts.join("\n") || buildDefaultPrompt(normalized.name || "Agent");
			}
			return normalized;
		});

		// Also migrate from personas.json if agents.json didn't exist
		const personaPath = join(homedir(), ".zero-core", "personas.json");
		if (!existsSync(jsonPath) && existsSync(personaPath) && !existsSync(jsonPath + ".migrated.bak")) {
			this.migrateFromPersonas(personaPath);
		}

		// Ensure at least one default agent exists
		if (this.store.list().length === 0) {
			const defaultWs = join(homedir(), ".zero-core", "workspace");
			this.store.create({ ...DEFAULT_AGENT, workspaceDir: defaultWs } as any);
		}
	}

	private migrateFromPersonas(personaPath: string): void {
		try {
			const raw = JSON.parse(readFileSync(personaPath, "utf-8"));
			const personas: Record<string, unknown>[] = raw.personas ?? raw.agents ?? [];
			for (const p of personas) {
				const parts: string[] = [];
				if (p.name && p.role) parts.push("Your name is " + p.name + ". " + p.role);
				if ((p.traits as string[])?.length) parts.push("Personality traits: " + (p.traits as string[]).join(", "));
				if ((p.expertise as string[])?.length) parts.push("Areas of expertise: " + (p.expertise as string[]).join(", "));
				if (p.communicationStyle) parts.push("Communication style: " + p.communicationStyle);
				if (p.customInstructions) parts.push(p.customInstructions as string);

				const record = {
					id: p.id as string,
					name: p.name as string,
					systemPrompt: parts.join("\n") || undefined,
					workspaceDir: normalizeWorkspaceDir(p.workspaceDir as string),
					createdAt: p.createdAt as string,
					updatedAt: p.updatedAt as string,
				};
				this.store.create(record as any);
			}
			try { renameSync(personaPath, personaPath + ".bak"); } catch { /* keep both */ }
			log.db(`Migrated ${personas.length} persona(s) to agents table`);
		} catch (err) {
			log.error("agent-store", "Migration failed:", (err as Error).message);
		}
	}

	list(): AgentRecord[] {
		return this.store.list();
	}

	get(id: string): AgentRecord | undefined {
		return this.store.get(id);
	}

	create(input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">): AgentRecord {
		const normalized = { ...input };
		normalized.workspaceDir = normalizeWorkspaceDir(normalized.workspaceDir);
		return this.store.create(normalized as any);
	}

	update(id: string, input: Partial<Omit<AgentRecord, "id" | "createdAt">>): AgentRecord {
		const patched = { ...input };
		if (patched.workspaceDir !== undefined) {
			patched.workspaceDir = normalizeWorkspaceDir(patched.workspaceDir);
		}
		return this.store.update(id, patched as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}
