// 全局 Wiki 记忆树存储 (v0.8 M2)
//
// # 文件说明书
//
// ## 核心功能
// 全局唯一 Wiki 记忆树的物理存储 + 查询。这棵树是 zero-core 全部知识/记忆
// 的载体(RFC §2.19):project 子树挂在 `project` 节点下;memory 节点(M5 提取者
// A 写)挂全局类型节点下,不绑 project。
//
// 物理上复用 `project_wiki` 表(同一行集),但语义已重构:每一行是一个
// WikiNode —— type ∈ header | intent | structure | project | memory;
// 叶子带 `docPointer` 指向实际文档;结构断言带 provenance;traceability 带
// requirementIds。ProjectWikiStore 作为兼容视图继续暴露旧 API 给 renderer
// 与现有 IPC,内部委托到本类。
//
// ## 输入
// - SessionDB 实例
// - WikiNode 数据
//
// ## 输出
// - WikiNode CRUD
// - 按 session 上下文 wikiRootNodeId 截断查询(决策 38)
// - project 子树初始化 / 全局根初始化
//
// ## 定位
// 服务层存储,被 ProjectWikiStore(兼容层)、archivist-service、wiki 工具使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
// - ../shared/types - WikiNode
//
// ## 维护规则
// - 新增字段时同步 db-migration.ts PROJECT_WIKI_COLUMNS 与下方 COLUMNS
// - 视角隔离在 store 层强制,不靠 agent 自觉(决策 38)
// - archivist 写入 scope = 自己 project 子树;提取者 A 写全局 memory 节点
//

