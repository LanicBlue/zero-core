// 项目 Wiki 存储管理 (v0.8 M2 兼容层)
//
// # 文件说明书
//
// ## 核心功能
// ProjectWikiStore 是 WikiStore(全局记忆树)的**向后兼容视图**。它把全局树
// 中的 project 子树投影成旧 `ProjectWikiNode` 形状(nodeType / path / detail /
// sourceReqId 等),供现有 renderer (WikiTree.tsx / WikiDetail.tsx)、IPC handlers
// (wiki-handlers.ts)、project-wiki-router.ts 消费。
//
// 全部数据物理上落在 `project_wiki` 表(由 WikiStore 管理);本类不再持有
// 自己的 SqliteStore,而是把每个旧 API 委托给 WikiStore 的等价方法。
//
// ## 输入
// - SessionDB 实例
// - WikiStore(主存储,通过 deps 注入或自动构造)
//
// ## 输出
// - ProjectWikiNode CRUD(旧形状)
//
// ## 定位
// 服务层兼容视图,被 renderer-facing 路由/IPC/LeadService/AnalystService 使用。
// 新代码(archivist-service、wiki 工具)直接用 WikiStore。
//
// ## 依赖
// - ./wiki-node-store - 全局 wiki 树主存储
// - ./sqlite-store - 通用存储(仅供 list filter 兼容)
// - ../shared/types - ProjectWikiNode / WikiNode
//
// ## 维护规则
// - 字段映射改动需同步 WikiTree.tsx / WikiDetail.tsx / wiki-handlers.ts
// - 全局树 schema 变更先动 WikiStore + db-migration.ts,这里只跟投影
//

import type { SessionDB } from "./session-db.js";
import { WikiStore } from "./wiki-node-store.js";
import type { ProjectWikiNode, WikiNode, WikiNodeType } from "../shared/types.js";

// ---------------------------------------------------------------------------
// ProjectWikiStore — back-compat view over WikiStore
// ---------------------------------------------------------------------------

// tool-decoupling(决策 1):process-wide 单例 getter/setter。这是 WikiStore 的
// "project 视图"(ProjectWikiStore,back-compat 层)。启动时注册;工具 import
// { getProjectWikiStore } 直读。headless 无则 undefined。注意:全局 WikiStore
// 用 getWikiStoreGlobal()(见 wiki-node-store.ts);两个单例不同。
let _projectWikiStore: ProjectWikiStore | undefined;
export function getProjectWikiStore(): ProjectWikiStore | undefined {
	return _projectWikiStore;
}
export function setProjectWikiStore(s: ProjectWikiStore | undefined): void {
	_projectWikiStore = s;
}

export class ProjectWikiStore {
	private wiki: WikiStore;

	/**
	 * Back-compat constructor: called as `new ProjectWikiStore(sessionDB)`.
	 * Builds its own WikiStore internally.
	 */
	constructor(sessionDBOrWiki: SessionDB | WikiStore) {
		if (sessionDBOrWiki instanceof WikiStore) {
			this.wiki = sessionDBOrWiki;
		} else {
			this.wiki = new WikiStore(sessionDBOrWiki as SessionDB);
		}
	}

	/** Expose the underlying global WikiStore (new code should use this). */
	getWikiStore(): WikiStore {
		return this.wiki;
	}

	list(filter?: { projectId?: string; parentId?: string; nodeType?: string }): ProjectWikiNode[] {
		let nodes: WikiNode[];
		if (filter?.projectId) {
			nodes = this.wiki.listByProject(filter.projectId);
		} else {
			nodes = this.wiki.list();
		}
		let result = nodes.map((n) => projectView(n));
		if (filter?.parentId !== undefined) {
			result = result.filter((n) => (n.parentId ?? undefined) === (filter.parentId ?? undefined));
		}
		if (filter?.nodeType) {
			result = result.filter((n) => n.nodeType === filter.nodeType);
		}
		return result;
	}

	get(id: string): ProjectWikiNode | undefined {
		const node = this.wiki.get(id);
		return node ? projectView(node) : undefined;
	}

	getByPath(projectId: string, path: string): ProjectWikiNode | undefined {
		const node = this.wiki.getByProjectPath(projectId, path);
		return node ? projectView(node) : undefined;
	}

