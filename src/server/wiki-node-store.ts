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
import { join, resolve, normalize, isAbsolute } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { ZERO_CORE_DIR } from "../core/config.js";

// ---------------------------------------------------------------------------
// Column definitions — MUST stay in sync with db-migration.ts PROJECT_WIKI_COLUMNS
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "parentId", column: "parent_id" },
	// v0.8 (P1 §10.1): `type` column DROPPED — position is now the type. Rows
	// are classified on read by deriveTypeFromPosition (project subtree →
	// project/header/intent/structure; global memory type roots + leaves →
	// memory; synthetic roots → project). Legacy `node_type` kept below for
	// back-compat rows.
	{ key: "path" },
	{ key: "title" },
	{ key: "summary" },
	// v0.8 (P1 §10.1): `detail` column DROPPED — wiki body content lives on
	// disk at `~/.zero-core/wiki/<area>/<safe-name>.md`. `docPointer` carries
	// that per-node body file path (code-internal locator; NOT exposed to
	// agents — they address by nodeId). detail read/write goes through
	// readNodeDetail / writeNodeDetail; list/get do NOT populate detail.
	{ key: "docPointer", column: "doc_pointer" },
	{ key: "provenance" },
	{ key: "requirementIds", column: "requirement_ids", json: true },
	{ key: "projectId", column: "project_id" },
	{ key: "relations", json: true },
	// v0.8 (P0 §3.3 / §10.1): undirected sibling links (nodeId array). NULL
	// coalesces to [] on read (see rowToWikiNode).
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
 * v0.8 (P6 §7.1 / §7.5): path constants for the fresh-DB seed knowledge
 * subtree. The seed writes:
 *   wiki-root:global / knowledge (KNOWLEDGE_ROOT_PATH_SEED)
 *                  └── software-dev (SOFTWARE_DEV_NODE_PATH_SEED)
 * Both are protected (cannot be deleted — see assertNotProtected).
 */
export const KNOWLEDGE_ROOT_PATH_SEED = "knowledge";
export const SOFTWARE_DEV_NODE_PATH_SEED = "software-dev";

/**
 * v0.8 (§10.5): path constants for the fresh-DB seed subtree-root skeleton.
 * Alongside the knowledge subtree, the global root also carries empty
 * container roots for the two other §10.5 top-level branches so the wiki
 * browser opens with a clear skeleton:
 *
 *   wiki-root:global
 *     ├── knowledge          (KNOWLEDGE_ROOT_PATH_SEED)        — protected
 *     │     └── software-dev (SOFTWARE_DEV_NODE_PATH_SEED)     — protected
 *     ├── projects           (PROJECTS_ROOT_PATH_SEED)         — empty container
 *     └── memory             (MEMORY_ROOT_PATH_SEED)           — empty container
 *
 * These are NOT protected (they are navigation skeletons, not anchors);
 * the per-project subtree roots (`wiki-root:<projectId>`) and per-agent
 * memory roots (`wiki-root:memory-agent:<agentId>`) are still created
 * lazily by ensureProjectSubtree / ensureMemoryAgentRoot and live as
 * siblings of these skeleton roots.
 */
export const PROJECTS_ROOT_PATH_SEED = "projects";
export const MEMORY_ROOT_PATH_SEED = "memory";

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
// v0.8 (P1 §10.1): wiki body content lives on disk — path helpers + FS
// isolation root. Exported so the FS tool guard (wiki-path-guard) reuses the
// same canonical root. agent FS tools (Shell/Read/Grep/Glob/Write/Edit) MUST
// reject any path that resolves inside WIKI_DISK_ROOT.
// ---------------------------------------------------------------------------

/**
 * The on-disk root of the wiki body content store. Body files live under
 * `<WIKI_DISK_ROOT>/<area>/<safe-name>.md`; the DB row only carries the
 * per-node `docPointer` (= the absolute path to its body file). Agents never
 * touch this directory directly — they address nodes by nodeId and the wiki
 * tools (ExpandNode / UpdateWikiNode) read/write through WikiStore.
 */
export const WIKI_DISK_ROOT = join(ZERO_CORE_DIR, "wiki");

