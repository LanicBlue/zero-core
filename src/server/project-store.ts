// 项目存储
//
// # 文件说明书
//
// ## 核心功能
// Project 数据持久化，基于 SqliteStore 的 CRUD 操作。
// v0.8 (M0): Project slimmed to { id, name, workspaceDir, createdAt, updatedAt }.
//   workspaceDir 规范化 (path.resolve + fs.realpath.sync 归一),唯一约束,
//   创建后不可改 (换目录 = 新建 Project)。
//
// ## 输入
// - SessionDB 实例
// - Project 数据
//
// ## 输出
// - ProjectRecord CRUD
//
// ## 定位
// 服务层存储，被 project-router 和 IPC handlers 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
// - node:path / node:fs - workspaceDir 归一
//
// ## 维护规则
// - workspaceDir 是身份键之一(唯一约束),不可在 update 中变更
// - 新增字段时需同步 db-migration.ts 的 PROJECT_COLUMNS
//
import { resolve, normalize } from "node:path";
import { realpathSync } from "node:fs";
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { ProjectRecord } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions — must stay in sync with db-migration.ts PROJECT_COLUMNS
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "workspaceDir", column: "workspace_dir" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a workspace directory for storage: resolve relative to cwd,
 * collapse `.`/`..` and redundant separators, then realpath to absorb
 * symlinks / case differences. If the directory does not exist yet, fall
 * back to the resolved (non-realpath) path so creation can still proceed.
 *
 * v0.8 (M0): this is the identity-normalization that backs the unique
 * constraint and prevents split-brain Projects for the same workspace.
 */
function normalizeWorkspaceDir(dir: string): string {
	if (!dir || typeof dir !== "string") {
		throw new Error("workspaceDir is required");
	}
	const resolved = normalize(resolve(dir));
	try {
		return realpathSync(resolved);
	} catch {
		// Path doesn't exist yet (e.g. project created before workspace is
		// materialized). Use the resolved form so it normalizes once the
		// dir is created later.
		return resolved;
	}
}

// ---------------------------------------------------------------------------
// ProjectStore
// ---------------------------------------------------------------------------

export class ProjectStore {
	private store: SqliteStore<ProjectRecord>;

	constructor(sessionDB: SessionDB) {
		this.store = new SqliteStore<ProjectRecord>(sessionDB.getDb(), "projects", COLUMNS);
	}

	list(): ProjectRecord[] {
		return this.store.list();
	}

	get(id: string): ProjectRecord | undefined {
		return this.store.get(id);
	}

	/** Find a project by normalized workspaceDir (the uniqueness key). */
	getByWorkspaceDir(dir: string): ProjectRecord | undefined {
		const normalized = normalizeWorkspaceDir(dir);
		return this.store.list().find((p) => p.workspaceDir === normalized);
	}

	/**
	 * @deprecated v0.8 — use getByWorkspaceDir. Kept as an alias for callers
	 * that historically asked for "project by path".
	 */
	getByPath(dir: string): ProjectRecord | undefined {
		return this.getByWorkspaceDir(dir);
	}

	create(input: Omit<ProjectRecord, "id" | "createdAt" | "updatedAt">): ProjectRecord {
		const normalized = normalizeWorkspaceDir(input.workspaceDir);

		// Uniqueness guard — one workspaceDir can only bind one Project
		const existing = this.store.list().find((p) => p.workspaceDir === normalized);
		if (existing) {
			throw new Error(
				`workspaceDir already bound to Project "${existing.name}" (${existing.id}); ` +
				`a workspaceDir can only bind one Project (Q1, decision 5).`,
			);
		}

		return this.store.create({ ...input, workspaceDir: normalized } as any);
	}

	/**
	 * Update project metadata. workspaceDir is **immutable** after creation
	 * (Q1, decision 5); passing it here is a no-op (silently ignored) so
	 * legacy callers don't crash. To switch workspaces, create a new Project.
	 */
	update(id: string, input: Partial<Omit<ProjectRecord, "id" | "createdAt">>): ProjectRecord {
		// Strip workspaceDir from updates — immutable after creation.
		const { workspaceDir: _ignored, ...patched } = input as any;
		return this.store.update(id, patched as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}
