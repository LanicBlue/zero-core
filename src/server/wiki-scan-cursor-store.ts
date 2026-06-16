// Wiki 扫描游标存储 (v0.8 M2)
//
// # 文件说明书
//
// ## 核心功能
// 按 (archivist, project) 维度记录 archivist 扫描 main 分支的 git 游标
// `lastScannedRef`(主分支 commit sha)。archivist 全局化后,游标不能挂在 agent
// 上(RFC §2.13 / §4.2)。下次扫描跑 `git log/diff <last>..main`,只重读变化;
// feature 分支 WIP 不进 wiki(决策 19/26)。
//
// ## 输入
// - SessionDB 实例
// - (archivistId, projectId) 复合键
//
// ## 输出
// - WikiScanCursor CRUD
//
// ## 定位
// 服务层存储,被 archivist-service 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
//
// ## 维护规则
// - 新增字段时同步 db-migration.ts WIKI_SCAN_CURSOR_COLUMNS
//

import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiScanCursor {
	id: string;
	archivistId: string;
	projectId: string;
	lastScannedRef?: string;
	lastFullScanAt?: string;
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Column definitions — MUST stay in sync with db-migration.ts WIKI_SCAN_CURSOR_COLUMNS
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "archivistId", column: "archivist_id" },
	{ key: "projectId", column: "project_id" },
	{ key: "lastScannedRef", column: "last_scanned_ref" },
	{ key: "lastFullScanAt", column: "last_full_scan_at" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// WikiScanCursorStore
// ---------------------------------------------------------------------------

export class WikiScanCursorStore {
	private store: SqliteStore<WikiScanCursor>;

	constructor(sessionDB: SessionDB) {
		this.store = new SqliteStore<WikiScanCursor>(
			sessionDB.getDb(),
			"wiki_scan_cursors",
			COLUMNS,
		);
	}

	/** Find the cursor for a (archivist, project) pair. */
	get(archivistId: string, projectId: string): WikiScanCursor | undefined {
		return this.store
			.list()
			.find((c) => c.archivistId === archivistId && c.projectId === projectId);
	}

	/**
	 * Upsert the cursor. Creates if missing; updates otherwise. (archivistId,
	 * projectId) is the logical key.
	 */
	setLastScannedRef(
		archivistId: string,
		projectId: string,
		lastScannedRef: string,
	): WikiScanCursor {
		const existing = this.get(archivistId, projectId);
		if (existing) {
			return this.store.update(existing.id, { lastScannedRef });
		}
		return this.store.create({ archivistId, projectId, lastScannedRef });
	}

	/** Mark the timestamp of the last full rescan (drift backstop). */
	setLastFullScanAt(archivistId: string, projectId: string, at: string): void {
		const existing = this.get(archivistId, projectId);
		if (existing) {
			this.store.update(existing.id, { lastFullScanAt: at });
		} else {
			this.store.create({ archivistId, projectId, lastFullScanAt: at });
		}
	}

	/** Delete the cursor for a (archivist, project) pair. */
	delete(archivistId: string, projectId: string): void {
		const existing = this.get(archivistId, projectId);
		if (existing) this.store.delete(existing.id);
	}
}
