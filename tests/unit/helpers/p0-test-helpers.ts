// P0 test helpers — shared utilities for the data-model & schema phase.
//
// # 文件说明书
//
// ## 核心功能
// 提供 v0.8 P0 (数据模型 & schema 地基) 单元测试共享的工具:
//   - seedAgentWithRoleTag:在过渡期(P0 §1.4)给 agents 行直接写 `role_tag`
//     物理列。store 不再 round-trip roleTag,但 listByRoleTag/pm-service/
//     project-notification-router 仍读它,所以测试必须显式 seed。
//   - buildLegacyAgentRow / buildLegacyCronRow:构造**旧 schema** 行,供
//     migration 测试验证「旧库 → migration → 新 schema + 数据保留」契约(§1.2)。
//   - createLegacySchemaDb:在临时 DB 里建出**旧 schema** 的 agents/crons/
//     project_wiki 表(无 P0 新列),用于 migration 双路径测试。
//
// ## 输入
// - CoreDatabase / Database 实例
//
// ## 输出
// - 测试夹具构造函数
//
// ## 定位
// 单元测试辅助,被 p0-migration.test.ts / p0-store.test.ts / p0-startup.test.ts
// 以及被适配的 m0/m1/m3/m4 测试使用。
//
// ## 依赖
// - better-sqlite3 - SQLite 驱动 (类型)
// - ../shared/types (AgentRecord / CronSchedule)
//
// ## 维护规则
// - 过渡期 helper:P2/P7 把所有 roleTag 用法迁完后,seedAgentWithRoleTag
//   随之删除。
// - 不要在这里塞业务逻辑;只放 schema/migration 测试需要的纯构造工具。
//

import type Database from "better-sqlite3";
import type { CoreDatabase } from "../../../src/server/core-database.js";
import type { AgentRecord } from "../../../src/shared/types.js";

/**
 * v0.8 (P0 §1.4 过渡期): AgentStore.create 不再持久化 roleTag(类型已删,
 * store 的 *_COLUMNS 不含它)。但 listByRoleTag/pm-service/project-notification
 * -router 仍读 `role_tag` 物理列。测试需要带 roleTag 的 agent 时,先用
 * AgentStore.create 落标准列,再用本 helper 直接 UPDATE 物理列。
 *
 * P2/P7 把所有 roleTag 调用方迁完后,本 helper 删除。
 */
export function seedAgentWithRoleTag(
	sessionDB: CoreDatabase,
	agentId: string,
	roleTag: string,
): void {
	sessionDB.getDb().prepare("UPDATE agents SET role_tag = ? WHERE id = ?").run(roleTag, agentId);
}