/**
 * Compute the canonical disk path for a node's body content file. The area
 * bucket is decided by position (P1 §10.1.5):
 *   - node carries `projectId`        → projects/<projectId>/
 *   - node's path signals memory      → memory/_legacy/   (legacy; future
 *                                          extractor writes per-agent under
 *                                          memory/<agentId>/ via createMemoryNode)
 *   - otherwise                       → knowledge/
 *
 * The leaf filename is derived from node.path (path-separator/colon sanitized)
 * + a short id suffix to guarantee uniqueness within the area directory.
 */
export function deriveContentFilePath(input: {
	id: string;
	path?: string;
	projectId?: string;
}): string {
	const area = input.projectId
		? join("projects", input.projectId)
		: input.path && input.path.startsWith("memory")
			? join("memory", "_legacy")
			: "knowledge";
	const raw = (input.path ?? input.id).replace(/[:/\\]+/g, "_").replace(/^_+|_+$/g, "");
	const tail = input.id.length >= 8 ? input.id.slice(0, 8) : input.id;
	const safe = `${raw || "node"}__${tail}.md`;
	return join(WIKI_DISK_ROOT, area, safe);
}

/**
 * v0.8 (P1 §10.1): canonicalize a path and check whether it resolves inside
 * WIKI_DISK_ROOT. This is the same canonicalization logic wiki-path-guard
 * uses (kept inline here so the store has no runtime/tools/ dependency — the
 * guard imports FROM this module, not the other way around). Used to harden
 * readNodeDetail / writeNodeDetail / deleteNodeDetail against `node.docPointer`
 * values that escaped WIKI_DISK_ROOT (legacy rows or buggy upsert inputs).
 *
 * Returns false for empty/non-string input.
 */
export function isInsideWikiDisk(p: string | undefined | null): boolean {
	if (!p || typeof p !== "string") return false;
	const canon = (s: string): string => {
		const abs = isAbsolute(s) ? s : resolve(process.cwd(), s);
		const norm = normalize(abs);
		return process.platform === "win32"
			? norm.replace(/\\/g, "/").toLowerCase()
			: norm;
	};
	const c = canon(p.trim());
	const root = canon(WIKI_DISK_ROOT);
	const rootWithSlash = root.endsWith("/") ? root : root + "/";
	return c === root || c.startsWith(rootWithSlash);
}

/**
 * v0.8 (P2 §11.6): the synthetic memory-anchor node id for a given agent.
 * Sessions whose agentId = X derive `memory-anchor:<X>` as one of their
 * automatic anchors; the anchor is resolved against the per-agent memory
 * subtree root `wiki-root:memory:<agentId>` (a real row, created lazily by
 * ensureMemoryAgentRoot). Memory leaves for that agent hang directly under
 * the per-agent root (path: `memory:<agentId>:<type>:<subject>`).
 *
 * The id is synthetic (no row is created with this exact id) — it is the
 * anchor handle used by wiki-anchor-injection to render the per-agent memory
 * index; the actual subtree lives at memoryAgentRootId(agentId).
 */
export function memoryAnchorIdForAgent(agentId: string): string {
	return `memory-anchor:${agentId}`;
}

/**
 * v0.8 (P2 §11.6): stable synthetic id of an agent's per-agent memory
 * subtree root. Real row, created lazily by ensureMemoryAgentRoot(). The
 * root hangs directly under WIKI_GLOBAL_ROOT_ID (memory is global to the
 * agent — cross-project, per RFC §11.6 risk note).
 *
 * Replaces the M5 scheme (5 global type roots shared by all agents). Old
 * data under `wiki-root:memory:<type>` is left in place — P9 cleanup will
 * DROP it together with the agent-tool-entries table.
 */
