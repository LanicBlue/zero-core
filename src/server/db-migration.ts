// 数据库迁移
//
// # 文件说明书
//
// ## 核心功能
// 数据库迁移管理，处理 schema 版本升级和数据迁移。
//
// ## 输入
// - SessionDB 实例
//
// ## 输出
// - 迁移结果
//
// ## 定位
// 服务层迁移，被 loadCoreModules 调用。
//
// ## 依赖
// - better-sqlite3 - SQLite 驱动
// - ./session-db - 会话数据库
//
// ## 维护规则
// - 新增迁移时需追加到迁移列表
// - 保持迁移顺序不可变
//
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
	{ key: "roleTag", column: "role_tag" },
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
	{ key: "auto_background_timeout" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

const PROJECT_COLUMNS = [
	{ key: "name" },
	{ key: "workspaceDir", column: "workspace_dir" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// v0.8 (M0): SessionRecord context bundle columns. JSON-stored context +
// extracted projectId column for the (agentId, projectId) find-or-create
// routing key. Kept here for parity with the *_COLUMNS pattern even though
// the sessions table itself is owned by SessionDB.
const SESSION_COLUMNS = [
	{ key: "context", json: true },
	{ key: "contextProjectId", column: "context_project_id" },
	{ key: "contextWorkspaceDir", column: "context_workspace_dir" },
	{ key: "contextWikiRootNodeId", column: "context_wiki_root_node_id" },
];

const PROJECT_WIKI_COLUMNS = [
	{ key: "projectId", column: "project_id" },
	{ key: "parentId", column: "parent_id" },
	{ key: "nodeType", column: "node_type" },
	{ key: "path" },
	{ key: "title" },
	{ key: "summary" },
	{ key: "detail" },
	{ key: "lastUpdatedBy", column: "last_updated_by" },
	{ key: "sourceReqId", column: "source_req_id" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

const REQUIREMENT_COLUMNS = [
	{ key: "projectId", column: "project_id" },
	{ key: "title" },
	{ key: "description" },
	{ key: "status" },
	{ key: "source" },
	{ key: "priority" },
	{ key: "impactScope", column: "impact_scope" },
	{ key: "context" },
	{ key: "assignedLeadSessionId", column: "assigned_lead_session_id" },
	{ key: "discussionSessionId", column: "discussion_session_id" },
	{ key: "reviewer" },
	{ key: "closedAt", column: "closed_at" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

const REQUIREMENT_STATUS_HISTORY_COLUMNS = [
	{ key: "requirementId", column: "requirement_id" },
	{ key: "fromStatus", column: "from_status" },
	{ key: "toStatus", column: "to_status" },
	{ key: "triggeredBy", column: "triggered_by" },
	{ key: "comment" },
	{ key: "createdAt", column: "created_at" },
];

const TASK_STEPS_COLUMNS = [
	{ key: "requirementId", column: "requirement_id" },
	{ key: "stepOrder", column: "step_order" },
	{ key: "role" },
	{ key: "title" },
	{ key: "description" },
	{ key: "agentConfig", column: "agent_config" },
	{ key: "status" },
	{ key: "input" },
	{ key: "output" },
	{ key: "reviewResult", column: "review_result" },
	{ key: "reviewComment", column: "review_comment" },
	{ key: "retryCount", column: "retry_count" },
	{ key: "maxRetries", column: "max_retries" },
	{ key: "sessionId", column: "session_id" },
	{ key: "startedAt", column: "started_at" },
	{ key: "completedAt", column: "completed_at" },
	{ key: "error" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

const REQUIREMENT_MESSAGES_COLUMNS = [
	{ key: "requirementId", column: "requirement_id" },
	{ key: "sender" },
	{ key: "content" },
	{ key: "messageType", column: "message_type" },
	{ key: "metadata" },
	{ key: "createdAt", column: "created_at" },
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

function safeAddIndex(db: Database.Database, table: string, indexName: string, columns: string): void {
	try {
		const indexes = (db.pragma("index_list(" + table + ")") as Array<{ name: string }>).map(r => r.name);
		if (!indexes.includes(indexName)) {
			db.exec("CREATE INDEX " + indexName + " ON " + table + "(" + columns + ")");
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

	// Agent columns
	safeAddColumn(db, "agents", "knowledge_base_ids", "TEXT");
	// v0.8 (M0): AgentRecord slimmed — add roleTag (project binding / cron
	// schedule / wikiRootNodeId / lastScannedRef never lived on agents in
	// this version; their columns are simply not added here).
	safeAddColumn(db, "agents", "role_tag", "TEXT");

	// Agent tool columns (table may exist from older versions with fewer columns)
	for (const col of AGENT_TOOL_COLUMNS) {
		const colName = col.column || col.key;
		const isJson = col.json;
		const isBool = col.bool;
		const type = isJson ? "TEXT" : isBool ? "INTEGER" : "TEXT";
		const def = isBool ? `${type} DEFAULT 1` : type;
		safeAddColumn(db, "agent_tools", colName, def);
	}

	// Provider columns
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

	// v0.8 (M0): SessionRecord context bundle (D-B) + routing columns.
	for (const col of SESSION_COLUMNS) {
		const colName = col.column || col.key;
		safeAddColumn(db, "sessions", colName, "TEXT");
	}
	safeAddIndex(db, "sessions", "idx_sessions_agent_project", "agent_id, context_project_id");

	// Step-level storage: turns table new columns
	safeAddColumn(db, "turns", "turn_group", "INTEGER NOT NULL DEFAULT -1");
	safeAddColumn(db, "turns", "input_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "turns", "output_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "turns", "total_tokens", "INTEGER DEFAULT 0");
	safeAddIndex(db, "turns", "idx_turns_session_group", "session_id, turn_group");

	// Migrate old rows: set turn_group = seq for un-migrated rows
	migrateTurnsToSteps(db);

	// ─── Multi-Agent Workflow tables ───────────────────────────
	// v0.8 (M0): projects slimmed to pure metadata + workspaceDir uniqueness.
	// Legacy columns (path/analyst_cron_id/analyst_session_id/last_analysis_at/
	// analysis_interval/status) are not created on fresh DBs; on upgraded DBs
	// they are left in place harmlessly (SqliteStore only reads PROJECT_COLUMNS).
	db.exec(`CREATE TABLE IF NOT EXISTS projects (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		workspace_dir TEXT NOT NULL UNIQUE,
		created_at TEXT,
		updated_at TEXT
	)`);
	// Best-effort: add the new workspace_dir column on upgraded DBs that have
	// the old schema (CREATE TABLE IF NOT EXISTS won't alter existing rows).
	safeAddColumn(db, "projects", "workspace_dir", "TEXT");
	// Backfill workspace_dir from legacy `path` for rows that have one.
	try {
		const cols = (db.pragma("table_info(projects)") as Array<{ name: string }>).map(r => r.name);
		if (cols.includes("path")) {
			db.exec("UPDATE projects SET workspace_dir = COALESCE(workspace_dir, path) WHERE workspace_dir IS NULL");
		}
	} catch { /* ignore */ }
	safeAddIndex(db, "projects", "idx_projects_workspace", "workspace_dir");

	db.exec(`CREATE TABLE IF NOT EXISTS project_wiki (
		id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
		parent_id TEXT REFERENCES project_wiki(id),
		node_type TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL,
		summary TEXT, detail TEXT, last_updated_by TEXT DEFAULT 'analyst',
		source_req_id TEXT, created_at TEXT, updated_at TEXT,
		UNIQUE(project_id, path)
	)`);
	safeAddIndex(db, "project_wiki", "idx_wiki_project", "project_id");
	safeAddIndex(db, "project_wiki", "idx_wiki_parent", "parent_id");

	db.exec(`CREATE TABLE IF NOT EXISTS requirements (
		id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
		title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'found',
		source TEXT DEFAULT 'analyst', priority TEXT DEFAULT 'normal',
		impact_scope TEXT, context TEXT,
		assigned_lead_session_id TEXT, discussion_session_id TEXT,
		reviewer TEXT DEFAULT 'analyst',
		closed_at TEXT, created_at TEXT, updated_at TEXT
	)`);
	safeAddIndex(db, "requirements", "idx_req_project", "project_id");
	safeAddIndex(db, "requirements", "idx_req_status", "status");

	db.exec(`CREATE TABLE IF NOT EXISTS requirement_status_history (
		id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES requirements(id),
		from_status TEXT, to_status TEXT NOT NULL, triggered_by TEXT NOT NULL,
		comment TEXT, created_at TEXT
	)`);
	safeAddIndex(db, "requirement_status_history", "idx_rsh_req", "requirement_id");

	db.exec(`CREATE TABLE IF NOT EXISTS task_steps (
		id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES requirements(id),
		step_order INTEGER NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL,
		description TEXT, agent_config TEXT,
		status TEXT DEFAULT 'pending', input TEXT, output TEXT,
		review_result TEXT, review_comment TEXT,
		retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
		session_id TEXT, started_at TEXT, completed_at TEXT, error TEXT,
		created_at TEXT, updated_at TEXT
	)`);
	safeAddIndex(db, "task_steps", "idx_steps_req", "requirement_id");

	db.exec(`CREATE TABLE IF NOT EXISTS requirement_messages (
		id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES requirements(id),
		sender TEXT NOT NULL, content TEXT NOT NULL,
		message_type TEXT DEFAULT 'text', metadata TEXT, created_at TEXT
	)`);
	safeAddIndex(db, "requirement_messages", "idx_msg_req", "requirement_id");

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
		{ key: "sourceApp", column: "source_app" },
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
		try {
			kv.migrateFromJsonFile(key, join(zeroDir, file));
		} catch (err) {
			log.warn("migration", `KV migration failed for ${key} (${file}):`, (err as Error).message);
		}
	}

	// ─── 4. Memory graph migration ───────────────────────────────

	memory.migrateFromJson();
}

// ---------------------------------------------------------------------------
// Step-level migration: set turn_group = seq for old rows
// ---------------------------------------------------------------------------

function migrateTurnsToSteps(db: Database.Database): void {
	const result = db.prepare("UPDATE turns SET turn_group = seq WHERE turn_group = -1").run();
	if (result.changes > 0) {
		log.db(`migrateTurnsToSteps: updated ${result.changes} row(s) with turn_group = seq`);
	}
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
