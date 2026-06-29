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

// Incremental refresh when nodes are mutated from the backend (archivist scan /
// Wiki tool). v0.8 原则:不全量重置,只更新变化的分支 —— 该节点的父分支失效重拉,
// 该节点正文缓存清掉(下次点选重读),其余已加载的分支原样保留。未显示(未展开)
// 的分支不管,展开时自然拿最新。只获取需要显示的节点,与"显示时拉/展开时拉子/点
// 选时拉正文"的懒模型一致。
function refreshWikiBranch(parentId: string): void {
	const s = useWikiStore.getState();
	// 只刷新"已显示"的父分支;未加载的不管(展开时拿最新)。
	if (!s.childrenLoaded[parentId]) return;
	// 失效该父的 children 缓存 → expandNode 见 loaded=false 会真正重请求。
	useWikiStore.setState((st) => {
		const cl = { ...st.childrenLoaded };
		delete cl[parentId];
		return { childrenLoaded: cl };
	});
	void s.expandNode(parentId);
}

if (typeof window !== "undefined") {
	api().onDataChanged((e: { collection: string; changes?: Array<{ id: string; op: string; record?: any }> }) => {
		if (e.collection !== "project_wiki") return;
		const s = useWikiStore.getState();
		for (const c of e.changes ?? []) {
			if (c.op === "delete") {
				const node = s.nodeById[c.id];
				const parentId = node?.parentId;
				useWikiStore.setState((st) => {
					const nodeById = { ...st.nodeById };
					delete nodeById[c.id];
					const detailByNode = { ...st.detailByNode };
					delete detailByNode[c.id];
					return { nodeById, detailByNode };
				});
				if (parentId) refreshWikiBranch(parentId);
				continue;
			}
			// create / update:record 可能是 DB 行,只用其 parentId 定位父分支
			// (真正的 WikiNode 形状由父分支重拉时补全,不直接塞 record 进 nodeById)。
			const rec = c.record ?? {};
			const parentId = rec.parentId ?? rec.parent_id;
			// 清该节点正文缓存,下次点选重读(docWrite 后内容变了)。
			useWikiStore.setState((st) => {
				if (!(c.id in st.detailByNode)) return st;
				const detailByNode = { ...st.detailByNode };
				delete detailByNode[c.id];
				return { detailByNode };
			});
			if (parentId) refreshWikiBranch(parentId);
			// 节点自己被展开过 → 也刷它自己的 children(rename/move 后顺序/身份可能变)。
			if (s.childrenLoaded[c.id]) refreshWikiBranch(c.id);
		}
	});
}
