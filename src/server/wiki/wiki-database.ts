// WikiDatabase — 独立 Wiki 数据库生命周期（wiki-system-redesign plan-01 §1 / design.md §3.2）
//
// # 文件说明书
//
// ## 核心功能
// 新 Wiki 子系统的数据库生命周期所有者。打开 `${ZERO_CORE_DIR}/db/wiki.db`
// (via `wikiDbPath`),配置 WAL + foreign_keys + busy_timeout,初始化 schema,
// 并 bootstrap 固定根。被 DatabaseManager 持有为单实例。
//
// ## 独立性不变量（plan-01 §1 / acceptance-01 §A）
//   - 独立 migration / WAL / checkpoint / health / close 生命周期。
//   - **不**建立第二个指向 `core.db` 的连接。
//   - **不**使用 `ATTACH DATABASE`(跨库 transaction 由 service 层用幂等
//     操作编排,不在 DB 层做)。
//   - 独占持有 wiki.db 时 checkpoint 安全(参考 memory feedback-sessions-db-
//     readonly 的「受许可的维护路径」语义)。
//
// ## WAL / FK / busy_timeout（design.md §3.2）
//   PRAGMA journal_mode = WAL;
//   PRAGMA foreign_keys = ON;
//   PRAGMA busy_timeout = 5000;
//
// ## Ready-order（plan-01 §1）
//   DatabaseManager.open() 必须**先**完成 core + wiki 双 ready,再返回 ——
//   下游 AgentService / recovery 在那之后才构造。本类构造器同步完成 open,
//   DatabaseManager 在 open() 末尾 `new WikiDatabase(wikiDbPath)` 即可。
//
// ## Fixed-root bootstrap（plan-01 §5）
//   idempotent 创建 wiki-root + knowledge/memory/projects 四个 namespace。
//   重复启动不改变 created_at / revision / 不产生重复行。
//
// 参见:
//   - docs/plan/wiki-system-redesign/design.md §3.2（PRAGMA + 独立连接）
//   - docs/plan/wiki-system-redesign/plan-01-database-contracts.md §1（lifecycle）

import Database from "better-sqlite3";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { log } from "../../core/logger.js";
import { wikiDbPath } from "../../core/database-paths.js";
import {
	WIKI_ROOT_PATH,
	joinWikiPath,
} from "./wiki-path.js";
import { initWikiSchema, readWikiSchemaVersion, WIKI_SCHEMA_VERSION } from "./wiki-schema.js";
import type { WikiNodeKind } from "../../shared/wiki-types.js";

/**
 * Wiki DB busy_timeout 毫秒数(design.md §3.2 = 5000)。与 CoreDatabase 一致。
 */
const WIKI_BUSY_TIMEOUT_MS = 5000;

/**
 * 固定根 bootstrap 配置(plan-01 §5)。`path` / `kind` / `summary` 在此唯一
 * 声明,确保重复启动幂等(同一 path/kind/summary,不改 created_at/revision)。
 *
 * 注意:`name` = 路径最后一段;display title 默认 = name。
 */
interface FixedRootSpec {
	/** 规范路径(已确定,不依赖运行时 ID)。 */
	readonly path: string;
	/** 闭合 kind。 */
	readonly kind: WikiNodeKind;
	/** 确定性非空 summary。 */
	readonly summary: string;
}

const FIXED_ROOT_SPECS: readonly FixedRootSpec[] = [
	{
		path: WIKI_ROOT_PATH,
		kind: "root",
		summary: "Root of the zero-core Wiki tree. Agent-visible paths start here.",
	},
	{
		path: joinWikiPath(WIKI_ROOT_PATH, "knowledge"),
		kind: "namespace",
		summary: "Shared, agent-readable knowledge subtree (cross-project).",
	},
	{
		path: joinWikiPath(WIKI_ROOT_PATH, "memory"),
		kind: "namespace",
		summary: "Per-agent long-term memory roots (wiki-root/memory/<stable-agent-id>).",
	},
	{
		path: joinWikiPath(WIKI_ROOT_PATH, "projects"),
		kind: "namespace",
		summary: "Per-project semantic mirror roots (wiki-root/projects/<stable-project-id>).",
	},
] as const;

/**
 * Wiki 数据库健康状态(与 DatabaseManager.DatabaseHealthEntry 形状一致)。
 */
export interface WikiDatabaseHealth {
	exists: boolean;
	writable: boolean;
	integrity: "ok" | string;
	foreignKeys: "ok" | string;
	journalMode: string;
	schemaVersion: number;
}

