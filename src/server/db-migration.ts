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
import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { ZERO_CORE_DIR } from "../core/config.js";
import { SqliteStore } from "./sqlite-store.js";
import { KeyValueStore } from "./key-value-store.js";
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
	// knowledge_base_ids column is ALTERed onto upgraded DBs (see below) but
	// INTENTIONALLY OMITTED from AGENT_COLUMNS: knowledgeBaseIds was merged into
	// wikiAnchors (knowledge base = wiki), so neither store round-trips it. Same
	// pattern as role_tag.
	// v0.8 (P0 §2.2): subagents + wikiAnchors — JSON-stored as single TEXT
	// columns (parity with knowledgeBaseIds). Migration ALTERs these onto
	// upgraded DBs; fresh DBs get them via the SqliteStore ensureTable()
	// self-heal below.
	{ key: "subagents", json: true },
	{ key: "wikiAnchors", json: true },
	// v0.8 (P0 §1.4): roleTag was REMOVED from the AgentRecord type. The
	// physical `role_tag` column is INTENTIONALLY KEPT (legacy) — dropping it
	// would risk data loss / rollback pain (plan-P0 §1.4 + acceptance-P0).
	// AgentStore no longer reads or writes it; runtime callers that still
	// reference `.roleTag` are tagged with `@ts-expect-error` for P2/P7
	// cleanup. The mapping entry below is DELIBERATELY OMITTED so the store
	// never round-trips it (omitting from *_COLUMNS removes it from SELECT /
	// INSERT / UPDATE — see sqlite-store.initStatements).
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
//
// Note: SESSION_COLUMNS is consumed by the `for (const col of SESSION_COLUMNS)`
// loop in runMigrations, which calls safeAddColumn(..., "TEXT") for each. That
// is correct for the context-bundle columns above (all TEXT/JSON-as-TEXT).
// The steps-overhaul sub-1 turn_state-fold columns (phase/source/error/
// turn_count/step_count/token_usage/last_completed_step_seq) are NOT listed
// here because they need typed definitions (phase = TEXT NOT NULL DEFAULT
// 'completed', turn_count = INTEGER NOT NULL DEFAULT 0, etc.) — forcing them
// through the TEXT-only loop would corrupt their types. They are added with
// the correct types by an explicit typed safeAddColumn block in runMigrations
// below AND by SessionDB.initSchema (double-belt-and-suspenders; both paths
// run on every startup, fresh + upgraded). They are also NOT part of the
// SessionRecord TS type — rowToRecord does not read them.
const SESSION_COLUMNS = [
	{ key: "context", json: true },
	{ key: "contextProjectId", column: "context_project_id" },
	{ key: "contextWorkspaceDir", column: "context_workspace_dir" },
	{ key: "contextWikiRootNodeId", column: "context_wiki_root_node_id" },
];

