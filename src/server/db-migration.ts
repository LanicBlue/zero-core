import type Database from "better-sqlite3";
import type { SessionDB } from "./session-db.js";
import { join } from "node:path";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { ZERO_CORE_DIR } from "../core/config.js";
import { SqliteStore } from "./sqlite-store.js";
import { KeyValueStore } from "./key-value-store.js";
import { MemoryStore } from "./memory-store.js";
import { log } from "../core/logger.js";
import { buildDefaultPrompt } from "../core/default-prompt.js";
import type { AgentRecord } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions — needed for ensureColumn calls on existing tables
// ---------------------------------------------------------------------------

const AGENT_COLUMNS = [
	{ key: "name" },
	{ key: "workspaceDir", column: "workspace_dir" },
	{ key: "model" },
	{ key: "provider" },
	{ key: "thinkingLevel", column: "thinking_level" },
	{ key: "contextConfig", column: "context_config", json: true },
	{ key: "systemPrompt", column: "system_prompt" },
	{ key: "toolPolicy", column: "tool_policy", json: true },
	{ key: "skillPolicy", column: "skill_policy", json: true },
	{ key: "knowledgeBaseIds", column: "knowledge_base_ids", json: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

const AGENT_TOOL_COLUMNS = [
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
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// runMigrations — called once at startup, after SessionDB is created
// ---------------------------------------------------------------------------

function safeAddColumn(db: Database.Database, table: string, column: string, def: string): void {
	try {
		const cols = (db.pragma("table_info(" + table + ")") as Array<{ name: string }>).map(r => r.name);
		if (!cols.includes(column)) {
			db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + def);
		}
	} catch { /* already exists */ }
}

export function runMigrations(sessionDB: SessionDB): void {
	const kv = sessionDB.getKVStore();
	const memory = sessionDB.getMemoryStore();
	const db = sessionDB.getDb();

	// ─── 1. Column migrations for existing tables ────────────────
	// Must add columns BEFORE creating SqliteStore instances, because
	// the constructor runs initStatements() which SELECTs all declared columns.

	safeAddColumn(db, "agents", "knowledge_base_ids", "TEXT");
	safeAddColumn(db, "agent_tools", "blocking", "INTEGER DEFAULT 1");
	safeAddColumn(db, "agent_tools", "auto_background_timeout", "INTEGER");
	safeAddColumn(db, "providers", "enable_concurrency_limit", "INTEGER DEFAULT 0");
	safeAddColumn(db, "providers", "max_concurrency", "INTEGER");

	// Session token tracking
	safeAddColumn(db, "sessions", "input_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "sessions", "output_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "sessions", "total_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "sessions", "cache_read_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "sessions", "cache_write_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "sessions", "reasoning_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "sessions", "estimated_cost_usd", "REAL DEFAULT 0");

	// Now safe to create SqliteStore instances with all columns
	const agents = new SqliteStore<AgentRecord>(db, "agents", AGENT_COLUMNS);
	const agentTools = new SqliteStore<any>(db, "agent_tools", AGENT_TOOL_COLUMNS);

	// ─── 2. JSON file → SQLite migrations ────────────────────────

	const zeroDir = ZERO_CORE_DIR;

	// Providers
	agents.ensureColumn("models", "TEXT"); // noop if exists — safety
	const providers = new SqliteStore<any>(db, "providers", [
		{ key: "name" }, { key: "type" }, { key: "apiKey", column: "api_key" },
		{ key: "baseUrl", column: "base_url" }, { key: "models", json: true },
		{ key: "enabled", bool: true }, { key: "isSystem", column: "is_system", bool: true },
		{ key: "enableConcurrencyLimit", column: "enable_concurrency_limit", bool: true },
		{ key: "maxConcurrency", column: "max_concurrency" },
		{ key: "createdAt", column: "created_at" }, { key: "updatedAt", column: "updated_at" },
	]);
	providers.migrateFromJson(join(zeroDir, "providers.json"), "providers", (raw: any) => ({
		...raw, models: raw.models ?? [],
	}));

	// Agents
	agents.migrateFromJson(join(zeroDir, "agents.json"), "agents", (raw: any) => {
		const normalized = { ...raw };
		normalized.workspaceDir = normalizeWorkspaceDir(raw.workspaceDir);
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
	migratePersonas(db, agents, join(zeroDir, "personas.json"), join(zeroDir, "agents.json"));

	// Agent tools
	agentTools.migrateFromJson(join(zeroDir, "agent-tools.json"), "entries");

	// Templates
	const templates = new SqliteStore<any>(db, "templates", [
		{ key: "name" }, { key: "description" }, { key: "icon" },
		{ key: "systemPrompt", column: "system_prompt" }, { key: "model" }, { key: "provider" },
		{ key: "thinkingLevel", column: "thinking_level" }, { key: "toolPolicy", column: "tool_policy", json: true },
		{ key: "tags", json: true }, { key: "sourceUrl", column: "source_url" }, { key: "color" },
		{ key: "recommendedTools", column: "recommended_tools", json: true },
		{ key: "isBuiltIn", column: "is_built_in", bool: true },
		{ key: "createdAt", column: "created_at" }, { key: "updatedAt", column: "updated_at" },
	]);
	templates.migrateFromJson(join(zeroDir, "templates.json"), "templates");

	// MCP servers
	const mcpServers = new SqliteStore<any>(db, "mcp_servers", [
		{ key: "name" }, { key: "transport" }, { key: "command" },
		{ key: "args", json: true }, { key: "env", json: true }, { key: "url" },
		{ key: "headers", json: true }, { key: "enabled", bool: true },
		{ key: "agentIds", column: "agent_ids", json: true },
		{ key: "createdAt", column: "created_at" }, { key: "updatedAt", column: "updated_at" },
	]);
	mcpServers.migrateFromJson(join(zeroDir, "mcp-servers.json"), "servers");

	// Knowledge bases
	const kbEntries = new SqliteStore<any>(db, "kb_entries", [
		{ key: "name" }, { key: "description" },
		{ key: "embeddingProvider", column: "embedding_provider" },
		{ key: "embeddingModel", column: "embedding_model" },
		{ key: "agentIds", column: "agent_ids", json: true },
		{ key: "files", json: true },
		{ key: "createdAt", column: "created_at" }, { key: "updatedAt", column: "updated_at" },
	]);
	kbEntries.migrateFromJson(join(zeroDir, "knowledge-bases.json"), "knowledgeBases");

	// ─── 3. KV-store JSON migrations ─────────────────────────────

	const kvMigrations: Array<{ key: string; file: string }> = [
		{ key: "workspace", file: "workspace.json" },
		{ key: "tool_config", file: "tool-config.json" },
		{ key: "theme", file: "theme.json" },
		{ key: "device_context", file: "device-context.json" },
		{ key: "github_cache", file: "github-cache.json" },
		{ key: "global_config", file: "zero-core.json" },
	];
	for (const { key, file } of kvMigrations) {
		kv.migrateFromJsonFile(key, join(zeroDir, file));
	}

	// ─── 4. Memory graph migration ───────────────────────────────

	memory.migrateFromJson();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeWorkspaceDir(dir: string | undefined): string | undefined {
	if (!dir) return join(ZERO_CORE_DIR, "workspace");
	let d = dir.startsWith("~") ? dir.replace(/^~/, homedir()) : dir;
	const sep = process.platform === "win32" ? "\\" : "/";
	d = d.replace(/[/\\]+/g, sep);
	return d;
}

function migratePersonas(db: Database.Database, agentStore: SqliteStore<any>, personaPath: string, agentsJsonPath: string): void {
	if (!existsSync(personaPath)) return;
	// Only migrate if agents.json didn't exist
	if (existsSync(agentsJsonPath) || existsSync(agentsJsonPath + ".migrated.bak")) return;

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

			agentStore.create({
				id: p.id as string,
				name: p.name as string,
				systemPrompt: parts.join("\n") || undefined,
				workspaceDir: normalizeWorkspaceDir(p.workspaceDir as string),
				createdAt: p.createdAt as string,
				updatedAt: p.updatedAt as string,
			} as any);
		}
		try { renameSync(personaPath, personaPath + ".bak"); } catch { /* keep both */ }
		log.db(`Migrated ${personas.length} persona(s) to agents table`);
	} catch (err) {
		log.error("migration", "Persona migration failed:", (err as Error).message);
	}
}