/**
 * WikiDatabase — 独立 SQLite Wiki 数据库。
 *
 * 由 DatabaseManager 在 open() 末尾构造。打开 wikiDbPath、配置 PRAGMA、
 * 初始化 schema、bootstrap 固定根。之后 repository 通过 `getDb()` /
 * `transaction()` 访问底层句柄。
 */
export class WikiDatabase {
	private readonly db: Database.Database;
	private readonly _path: string;
	private _closed = false;

	/**
	 * @param dbPath 数据库路径。生产代码不传 —— 默认走 `wikiDbPath`
	 *   (`${ZERO_CORE_DIR}/db/wiki.db`,来自 database-paths)。测试传临时绝对路径。
	 */
	constructor(dbPath?: string) {
		const path = dbPath ?? wikiDbPath;
		this._path = path;

		// 1) 创建父目录(plan-01 §1：「创建父目录」)。
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		// 2) 打开连接(better-sqlite3 单连接;不建第二个指向 core.db 的连接)。
		this.db = new Database(path);

		// 3) PRAGMA(design.md §3.2)：WAL + foreign_keys + busy_timeout。
		//    与 CoreDatabase 一致;测试环境 ZERO_CORE_DB_NO_WAL=1 时降级 MEMORY,
		//    避免测试 worker 退出时的 WAL checkpoint 内核 I/O 卡死(参考 CoreDatabase
		//    构造器的同款 env 处理)。
		const journalMode = process.env.ZERO_CORE_DB_NO_WAL === "1" ? "MEMORY" : "WAL";
		this.db.pragma(`journal_mode = ${journalMode}`);
		this.db.pragma("foreign_keys = ON");
		this.db.pragma(`busy_timeout = ${WIKI_BUSY_TIMEOUT_MS}`);

		// 4) schema 初始化(幂等,IF NOT EXISTS)。
		initWikiSchema(this.db);

		// 5) bootstrap 固定根(幂等)。
		this.bootstrapFixedRoots();

		log.db("wiki_database_opened", {
			path,
			journalMode,
			schemaVersion: readWikiSchemaVersion(this.db),
		});
	}

	/** 底层 better-sqlite3 句柄(repository 通过此访问)。 */
	getDb(): Database.Database {
		if (this._closed) {
			throw new Error(`WikiDatabase.getDb() called after close() (path=${this._path})`);
		}
		return this.db;
	}

	/** 数据库文件路径。 */
	get path(): string {
		return this._path;
	}

	/** schema 版本(= WIKI_SCHEMA_VERSION on fresh init)。 */
	schemaVersion(): number {
		return readWikiSchemaVersion(this.db);
	}

	/**
	 * 显式 transaction 包装器(better-sqlite3 同步 transaction)。
	 * repository 的多表写入(节点 + FTS + audit)必须在同一 transaction 内。
	 *
	 * 用法:
	 *   wikiDb.transaction(() => { ... }); // 自动 BEGIN/COMMIT/ROLLBACK
	 */
	transaction<T>(fn: () => T): T {
		if (this._closed) {
			throw new Error(`WikiDatabase.transaction() called after close() (path=${this._path})`);
		}
		return this.db.transaction(fn)();
	}

	/**
	 * integrity_check 结果(只读 PRAGMA)。"ok" 表示通过。
	 */
	integrityCheck(): "ok" | string {
		const res = this.db.pragma("integrity_check") as Array<{ integrity_check?: string }>;
		if (Array.isArray(res) && res.length === 1 && res[0]?.integrity_check === "ok") {
			return "ok";
		}
		return JSON.stringify(res);
	}

	/**
	 * foreign_key_check 结果(只读 PRAGMA)。"ok" 表示无违反。
	 */
	foreignKeyCheck(): "ok" | string {
		const res = this.db.pragma("foreign_key_check") as unknown[];
		return Array.isArray(res) && res.length === 0 ? "ok" : JSON.stringify(res);
	}

	/**
	 * 健康状态汇总。所有 PRAGMA 只读,不写、不 checkpoint。
	 */
	health(): WikiDatabaseHealth {
		let writable = true;
		let journalMode = "unknown";
		let integrity: string | string[] = "ok";
		let foreignKeys: string | string[] = "ok";
		try {
			journalMode =
				(this.db.pragma("journal_mode") as Array<{ journal_mode?: string }>)[0]?.journal_mode
				?? "unknown";
			integrity = this.db.pragma("integrity_check") as any;
			foreignKeys = this.db.pragma("foreign_key_check") as any;
		} catch (err) {
			integrity = `error: ${(err as Error).message}`;
			writable = false;
		}
		return {
			exists: existsSync(this._path),
			writable,
			integrity:
				Array.isArray(integrity) && integrity.length === 1
					&& (integrity[0] as any)?.integrity_check === "ok"
					? "ok"
					: (typeof integrity === "string" ? integrity : JSON.stringify(integrity)),
			foreignKeys:
				Array.isArray(foreignKeys) && foreignKeys.length === 0
					? "ok"
					: (typeof foreignKeys === "string" ? foreignKeys : JSON.stringify(foreignKeys)),
			journalMode,
			schemaVersion: readWikiSchemaVersion(this.db),
		};
	}

