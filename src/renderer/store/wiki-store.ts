// Wiki 状态管理 (v0.8 P8 升级为全局树浏览器 · 懒加载模型)
//
// # 文件说明书
//
// ## 核心功能
// Wiki 浏览器的状态层。一棵树 + 一个视角(全局 / 单项目子树)。
//
// **懒加载(显示时才 fetch)**:树结构不再一次性拉整棵子树,而是逐层:
//   - refresh()(挂载/切 scope)→ 只拉 scope 根锚点的直接子节点。
//   - expandNode(id) → 只拉该节点的直接子节点(首次展开才请求)。
//   - readDetail(id)(点选节点)→ 才读磁盘正文 + 懒摘要。
//
// 视角(ViewScope)决定根锚点:
//   - { kind: "global" }      → 全局根 wiki-root:global(整树,逐层展开)
//   - { kind: "project", id } → 该项目子树根 wiki-root:<id>
//
// ## 输入
// IPC: wiki:getChildren / wiki:readDetail / wiki:readWorkspaceDoc / wiki:search。
//
// ## 输出
// - childrenByNode(parentId → 已加载直接子节点)
// - nodeById(扁平索引)
// - 选中节点 + 展开状态(WikiTree 本地管)
// - 正文(磁盘懒加载)
//
import { create } from "zustand";
import type { WikiNode } from "../../shared/types.js";
import { useNotificationStore } from "./notification-store.js";
import { subscribeDataChange } from "./data-sync.js";

const api = () => (window as any).api;

/**
 * v0.8 (P8 §10.9): the wiki browser's view scope. Decides the root anchor
 * whose direct children are loaded first (then expanded lazily).
 */
export type WikiViewScope =
	| { kind: "global" }
	| { kind: "project"; projectId: string };

export const WIKI_GLOBAL_ROOT_ID = "wiki-root:global";

/** The root anchor nodeId for the active scope (the lazy-load entry point). */
function scopeRootId(scope: WikiViewScope): string {
	if (scope.kind === "global") return WIKI_GLOBAL_ROOT_ID;
	return `wiki-root:${scope.projectId}`;
}

interface WikiState {
	/** parentId → already-loaded DIRECT children. */
	childrenByNode: Record<string, WikiNode[]>;
	/** nodeId → true once that node's children have been fetched. */
	childrenLoaded: Record<string, boolean>;
	/** nodeId → node (flat index of everything loaded so far). */
	nodeById: Record<string, WikiNode>;
	/** nodeId currently fetching its children (for "Loading…" rows). */
	loadingChildren: Record<string, boolean>;
	/** True once the root's children have loaded (drives first paint). */
	rootLoaded: boolean;
	selectedNodeId: string | null;
	/** Lazy-loaded body content for the selected node (keyed by nodeId). */
	detailByNode: Record<string, string | undefined>;
	/** Current view scope — drives the root anchor. */
	scope: WikiViewScope;

	setScope: (scope: WikiViewScope) => void;
	refresh: () => Promise<void>;
	selectNode: (nodeId: string | null) => void;
	expandNode: (nodeId: string) => Promise<void>;
	readDetail: (nodeId: string) => Promise<void>;
	readWorkspaceDoc: (projectId: string, relPath: string) => Promise<{ content?: string; error?: string }>;
	search: (query: string) => Promise<WikiNode[]>;
	getSelectedNode: () => WikiNode | undefined;
}

