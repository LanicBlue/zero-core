// Wiki 状态管理
//
// # 文件说明书
//
// ## 核心功能
// Wiki 相关的 Zustand 状态管理，包括节点树、选中节点和展开详情。
//
// ## 输入
// - IPC 调用（wiki:listByProject 等）
//
// ## 输出
// - Wiki 节点树
// - 选中节点
// - 展开详情
//
// ## 定位
// 渲染进程状态管理，被 WikiPage 等组件使用。
//
// ## 依赖
// - zustand - 状态管理
// - ../../shared/types - 共享类型
//
// ## 维护规则
// - 新增 Wiki 字段时需更新类型
// - 保持与 IPC 接口一致
//
import { create } from "zustand";
import type { ProjectWikiNode, UpdateWikiNodeInput } from "../../shared/types.js";

const api = () => (window as any).api;

interface WikiState {
	nodesByProject: Record<string, ProjectWikiNode[]>;
	selectedNodeId: string | null;
	expandedDetail: string | null;
	loading: boolean;

	fetchWikiTree: (projectId: string) => Promise<void>;
	selectNode: (nodeId: string | null) => void;
	expandNode: (nodeId: string) => Promise<void>;
	updateNode: (nodeId: string, data: UpdateWikiNodeInput) => Promise<void>;
	getSelectedNode: () => ProjectWikiNode | undefined;
	getNodesForProject: (projectId: string) => ProjectWikiNode[];
}

export const useWikiStore = create<WikiState>((set, get) => ({
	nodesByProject: {},
	selectedNodeId: null,
	expandedDetail: null,
	loading: false,

	fetchWikiTree: async (projectId) => {
		set({ loading: true });
		try {
			const nodes = await api().wikiListByProject(projectId);
			set((state) => ({
				nodesByProject: { ...state.nodesByProject, [projectId]: nodes },
				loading: false,
			}));
		} catch {
			set({ loading: false });
		}
	},

	selectNode: (nodeId) => {
		set({ selectedNodeId: nodeId });
	},

	expandNode: async (nodeId) => {
		try {
			const node = await api().wikiGetNode(nodeId);
			if (!node) return;
			// Update the node in all project caches
			set((state) => {
				const updated: Record<string, ProjectWikiNode[]> = {};
				for (const [pid, nodes] of Object.entries(state.nodesByProject)) {
					updated[pid] = nodes.map((n) => (n.id === nodeId ? node : n));
				}
				return { nodesByProject: updated, expandedDetail: nodeId };
			});
		} catch { /* keep existing data */ }
	},

	updateNode: async (nodeId, data) => {
		const result = await api().wikiUpdateNode(nodeId, data);
		if ("error" in result) throw new Error(result.error);
		set((state) => {
			const updated: Record<string, ProjectWikiNode[]> = {};
			for (const [pid, nodes] of Object.entries(state.nodesByProject)) {
				updated[pid] = nodes.map((n) => (n.id === nodeId ? result : n));
			}
			return { nodesByProject: updated };
		});
	},

	getSelectedNode: () => {
		const { selectedNodeId, nodesByProject } = get();
		if (!selectedNodeId) return undefined;
		for (const nodes of Object.values(nodesByProject)) {
			const found = nodes.find((n) => n.id === selectedNodeId);
			if (found) return found;
		}
		return undefined;
	},

	getNodesForProject: (projectId) => {
		return get().nodesByProject[projectId] || [];
	},
}));