const PROJECT_WIKI_COLUMNS = [
	{ key: "projectId", column: "project_id" },
	{ key: "parentId", column: "parent_id" },
	// v0.8 (M2): global-tree type discriminator (header|intent|structure|project|memory).
	// v0.8 (P1 §10.1): `type` column is DROPPED — position is now the type (project
	// subtree = project/header/intent/structure; global memory type roots + their
	// leaves = memory). Legacy `node_type` is kept below for back-compat reads.
	// Migration (migrateWikiDetailToDisk) physically drops the `type` column on
	// upgraded DBs after exporting `detail` to disk (RFC decision 23 refined in P1).
	{ key: "path" },
	{ key: "title" },
	{ key: "summary" },
	// v0.8 (P1 §10.1): `detail` column is DROPPED — wiki body content lives on
	// disk at `~/.zero-core/wiki/<area>/<safe-name>.md`. The `docPointer` column
	// below carries the per-node body file path (code-internal locator; NOT
	// exposed to agents — they use nodeId). Migration exports legacy `detail`
	// rows to disk BEFORE dropping the column, so no content is lost.
	// v0.8 (M2): leaf pointer to the actual document on disk (code file /
	// requirement doc / ADR). The doc itself is NOT stored in the tree.
	{ key: "docPointer", column: "doc_pointer" },
	// v0.8 (M2): provenance tag for structural assertions (structure/derived/
	// confirmed) — archivist's own confidence marker, RFC §2.17a decision 33.
	{ key: "provenance" },
	// v0.8 (M2): traceability requirement IDs, RFC §4.6.
	{ key: "requirementIds", column: "requirement_ids", json: true },
	// v0.8 (M2): free-form relations (module contains / depends-on / implements).
	{ key: "relations", json: true },
	// v0.8 (P0 §3.3 / §10.1): undirected sibling links (nodeId array). NULL on
	// read coalesces to [] in WikiStore. type/detail stay in this phase (P1
	// moves detail to disk).
	{ key: "links", json: true },
	// v0.8 (M2): archivist divergence flags (req unimplemented / code capability
	// not covered by any req), RFC §2.16.
	{ key: "flags", json: true },
	{ key: "lastUpdatedBy", column: "last_updated_by" },
	{ key: "sourceReqId", column: "source_req_id" },
	// Legacy discriminator kept so ProjectWikiStore's back-compat view can read
	// it for pre-M2 rows.
	{ key: "nodeType", column: "node_type" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// v0.8 (M2): wiki scan cursor — per (archivist, project) git scan cursor
// (RFC §2.13, §4.2). Records the main-branch commit sha the archivist last
// scanned; on the next scan it runs `git log/diff <last>..main` and only
// re-reads changes. MUST stay in sync with wiki-scan-cursor-store.ts COLUMNS.
const WIKI_SCAN_CURSOR_COLUMNS = [
	{ key: "archivistId", column: "archivist_id" },
	{ key: "projectId", column: "project_id" },
	{ key: "lastScannedRef", column: "last_scanned_ref" },
	{ key: "lastFullScanAt", column: "last_full_scan_at" },
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
	// v0.8 (M4): discuss-as-document fields (RFC §4.5 / decision 12/14/34).
	{ key: "docPath", column: "doc_path" },
	{ key: "createdByAgentId", column: "created_by_agent_id" },
	{ key: "assignedAgentId", column: "assigned_agent_id" },
	{ key: "reviewerAgentId", column: "reviewer_agent_id" },
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

// v0.8 (M1): CronRecord — cron becomes a first-class entity. One agent can
// carry N cron entries (one per workingScope). workingScope is JSON-stored as
// the full SessionContextBundle. MUST stay in sync with cron-store.ts COLUMNS.
//
// v0.8 (P0 §3.4): `schedule` is now JSON (CronSchedule union: once|alarm|
// interval). The store writes it through the `json:true` flag. Legacy string
// rows are migrated by migrateCronScheduleToString below. `triggerMode` is a
// redundant copy of `schedule.mode` for cheap WHERE filtering.
const CRON_COLUMNS = [
	{ key: "agentId", column: "agent_id" },
	{ key: "workingScope", column: "working_scope", json: true },
	{ key: "schedule", json: true },
	{ key: "triggerMode", column: "trigger_mode" },
	{ key: "lastRunAt", column: "last_run_at" },
	{ key: "lastStatus", column: "last_status" },
	{ key: "lastError", column: "last_error" },
	{ key: "nextRunAt", column: "next_run_at" },
	{ key: "lastGitRef", column: "last_git_ref" },
	{ key: "source" },
	{ key: "workId", column: "work_id" },
	{ key: "prompt" },
	{ key: "enabled", bool: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// v0.8 (P0 §3.4 / §9.3): cron_runs — per-fire audit log. PK id is uuid.
// `success` is INTEGER 0/1. Mirrors CronRunRecord in shared/types.ts. The
// createdAt/updatedAt columns are kept for SqliteStore parity (the generic
// store requires them); canonical fire time is fired_at.
const CRON_RUNS_COLUMNS = [
	{ key: "cronId", column: "cron_id" },
	{ key: "firedAt", column: "fired_at" },
	{ key: "agentId", column: "agent_id" },
	{ key: "sessionId", column: "session_id" },
	{ key: "success", bool: true },
	{ key: "error" },
	{ key: "durationMs", column: "duration_ms" },
	{ key: "tokens" },
	{ key: "cost" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// v0.8: project_jobs — 项目级后台 agent 任务(如 wiki 充实)。PK id 是 uuid
// (ProjectJobStore mints)。与 cron_runs 不同:这是 on-demand 显式踢一次的
// 长任务生命周期记录,跨 session/重启可追踪。MUST stay in sync with
// project-job-store.ts PROJECT_JOBS_COLUMNS.
const PROJECT_JOBS_COLUMNS = [
	{ key: "jobType", column: "job_type" },
	{ key: "projectId", column: "project_id" },
	{ key: "agentId", column: "agent_id" },
	{ key: "sessionId", column: "session_id" },
	{ key: "status" },
	{ key: "startedAt", column: "started_at" },
	{ key: "finishedAt", column: "finished_at" },
	{ key: "error" },
	{ key: "promptSummary", column: "prompt_summary" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// v0.8 project_work —— 取代工作流角色的"工位/工作"系统。每行 = 项目里定义的
// 一项工作(具体职责):动作 prompt + requiredTools + agentId(可空)+ contextPolicy
// + hooks(inline JSON)。触发源:cron(复用 crons 表,带 work_id)、hook、手动。
// MUST stay in sync with project-work-store.ts PROJECT_WORK_COLUMNS.
const PROJECT_WORK_COLUMNS = [
	{ key: "projectId", column: "project_id" },
	{ key: "name" },
	{ key: "actionPrompt", column: "action_prompt" },
	{ key: "requiredTools", column: "required_tools", json: true },
	{ key: "agentId", column: "agent_id" },
	{ key: "contextPolicy", column: "context_policy", json: true },
	{ key: "hooks", json: true },
	{ key: "enabled", bool: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// v0.8 (P0 §7.7 #4): tool_configs — per-tool default-param config. PK =
// tool_name (no id column; the SqliteStore auto-adds id/createdAt/updatedAt
// but tool_configs is keyed by tool_name, so we use a dedicated store path).
// Defined here for parity; the actual table DDL is below.
const TOOL_CONFIGS_COLUMNS = [
	{ key: "toolName", column: "tool_name" },
	{ key: "config", json: true },
	{ key: "updatedAt", column: "updated_at" },
];

// v0.8 (P0 §7.7 #4): tool_usage — per-call log (the tool-call log, NOT the
// sessions-level token-resource accounting, RFC §8.5).
const TOOL_USAGE_COLUMNS = [
	{ key: "toolName", column: "tool_name" },
	{ key: "agentId", column: "agent_id" },
	{ key: "sessionId", column: "session_id" },
	{ key: "calledAt", column: "called_at" },
	{ key: "params", json: true },
	{ key: "success", bool: true },
	{ key: "durationMs", column: "duration_ms" },
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

// v0.8 (P0 §3.4): convert legacy string schedule values in `crons.schedule`
// to structured CronSchedule JSON. Idempotent — rows already carrying JSON
// (i.e. the value parses as an object with a `mode` field) are skipped.
//
// Mapping rules (plan-P0 §11):
//   "off"      → enabled=false + schedule = {mode:"interval",everyMs:0}
//   "hourly"   → {mode:"interval",everyMs:3600000}
//   "daily"    → {mode:"alarm",time:"09:00",days:[],tz:<local>}
//   "weekly"   → {mode:"alarm",time:"09:00",days:[<today>],tz:<local>}
//   "<digits>" → {mode:"interval",everyMs:<n>}
//
// The `trigger_mode` column is backfilled in the same pass to mirror
// schedule.mode. `enabled` is left untouched except for the "off" case where
// the cron was implicitly disabled by the string sentinel.
function migrateCronScheduleToJson(db: Database.Database): void {
	try {
		const tableInfo = db.pragma("table_info(crons)") as Array<{ name: string }> | undefined;
		if (!tableInfo || tableInfo.length === 0) return; // table not created yet
		const colNames = new Set(tableInfo.map((c) => c.name));
		if (!colNames.has("schedule")) return;

		const localTz: string = (() => {
			try {
				return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
			} catch {
				return "UTC";
			}
		})();
		const todayIsoWeekday = (((new Date().getDay() + 6) % 7) + 1); // 1=Mon … 7=Sun

		const rows = db.prepare("SELECT id, schedule, enabled FROM crons").all() as Array<{
			id: string;
			schedule: string | null;
			enabled: number;
		}>;

		const updateStmt = db.prepare(
			"UPDATE crons SET schedule = ?, trigger_mode = ?, enabled = ? WHERE id = ?",
		);

		for (const row of rows) {
			const raw = row.schedule;
			if (raw == null) continue;
			// Already JSON-shaped? Skip — idempotent.
			const trimmed = raw.trim();
			if (trimmed.startsWith("{")) {
				try {
					const parsed = JSON.parse(trimmed);
					if (parsed && typeof parsed === "object" && typeof parsed.mode === "string") {
						// Backfill trigger_mode if empty.
						if (colNames.has("trigger_mode")) {
							const existing = (
								db.prepare("SELECT trigger_mode AS m FROM crons WHERE id = ?").get(row.id) as { m?: string } | undefined
							)?.m;
							if (!existing) {
								updateStmt.run(trimmed, parsed.mode, row.enabled, row.id);
							}
						}
						continue;
					}
				} catch {
					// fall through — treat as legacy string
				}
			}

			// Legacy string cadence — convert.
			let newSchedule: import("../shared/types.js").CronSchedule;
			let newEnabled = row.enabled !== 0; // preserve existing

			const asNumber = Number(trimmed);
			if (!Number.isNaN(asNumber) && trimmed !== "" && /^\d+$/.test(trimmed)) {
				// Pure digit string → interval ms.
				newSchedule = { mode: "interval", everyMs: asNumber };
			} else {
				switch (trimmed.toLowerCase()) {
					case "off":
						newSchedule = { mode: "interval", everyMs: 0 };
						newEnabled = false; // "off" sentinel = disabled
						break;
					case "hourly":
						newSchedule = { mode: "interval", everyMs: 3_600_000 };
						break;
					case "daily":
						newSchedule = { mode: "alarm", time: "09:00", days: [], tz: localTz };
						break;
					case "weekly":
						newSchedule = { mode: "alarm", time: "09:00", days: [todayIsoWeekday], tz: localTz };
						break;
					default:
						// Unknown string — keep as interval 0 so the row is inert
						// rather than crashing the P4 scheduler with a non-JSON
						// value. Log loudly so the operator can fix it.
						console.warn(
							`[db-migration] crons.id=${row.id} has unrecognized schedule "${trimmed}" — coercing to interval everyMs=0.`,
						);
						newSchedule = { mode: "interval", everyMs: 0 };
						break;
				}
			}

			const json = JSON.stringify(newSchedule);
			updateStmt.run(json, newSchedule.mode, newEnabled ? 1 : 0, row.id);
		}
	} catch (e) {
		console.warn("[db-migration] cron schedule JSON migration skipped:", (e as Error).message);
	}
}

// v0.8 (M2): rebuild project_wiki when an upgraded DB still carries the
// pre-M2 schema (`project_id TEXT NOT NULL` + UNIQUE(project_id, path)).
// The global wiki tree needs project_id = NULL for the global root and
// memory nodes, so the legacy NOT NULL constraint is fatal at startup.
// Only rebuilds when the table is empty (lossless — archivist rescans
// repopulate it); non-empty tables are left untouched to avoid data loss.
//
// v0.8 (P1): the rebuilt schema mirrors the new (post-P1) shape — no `detail`
// / `type` columns. Content lives on disk (migrateWikiDetailToDisk handles
// export + drop on non-empty legacy tables; this empty-rebuild path just
// builds the new shape directly).
function migrateWikiTableSchema(db: Database.Database): void {
	try {
		const cols = db.pragma("table_info(project_wiki)") as Array<{ name: string; notnull: number }>;
		const projectIdCol = cols.find((c) => c.name === "project_id");
		if (!projectIdCol || projectIdCol.notnull === 0) return; // already nullable — new schema
		const rowCount = (db.prepare("SELECT count(*) AS n FROM project_wiki").get() as { n: number }).n;
		if (rowCount > 0) {
			console.warn(`[db-migration] project_wiki has legacy NOT NULL project_id constraint but ${rowCount} rows — leaving as-is to avoid data loss; global root/memory nodes will fail to insert.`);
			return;
		}
		db.exec("DROP TABLE project_wiki");
		db.exec(`CREATE TABLE project_wiki (
			id TEXT PRIMARY KEY, project_id TEXT,
			parent_id TEXT REFERENCES project_wiki(id),
			node_type TEXT, path TEXT, title TEXT,
			summary TEXT, doc_pointer TEXT, provenance TEXT,
			requirement_ids TEXT, relations TEXT, links TEXT,
			flags TEXT,
			last_updated_by TEXT DEFAULT 'agent',
			source_req_id TEXT, created_at TEXT, updated_at TEXT
		)`);
		console.log("[db-migration] rebuilt project_wiki to v0.8 schema (was empty, dropped NOT NULL project_id + legacy UNIQUE).");
	} catch (e) {
		console.warn("[db-migration] project_wiki schema migration skipped:", (e as Error).message);
	}
}

// v0.8 (P1 §10.1): export wiki body content from the legacy `detail` column to
// disk (~/.zero-core/wiki/<area>/<safe-name>.md), populate `doc_pointer`, then
// DROP the `detail` and `type` columns. Position (projectId / parentId chain)
// now carries the type discriminator.
//
// This is the explicit, data-preserving migration promised by schema contract
// §1.2 (plan-P1 §3): "detail 内容先导出磁盘再删列(否则丢数据)". Idempotent —
// skips when `detail` is already absent.
//
// Path scheme (mirrors WikiStore.deriveContentFilePath):
//   - node has project_id        → projects/<projectId>/<safeName>.md
//   - node is under memory:* (parent path / own path) → memory/<agentId>/<safeName>.md
//   - otherwise                  → knowledge/<safeName>.md
//
// `type` column is dropped in the same pass; positions are already correct
// (legacy rows were written with proper parentId chains). Rows whose `type`
// disagrees with their position are left where they live — we trust the
// position over the legacy column (RFC §10.4: "type 按位置归位").
function migrateWikiDetailToDisk(db: Database.Database): void {
	try {
		const cols = db.pragma("table_info(project_wiki)") as Array<{ name: string }> | undefined;
		if (!cols || cols.length === 0) return;
		const colNames = new Set(cols.map((c) => c.name));
		if (!colNames.has("detail")) return; // already migrated / fresh DB
		const hasType = colNames.has("type");

		const wikiDir = join(ZERO_CORE_DIR, "wiki");
		// Resolve a node's row for parent lookup (to detect memory subtree).
		const getParentStmt = db.prepare("SELECT id, parent_id, path, project_id FROM project_wiki WHERE id = ?");
		const updatePointerStmt = db.prepare(
			"UPDATE project_wiki SET doc_pointer = ? WHERE id = ?",
		);

		// safe leaf name from path: replace ':' and '/' to keep it filename-safe
		// while staying unique within the area dir. Node ids are stable, so we
		// also fold a short id suffix to avoid collisions across project subtrees.
		function safeName(id: string, path: string | null): string {
			const p = (path ?? id).replace(/[:/\\]+/g, "_").replace(/^_+|_+$/g, "");
			const tail = id.length >= 8 ? id.slice(0, 8) : id;
			return `${p || "node"}__${tail}.md`;
		}

		// Walk up to decide area: any ancestor with path "memory-root:*" or own
		// project_id set tells us the area.
		// Memory area is per-agent: memory/<agentId>/ (agentId = 2nd colon segment
		// of the leaf's own path, e.g. `memory:<agentId>:<type>:<slug>`).
		function memoryArea(row: { path: string | null }): string {
			const agent = row.path ? row.path.split(":")[1] ?? "" : "";
			const clean = agent.replace(/[:/\\]+/g, "_").replace(/^_+|_+$/g, "");
			return join("memory", clean || "_shared");
		}
		function areaOf(
			row: { id: string; parent_id: string | null; path: string | null; project_id: string | null },
		): string {
			if (row.project_id) return join("projects", row.project_id);
			// Walk parent chain to detect memory subtree.
			let cur: string | null = row.parent_id;
			let guard = 0;
			while (cur && guard++ < 32) {
				const parent = getParentStmt.get(cur) as
					| { id: string; parent_id: string | null; path: string | null; project_id: string | null }
					| undefined;
				if (!parent) break;
				if (parent.project_id) return join("projects", parent.project_id);
				if (parent.path && (parent.path.startsWith("memory-root:") || parent.id.startsWith("wiki-root:memory:"))) {
					return memoryArea(row);
				}
				cur = parent.parent_id;
			}
			// Own path signals memory too.
			if (row.path && row.path.startsWith("memory")) return memoryArea(row);
			return "knowledge";
		}

		const rows = db.prepare(
			"SELECT id, parent_id, path, project_id, detail, doc_pointer FROM project_wiki",
		).all() as Array<{
			id: string;
			parent_id: string | null;
			path: string | null;
			project_id: string | null;
			detail: string | null;
			doc_pointer: string | null;
	}>;

	// mkdirSync / writeFileSync come from the top-level ESM import (node:fs).
	let exported = 0;
	let pointerFilled = 0;
		for (const row of rows) {
			// Skip synthetic roots — they carry no body content.
			if (row.id.startsWith("wiki-root:")) continue;
			const detail = row.detail;
			// Compute canonical path; export only non-empty detail.
			const area = areaOf(row);
			const file = join(wikiDir, area, safeName(row.id, row.path));
			if (detail && detail.trim().length > 0) {
				mkdirSync(join(wikiDir, area), { recursive: true });
				writeFileSync(file, detail, "utf-8");
				exported++;
				// Only stamp doc_pointer when there's actual content; otherwise leave it.
				if (!row.doc_pointer) {
					updatePointerStmt.run(file, row.id);
					pointerFilled++;
				}
			}
		}

		// Now drop the columns. SQLite ≥3.35 supports ALTER TABLE DROP COLUMN.
		try {
			db.exec("ALTER TABLE project_wiki DROP COLUMN detail");
		} catch (e) {
			console.warn("[db-migration] DROP COLUMN detail failed (SQLite too old? leaving column inert):", (e as Error).message);
		}
		if (hasType) {
			try {
				db.exec("ALTER TABLE project_wiki DROP COLUMN type");
			} catch (e) {
				console.warn("[db-migration] DROP COLUMN type failed (SQLite too old? leaving column inert):", (e as Error).message);
			}
		}
		console.log(
			`[db-migration] wiki detail→disk: exported ${exported} body file(s), filled ${pointerFilled} doc_pointer(s), dropped detail${hasType ? " + type" : ""} column(s).`,
		);
	} catch (e) {
		console.warn("[db-migration] wiki detail→disk migration skipped:", (e as Error).message);
	}
}

/**
 * 把存量 archivist 长期绑定 cron(source=`archivist-bind:<op>`)迁移到 project_work。
 * 策略:每 project 的绑定 cron 共用一个 agentId,把它们按 operationId 归并成 1~3 个
 * work(文档充实/文档重建/git 同步),回填对应 cron.work_id。已迁移(work_id 非空)跳过。
 * 低风险:archivist-binding 是 v0.8 阶段2 才建的,存量数据少;任何异常都外层 catch 吞掉。
 */
function migrateArchivistBindToProjectWork(db: Database.Database): void {
	const tableInfo = db.pragma("table_info(crons)") as Array<{ name: string }> | undefined;
	if (!tableInfo || tableInfo.length === 0) return;
	const colNames = new Set(tableInfo.map((c) => c.name));
	if (!colNames.has("work_id") || !colNames.has("source")) return;

	const workTableInfo = db.pragma("table_info(project_work)") as Array<{ name: string }> | undefined;
	if (!workTableInfo || workTableInfo.length === 0) return;

	const PREFIX = "archivist-bind:";
	const rows = db.prepare("SELECT id, agent_id, working_scope, source, work_id FROM crons WHERE source LIKE ?")
		.all(`${PREFIX}%`) as Array<{ id: string; agent_id: string; working_scope: string | null; source: string; work_id: string | null }>;

	// 按 (projectId, operationId) 分组,归并成 work。
	type Group = { projectId: string; opId: string; agentId: string; cronIds: string[] };
	const groups = new Map<string, Group>();
	const opName: Record<string, string> = { "wiki-enrich": "文档充实", "doc-rebuild": "文档重建", "git-update": "git 同步" };
	for (const r of rows) {
		if (r.work_id) continue; // 已迁移
		const opId = r.source.slice(PREFIX.length);
		let projectId = "";
		try { projectId = (JSON.parse(r.working_scope ?? "{}") as { projectId?: string }).projectId ?? ""; } catch { /* ignore */ }
		if (!projectId) continue;
		const key = `${projectId}::${opId}`;
		const g = groups.get(key) ?? { projectId, opId, agentId: r.agent_id, cronIds: [] };
		g.cronIds.push(r.id);
		groups.set(key, g);
	}

	for (const g of groups.values()) {
		const workId = `pw-migr-${g.projectId}-${g.opId}`;
		const name = opName[g.opId] ?? g.opId;
		// 幂等:work 已存在则跳过 insert。
		const exists = db.prepare("SELECT 1 FROM project_work WHERE id = ?").get(workId);
		if (!exists) {
			db.prepare(`INSERT INTO project_work (id, project_id, name, action_prompt, required_tools, agent_id, enabled, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
				workId, g.projectId, name, "", JSON.stringify(["Wiki"]), g.agentId, new Date().toISOString(), new Date().toISOString(),
			);
		}
		const upd = db.prepare("UPDATE crons SET work_id = ? WHERE id = ?");
		for (const cid of g.cronIds) upd.run(workId, cid);
	}
}

/**
 * v0.8 de-role: rewrite retired role tokens ("analyst", "lead") → "agent" across
 * the requirement + wiki persisted fields. The tooling no longer binds roles;
 * any agent caller is just "agent". Idempotent — the WHERE clauses guard it (an
 * already-migrated row has no analyst/lead to match). Runs after all affected
 * tables exist. display-only fields (reviewer/last_updated_by/sender) and the
 * state-machine actor (triggered_by) are all rewritten so new code, which emits
 * only "agent", never collides with legacy values.
 */
function migrateRoleTokensToAgent(db: Database.Database): void {
	try {
		db.exec(`UPDATE requirements SET source = 'agent' WHERE source = 'analyst'`);
		db.exec(`UPDATE requirements SET reviewer = 'agent' WHERE reviewer = 'analyst'`);
		db.exec(`UPDATE requirement_messages SET sender = 'agent' WHERE sender IN ('analyst', 'lead')`);
		db.exec(`UPDATE requirement_status_history SET triggered_by = 'agent' WHERE triggered_by IN ('analyst', 'lead')`);
		db.exec(`UPDATE project_wiki SET last_updated_by = 'agent' WHERE last_updated_by = 'analyst'`);
	} catch (err) {
		log.warn("migration", `migrateRoleTokensToAgent failed (non-fatal): ${(err as Error).message}`);
	}
}

export function runMigrations(sessionDB: SessionDB): void {
	const kv = sessionDB.getKVStore();
	const db = sessionDB.getDb();

	// ─── 1. Column migrations for existing tables ────────────────
	// Must add columns BEFORE creating SqliteStore instances, because
	// the constructor runs initStatements() which SELECTs all declared columns.

	// Agent columns
	safeAddColumn(db, "agents", "knowledge_base_ids", "TEXT");
	// v0.8 (M0): legacy role_tag column — physically added on upgraded DBs so
	// pre-P0 rows keep their data, but AgentStore no longer reads/writes it
	// (AGENT_COLUMNS omits the mapping). P0 §1.4: physical column is INTENT-
	// IONALLY retained to avoid data loss / rollback pain.
	safeAddColumn(db, "agents", "role_tag", "TEXT");
	// v0.8 (P0 §2.2): subagents + wikiAnchors — new JSON columns. ALTER for
	// upgraded DBs; fresh DBs also pick them up via SqliteStore.ensureTable()
	// self-heal. AGENT_COLUMNS above lists both so SELECT/INSERT/UPDATE
	// round-trip them.
	safeAddColumn(db, "agents", "subagents", "TEXT");
	safeAddColumn(db, "agents", "wiki_anchors", "TEXT");

	// Wiki columns
	// v0.8 (P0 §3.3): project_wiki.links — undirected sibling nodeId array
	// (JSON TEXT). NULL on read coalesces to [] in WikiStore. ALTER for
	// upgraded DBs; fresh DBs get it from the CREATE TABLE block above.
	safeAddColumn(db, "project_wiki", "links", "TEXT");

	// v0.8 (§11.5): agent-as-tool retired — DROP the agent_tools table on
	// upgraded DBs. Fresh DBs never had it. Empty on production (no callers
	// since P2 retired the runtime path), so DROP is lossless. Idempotent.
	db.exec(`DROP TABLE IF EXISTS agent_tools`);

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

	// v0.8: archived flag — soft-delete sessions (excluded from active
	// routing/listing/main lookup, row retained). Added here with the other
	// sessions columns; SessionDB.initSchema also adds it idempotently.
	safeAddColumn(db, "sessions", "archived", "INTEGER NOT NULL DEFAULT 0");

	// v0.8 (M0): SessionRecord context bundle (D-B) + routing columns.
	for (const col of SESSION_COLUMNS) {
		const colName = col.column || col.key;
		safeAddColumn(db, "sessions", colName, "TEXT");
	}
	safeAddIndex(db, "sessions", "idx_sessions_agent_project", "agent_id, context_project_id");

	// steps-overhaul sub-1: sessions absorbs turn_state. 7 typed columns with
	// the SAME types/defaults as SessionDB.initSchema's CREATE TABLE / ALTER
	// (double-belt-and-suspenders: both paths run on every startup). phase
	// defaults to 'completed' so existing (pre-fold) sessions rows are NOT
	// flagged as recovery candidates (recovery scans phase NOT IN
	// ('completed','failed')). turn_count/step_count default 0; turn_count is
	// bumped in appendStep (role='user'). memory feedback-fresh-db-migrations:
	// are NOT in SESSION_COLUMNS (that loop forces TEXT, wrong for INTEGER /
	// NOT NULL DEFAULT cols); typed safeAddColumn here is the sync point.
	safeAddColumn(db, "sessions", "phase", "TEXT NOT NULL DEFAULT 'completed'");
	safeAddColumn(db, "sessions", "last_completed_step_seq", "INTEGER");
	safeAddColumn(db, "sessions", "source", "TEXT NOT NULL DEFAULT 'background'");
	safeAddColumn(db, "sessions", "error", "TEXT");
	safeAddColumn(db, "sessions", "turn_count", "INTEGER NOT NULL DEFAULT 0");
	safeAddColumn(db, "sessions", "step_count", "INTEGER NOT NULL DEFAULT 0");
	safeAddColumn(db, "sessions", "token_usage", "TEXT");
	safeAddIndex(db, "sessions", "idx_sessions_phase", "phase");

	// steps-overhaul sub-1: physical `turns` table renamed to `steps`.
	// SessionDB.initSchema DROPPED the legacy `turns` + `turn_state` tables and
	// CREATEs `steps` with these columns, so on every startup (fresh + upgraded)
	// the columns already exist by here — these safeAddColumn calls are no-ops
	// kept as defensive parity with the v0.8 pattern (and to self-heal any DB
	// that somehow lost them). The old migrateTurnsToSteps backfill is removed
	// (its source table `turns` no longer exists; nothing to migrate — design
	// decided DROP+rebuild, no data migration).
	safeAddColumn(db, "steps", "turn_group", "INTEGER NOT NULL DEFAULT -1");
	safeAddColumn(db, "steps", "input_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "steps", "output_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "steps", "total_tokens", "INTEGER DEFAULT 0");
	safeAddColumn(db, "steps", "attachments", "TEXT");
	safeAddIndex(db, "steps", "idx_steps_session_seq", "session_id, seq");
	safeAddIndex(db, "steps", "idx_steps_session_group", "session_id, turn_group");

	// Step 2E (hook-redesign): parent_tool_call_id on delegated_tasks lets the
	// parent resume path resolve a dangling Agent tool-call → its delegated task
	// (tool-call ↔ task link). Fresh DBs get it via CREATE TABLE; upgraded DBs
	// that already have delegated_tasks need the column added.
	safeAddColumn(db, "delegated_tasks", "parent_tool_call_id", "TEXT");

	// Persist the model the sub-agent actually ran on (Subagent tool's model
	// override, else the target/caller's configured model), so historical tasks
	// show the model used at delegation time rather than the agent's current
	// model. Fresh DBs get it via CREATE TABLE; upgraded DBs need it added.
	safeAddColumn(db, "delegated_tasks", "model_id", "TEXT");

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
		id TEXT PRIMARY KEY, project_id TEXT,
		parent_id TEXT REFERENCES project_wiki(id),
		node_type TEXT, path TEXT, title TEXT,
		summary TEXT, doc_pointer TEXT, provenance TEXT,
		requirement_ids TEXT, relations TEXT, links TEXT,
		flags TEXT,
		last_updated_by TEXT DEFAULT 'agent',
		source_req_id TEXT, created_at TEXT, updated_at TEXT
	)`);
	// v0.8 (M2): legacy UNIQUE(project_id, path) is dropped — global tree
	// paths are unique within (parentId, path), not (projectId, path).
	// Upgraded DBs created the table pre-M2 with `project_id TEXT NOT NULL`
	// and UNIQUE(project_id, path); CREATE TABLE IF NOT EXISTS does NOT alter
	// an existing table, so the legacy NOT NULL constraint survives and breaks
	// insertion of the global root / memory nodes (project_id = NULL). Rebuild
	// the table when it still carries the old constraint and holds no data
	// (project_wiki is repopulated by archivist scans, so an empty rebuild is
	// lossless; if rows exist we leave it alone to avoid data loss).
	migrateWikiTableSchema(db);
	// v0.8 (P1 §10.1): move wiki body content from the `detail` column to disk
	// (~/.zero-core/wiki/<area>/<safe-name>.md), then DROP the `detail` and
	// `type` columns. Position now carries the type. This MUST run AFTER the
	// table exists and AFTER the legacy schema rebuild (above), so the export
	// sees a single project_wiki table. Idempotent: skips when `detail` is
	// already absent (fresh DB or already-migrated).
	migrateWikiDetailToDisk(db);
	safeAddIndex(db, "project_wiki", "idx_wiki_project", "project_id");
	safeAddIndex(db, "project_wiki", "idx_wiki_parent", "parent_id");
	// v0.8 §2.13: composite index for getByParentAndPath — the archivist's
	// per-file upsert hot path. Without it each lookup scanned the whole table.
	safeAddIndex(db, "project_wiki", "idx_wiki_parent_path", "parent_id, path");
	// v0.8 (P1): idx_wiki_type referenced the now-dropped `type` column. Drop
	// it explicitly (SQLite does not cascade DROP COLUMN to dependent indexes
	// reliably across versions). Idempotent via try/catch.
	try {
		db.exec("DROP INDEX IF EXISTS idx_wiki_type");
	} catch { /* ignore */ }

	// v0.8 (M2): wiki scan cursor — per (archivist, project) git scan cursor
	// (RFC §2.13, §4.2). (archivist_id, project_id) is the unique key.
	db.exec(`CREATE TABLE IF NOT EXISTS wiki_scan_cursors (
		id TEXT PRIMARY KEY,
		archivist_id TEXT NOT NULL,
		project_id TEXT NOT NULL,
		last_scanned_ref TEXT,
		last_full_scan_at TEXT,
		created_at TEXT,
		updated_at TEXT,
		UNIQUE(archivist_id, project_id)
	)`);
	safeAddIndex(db, "wiki_scan_cursors", "idx_wsc_archivist_project", "archivist_id, project_id");

	db.exec(`CREATE TABLE IF NOT EXISTS requirements (
		id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
		title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'found',
		source TEXT DEFAULT 'agent', priority TEXT DEFAULT 'normal',
		impact_scope TEXT, context TEXT,
		assigned_lead_session_id TEXT, discussion_session_id TEXT,
		reviewer TEXT DEFAULT 'agent',
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

	// v0.8 (M1): crons table — first-class cron entity. workingScope stored as
	// JSON (SessionContextBundle). agentId is a soft reference (no FK) so cron
	// deletion never cascades to the agent and the agent is the canonical owner.
	//
	// v0.8 (P0 §3.4): `schedule` is now structured JSON (CronSchedule union).
	// Legacy string rows are converted by migrateCronScheduleToJson below.
	// `trigger_mode` / `last_run_at` / `last_status` / `last_error` /
	// `next_run_at` are scheduler telemetry columns (populated by P4; this
	// phase only adds them).
	db.exec(`CREATE TABLE IF NOT EXISTS crons (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL,
		working_scope TEXT,
		schedule TEXT,
		trigger_mode TEXT,
		last_run_at TEXT,
		last_status TEXT,
		last_error TEXT,
		next_run_at TEXT,
		last_git_ref TEXT,
		prompt TEXT,
		source TEXT,
		work_id TEXT,
		enabled INTEGER DEFAULT 1,
		created_at TEXT,
		updated_at TEXT
	)`);
	// Cover upgraded DBs whose pre-P0 crons table lacks the new telemetry
	// columns (CREATE TABLE IF NOT EXISTS won't alter an existing row).
	safeAddColumn(db, "crons", "trigger_mode", "TEXT");
	safeAddColumn(db, "crons", "last_run_at", "TEXT");
	safeAddColumn(db, "crons", "last_status", "TEXT");
	safeAddColumn(db, "crons", "last_error", "TEXT");
	safeAddColumn(db, "crons", "next_run_at", "TEXT");
	safeAddColumn(db, "crons", "last_git_ref", "TEXT");
	safeAddColumn(db, "crons", "source", "TEXT");
	safeAddColumn(db, "crons", "work_id", "TEXT");
	migrateCronScheduleToJson(db);
	safeAddIndex(db, "crons", "idx_crons_agent", "agent_id");
	safeAddIndex(db, "crons", "idx_crons_enabled", "enabled");

	// v0.8 (P0 §3.4 / §9.3): cron_runs — per-fire audit log. PK id is uuid
	// (CronRunStore mints it). success is INTEGER 0/1. created_at/updated_at
	// are kept for SqliteStore parity (the generic store expects them; the
	// canonical fire timestamp is fired_at).
	db.exec(`CREATE TABLE IF NOT EXISTS cron_runs (
		id TEXT PRIMARY KEY,
		cron_id TEXT NOT NULL,
		fired_at TEXT NOT NULL,
		agent_id TEXT,
		session_id TEXT,
		success INTEGER NOT NULL DEFAULT 0,
		error TEXT,
		duration_ms INTEGER,
		tokens INTEGER,
		cost REAL,
		created_at TEXT,
		updated_at TEXT
	)`);
	safeAddIndex(db, "cron_runs", "idx_cron_runs_cron", "cron_id");

	// project_jobs — 项目级后台 agent 任务(wiki 充实等)。on-demand 显式踢一次
	// 的长任务生命周期记录。PK id 是 uuid (ProjectJobStore mints)。
	db.exec(`CREATE TABLE IF NOT EXISTS project_jobs (
		id TEXT PRIMARY KEY,
		job_type TEXT NOT NULL,
		project_id TEXT NOT NULL,
		agent_id TEXT,
		session_id TEXT,
		status TEXT NOT NULL DEFAULT 'running',
		started_at TEXT NOT NULL,
		finished_at TEXT,
		error TEXT,
		prompt_summary TEXT,
		created_at TEXT,
		updated_at TEXT
	)`);
	safeAddIndex(db, "project_jobs", "idx_project_jobs_project", "project_id");
	safeAddIndex(db, "project_jobs", "idx_project_jobs_status", "status");

	// project_work —— 取代工作流角色的"工位/工作"系统。PK id 是 uuid
	// (ProjectWorkStore mints)。agent_id 可空(空岗)。required_tools /
	// context_policy / hooks 是 JSON 列。cron 触发器不在此表,复用 crons 表
	// (crons.work_id 引用本表 id)。
	db.exec(`CREATE TABLE IF NOT EXISTS project_work (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL,
		name TEXT NOT NULL,
		action_prompt TEXT,
		required_tools TEXT,
		agent_id TEXT,
		context_policy TEXT,
		hooks TEXT,
		enabled INTEGER DEFAULT 1,
		created_at TEXT,
		updated_at TEXT
	)`);
	safeAddIndex(db, "project_work", "idx_project_work_project", "project_id");
	safeAddIndex(db, "project_work", "idx_project_work_agent", "agent_id");
	// 回填:把存量 archivist-bind cron(source=`archivist-bind:<op>`)迁移到
	// project_work。每 project 按操作建一个 work,回填对应 cron.work_id。
	// 低风险(archivist-binding 本 session 才建),失败不阻断启动。
	try {
		migrateArchivistBindToProjectWork(db);
	} catch (err) {
		console.warn("[db-migration] project_work backfill skipped:", (err as Error).message);
	}

	// v0.8 (P0 §7.7 #4): tool_configs — per-tool default-param config. PK =
	// tool_name (no surrogate id). The SqliteStore constructor always injects
	// id/createdAt/updatedAt columns, but this table is keyed by tool_name, so
	// we hand-roll DDL + use a dedicated ToolConfigStore below.
	db.exec(`CREATE TABLE IF NOT EXISTS tool_configs (
		tool_name TEXT PRIMARY KEY,
		config TEXT,
		updated_at TEXT
	)`);

	// v0.8 (P0 §7.7 #4): tool_usage — per-call log (the tool-call log, NOT the
	// sessions-level token accounting, RFC §8.5). PK id is uuid.
	db.exec(`CREATE TABLE IF NOT EXISTS tool_usage (
		id TEXT PRIMARY KEY,
		tool_name TEXT NOT NULL,
		agent_id TEXT,
		session_id TEXT,
		called_at TEXT NOT NULL,
		params TEXT,
		success INTEGER NOT NULL DEFAULT 0,
		duration_ms INTEGER
	)`);
	safeAddIndex(db, "tool_usage", "idx_tool_usage_tool", "tool_name");
	safeAddIndex(db, "tool_usage", "idx_tool_usage_session", "session_id");

	// v0.8 (M3): orchestrate_plans — lead-submitted DSL flows + confirm gate
	// state (decision 11). flow stored as JSON. leadSessionId is the routing
	// key for the IPC confirm/reject path to find the active awaiter.
	db.exec(`CREATE TABLE IF NOT EXISTS orchestrate_plans (
		id TEXT PRIMARY KEY,
		requirement_id TEXT NOT NULL,
		project_id TEXT NOT NULL,
		lead_agent_id TEXT NOT NULL,
		lead_session_id TEXT NOT NULL,
		flow TEXT,
		state TEXT DEFAULT 'pending',
		rejection_reason TEXT,
		manifest_id TEXT,
		created_at TEXT,
		updated_at TEXT
	)`);
	safeAddIndex(db, "orchestrate_plans", "idx_oplans_req", "requirement_id");
	safeAddIndex(db, "orchestrate_plans", "idx_oplans_session", "lead_session_id");
	safeAddIndex(db, "orchestrate_plans", "idx_oplans_state", "state");

	// v0.8 (M3): orchestrate_manifests — per-run manifest (decision 34) that
	// PM reads for coverage judgement and archivist reads for traceability.
	// touchedFiles/tests/review are JSON arrays.
	db.exec(`CREATE TABLE IF NOT EXISTS orchestrate_manifests (
		id TEXT PRIMARY KEY,
		requirement_id TEXT NOT NULL,
		plan_id TEXT NOT NULL,
		project_id TEXT NOT NULL,
		touched_files TEXT,
		tests TEXT,
		review TEXT,
		summary TEXT,
		created_at TEXT
	)`);
	safeAddIndex(db, "orchestrate_manifests", "idx_oman_req", "requirement_id");
	safeAddIndex(db, "orchestrate_manifests", "idx_oman_plan", "plan_id");

	// Now safe to create SqliteStore instances with all columns
	const agents = new SqliteStore<AgentRecord>(db, "agents", AGENT_COLUMNS);

	// v0.8 (P0 §1.4): ensure the legacy `role_tag` physical column exists on
	// the agents table. The earlier safeAddColumn (above) handles upgraded DBs
	// where the table already exists, but on a fresh DB the agents table is
	// only created by SqliteStore.ensureTable() just now — and role_tag is
	// deliberately NOT in AGENT_COLUMNS (store no longer round-trips it), so
	// ensureTable won't add it. Re-adding it here keeps the physical column
	// alive on fresh DBs too, so AgentStore.listByRoleTag's raw SQL works and
	// legacy data is preserved (acceptance-P0: "roleTag 列还在").
	agents.ensureColumn("role_tag", "TEXT");

	// ─── 2. JSON file → SQLite migrations ────────────────────────

	const zeroDir = ZERO_CORE_DIR;

	// Providers
	agents.ensureColumn("models", "TEXT"); // noop if exists — safety
	const providers = new SqliteStore<any>(db, "providers", [
		{ key: "name" }, { key: "type" }, { key: "apiKey", column: "api_key" },
		{ key: "baseUrl", column: "base_url" }, { key: "models", json: true },
		{ key: "enabled", bool: true }, { key: "isSystem", column: "is_system", bool: true },
		{ key: "enableConcurrencyLimit", column: "enable_concurrency_limit", bool: true },
		{ key: "maxConcurrency", column: "max_concurrency", number: true },
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

	// v0.8 (§11.5): agent-tools.json migration removed — table dropped above.

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

	// v0.8: Knowledge bases migration removed — the KB subsystem (vector RAG)
	// is retired (will be redone via wiki-format file splitting). The
	// kb_entries/kb_chunks tables are dropped in step 4 below.

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

	// ─── 4. Drop legacy memory + knowledge-base tables ────────────
	// All superseded by the v0.8 wiki tree:
	//  - memory_entities/memory_relations: v0.7 memory graph (zombie since
	//    P2 §11.6, zero runtime writers).
	//  - memory_nodes/_subjects/_edges/_fts: Gen1 MemoryNodeStore (M5
	//    migrated writes to the wiki memory subtree; store removed).
	//  - kb_entries/kb_chunks: standalone KB vector-RAG subsystem retired
	//    (will be redone via wiki-format file splitting).
	// DROP IF EXISTS makes this idempotent on fresh DBs that never had them.
	db.exec(`DROP TABLE IF EXISTS memory_relations`);
	db.exec(`DROP TABLE IF EXISTS memory_entities`);
	db.exec(`DROP TABLE IF EXISTS memory_nodes_fts`);
	db.exec(`DROP TABLE IF EXISTS memory_edges`);
	db.exec(`DROP TABLE IF EXISTS memory_subjects`);
	db.exec(`DROP TABLE IF EXISTS memory_nodes`);
	db.exec(`DROP TABLE IF EXISTS kb_chunks`);
	db.exec(`DROP TABLE IF EXISTS kb_entries`);

	// v0.8 de-role: rewrite legacy "analyst"/"lead" tokens → "agent" across the
	// requirement + wiki persisted fields. All affected tables exist by here.
	// Idempotent. See migrateRoleTokensToAgent.
	migrateRoleTokensToAgent(db);
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
