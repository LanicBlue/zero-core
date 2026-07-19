// Wiki schema DDL（wiki-system-redesign plan-01 §2 / design.md §5）
//
// # 文件说明书
//
// ## 核心功能
// 新 Wiki DB 的 schema 初始化（7 张表 + 索引）。一次 `initWikiSchema(db)`
// 完成全部建表,幂等。
//
// ## INTEGER affinity 不变量（acceptance-01 §A/§E 拒绝条件）
//   所有 DDL 通过**裸 `Database.exec()`** + 显式 SQL 字符串执行。
//   每个整数列（id / parent_id / revision / old_revision / new_revision ...）
//   都保持 INTEGER affinity。**严禁**用 `SqliteStore<T>` 创建或迁移 Wiki 表
//   —— 它把所有列默认声明为 TEXT（参考 memory reference-sqlite-text-affinity-
//   numeric）。move / FTS / audit 需要多表事务,不能用通用 KV 风格 store。
//
// ## Idempotent
//   - 全部 CREATE 使用 `IF NOT EXISTS`。
//   - 重复启动不报错、不重复 root、不改变 root revision/created_at
//     （root bootstrap 由 wiki-database.ts 在 schema init 后调用）。
//
// ## 不做
//   - 不读取或迁移旧 `project_wiki`（plan-01 §E 拒绝条件）。
//   - 不使用 trigger 同步 FTS（design.md §5.5：repository 显式 transaction）。
//   - 不建立表级永久 UNIQUE —— active 唯一性由 partial unique index 保证
//     （`WHERE archived_at IS NULL`）,允许归档后同路径重建。
//
// 参见:
//   - docs/archive/wiki-system-redesign/design.md §5（DDL 权威来源）
//   - docs/archive/wiki-system-redesign/plan-01-database-contracts.md §2（schema 要求）

import type Database from "better-sqlite3";

/**
 * Wiki DB schema 版本。仅服务新 Wiki DB,不含旧 Wiki 迁移步骤（plan-01 §2）。
 * 后续 schema 演进时单调递增;plan-01 起始为 1。
 */
export const WIKI_SCHEMA_VERSION = 1;

/**
 * 7 张核心表的名称常量,供 repository 验证 / 工具诊断引用。后续 sub 不得
 * 改名（acceptance-01 §A 「七类核心表/FTS 均存在」依赖此闭集）。
 */
export const WIKI_TABLE_NAMES = [
	"wiki_nodes",
	"wiki_links",
	"wiki_addresses",
	"wiki_repositories",
	"wiki_source_bindings",
	"wiki_nodes_fts",
	"wiki_audit_log",
] as const;

/**
 * 全部 Wiki schema DDL,一次性执行。幂等（`IF NOT EXISTS`）。
 *
 * DDL 严格匹配 design.md §5.1–§5.6:
 *   - 整数列显式声明 `INTEGER`,保持 INTEGER affinity（不用 SqliteStore<T>）。
 *   - JSON 字段使用 `json_valid(…)` CHECK（§5.1 attributes_json）。
 *   - active path/sibling 唯一性用 partial unique index（`WHERE archived_at IS NULL`）。
 *   - FTS 是 external-content（content='wiki_nodes', content_rowid='id'）,
 *     字段固定 name/summary/content,无 trigger,可重建。
 *   - FK 行为按设计：parent_id RESTRICT,link source CASCADE / target RESTRICT 等。
 */