export const useWikiStore = create<WikiState>((set, get) => ({
	childrenByNode: {},
	childrenLoaded: {},
	nodeById: {},
	loadingChildren: {},
	rootLoaded: false,
	selectedNodeId: null,
	detailByNode: {},
	scope: { kind: "global" },

	setScope: (scope) => {
		// New scope → drop the loaded tree and re-fetch the new root's children.
		set({
			scope,
			childrenByNode: {},
			childrenLoaded: {},
			nodeById: {},
			loadingChildren: {},
			rootLoaded: false,
			selectedNodeId: null,
			detailByNode: {},
		});
		void get().refresh();
	},

	refresh: async () => {
		// Load ONLY the scope root's direct children — the rest loads lazily
		// on expand. This replaces the old "pull the whole subtree at once".
		const rootId = scopeRootId(get().scope);
		set((s) => ({ loadingChildren: { ...s.loadingChildren, [rootId]: true } }));
		try {
			const children = await api().wikiGetChildren(rootId);
			set((state) => {
				const nodeById = { ...state.nodeById };
				for (const c of children) nodeById[c.id] = c;
				return {
					childrenByNode: { ...state.childrenByNode, [rootId]: children },
					childrenLoaded: { ...state.childrenLoaded, [rootId]: true },
					loadingChildren: { ...state.loadingChildren, [rootId]: false },
					nodeById,
					rootLoaded: true,
				};
			});
		} catch (err: any) {
			set((s) => ({ loadingChildren: { ...s.loadingChildren, [rootId]: false } }));
			useNotificationStore.getState().addError(err?.message || "Failed to fetch wiki tree");
		}
	},

	selectNode: (nodeId) => {
		set({ selectedNodeId: nodeId });
	},

	expandNode: async (nodeId) => {
		// Lazy-load a node's DIRECT children on first expand. Idempotent: skip
		// if already loaded (or currently loading).
		if (get().childrenLoaded[nodeId] || get().loadingChildren[nodeId]) return;
		set((s) => ({ loadingChildren: { ...s.loadingChildren, [nodeId]: true } }));
		try {
			const children = await api().wikiGetChildren(nodeId);
			set((state) => {
				const nodeById = { ...state.nodeById };
				for (const c of children) nodeById[c.id] = c;
				return {
					childrenByNode: { ...state.childrenByNode, [nodeId]: children },
					childrenLoaded: { ...state.childrenLoaded, [nodeId]: true },
					loadingChildren: { ...state.loadingChildren, [nodeId]: false },
					nodeById,
				};
			});
		} catch (err: any) {
			set((s) => ({ loadingChildren: { ...s.loadingChildren, [nodeId]: false } }));
			useNotificationStore.getState().addError(err?.message || "Failed to expand wiki node");
		}
	},

	readDetail: async (nodeId) => {
		// Body content + lazy summary — fetched when the user SELECTS a node
		// (the detail panel). Idempotent: skip if already loaded.
		if (nodeId in get().detailByNode) return;
		try {
			const { detail, summary } = await api().wikiReadDetail(nodeId);
			set((state) => ({
				detailByNode: { ...state.detailByNode, [nodeId]: detail },
				// Backfill the lazily-materialized summary (scan leaves it empty).
				nodeById: summary && state.nodeById[nodeId]
					? { ...state.nodeById, [nodeId]: { ...state.nodeById[nodeId], summary } }
					: state.nodeById,
			}));
		} catch (err: any) {
			set((state) => ({ detailByNode: { ...state.detailByNode, [nodeId]: undefined } }));
			useNotificationStore.getState().addError(err?.message || "Failed to read wiki node detail");
		}
	},

	readWorkspaceDoc: async (projectId, relPath) => {
		try {
			return await api().wikiReadWorkspaceDoc(projectId, relPath);
		} catch (err: any) {
			return { error: err?.message || "Failed to read workspace doc" };
		}
	},

	search: async (query) => {
		try {
			const anchors = [scopeRootId(get().scope)];
			return await api().wikiSearch(query, anchors);
		} catch {
			return [];
		}
	},

	getSelectedNode: () => {
		const { selectedNodeId, nodeById } = get();
		if (!selectedNodeId) return undefined;
		return nodeById[selectedNodeId];
	},
}));

// Refresh the tree when nodes are mutated from the backend (archivist scan /
// Wiki tool). Simplified strategy: drop the loaded tree and re-fetch the root.
// (Could be refined to refresh only the affected branch later.)
subscribeDataChange("project_wiki", () => {
	useWikiStore.setState({
		childrenByNode: {},
		childrenLoaded: {},
		nodeById: {},
		rootLoaded: false,
	});
	void useWikiStore.getState().refresh();
});
