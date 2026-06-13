// 项目 Wiki 存储管理
//
// # 文件说明书
//
// ## 核心功能
// ProjectWiki 数据持久化，基于 SqliteStore 的 CRUD 操作。
//
// ## 输入
// - SessionDB 实例
// - Wiki 节点数据
//
// ## 输出
// - ProjectWikiNode CRUD
//
// ## 定位
// 服务层存储，被 project-wiki-router 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
//
// ## 维护规则
// - 新增字段时需更新列定义
//
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { ProjectWikiNode } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
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

// ---------------------------------------------------------------------------
// ProjectWikiStore
// ---------------------------------------------------------------------------

export class ProjectWikiStore {
	private store: SqliteStore<ProjectWikiNode>;
	private db: import("better-sqlite3").Database;

	constructor(sessionDB: SessionDB) {
		this.db = sessionDB.getDb();
		this.store = new SqliteStore<ProjectWikiNode>(this.db, "project_wiki", COLUMNS);
	}

	list(filter?: { projectId?: string; parentId?: string; nodeType?: string }): ProjectWikiNode[] {
		let result = this.store.list();
		if (filter?.projectId) {
			result = result.filter((n) => n.projectId === filter.projectId);
		}
		if (filter?.parentId !== undefined) {
			result = result.filter((n) => n.parentId === filter.parentId);
		}
		if (filter?.nodeType) {
			result = result.filter((n) => n.nodeType === filter.nodeType);
		}
		return result;
	}

	get(id: string): ProjectWikiNode | undefined {
		return this.store.get(id);
	}

	getByPath(projectId: string, path: string): ProjectWikiNode | undefined {
		return this.store.list().find((n) => n.projectId === projectId && n.path === path);
	}

	listByProject(projectId: string): ProjectWikiNode[] {
		return this.store.list().filter((n) => n.projectId === projectId);
	}

	getChildren(parentId: string): ProjectWikiNode[] {
		return this.store.list().filter((n) => n.parentId === parentId);
	}

	getTopLevelNodes(projectId: string): ProjectWikiNode[] {
		return this.store.list().filter((n) => n.projectId === projectId && !n.parentId);
	}

	getNodesByPaths(projectId: string, paths: string[]): ProjectWikiNode[] {
		const pathSet = new Set(paths);
		return this.store.list().filter((n) => n.projectId === projectId && pathSet.has(n.path));
	}

	create(input: Omit<ProjectWikiNode, "id" | "createdAt" | "updatedAt">): ProjectWikiNode {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<ProjectWikiNode, "id" | "createdAt">>): ProjectWikiNode {
		return this.store.update(id, input as any);
	}

	/** Delete a node and all its children recursively */
	delete(id: string): void {
		const children = this.getChildren(id);
		for (const child of children) {
			this.delete(child.id);
		}
		this.store.delete(id);
	}

	/** Delete all wiki nodes for a project */
	deleteByProject(projectId: string): void {
		const nodes = this.listByProject(projectId);
		for (const node of nodes) {
			this.store.delete(node.id);
		}
	}
}