export function initWikiSchema(db: Database.Database): void {
	// ── wiki_nodes（design.md §5.1）────────────────────────────────────────
	// INTEGER PRIMARY KEY → id 自带 INTEGER affinity（rowid alias）。
	// parent_id INTEGER → 外键到 wiki_nodes(id),ON DELETE RESTRICT。
	// revision INTEGER NOT NULL DEFAULT 1 → 乐观并发控制。
	// attributes_json 带 json_valid CHECK。
	// active path/sibling partial unique index → 归档后可重建同路径。
	db.exec(`
		CREATE TABLE IF NOT EXISTS wiki_nodes (
			id              INTEGER PRIMARY KEY,
			parent_id       INTEGER,
			name            TEXT NOT NULL,
			path            TEXT NOT NULL,
			kind            TEXT NOT NULL DEFAULT 'node',
			summary         TEXT NOT NULL DEFAULT '',
			content         TEXT NOT NULL DEFAULT '',
			attributes_json TEXT,
			revision        INTEGER NOT NULL DEFAULT 1,
			created_at      TEXT NOT NULL,
			updated_at      TEXT NOT NULL,
			archived_at     TEXT,

			CHECK(attributes_json IS NULL OR json_valid(attributes_json)),
			FOREIGN KEY(parent_id) REFERENCES wiki_nodes(id) ON DELETE RESTRICT
		);

		CREATE INDEX IF NOT EXISTS idx_wiki_nodes_parent ON wiki_nodes(parent_id);
		CREATE INDEX IF NOT EXISTS idx_wiki_nodes_kind ON wiki_nodes(kind);
		CREATE INDEX IF NOT EXISTS idx_wiki_nodes_archived ON wiki_nodes(archived_at);
		-- 复合 (parent_id, archived_at) covering index(round-2 P1 §4 perf):
		-- WikiNodeRepository.countChildrenByParents 的 grouped COUNT
		-- (WHERE parent_id IN (...) AND archived_at IS NULL GROUP BY parent_id)
		-- 在无此索引时退到 idx_wiki_nodes_archived(扫全表 active 行,1M 下
		-- ~400ms/op);有此索引走 covering seek(parent_id=? AND archived_at=?),
		-- 0.1ms/op 级,与规模无关。同时加速 countActiveChildren / getActiveChildrenBounded
		-- 的 parent_id + active 过滤。CREATE IF NOT EXISTS 幂等,fresh+存量 DB 都建。
		CREATE INDEX IF NOT EXISTS idx_wiki_nodes_parent_archived ON wiki_nodes(parent_id, archived_at);

		-- active 节点 path 唯一:partial unique index(WHERE archived_at IS NULL)。
		-- 表级永久 UNIQUE 禁止(plan-01 §2):归档后允许同路径 active 重建。
		CREATE UNIQUE INDEX IF NOT EXISTS uq_wiki_nodes_active_path
			ON wiki_nodes(path) WHERE archived_at IS NULL;

		-- active 同级 (parent_id, name) 唯一:防止同父下重名 active 节点。
		CREATE UNIQUE INDEX IF NOT EXISTS uq_wiki_nodes_active_sibling
			ON wiki_nodes(parent_id, name) WHERE archived_at IS NULL;
	`);

	// ── wiki_links（design.md §5.2）────────────────────────────────────────
	// 一条记录同时支持 outgoing/incoming,不双写反向链接。
	// PRIMARY KEY(source_id, target_id, relation) → 复合主键自带唯一性。
	// source_id CASCADE(删 source 节点级联删 link),target_id RESTRICT
	//   (被引用的 target 节点不允许直接硬删;需先解链或归档)。
	db.exec(`
		CREATE TABLE IF NOT EXISTS wiki_links (
			source_id   INTEGER NOT NULL,
			target_id   INTEGER NOT NULL,
			relation    TEXT NOT NULL,
			created_at  TEXT NOT NULL,
			created_by  TEXT,

			PRIMARY KEY(source_id, target_id, relation),
			FOREIGN KEY(source_id) REFERENCES wiki_nodes(id) ON DELETE CASCADE,
			FOREIGN KEY(target_id) REFERENCES wiki_nodes(id) ON DELETE RESTRICT
		);

		CREATE INDEX IF NOT EXISTS idx_wiki_links_target ON wiki_links(target_id);
	`);

	// ── wiki_addresses（design.md §5.3）────────────────────────────────────
	// 静态逻辑地址表。address TEXT PRIMARY KEY 是业务键。
	// target_id INTEGER 可 null(动态地址 memory:// / project:// 不入此表;
	//   入表的静态地址可能未绑定 target)。
	// target_id RESTRICT:被地址引用的节点不允许直接硬删。
	db.exec(`
		CREATE TABLE IF NOT EXISTS wiki_addresses (
			address         TEXT PRIMARY KEY,
			target_id       INTEGER,
			resolver        TEXT,
			scope           TEXT NOT NULL,
			kind            TEXT NOT NULL,
			prompt_policy   TEXT,
			revision        INTEGER NOT NULL DEFAULT 1,
			created_at      TEXT NOT NULL,
			updated_at      TEXT NOT NULL,

			FOREIGN KEY(target_id) REFERENCES wiki_nodes(id) ON DELETE RESTRICT
		);

		CREATE INDEX IF NOT EXISTS idx_wiki_addresses_target ON wiki_addresses(target_id);
	`);

	// ── wiki_repositories（design.md §5.4）─────────────────────────────────
	// 项目镜像仓库绑定。repository_id TEXT PRIMARY KEY 是稳定业务键。
	// project_node_id INTEGER NOT NULL UNIQUE → 项目根节点(1:1)。
	// project_id TEXT NOT NULL UNIQUE → ProjectRecord.id 应用层软引用。
	// project_node_id RESTRICT:被仓库绑定的项目根节点不允许直接硬删。
	db.exec(`
		CREATE TABLE IF NOT EXISTS wiki_repositories (
			repository_id       TEXT PRIMARY KEY,
			project_node_id     INTEGER NOT NULL UNIQUE,
			project_id          TEXT NOT NULL UNIQUE,
			source_root         TEXT NOT NULL DEFAULT '',
			default_branch      TEXT NOT NULL DEFAULT 'main',
			indexed_revision    TEXT,
			sync_status         TEXT NOT NULL DEFAULT 'pending',
			last_error          TEXT,
			last_indexed_at     TEXT,

			FOREIGN KEY(project_node_id) REFERENCES wiki_nodes(id) ON DELETE RESTRICT
		);
	`);

	// ── wiki_source_bindings（design.md §5.4）──────────────────────────────
	// 文件/目录节点的源码映射。node_id INTEGER PRIMARY KEY(1:1 与节点)。
	// UNIQUE(repository_id, source_path) → 同仓库同路径唯一映射。
	// node_id CASCADE(删节点级联删绑定),repository_id CASCADE
	//   (删仓库级联删所有绑定)。
	db.exec(`
		CREATE TABLE IF NOT EXISTS wiki_source_bindings (
			node_id             INTEGER PRIMARY KEY,
			repository_id       TEXT NOT NULL,
			source_path         TEXT NOT NULL,
			source_kind         TEXT NOT NULL,
			indexed_revision    TEXT NOT NULL,
			blob_oid            TEXT,

			UNIQUE(repository_id, source_path),
			FOREIGN KEY(node_id) REFERENCES wiki_nodes(id) ON DELETE CASCADE,
			FOREIGN KEY(repository_id) REFERENCES wiki_repositories(repository_id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_wiki_source_bindings_repo
			ON wiki_source_bindings(repository_id);
	`);

	// ── wiki_nodes_fts（design.md §5.5）external-content FTS5 ──────────────
	// content='wiki_nodes' + content_rowid='id' → external-content 模式。
	// 字段固定 name/summary/content,tokenize unicode61。
	// **无 trigger**:由 WikiNodeRepository 在显式 transaction 内手动同步
	//   (insert/delete/update 在同一事务)。索引可重建(rebuild)。
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS wiki_nodes_fts USING fts5(
			name,
			summary,
			content,
			content='wiki_nodes',
			content_rowid='id',
			tokenize='unicode61'
		);
	`);

	// ── wiki_audit_log（design.md §5.6）────────────────────────────────────
	// audit_id TEXT PRIMARY KEY → 公开 opaque operation receipt。
	// request_id TEXT UNIQUE → 安全重试去重(重复 request_id 不产生两条记录)。
	// old_revision / new_revision INTEGER → 修订号可公开。
	db.exec(`
		CREATE TABLE IF NOT EXISTS wiki_audit_log (
			audit_id         TEXT PRIMARY KEY,
			request_id       TEXT UNIQUE,
			actor_agent_id   TEXT,
			session_id       TEXT,
			action           TEXT NOT NULL,
			node_path        TEXT,
			old_revision     INTEGER,
			new_revision     INTEGER,
			detail_json      TEXT,
			created_at       TEXT NOT NULL,

			CHECK(detail_json IS NULL OR json_valid(detail_json))
		);

		CREATE INDEX IF NOT EXISTS idx_wiki_audit_created ON wiki_audit_log(created_at);
		CREATE INDEX IF NOT EXISTS idx_wiki_audit_node ON wiki_audit_log(node_path);
		CREATE INDEX IF NOT EXISTS idx_wiki_audit_actor ON wiki_audit_log(actor_agent_id);
	`);

	// ── schema-version（plan-01 §2：只服务新 Wiki DB）─────────────────────
	// 单行表,记录当前 schema 版本。后续演进时由迁移流程单调递增。
	// plan-01 起始版本 = WIKI_SCHEMA_VERSION(1)。不含旧 Wiki 迁移步骤。
	db.exec(`
		CREATE TABLE IF NOT EXISTS wiki_schema_version (
			version     INTEGER PRIMARY KEY,
			applied_at  TEXT NOT NULL
		);
	`);

	markSchemaVersion(db);
}

/**
 * 在 `wiki_schema_version` 表记录当前版本（如果尚未存在）。
 * 幂等：已有同版本行则 no-op。
 *
 * 注意:plan-01 阶段只有版本 1,无迁移流程。后续 sub 若引入迁移,新增独立的
 * `runWikiMigrations(db, from, to)` 函数,不得在本 schema init 内塞迁移逻辑
 * （acceptance-01 §B「新 Wiki schema 不位于 db-migration.ts 的旧 project_wiki
 * migration 中」）。
 */
function markSchemaVersion(db: Database.Database): void {
	const now = new Date().toISOString();
	// INSERT OR IGNORE:已存在同 version 行则保留原 applied_at(幂等)。
	db.prepare(
		`INSERT OR IGNORE INTO wiki_schema_version (version, applied_at) VALUES (?, ?)`,
	).run(WIKI_SCHEMA_VERSION, now);
}

/**
 * 读取当前 schema 版本（最新一行）。无版本行返回 0(fresh DB 调用 initWikiSchema 前)。
 */
export function readWikiSchemaVersion(db: Database.Database): number {
	const row = db.prepare(
		`SELECT version FROM wiki_schema_version ORDER BY version DESC LIMIT 1`,
	).get() as { version: number } | undefined;
	return row?.version ?? 0;
}