export function memoryAgentRootId(agentId: string): string {
	// Sanitize agentId into a path-safe segment to keep the synthetic id stable
	// even for weird agent ids (slashes / colons would clash with the wiki id
	// grammar). Keep it recognizable for the common case (uuid / slug ids).
	const safe = agentId.replace(/[:/\\]+/g, "_");
	return `wiki-root:memory-agent:${safe}`;
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
			// v0.8 (P1 §10.1): `type` and `detail` removed; type is positional,
			// detail lives on disk (writeNodeDetail handles body export).
			const cols = [
				"id",
				"parent_id",
				"path",
				"title",
				"summary",
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
			record.path,
			record.title,
			record.summary ?? null,
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
		// v0.8 (P1 §10.1): `detail` is not a DB column anymore — peel it off
		// and write to disk after the row exists (so docPointer can be set).
		const { detail, ...rowInput } = input as Omit<WikiNode, "id" | "createdAt" | "updatedAt"> & { detail?: string };
		const created = this.store.create(rowInput as any);
		const node = rowToWikiNode(created)!;
		if (detail && detail.trim().length > 0) {
			this.writeNodeDetail(node.id, detail);
			// Re-fetch so the returned node carries the stamped docPointer
			// (writeNodeDetail mutates the row; the original `node` snapshot
			// is pre-stamp). Matches the round-trip callers expect.
			return this.get(node.id)!;
		}
		return node;
	}

	update(id: string, input: Partial<Omit<WikiNode, "id" | "createdAt">>): WikiNode {
		// v0.8 (P1 §10.1): `detail` is peeled off and routed to disk; the
		// remaining fields (title/summary/path/provenance/...) update the row.
		const { detail, ...rowPatch } = input as Partial<WikiNode> & { detail?: string };
		const updated = rowToWikiNode(this.store.update(id, rowPatch as any))!;
		if (detail !== undefined) {
			// Empty/blank detail deletes the body file; non-empty writes it.
			if (detail.trim().length === 0) {
				this.deleteNodeDetail(id);
			} else {
				this.writeNodeDetail(id, detail);
			}
		}
		return updated;
	}

	delete(id: string): void {
		// v0.8 (P6 §7.1): protect the fresh-DB seed nodes — knowledge root and
		// the software-dev playbook leaf. Deleting them would orphan zero's
		// playbook and the auto-bootstrap path. RFC §7.5.
		this.assertNotProtected(id);
		// Cascade-delete children (recursive). Detail files are also removed.
		const children = this.getChildren(id);
		for (const child of children) {
			this.delete(child.id);
		}
		this.deleteNodeDetail(id);
		this.store.delete(id);
	}

	/**
	 * v0.8 (P6 §7.1 / §7.5): protected wiki nodes that cannot be deleted.
	 * Identified by (parentId, path) so they survive DB id changes. The
	 * knowledge root and its software-dev child are the fresh-DB seed.
	 */
	private assertNotProtected(id: string): void {
		const node = this.get(id);
		if (!node) return;
		// software-dev playbook leaf — under the knowledge root.
		if (node.path === SOFTWARE_DEV_NODE_PATH_SEED) {
			const parent = node.parentId ? this.get(node.parentId) : undefined;
			if (parent && parent.path === KNOWLEDGE_ROOT_PATH_SEED && parent.parentId === WIKI_GLOBAL_ROOT_ID) {
				throw new Error(
					"Cannot delete the protected 'knowledge/software-dev' playbook node (fresh-DB seed, RFC §7.1)",
				);
			}
		}
		// knowledge root — directly under the global root. Protecting it keeps
		// the playbook anchored (zero / future HR manage its contents via
		// upsert, not by deleting the root).
		if (
			node.path === KNOWLEDGE_ROOT_PATH_SEED &&
			node.parentId === WIKI_GLOBAL_ROOT_ID
		) {
			throw new Error(
				"Cannot delete the protected 'knowledge' subtree root (RFC §7.5)",
			);
		}
	}

	getChildren(parentId: string): WikiNode[] {
		return this.store.list().filter((n) => n.parentId === parentId).map(rowToWikiNode);
	}

	// ─── Disk body content (v0.8 P1 §10.1) ──────────────────────────

	/**
	 * Read a node's body content from disk. Returns undefined when the node
	 * has no body file (synthetic roots, structure-only nodes, or content not
	 * yet written). This is the canonical "expand a node" path — list/get do
	 * NOT populate `detail`; callers that need the body call here.
	 *
	 * v0.8 (P1 §10.1, hardened): the body file path is ALWAYS the derived
	 * path from `deriveContentFilePath(node)`. `docPointer` is a code-internal
	 * cache that the store stamps itself; we never trust a caller-set or
	 * legacy-row `docPointer` value here, because such values can escape
	 * WIKI_DISK_ROOT (FS isolation §10.1). If `docPointer` is set AND inside
	 * WIKI_DISK_ROOT we still prefer the derived path (canonical, position-
	 * stable) — the cache is informational only.
	 */
	readNodeDetail(nodeId: string): string | undefined {
		const node = this.get(nodeId);
		if (!node) return undefined;
		const file = deriveContentFilePath(node);
		try {
			if (!existsSync(file)) return undefined;
			return readFileSync(file, "utf-8");
		} catch {
			return undefined;
		}
	}

	/**
	 * Write (or overwrite) a node's body content on disk. Stamps `docPointer`
	 * on the row so future reads go straight to the file. The DB row is NOT
	 * otherwise touched (no summary / title change here) — this is the
	 * "改正文不动 DB" guarantee from acceptance-P1.
	 *
	 * v0.8 (P1 §10.1, hardened): the file path is ALWAYS derived from the
	 * node's position; we never write to `node.docPointer` directly, even when
	 * it is set. This is the FS-isolation lock: a legacy/corrupt/benign
	 * `docPointer` value pointing outside WIKI_DISK_ROOT (e.g. an external
	 * relative path like "src/foo.ts") cannot cause a write to escape the
	 * wiki disk root. After writing, `docPointer` is stamped to the derived
	 * path so callers that read it see the canonical body locator.
	 */
	writeNodeDetail(nodeId: string, content: string): void {
		const node = this.get(nodeId);
		if (!node) {
			throw new Error(`writeNodeDetail: node not found: ${nodeId}`);
		}
		const file = deriveContentFilePath(node);
		// Defensive: never let a future change to deriveContentFilePath produce
		// an out-of-root path silently.
		if (!isInsideWikiDisk(file)) {
			throw new Error(
				`writeNodeDetail: derived body path escapes WIKI_DISK_ROOT (FS isolation §10.1): ${file}`,
			);
		}
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, content, "utf-8");
		// Stamp docPointer to the derived path. We re-stamp even when the row
		// already had a docPointer, so any stale/escaping cache value is
		// overwritten with the canonical locator (cheap UPDATE; no content
		// round-trip).
		if (node.docPointer !== file) {
			this.store.update(nodeId, { docPointer: file } as any);
		}
	}

	/** Delete a node's body file (used by WikiStore.delete cascade). */
	private deleteNodeDetail(nodeId: string): void {
		const node = this.get(nodeId);
		if (!node) return;
		// v0.8 (P1 §10.1, hardened): always delete the derived path; never
		// trust node.docPointer (it may be a stale escaping value).
		const file = deriveContentFilePath(node);
		try {
			if (existsSync(file)) rmSync(file, { force: true });
		} catch {
			// best-effort; never let disk cleanup block a delete
		}
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

	// ─── View-truncated queries (v0.8 P1 §10.3 — multi-anchor scope) ──

	/**
	 * v0.8 (P1 §10.3): list all wiki nodes visible from a SET of anchor node
	 * ids. This is the multi-anchor generalization of listVisibleFromRoot —
	 * the caller passes every anchor (auto memory/project anchors + free
	 * wikiAnchors), and the result is the UNION of each anchor's subtree.
	 *
	 * Special cases:
	 *   - anchors includes WIKI_GLOBAL_ROOT_ID → returns the whole tree
	 *     (zero / global-scope sessions). The single-anchor convenience
	 *     listVisibleFromRoot still works for that case.
	 *   - empty anchor list → empty result.
	 *
	 * The anchors are *node ids in the tree*; for memory anchors the caller
	 * typically passes the five `wiki-root:memory:<type>` type roots (every
	 * memory leaf is reachable from one of them).
	 */
	listVisibleFromAnchors(anchorNodeIds: string[]): WikiNode[] {
		if (anchorNodeIds.length === 0) return [];
		// Fast path: global root anchor = whole tree.
		if (anchorNodeIds.includes(WIKI_GLOBAL_ROOT_ID)) {
			return this.list();
		}
		const visibleIds = new Set<string>();
		for (const anchorId of anchorNodeIds) {
			const subtreeIds = this.collectSubtreeIdsSafe(anchorId);
			for (const id of subtreeIds) visibleIds.add(id);
		}
		return this.store.list().filter((n) => visibleIds.has(n.id)).map(rowToWikiNode);
	}

	/**
	 * v0.8 (P1 §10.3): read a single node, but only if it is visible from the
	 * caller's anchor set. Multi-anchor version of getVisible.
	 */
	getVisibleFromAnchors(anchorNodeIds: string[], nodeId: string): WikiNode | undefined {
		return this.listVisibleFromAnchors(anchorNodeIds).find((n) => n.id === nodeId);
	}

	/**
	 * collectSubtreeIds that returns an empty set (rather than throwing) when
	 * the anchor id doesn't exist as a node yet. Synthetic anchors like
	 * `memory-anchor:<agentId>` aren't backed by a row; they're matched by
	 * convention against matching nodes elsewhere (handled at the
	 * anchor-resolution layer, not here).
	 */
	private collectSubtreeIdsSafe(rootId: string): Set<string> {
		const root = this.get(rootId);
		if (!root) return new Set<string>();
		return this.collectSubtreeIds(root.id);
	}

	// ─── Write guards (decision 39 — store-layer scope enforcement) ──

	/**
	 * v0.8 (P1 §10.3): assert that a node lives inside ANY of the caller's
	 * anchor subtrees. This is the multi-anchor replacement for the legacy
	 * type-based `assertNodeInsideProjectScope` — read + write use the SAME
	 * boundary (write scope = visible scope, acceptance-P1).
	 *
	 * Throws if the node is outside every anchor's subtree (so the writer
	 * fails loudly rather than silently writing across the boundary).
	 */
	assertNodeInAnchorScope(anchorNodeIds: string[], nodeId: string): void {
		if (anchorNodeIds.includes(WIKI_GLOBAL_ROOT_ID)) return; // global caller
		for (const anchorId of anchorNodeIds) {
			const ids = this.collectSubtreeIdsSafe(anchorId);
			if (ids.has(nodeId)) return;
		}
		throw new Error(
			`Node ${nodeId} is outside all caller anchor subtrees ` +
				`(anchors: ${anchorNodeIds.join(", ") || "(none)"}; ` +
				`write scope violation, RFC §2.16/OQ2 + P1 §10.3).`,
		);
	}

	/**
	 * @deprecated v0.8 (P1 §10.3): replaced by assertNodeInAnchorScope. Kept
	 * as a thin wrapper for legacy callers (archivist-service, wiki-tools)
	 * that still operate in single-project mode — they pass the project
	 * subtree root id as the sole anchor. Internally delegates to the
	 * multi-anchor path. New code should pass the full anchor set.
	 */
	assertNodeInsideProjectScope(projectId: string, nodeId: string): void {
		this.assertNodeInAnchorScope([projectSubtreeRootId(projectId)], nodeId);
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
			provenance?: "structure" | "derived" | "confirmed";
			requirementIds?: string[];
			relations?: Array<{ kind: string; targetId: string }>;
			flags?: string[];
			lastUpdatedBy?: string;
		},
	): WikiNode {
		// Enforce parent is inside this project subtree (multi-anchor guard
		// with the project subtree root as the sole anchor; new code passes
		// the full anchor set via assertNodeInAnchorScope directly).
		this.assertNodeInAnchorScope([projectSubtreeRootId(projectId)], input.parentId);

		// Type is constrained by the input signature to header | intent |
		// structure. memory nodes belong to extractor A (M5); project subtree
		// roots are minted by ensureProjectSubtree — both routes never go
		// through here. (The check is structurally enforced by the type; no
		// runtime re-check needed.)

		// v0.8 (P1 §10.1, hardened): `docPointer` is NOT accepted on input.
		// It is a code-internal cache of the node's body content file path
		// (always derived by deriveContentFilePath + stamped by
		// writeNodeDetail). External/caller-supplied paths — including
		// workspace-relative paths like "src/foo.ts" — must NOT be able to set
		// it, otherwise writeNodeDetail could be coerced into writing outside
		// WIKI_DISK_ROOT. The strip below is defensive in case a caller still
		// passes the field via `...input`.
		const { docPointer: _ignoredDocPointer, ...rowInput } = input as typeof input & {
			docPointer?: string;
		};
		void _ignoredDocPointer;

		const existing = this.getByParentAndPath(rowInput.parentId, rowInput.path);
		if (existing) {
			return this.update(existing.id, {
				...rowInput,
				projectId,
				lastUpdatedBy: rowInput.lastUpdatedBy ?? "archivist",
			});
		}
		return this.create({
			...rowInput,
			projectId,
			lastUpdatedBy: rowInput.lastUpdatedBy ?? "archivist",
		});
	}

	/**
	 * Update a node's METADATA (title/summary/flags/...) — scope-guarded.
	 * Does NOT touch the body document (use writeNodeDetail / the doc ops for
	 * that). Mirrors the scope enforcement in upsertProjectNode so the Wiki
	 * tool can update by nodeId without bypassing the store-layer scope lock.
	 * Returns the updated node (without detail — list/get never populate it).
	 */
	updateNodeMetadata(
		projectId: string,
		nodeId: string,
		patch: Partial<Pick<WikiNode, "title" | "summary" | "flags" | "provenance">> & {
			lastUpdatedBy?: string;
		},
	): WikiNode {
		this.assertNodeInsideProjectScope(projectId, nodeId);
		return this.update(nodeId, {
			...patch,
			lastUpdatedBy: patch.lastUpdatedBy ?? "agent",
		});
	}

	/**
	 * Delete a node (cascade children + body file) — scope-guarded. The
	 * existing delete() protects the fresh-DB seed nodes (knowledge root +
	 * software-dev playbook) and cascades; this wrapper only adds the project-
	 * scope assertion so the Wiki tool can delete by nodeId safely.
	 */
	deleteNode(projectId: string, nodeId: string): void {
		this.assertNodeInsideProjectScope(projectId, nodeId);
		this.delete(nodeId);
	}

	/**
	 * Append a flag to a node (archivist divergence signal, RFC §2.16).
	 * Enforces project-scope membership (single-anchor legacy guard).
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

	/**
	 * v0.8 (P2 §11.6): ensure an agent's per-agent memory subtree root exists.
	 * One root per agent, hanging directly under WIKI_GLOBAL_ROOT_ID. Memory is
	 * GLOBAL to the agent (cross-project) — the same agent's memory spans every
	 * project it touches (RFC §11.6 risk note). Idempotent.
	 *
	 * Replaces the M5 scheme where every agent's memories lived under the 5
	 * shared type roots. The per-agent root is the single anchor handle that
	 * wiki-anchor-injection renders as the agent's MEMORY.md-style index.
	 */
	ensureMemoryAgentRoot(agentId: string): WikiNode {
		const id = memoryAgentRootId(agentId);
		const existing = this.get(id);
		if (existing) return existing;
		const now = new Date().toISOString();
		this.insertWithId({
			id,
			parentId: WIKI_GLOBAL_ROOT_ID,
			type: "memory",
			nodeType: "section",
			path: `memory-agent:${agentId}`,
			title: `Memory: ${agentId}`,
			summary: `Per-agent memory subtree for agent ${agentId} (P2 §11.6).`,
			lastUpdatedBy: "extractor-A",
			createdAt: now,
			updatedAt: now,
		} as any);
		return this.get(id)!;
	}

	/**
	 * v0.8 (P2 §11.6): upsert a memory leaf under an agent's per-agent subtree.
	 * Replaces the M5 `createMemoryNode`-under-type-root path. Same upsert
	 * semantics (by parent + path); type is encoded in the path so the index
	 * renderer can still bucket by type when needed.
	 *
	 * `type` is preserved on the leaf so consumers reading the body JSON still
	 * see event/decision/discovery/status_change/preference.
	 */
	createMemoryNodeForAgent(input: {
		agentId: string;
		type: "event" | "decision" | "discovery" | "status_change" | "preference";
		subject: string;
		title: string;
		summary?: string;
		detail?: string;
		provenance?: "structure" | "derived" | "confirmed";
		lastUpdatedBy?: string;
	}): WikiNode {
		const root = this.ensureMemoryAgentRoot(input.agentId);
		// Path encodes type + subject for stable upsert + bucket rendering.
		const slug = input.subject
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "unnamed";
		const path = `memory:${input.agentId}:${input.type}:${slug}`;
		const existing = this.getByParentAndPath(root.id, path);
		if (existing) {
			return this.update(existing.id, {
				title: input.title,
				summary: input.summary,
				type: "memory",
				lastUpdatedBy: input.lastUpdatedBy ?? "extractor-A",
			});
		}
		return this.create({
			parentId: root.id,
			path,
			title: input.title,
			summary: input.summary,
			detail: input.detail,
			type: "memory",
			provenance: input.provenance ?? "derived",
			lastUpdatedBy: input.lastUpdatedBy ?? "extractor-A",
		});
	}

	// ─── Project registry / helpers ─────────────────────────────────

	/** List all known project subtree root nodes. */
	listProjects(): string[] {
		// v0.8 (P1 §10.1): project subtree roots are now identified by id
		// prefix (`wiki-root:<projectId>`) rather than the dropped `type`
		// column. Rows with a projectId AND a wiki-root id are project roots.
		return this.store
			.list()
			.filter((n) => n.projectId && n.id.startsWith("wiki-root:") && n.id !== WIKI_GLOBAL_ROOT_ID && !n.id.startsWith("wiki-root:memory:"))
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
		// v0.8 (P1 §10.1): the `type` column was dropped — rows no longer
		// carry `type`, so we must run rowToWikiNode (which calls
		// deriveTypeFromPosition) BEFORE filtering. Filtering the raw row
		// yields an empty set because row.type is undefined.
		return this.store
			.list()
			.map(rowToWikiNode)
			.filter((n) => n.type === "memory");
	}

	/**
	 * Simple LIKE-based search over memory node title + summary + detail.
	 * Splits the query on whitespace and ANDs the terms. NOT FTS5 — extractor
	 * A's volume is small enough that a linear scan is fine for v1, and we
	 * avoid coupling memory nodes to a second FTS table.
	 *
	 * v0.8 (P1 §10.1): `detail` no longer lives on the row — the body file is
	 * loaded lazily (readNodeDetail) only for the surviving matches, so the
	 * search now scans title + summary on the row, then re-checks the disk
	 * body for any candidate that didn't match on row fields. This keeps the
	 * scan cheap while still finding terms that only appear in the body.
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
		// v0.8 (P1 §10.1): rows no longer carry `type` — derive via
		// rowToWikiNode first, then filter by the synthesized type. The
		// fallback readNodeDetail(n.id) below is unaffected because it keys
		// off n.id, which is present on the raw row and the WikiNode.
		const candidates = this.store
			.list()
			.map(rowToWikiNode)
			.filter((n) => {
				if (n.type !== "memory") return false;
				if (typeRootIds.has(n.id)) return false; // skip type roots
				return true;
			});
		const matches = candidates.filter((n) => {
			const hay = ((n.title ?? "") + " " + (n.summary ?? "")).toLowerCase();
			if (terms.every(t => hay.includes(t))) return true;
			// Fall back to the disk body for terms not in title/summary.
			const detail = this.readNodeDetail(n.id) ?? "";
			if (!detail) return false;
			const detailHay = detail.toLowerCase();
			return terms.every(t => detailHay.includes(t));
		});
		matches.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
		// candidates already ran through rowToWikiNode above — no re-map.
		return matches.slice(0, limit);
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
 * Normalize a stored row into a WikiNode. v0.8 (P1 §10.1): the `type` column
 * is GONE — type is now derived from POSITION (project subtree membership →
 * project/header/intent/structure; global memory type roots + their leaves →
 * memory; synthetic roots → project). Back-compat rows still carrying
 * `nodeType` ("directory"/"file"/...) get type synthesized from that legacy
 * discriminator (decision 23, refined in P1).
 *
 * `detail` is NOT populated here — body content lives on disk and is loaded
 * only on demand via WikiStore.readNodeDetail (the ExpandNode path).
 *
 * Returns WikiNode & { nodeType? } — the legacy `nodeType` is kept on the
 * row object so the back-compat ProjectWikiStore view round-trips it through
 * SqliteStore's update path without dropping the column value.
 */