/** Sugar: create + seed in one call. Returns the created AgentRecord. */
export function createAgentWithRoleTag(
	sessionDB: CoreDatabase,
	agentStore: { create(input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">): AgentRecord },
	input: { name: string; roleTag: string; systemPrompt?: string; workspaceDir?: string; toolPolicy?: AgentRecord["toolPolicy"] },
): AgentRecord {
	const agent = agentStore.create({
		name: input.name,
		systemPrompt: input.systemPrompt,
		workspaceDir: input.workspaceDir,
		toolPolicy: input.toolPolicy,
	});
	seedAgentWithRoleTag(sessionDB, agent.id, input.roleTag);
	return agent;
}

// ---------------------------------------------------------------------------
// Legacy schema construction — for migration double-path tests (契约 §1.2)
// ---------------------------------------------------------------------------

/**
 * Build a fresh DB with the **pre-P0** (M1) schema. Used to verify migration
 * converts old rows to the new shape. The schema intentionally:
 *   - agents: has role_tag column, NO subagents/wiki_anchors
 *   - crons: schedule is plain TEXT (legacy string: off|hourly|daily|weekly|<ms>),
 *            NO trigger_mode/last_run_at/last_status/last_error/next_run_at
 *   - project_wiki: NO links column
 *   - NO cron_runs / tool_configs / tool_usage tables
 *
 * This deliberately mirrors the worst-case upgraded-DB shape so runMigrations
 * has to do the full ALTER + data-massage pass.
 */
export function createLegacySchemaDb(db: Database.Database): void {
	db.exec(`
		CREATE TABLE agents (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			workspace_dir TEXT,
			model TEXT,
			provider TEXT,
			thinking_level TEXT,
			context_config TEXT,
			system_prompt TEXT,
			tool_policy TEXT,
			skill_policy TEXT,
			knowledge_base_ids TEXT,
			role_tag TEXT,
			created_at TEXT,
			updated_at TEXT
		);

		CREATE TABLE crons (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			working_scope TEXT,
			schedule TEXT,
			prompt TEXT,
			enabled INTEGER DEFAULT 1,
			created_at TEXT,
			updated_at TEXT
		);

		CREATE TABLE project_wiki (
			id TEXT PRIMARY KEY,
			project_id TEXT,
			parent_id TEXT REFERENCES project_wiki(id),
			type TEXT,
			node_type TEXT,
			path TEXT,
			title TEXT,
			summary TEXT,
			detail TEXT,
			doc_pointer TEXT,
			provenance TEXT,
			requirement_ids TEXT,
			relations TEXT,
			flags TEXT,
			last_updated_by TEXT DEFAULT 'agent',
			source_req_id TEXT,
			created_at TEXT,
			updated_at TEXT
		);
	`);
}

/** Insert one legacy agents row (pre-P0, with role_tag set). */
export function buildLegacyAgentRow(db: Database.Database, row: {
	id: string;
	name: string;
	roleTag: string;
	systemPrompt?: string;
	createdAt?: string;
	updatedAt?: string;
}): void {
	const now = new Date().toISOString();
	db.prepare(`
		INSERT INTO agents (id, name, system_prompt, role_tag, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(row.id, row.name, row.systemPrompt ?? null, row.roleTag, row.createdAt ?? now, row.updatedAt ?? now);
}

/**
 * Insert one legacy crons row. `schedule` is a **legacy string** cadence
 * (off|hourly|daily|weekly|<ms>) — the migration's job is to convert it.
 */
export function buildLegacyCronRow(db: Database.Database, row: {
	id: string;
	agentId: string;
	schedule: string; // legacy string form
	enabled?: number; // 0 | 1
	workingScope?: string;
	prompt?: string;
	createdAt?: string;
	updatedAt?: string;
}): void {
	const now = new Date().toISOString();
	db.prepare(`
		INSERT INTO crons (id, agent_id, working_scope, schedule, prompt, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		row.id,
		row.agentId,
		row.workingScope ?? null,
		row.schedule,
		row.prompt ?? null,
		row.enabled ?? 1,
		row.createdAt ?? now,
		row.updatedAt ?? now,
	);
}

// v0.8 (P1 §10.1): wiki body content migration helper. buildLegacyWikiRow
// inserts a project_wiki row WITH the legacy `detail` + `type` columns, mirroring
// the pre-P1 (M2-era) shape. Used by p1-migration.test.ts to verify
// migrateWikiDetailToDisk exports detail to disk before dropping the columns.

/**
 * Insert one legacy project_wiki row carrying both `type` AND `detail`
 * (pre-P1 schema). The migration's job is to:
 *   - export non-empty `detail` to ~/.zero-core/wiki/<area>/<safe-name>.md,
 *   - stamp `doc_pointer` on the row,
 *   - DROP both `detail` and `type` columns.
 */
export function buildLegacyWikiRow(db: Database.Database, row: {
	id: string;
	parentId?: string | null;
	projectId?: string | null;
	type?: string; // legacy discriminator (header/intent/structure/memory/project)
	nodeType?: string;
	path: string;
	title: string;
	summary?: string;
	detail?: string; // legacy body content (TEXT)
	docPointer?: string;
	provenance?: string;
	lastUpdatedBy?: string;
	createdAt?: string;
	updatedAt?: string;
}): void {
	const now = new Date().toISOString();
	const cols = "(id, parent_id, project_id, type, node_type, path, title, summary, detail, doc_pointer, provenance, last_updated_by, created_at, updated_at)";
	const placeholders = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
	db.prepare(`INSERT INTO project_wiki ${cols} VALUES ${placeholders}`).run(
		row.id,
		row.parentId ?? null,
		row.projectId ?? null,
		row.type ?? null,
		row.nodeType ?? null,
		row.path,
		row.title,
		row.summary ?? null,
		row.detail ?? null,
		row.docPointer ?? null,
		row.provenance ?? null,
		row.lastUpdatedBy ?? "agent",
		row.createdAt ?? now,
		row.updatedAt ?? now,
	);
}