	/**
	 * WAL checkpoint(TRUNCATE)。仅在 DatabaseManager 调用,此时本进程是
	 * wiki.db 的活跃所有者 —— checkpoint 安全(参考 memory feedback-sessions-
	 * db-readonly 的「受许可的维护路径」语义)。
	 */
	checkpoint(): void {
		if (this._closed) {
			throw new Error(`WikiDatabase.checkpoint() called after close() (path=${this._path})`);
		}
		this.db.pragma("wal_checkpoint(TRUNCATE)");
	}

	/**
	 * 关闭数据库。幂等(重复 close no-op)。
	 */
	close(): void {
		if (this._closed) return;
		try {
			this.db.close();
		} catch (err) {
			log.warn("db", `WikiDatabase.close failed (path=${this._path}):`, (err as Error).message);
		}
		this._closed = true;
	}

	// -----------------------------------------------------------------------
	// Fixed-root bootstrap（plan-01 §5）
	// -----------------------------------------------------------------------

	/**
	 * 幂等创建 4 个固定根节点:wiki-root + knowledge/memory/projects。
	 *
	 * 幂等保证(plan-01 §5 / acceptance-01 §A「连续初始化两次不报错、不重复 root、
	 * 不改变 root revision/created_at」）:
	 *   - 已存在(按 path,active)→ 完全 no-op(不 UPDATE summary/kind/created_at/revision)。
	 *   - 不存在 → INSERT(kind/summary 固定;created_at = updated_at = now)。
	 *
	 * parent_id 解析:每个非根节点的 parent_id 由 path → parent path → 查库得。
	 * 顺序保证:wiki-root 先建,knowledge/memory/projects 后建(它们的 parent 是 root)。
	 *
	 * 在显式 transaction 内执行,保证 4 行原子写入。
	 */
	private bootstrapFixedRoots(): void {
		this.db.transaction(() => {
			for (const spec of FIXED_ROOT_SPECS) {
				// 按 path + active 查现有行(归档行不影响 active partial unique index)。
				const existing = this.db
					.prepare(
						`SELECT id FROM wiki_nodes
						 WHERE path = ? AND archived_at IS NULL
						 LIMIT 1`,
					)
					.get(spec.path) as { id: number } | undefined;
				if (existing) continue; // 幂等:已存在则不动 created_at/revision/summary

				// 解析 parent_id(根无 parent)。
				let parentId: number | null = null;
				if (spec.path !== WIKI_ROOT_PATH) {
					const slashIdx = spec.path.lastIndexOf("/");
					const parentPath = slashIdx >= 0 ? spec.path.slice(0, slashIdx) : null;
					if (parentPath !== null) {
						const parent = this.db
							.prepare(
								`SELECT id FROM wiki_nodes
								 WHERE path = ? AND archived_at IS NULL
								 LIMIT 1`,
							)
							.get(parentPath) as { id: number } | undefined;
						if (!parent) {
							// 理论上 FIXED_ROOT_SPECS 顺序保证 wiki-root 先建;
							// 若顺序被破坏,这里显式报错(不静默跳过)。
							throw new Error(
								`WikiDatabase bootstrap: parent missing for ${spec.path} (parent=${parentPath}). `
								+ `FIXED_ROOT_SPECS must list parents before children.`,
							);
						}
						parentId = parent.id;
					}
				}

				const now = new Date().toISOString();
				const name = spec.path.lastIndexOf("/") >= 0
					? spec.path.slice(spec.path.lastIndexOf("/") + 1)
					: spec.path;
				this.db
					.prepare(
						`INSERT INTO wiki_nodes
						   (id, parent_id, name, path, kind, summary, content,
						    attributes_json, revision, created_at, updated_at, archived_at)
						 VALUES (NULL, ?, ?, ?, ?, ?, '', NULL, 1, ?, ?, NULL)`,
					)
					.run(parentId, name, spec.path, spec.kind, spec.summary, now, now);
			}
		})();
	}
}

/**
 * Schema 版本常量(从 wiki-schema 重新导出,便于外部断言闭集)。
 */
export { WIKI_SCHEMA_VERSION } from "./wiki-schema.js";