function rowToWikiNode(row: any): WikiNode & { nodeType?: string } {
	const type = deriveTypeFromPosition(row);
	return {
		id: row.id,
		parentId: row.parentId,
		type,
		path: row.path,
		title: row.title,
		summary: row.summary,
		// detail intentionally NOT populated — see readNodeDetail (P1 §10.1).
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
 * v0.8 (P1 §10.1): derive a node's type from its position in the tree. Rules
 * (in priority order):
 *   1. synthetic root ids (`wiki-root:global`, `wiki-root:<projectId>`,
 *      `wiki-root:memory:<type>`) → `project` (subtree root) or `memory`
 *      (memory type root).
 *   2. row carries `projectId` → `project` subtree member; if its nodeType
 *      legacy discriminator says file/function/class → header, intent docs are
 *      flagged via path prefix `intent:` → intent; otherwise structure.
 *   3. row's path or parent signals memory (path starts with `memory` / parent
 *      is a memory type root) → memory.
 *   4. legacy `nodeType` discriminator → header/structure (back-compat).
 *   5. fallback → structure.
 *
 * The store is the ONLY caller, so position resolution can read the row's
 * parentId chain lazily. To keep this pure + cheap, we lean on signals already
 * on the row (id / path / projectId / nodeType) and only fall back to a
 * parent-chain walk when none of them is conclusive.
 */
function deriveTypeFromPosition(row: any): WikiNodeTypeGlobal {
	const id: string = row.id ?? "";
	const path: string = row.path ?? "";
	const projectId: string | undefined = row.projectId;
	const nodeType: string | undefined = row.nodeType;

	// 1. Synthetic roots.
	if (id === WIKI_GLOBAL_ROOT_ID) return "project";
	// v0.8 (P2 §11.6): the per-agent memory subtree root
	// (`wiki-root:memory-agent:<id>`, path `memory-agent:<id>`) is an
	// INDEX/anchor container — it must NOT be counted as a memory leaf by
	// listMemoryNodes / searchMemoryNodes (which filter type === "memory").
	// The leaves under it (path `memory:<agentId>:<type>:<slug>`) are the
	// actual memory rows. Anchor injection resolves the root by its id
	// prefix directly (wiki-anchor-injection.ts:classifyAnchorKind), so the
	// root does not need type === "memory" to render. Fall through: its
	// nodeType is "section" → "structure" (rule 4).
	if (id.startsWith("wiki-root:memory:")) return "memory"; // legacy shared type root
	if (id.startsWith("wiki-root:")) return "project"; // project subtree root

	// 2. Memory leaves by path signal.
	// P2 leaves: `memory:<agentId>:<type>:<slug>` (per-agent, under a
	// wiki-root:memory-agent: root). Legacy M5 leaves: `memory:<type>/<subject>`
	// under a wiki-root:memory:<type> root. Both match `path.startsWith("memory")`.
	// `memory-root:` covers the legacy type-root path namespace as memory too.
	if (path.startsWith("memory") || path.startsWith("memory-root:")) return "memory";

	// 3. Project subtree members.
	if (projectId) {
		if (path.startsWith("intent:")) return "intent";
		if (path.startsWith("header:")) return "header";
		// Legacy discriminator for project-subtree nodes that predate M2.
		if (nodeType === "file" || nodeType === "function" || nodeType === "class") return "header";
		if (nodeType === "directory") return "structure";
		return "structure";
	}

	// 4. No projectId and no memory path signal — legacy row. Trust nodeType.
	if (nodeType === "file" || nodeType === "function" || nodeType === "class") return "header";
	if (nodeType === "directory" || nodeType === "section") return "structure";

	// 5. Fallback.
	return "structure";
}