import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { WikiNode, WikiNodeTypeGlobal } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions — MUST stay in sync with db-migration.ts PROJECT_WIKI_COLUMNS
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "parentId", column: "parent_id" },
	{ key: "type" },
	{ key: "path" },
	{ key: "title" },
	{ key: "summary" },
	{ key: "detail" },
	{ key: "docPointer", column: "doc_pointer" },
	{ key: "provenance" },
	{ key: "requirementIds", column: "requirement_ids", json: true },
	{ key: "projectId", column: "project_id" },
	{ key: "relations", json: true },
	// v0.8 (P0 §3.3 / §10.1): undirected sibling links (nodeId array). NULL
	// coalesces to [] on read (see rowToWikiNode). type/detail stay in this
	// phase — P1 moves detail to disk.
	{ key: "links", json: true },
	{ key: "flags", json: true },
	{ key: "lastUpdatedBy", column: "last_updated_by" },
	{ key: "sourceReqId", column: "source_req_id" },
	// Legacy: kept so the back-compat ProjectWikiStore view can read it.
	{ key: "nodeType", column: "node_type" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// Constants — synthetic root ids
// ---------------------------------------------------------------------------

/**
 * The single global root of the wiki memory tree. It is synthetic — never
 * written by archivist; only its children (project subtree roots + global
 * memory type nodes) are real. Used as the wikiRootNodeId for global-scope
 * sessions (zero, observation cron).
 */
export const WIKI_GLOBAL_ROOT_ID = "wiki-root:global";

/**
 * Stable path prefix scheme (also used as path-internal scope key):
 *   project subtree root → "project:<projectId>"
 *   header leaf          → "header:<relPath>"
 *   intent leaf          → "intent:<relPath>"
 *   structure node       → "structure:<relPath>"
 *   memory node          → "memory:<type>/<subject>"
 */
export function projectSubtreeRootPath(projectId: string): string {
	return `project:${projectId}`;
}

/**
 * Stable wikiRootNodeId for a project's subtree root (the value the session
 * context bundle carries for project-role sessions). This is the ID of the
 * `project` node — created lazily by ensureProjectSubtree().
 */
export function projectSubtreeRootId(projectId: string): string {
	return `wiki-root:${projectId}`;
}

/**
 * v0.8 (M5): stable synthetic id of one of the five global memory-type
 * roots (RFC §2.16 N2 / decision 46). Memory leaves written by extractor A
 * hang under their matching type root. These ids are shared with
 * extractor-a-service so it can look up the parent before upserting a leaf.
 */
export type MemoryFactType =
	| "event" | "decision" | "discovery" | "status_change" | "preference";

export function memoryTypeRootId(type: MemoryFactType): string {
	return `wiki-root:memory:${type}`;
}

// ---------------------------------------------------------------------------
// WikiStore — the single global wiki memory tree
// ---------------------------------------------------------------------------

export class WikiStore {
	private store: SqliteStore<WikiNode & { nodeType?: string }>;
	private db: import("better-sqlite3").Database;
	private _insertWithIdStmt?: import("better-sqlite3").Statement;

	constructor(sessionDB: SessionDB) {
		this.db = sessionDB.getDb();
		this.store = new SqliteStore<WikiNode & { nodeType?: string }>(
			this.db,
			"project_wiki",
			COLUMNS,
		);
		this.ensureGlobalRoot();
	}

	/**
	 * INSERT a row carrying an explicit caller-chosen id (synthetic roots
	 * like WIKI_GLOBAL_ROOT_ID / projectSubtreeRootId). SqliteStore.create
	 * mints a fresh uuid, which we don't want for fixed-id roots.
	 */
	private insertWithId(record: WikiNode & { nodeType?: string }): void {
		if (!this._insertWithIdStmt) {
			// Column list kept in sync manually with COLUMNS above (the
			// backing SqliteStore keeps allColumns private, so we redeclare).
			const cols = [
				"id",
				"parent_id",
				"type",
				"path",
				"title",
				"summary",
				"detail",
				"doc_pointer",
				"provenance",
				"requirement_ids",
				"project_id",
				"relations",
				"links",
				"flags",
				"last_updated_by",
				"source_req_id",
				"node_type",
				"created_at",
				"updated_at",
			];
			const placeholders = cols.map(() => "?").join(", ");
			this._insertWithIdStmt = this.db.prepare(
				`INSERT INTO project_wiki (${cols.join(", ")}) VALUES (${placeholders})`,
			);
		}
		const now = record.createdAt || new Date().toISOString();
		const updatedAt = record.updatedAt || now;
		const vals = [
			record.id,
			record.parentId ?? null,
			record.type ?? null,
			record.path,
			record.title,
			record.summary ?? null,
			record.detail ?? null,
			record.docPointer ?? null,
			record.provenance ?? null,
			record.requirementIds ? JSON.stringify(record.requirementIds) : null,
			record.projectId ?? null,
			record.relations ? JSON.stringify(record.relations) : null,
			// v0.8 (P0 §3.3): links stored as JSON array; empty/undefined → null
			// (rowToWikiNode coalesces back to []).
			record.links && record.links.length > 0 ? JSON.stringify(record.links) : null,
			record.flags ? JSON.stringify(record.flags) : null,
			record.lastUpdatedBy ?? null,
			record.sourceReqId ?? null,
			(record as any).nodeType ?? null,
			now,
			updatedAt,
		];
		this._insertWithIdStmt.run(...vals);
	}

	// ─── Low-level CRUD ─────────────────────────────────────────────

	list(): WikiNode[] {
		return this.store.list().map(rowToWikiNode);
	}

	get(id: string): WikiNode | undefined {
		const row = this.store.get(id);
		return row ? rowToWikiNode(row) : undefined;
	}

	/**
	 * Find a node by (parentId, path). Used as the upsert key within a parent
	 * scope — e.g. archivist upserts a header node at
	 * (parent=project subtree root, path="header:src/foo.ts").
	 */
	getByParentAndPath(parentId: string | undefined, path: string): WikiNode | undefined {
		return this.store
			.list()
			.find((n) => (n.parentId ?? undefined) === (parentId ?? undefined) && n.path === path);
	}

	/**
	 * Find a project subtree node by legacy "path" string (renderer + old
	 * IPC use this). The renderer's path is the raw node.path; we scope to
	 * the project subtree for safety.
	 */
	getByProjectPath(projectId: string, path: string): WikiNode | undefined {
		const subtreeRoot = this.get(projectSubtreeRootId(projectId));
		if (!subtreeRoot) return undefined;
		// Exact match anywhere in this project subtree.
		const ids = this.collectSubtreeIds(subtreeRoot.id);
		return this.store.list().find((n) => ids.has(n.id) && n.path === path);
	}

	create(input: Omit<WikiNode, "id" | "createdAt" | "updatedAt">): WikiNode {
		const created = this.store.create(input as any);
		return rowToWikiNode(created)!;
	}

	update(id: string, input: Partial<Omit<WikiNode, "id" | "createdAt">>): WikiNode {
		return rowToWikiNode(this.store.update(id, input as any))!;
	}

	delete(id: string): void {
		// Cascade-delete children (recursive).
		const children = this.getChildren(id);
		for (const child of children) {
			this.delete(child.id);
		}
		this.store.delete(id);
	}

	getChildren(parentId: string): WikiNode[] {
		return this.store.list().filter((n) => n.parentId === parentId).map(rowToWikiNode);
	}

	// ─── Project subtree management ─────────────────────────────────

	/**
	 * Ensure the synthetic global root exists (id = WIKI_GLOBAL_ROOT_ID).
	 * Idempotent; called once at construction.
	 */
	private ensureGlobalRoot(): void {
		const existing = this.store.get(WIKI_GLOBAL_ROOT_ID);
		if (existing) return;
		const now = new Date().toISOString();
		this.insertWithId({
			id: WIKI_GLOBAL_ROOT_ID,
			parentId: undefined,
			type: "project" as WikiNodeTypeGlobal,
			// Legacy discriminator — pre-M2 schema has NOT NULL on node_type.
			nodeType: "directory",
			path: "global-root",
			title: "Global Wiki Memory Root",
			summary: "Single global wiki memory tree root (RFC §2.19).",
			lastUpdatedBy: "system",
			createdAt: now,
			updatedAt: now,
		} as any);
	}

	/**
	 * Ensure the `project` subtree root node exists for a given project.
	 * Idempotent. Returns the project-subtree root node. The node's id is
	 * `wiki-root:<projectId>` — the value the session context bundle carries
	 * as wikiRootNodeId for project-role sessions.
	 */
	ensureProjectSubtree(projectId: string, projectName?: string): WikiNode {
		const id = projectSubtreeRootId(projectId);
		const existing = this.store.get(id);
		if (existing) return rowToWikiNode(existing)!;

		const now = new Date().toISOString();
		this.insertWithId({
			id,
			parentId: WIKI_GLOBAL_ROOT_ID,
			type: "project" as WikiNodeTypeGlobal,
			nodeType: "directory",
			path: projectSubtreeRootPath(projectId),
			title: `Project: ${projectName ?? projectId}`,
			summary: `Wiki subtree root for project ${projectId}.`,
			projectId,
			lastUpdatedBy: "archivist",
			createdAt: now,
			updatedAt: now,
		} as any);
		return this.get(id)!;
	}

	/** Delete the entire subtree for a project (cascade). */
	deleteByProject(projectId: string): void {
		const root = this.get(projectSubtreeRootId(projectId));
		if (root) this.delete(root.id);
	}

	/** All nodes in a project subtree (including its root). */
	listByProject(projectId: string): WikiNode[] {
		const root = this.get(projectSubtreeRootId(projectId));
		if (!root) return [];
		const ids = this.collectSubtreeIds(root.id);
		return this.store.list().filter((n) => ids.has(n.id)).map(rowToWikiNode);
	}

	// ─── View-truncated queries (decision 38 — store-layer isolation) ──

	/**
	 * List all wiki nodes *visible* from a given wikiRootNodeId.
	 *
	 * This is the store-layer enforcement of the view isolation (RFC §2.19,
	 * decision 38): a project-role session whose wikiRootNodeId = its project
	 * subtree root can ONLY see that subtree — never sibling project subtrees,
	 * never the global root, never the global memory type nodes above it.
	 *
	 * A global session (wikiRootNodeId = WIKI_GLOBAL_ROOT_ID) sees everything.
	 */
	listVisibleFromRoot(wikiRootNodeId: string): WikiNode[] {
		// Special case: global root → whole tree.
		if (wikiRootNodeId === WIKI_GLOBAL_ROOT_ID) {
			return this.list();
		}
		const root = this.get(wikiRootNodeId);
		if (!root) return [];
		const ids = this.collectSubtreeIds(root.id);
		return this.store.list().filter((n) => ids.has(n.id)).map(rowToWikiNode);
	}

	/**
	 * Read a single node, but only if it is *visible* from the given view
	 * root. Returns undefined if the node is outside the viewer's subtree
	 * (i.e. structurally invisible), even if it exists in the tree.
	 */
	getVisible(wikiRootNodeId: string, nodeId: string): WikiNode | undefined {
		const visible = this.listVisibleFromRoot(wikiRootNodeId);
		return visible.find((n) => n.id === nodeId);
	}

	// ─── Write guards (decision 39 — store-layer scope enforcement) ──

	/**
	 * Assert that a node lives inside a specific project subtree. Used by
	 * archivist's wiki-write tools to enforce "only my project subtree" —
	 * the prompt self-restraint + tool-capability guard from RFC §2.16/OQ1.
	 *
	 * Throws if the node is outside the scope (so the writer fails loudly
	 * rather than silently writing across the boundary).
	 */
	assertNodeInsideProjectScope(projectId: string, nodeId: string): void {
		const root = this.get(projectSubtreeRootId(projectId));
		if (!root) {
			throw new Error(`Project subtree not initialized: ${projectId}`);
		}
		const ids = this.collectSubtreeIds(root.id);
		if (!ids.has(nodeId)) {
			throw new Error(
				`Node ${nodeId} is outside project ${projectId}'s wiki subtree ` +
					`(archivist write scope violation, RFC §2.16/OQ2).`,
			);
		}
	}

	/**
	 * Upsert a node inside a project subtree (archivist's write primitive).
	 * Enforces: target parent MUST already live in the project subtree, and
	 * the node's type must be a project-subtree structure type
	 * (header | intent | structure). Memory nodes (M5) go via createMemoryNode.
	 */
	upsertProjectNode(
		projectId: string,
		input: {
			parentId: string;
			type: "header" | "intent" | "structure";
			path: string;
			title: string;
			summary?: string;
			detail?: string;
			docPointer?: string;
			provenance?: "structure" | "derived" | "confirmed";
			requirementIds?: string[];
			relations?: Array<{ kind: string; targetId: string }>;
			flags?: string[];
			lastUpdatedBy?: string;
		},
	): WikiNode {
		// Enforce parent is inside this project subtree.
		this.assertNodeInsideProjectScope(projectId, input.parentId);

		// Type is constrained by the input signature to header | intent |
		// structure. memory nodes belong to extractor A (M5); project subtree
		// roots are minted by ensureProjectSubtree — both routes never go
		// through here. (The check is structurally enforced by the type; no
		// runtime re-check needed.)

		const existing = this.getByParentAndPath(input.parentId, input.path);
		if (existing) {
			return this.update(existing.id, {
				...input,
				projectId,
				lastUpdatedBy: input.lastUpdatedBy ?? "archivist",
			});
		}
		return this.create({
			...input,
			projectId,
			lastUpdatedBy: input.lastUpdatedBy ?? "archivist",
		});
	}

	/**
	 * Append a flag to a node (archivist divergence signal, RFC §2.16).
	 * Enforces project-scope membership.
	 */
	addFlag(projectId: string, nodeId: string, flag: string): void {
		this.assertNodeInsideProjectScope(projectId, nodeId);
		const node = this.get(nodeId);
		if (!node) return;
		const flags = new Set(node.flags ?? []);
		flags.add(flag);
		this.update(nodeId, { flags: [...flags], lastUpdatedBy: "archivist" });
	}

	/** Clear all flags from a node. */
	clearFlags(projectId: string, nodeId: string): void {
		this.assertNodeInsideProjectScope(projectId, nodeId);
		this.update(nodeId, { flags: [], lastUpdatedBy: "archivist" });
	}

	/**
	 * Create a global memory node (M5 extractor A writes here, NOT under any
	 * project subtree). Enforced: type = memory; parentId must NOT be inside
	 * any project subtree.
	 */
	createMemoryNode(input: {
		parentId: string;
		path: string;
		title: string;
		summary?: string;
		detail?: string;
		provenance?: "structure" | "derived" | "confirmed";
		lastUpdatedBy?: string;
	}): WikiNode {
		// Defensive: memory nodes must not live under a project subtree.
		for (const project of this.listProjects()) {
			const ids = this.collectSubtreeIds(projectSubtreeRootId(project));
			if (ids.has(input.parentId)) {
				throw new Error(
					`createMemoryNode refused: parent ${input.parentId} is inside project ${project}'s subtree; ` +
						`memory nodes must hang under a global type node (RFC §2.16 N2).`,
				);
			}
		}
		const existing = this.getByParentAndPath(input.parentId, input.path);
		if (existing) {
			return this.update(existing.id, {
				...input,
				type: "memory",
				lastUpdatedBy: input.lastUpdatedBy ?? "extractor-A",
			});
		}
		return this.create({
			...input,
			type: "memory",
			lastUpdatedBy: input.lastUpdatedBy ?? "extractor-A",
		});
	}

	/**
	 * v0.8 (M5): ensure one of the five global memory-type root nodes exists
	 * under WIKI_GLOBAL_ROOT_ID. Each (event/decision/discovery/status_change/
	 * preference) gets its own synthetic-id root; extractor A's memory leaves
	 * hang under the matching type root (RFC §2.16 N2, decision 46).
	 *
	 * Unlike createMemoryNode (which mints a uuid), this uses a stable
	 * synthetic id (wiki-root:memory:<type>) so it's idempotent across runs.
	 */
	ensureMemoryTypeRoot(type: "event" | "decision" | "discovery" | "status_change" | "preference"): WikiNode {
		const id = memoryTypeRootId(type);
		const existing = this.get(id);
		if (existing) return existing;
		const now = new Date().toISOString();
		const titles: Record<typeof type, string> = {
			event: "Memory: Events",
			decision: "Memory: Decisions",
			discovery: "Memory: Discoveries",
			status_change: "Memory: Status Changes",
			preference: "Memory: Preferences",
		};
		this.insertWithId({
			id,
			parentId: WIKI_GLOBAL_ROOT_ID,
			type: "memory",
			nodeType: "section",
			path: `memory-root:${type}`,
			title: titles[type],
			summary: `Global memory type root for ${type} facts (M5 extractor A).`,
			lastUpdatedBy: "extractor-A",
			createdAt: now,
			updatedAt: now,
		} as any);
		return this.get(id)!;
	}

	// ─── Project registry / helpers ─────────────────────────────────

	/** List all known project subtree root nodes. */
	listProjects(): string[] {
		return this.store
			.list()
			.filter((n) => n.type === "project" && n.projectId)
			.map((n) => n.projectId!) as string[];
	}

	// ─── Memory node queries (M5 — extractor A writes type=memory nodes) ──

	/**
	 * List all memory nodes in the global tree (any type). Used by recall +
	 * telemetry consumers to read cross-project memory written by extractor A.
	 *
	 * v0.8 (M5): the canonical location for content memory is now the wiki
	 * tree (decision 53); the legacy MemoryNodeStore is kept for back-compat
	 * reads of pre-M5 data.
	 */
	listMemoryNodes(): WikiNode[] {
		return this.store
			.list()
			.filter((n) => n.type === "memory")
			.map(rowToWikiNode);
	}

	/**
	 * Simple LIKE-based search over memory node title + summary + detail.
	 * Splits the query on whitespace and ANDs the terms. NOT FTS5 — extractor
	 * A's volume is small enough that a linear scan is fine for v1, and we
	 * avoid coupling memory nodes to a second FTS table.
	 *
	 * Sorts by updatedAt DESC (most-recently-evolved first). Excludes the
	 * five memory-type roots themselves (they have empty summaries).
	 */
	searchMemoryNodes(query: string, limit: number = 10): WikiNode[] {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return [];
		const typeRootIds = new Set([
			"wiki-root:memory:event",
			"wiki-root:memory:decision",
			"wiki-root:memory:discovery",
			"wiki-root:memory:status_change",
			"wiki-root:memory:preference",
		]);
		const matches = this.store.list().filter((n) => {
			if (n.type !== "memory") return false;
			if (typeRootIds.has(n.id)) return false; // skip type roots
			const hay = (
				(n.title ?? "") + " " + (n.summary ?? "") + " " + (n.detail ?? "")
			).toLowerCase();
			return terms.every(t => hay.includes(t));
		});
		matches.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
		return matches.slice(0, limit).map(rowToWikiNode);
	}

	/** Collect a node id and all its descendants. */
	private collectSubtreeIds(rootId: string): Set<string> {
		const out = new Set<string>([rootId]);
		const stack = [rootId];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			for (const child of this.store.list()) {
				if (child.parentId === cur && !out.has(child.id)) {
					out.add(child.id);
					stack.push(child.id);
				}
			}
		}
		return out;
	}
}

