// Wiki 状态管理 (v0.8 P8 升级为全局树浏览器)
//
// # 文件说明书
//
// ## 核心功能
// Wiki 浏览器的状态层。P8 起从「按项目分桶」升级为「全局树 + 多锚点
// 可见性」(RFC §10.9):一棵树 + 一个视角(全局 / 单项目子树 ∪ memory),
// 右侧正文按需 expand(磁盘读取)。
//
// 视角(ViewScope)决定可见域:
//   - { kind: "global" }          → 全局根锚点,整树可见(= zero 视角)。
//   - { kind: "project", id }     → 该项目子树根 ∪ 当前 agent memory 子树
//                                    (项目角色视角,store 守卫一致)。
// 视角对应一组 anchorNodeIds,传给 wiki:listByAnchors。store 层就是守卫层,
// UI 看到的 = 能操作的(验收 P8 权限一致)。
//
// ## 输入
// - IPC: wiki:listByAnchors / wiki:readDetail / wiki:readWorkspaceDoc /
//   wiki:search(均 v0.8 P8 新增)。
//
// ## 输出
// - 全局节点池(按视角刷新)
// - 选中节点
// - 展开正文(磁盘懒加载)
// - 工作区文档读取(docPointer 跳转原文)
//
// ## 定位
// 渲染进程状态管理,被 WikiPage 使用。
//
// ## 依赖
// - zustand
// - ../../shared/types (WikiNode)
// - ./notification-store
//
// ## 维护规则
// - 新增 wiki action 时同步 IPC + 此 store
// - 视角切换必须重新拉取,避免跨视角残留(权限一致性)
//
import { create } from "zustand";
import type { WikiNode } from "../../shared/types.js";
import { useNotificationStore } from "./notification-store.js";
import { subscribeDataChange } from "./data-sync.js";

const api = () => (window as any).api;

/**
 * v0.8 (P8 §10.9): the wiki browser's view scope. Decides the anchor set
 * passed to wiki:listByAnchors — and thus the visible domain.
 *
 *   - "global"  → anchors = [WIKI_GLOBAL_ROOT_ID] → whole tree (zero view)
 *   - "project" → anchors = [project subtree root] → that subtree only
 *
 * The renderer doesn't synthesize the per-agent memory anchor (there is no
 * "current session agent" in the global browser — the user is browsing). A
 * project view shows the project subtree; memory leaves written for agents
 * active in that project are reachable if they were upserted under that
 * subtree (they aren't, by design — memory is global). So a project view is
 * strictly narrower than global, matching the spec's "project role sees its
 * own subtree".
 *
 * Global root id is duplicated here (rather than imported) to keep the store
 * free of a main-process import.
 */
export type WikiViewScope =
	| { kind: "global" }
	| { kind: "project"; projectId: string };

export const WIKI_GLOBAL_ROOT_ID = "wiki-root:global";

/** Build the anchor nodeId set for a view scope. */
function scopeAnchors(scope: WikiViewScope): string[] {
	if (scope.kind === "global") return [WIKI_GLOBAL_ROOT_ID];
	// Project subtree root id (matches server projectSubtreeRootId).
	return [`wiki-root:${scope.projectId}`];
}

interface WikiState {
	/** All nodes currently visible under the active view scope. */
	nodes: WikiNode[];
	selectedNodeId: string | null;
	/** Lazy-loaded body content for the expanded node (keyed by nodeId). */
	detailByNode: Record<string, string | undefined>;
	loading: boolean;
	/** Current view scope — drives the anchor set + visible domain. */
	scope: WikiViewScope;

	setScope: (scope: WikiViewScope) => void;
	refresh: () => Promise<void>;
	selectNode: (nodeId: string | null) => void;
	expandNode: (nodeId: string) => Promise<void>;
	readWorkspaceDoc: (projectId: string, relPath: string) => Promise<{ content?: string; error?: string }>;
	search: (query: string) => Promise<WikiNode[]>;
	getSelectedNode: () => WikiNode | undefined;
}

export const useWikiStore = create<WikiState>((set, get) => ({
	nodes: [],
	selectedNodeId: null,
	detailByNode: {},
	loading: false,
	scope: { kind: "global" },

	setScope: (scope) => {
		set({ scope, selectedNodeId: null });
		void get().refresh();
	},

	refresh: async () => {
		const { scope } = get();
		set({ loading: true });
		try {
			const anchors = scopeAnchors(scope);
			const nodes = await api().wikiListByAnchors(anchors);
			set({ nodes, loading: false });
		} catch (err: any) {
			set({ loading: false });
			useNotificationStore.getState().addError(err?.message || "Failed to fetch wiki tree");
		}
	},

	selectNode: (nodeId) => {
		set({ selectedNodeId: nodeId });
	},

	expandNode: async (nodeId) => {
		// Idempotent: skip if already loaded.
		if (nodeId in get().detailByNode) return;
		try {
			const { detail } = await api().wikiReadDetail(nodeId);
			set((state) => ({
				detailByNode: { ...state.detailByNode, [nodeId]: detail },
			}));
		} catch (err: any) {
			// Mark as loaded-but-empty so we don't retry forever.
			set((state) => ({
				detailByNode: { ...state.detailByNode, [nodeId]: undefined },
			}));
			useNotificationStore.getState().addError(err?.message || "Failed to expand wiki node");
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
			const anchors = scopeAnchors(get().scope);
			return await api().wikiSearch(query, anchors);
		} catch {
			return [];
		}
	},

	getSelectedNode: () => {
		const { selectedNodeId, nodes } = get();
		if (!selectedNodeId) return undefined;
		return nodes.find((n) => n.id === selectedNodeId);
	},
}));

// v0.8: refresh the wiki tree when nodes are mutated from the backend (e.g.
// the Wiki tool via the session wikiStore, or the archivist background scan).
// Rides the unified data:changed channel (collection = the project_wiki table).
subscribeDataChange("project_wiki", () => {
	useWikiStore.getState().refresh();
});