	listByProject(projectId: string): ProjectWikiNode[] {
		// Ensure the subtree root exists so project-wiki-router / analyst
		// service's "already has wiki data?" check is well-defined.
		this.wiki.ensureProjectSubtree(projectId);
		return this.wiki.listByProject(projectId).map(projectView);
	}

	getChildren(parentId: string): ProjectWikiNode[] {
		return this.wiki.getChildren(parentId).map(projectView);
	}

	getTopLevelNodes(projectId: string): ProjectWikiNode[] {
		const root = this.wiki.get(`wiki-root:${projectId}`);
		if (!root) return [];
		return this.wiki.getChildren(root.id).map(projectView);
	}

	getNodesByPaths(projectId: string, paths: string[]): ProjectWikiNode[] {
		const pathSet = new Set(paths);
		return this.wiki
			.listByProject(projectId)
			.filter((n) => pathSet.has(n.path))
			.map(projectView);
	}

	create(input: Omit<ProjectWikiNode, "id" | "createdAt" | "updatedAt">): ProjectWikiNode {
		// Ensure the project subtree root exists.
		if (input.projectId) {
			this.wiki.ensureProjectSubtree(input.projectId);
		}
		// Resolve parent: default to the project subtree root when not given.
		const parentId =
			input.parentId ?? (input.projectId ? `wiki-root:${input.projectId}` : undefined);
		const type = legacyTypeToGlobal(input.nodeType);
		const created = this.wiki.create({
			parentId,
			type,
			path: input.path,
			title: input.title,
			summary: input.summary,
			detail: input.detail,
			projectId: input.projectId,
			lastUpdatedBy: input.lastUpdatedBy ?? "agent",
			sourceReqId: input.sourceReqId,
		});
		return projectView(created)!;
	}

	update(id: string, input: Partial<Omit<ProjectWikiNode, "id" | "createdAt">>): ProjectWikiNode {
		const patch: Partial<WikiNode> = {};
		if (input.title !== undefined) patch.title = input.title;
		if (input.summary !== undefined) patch.summary = input.summary;
		if (input.detail !== undefined) patch.detail = input.detail;
		if (input.nodeType !== undefined) patch.type = legacyTypeToGlobal(input.nodeType);
		if (input.parentId !== undefined) patch.parentId = input.parentId;
		if (input.lastUpdatedBy !== undefined) patch.lastUpdatedBy = input.lastUpdatedBy;
		if (input.sourceReqId !== undefined) {
			patch.requirementIds = input.sourceReqId ? [input.sourceReqId] : [];
			patch.sourceReqId = input.sourceReqId;
		}
		const updated = this.wiki.update(id, patch);
		return projectView(updated)!;
	}

	/** Delete a node and all its children recursively */
	delete(id: string): void {
		this.wiki.delete(id);
	}

	/** Delete all wiki nodes for a project */
	deleteByProject(projectId: string): void {
		this.wiki.deleteByProject(projectId);
	}
}

// ---------------------------------------------------------------------------
// View projection — WikiNode (global tree) → ProjectWikiNode (legacy shape)
// ---------------------------------------------------------------------------

function projectView(node: WikiNode): ProjectWikiNode {
	return {
		id: node.id,
		projectId: node.projectId ?? "",
		parentId: node.parentId,
		nodeType: globalTypeToLegacy(node.type),
		path: node.path,
		title: node.title,
		summary: node.summary,
		detail: node.detail,
		lastUpdatedBy: (node.lastUpdatedBy === "user" ? "user" : "agent"),
		sourceReqId: node.sourceReqId ?? node.requirementIds?.[0],
		createdAt: node.createdAt,
		updatedAt: node.updatedAt,
	};
}

function globalTypeToLegacy(type: string): WikiNodeType {
	switch (type) {
		case "header":
			return "file";
		case "intent":
			return "file";
		case "structure":
		case "project":
			return "directory";
		case "memory":
			return "section";
		default:
			return "section";
	}
}

function legacyTypeToGlobal(nodeType: string): WikiNode["type"] {
	switch (nodeType) {
		case "file":
		case "function":
		case "class":
			return "header";
		case "directory":
			return "structure";
		case "section":
			return "structure";
		default:
			return "structure";
	}
}