// ---------------------------------------------------------------------------
// Row ↔ WikiNode normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a stored row into a WikiNode. Back-compat rows from the legacy
 * `project_wiki` schema may have `type` empty (filled by older code as
 * `nodeType`); synthesize `type` from `nodeType` so the new API keeps working
 * on legacy data without a migration script (RFC decision 23).
 *
 * Returns WikiNode & { nodeType? } — the legacy `nodeType` is kept on the
 * row object so the back-compat ProjectWikiStore view round-trips it through
 * SqliteStore's update path without dropping the column value.
 */
function rowToWikiNode(row: any): WikiNode & { nodeType?: string } {
	const type: WikiNodeTypeGlobal = (row.type as WikiNodeTypeGlobal) ?? legacyTypeToGlobal(row.nodeType);
	return {
		id: row.id,
		parentId: row.parentId,
		type,
		path: row.path,
		title: row.title,
		summary: row.summary,
		detail: row.detail,
		docPointer: row.docPointer,
		provenance: row.provenance,
		requirementIds: row.requirementIds,
		projectId: row.projectId,
		relations: row.relations,
		// v0.8 (P0 §3.3): NULL/undefined → [] (avoid NULL parsing crash).
		links: Array.isArray(row.links) ? row.links : [],
		flags: row.flags,
		lastUpdatedBy: row.lastUpdatedBy,
		sourceReqId: row.sourceReqId,
		nodeType: row.nodeType,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Map the legacy `nodeType` discriminator ("directory"/"file"/...) to the new
 * global-tree `type`. Used for back-compat rows that predate M2. Forward
 * mapping lives in ProjectWikiStore's view projection.
 */
function legacyTypeToGlobal(nodeType?: string): WikiNodeTypeGlobal {
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
