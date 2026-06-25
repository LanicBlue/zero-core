// 项目状态管理
//
// # 文件说明书
//
// ## 核心功能
// 项目相关的 Zustand 状态管理。
//
// v0.8 (§8): 项目不再从 Agent 自动同步 — 每个项目必须显式建(Project
// 工具 / 项目页新建)。本 store 只负责 list/update/remove。
//
// ## 输入
// - IPC 调用（projects:list 等）
//
// ## 输出
// - 项目列表
//
// ## 定位
// 渲染进程状态管理，被 KanbanPage 等组件使用。
//
// ## 依赖
// - zustand - 状态管理
// - ../../shared/types - 共享类型
//
// ## 维护规则
// - 项目必须显式建，不再自动从 Agent 同步（v0.7 syncFromAgents 已移除）
//
import { create } from "zustand";
import type { ProjectRecord, CreateProjectInput, UpdateProjectInput } from "../../shared/types.js";
import { useNotificationStore } from "./notification-store.js";
import { subscribeListDataChange } from "./data-sync.js";

const api = () => (window as any).api;

interface ProjectState {
	projects: ProjectRecord[];
	loading: boolean;
	fetchProjects: (filter?: { status?: string }) => Promise<void>;
	updateProject: (id: string, input: UpdateProjectInput) => Promise<void>;
	removeProject: (id: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set) => ({
	projects: [],
	loading: false,

	/**
	 * 拉取项目列表。v0.8 (§8): 项目必须显式建(Project 工具 / 项目页新建),
	 * 这里只 list 显式建的项目,不再像 v0.7 那样从 Agent workspaceDir 自动同步
	 * 创建(旧逻辑会把 zero agent 的 ~/.zero-core 平台目录误建成 "zero" 项目
	 * 并触发 archivist 扫出 structure:wiki/structure:workspace 垃圾 wiki 节点)。
	 */
	fetchProjects: async (filter?) => {
		set({ loading: true });
		try {
			const data = await api().projectsList(filter);
			set({ projects: data, loading: false });
		} catch (err: any) {
			set({ loading: false });
			useNotificationStore.getState().addError(err?.message || "Failed to fetch projects");
		}
	},

	updateProject: async (id, input) => {
		try {
			const updated = await api().projectsUpdate(id, input);
			if ("error" in updated) throw new Error(updated.error);
			set((state) => ({
				projects: state.projects.map((p) => (p.id === id ? updated : p)),
			}));
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to update project");
			throw err;
		}
	},

	removeProject: async (id) => {
		try {
			await api().projectsDelete(id);
			set((state) => ({ projects: state.projects.filter((p) => p.id !== id) }));
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to remove project");
			throw err;
		}
	},
}));

// v0.8: incrementally sync projects when mutated from the backend (e.g. the
// Project tool). Single create/update → fetch one + patch; delete → remove;
// burst → full refetch.
subscribeListDataChange("projects", {
	patch: (id, record) => {
		const others = useProjectStore.getState().projects.filter((p) => p.id !== id);
		useProjectStore.setState({ projects: record ? [...others, record as ProjectRecord] : others });
		return true; // 非过滤列表:新 id 直接 append
	},
	refetchAll: () => { useProjectStore.getState().fetchProjects(); },
});
