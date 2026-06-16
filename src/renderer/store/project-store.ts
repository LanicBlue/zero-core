// 项目状态管理
//
// # 文件说明书
//
// ## 核心功能
// 项目相关的 Zustand 状态管理，自动从 Agent 同步项目。
//
// ## 输入
// - IPC 调用（projects:list, agents:list 等）
//
// ## 输出
// - 项目列表
// - 自动同步方法
//
// ## 定位
// 渲染进程状态管理，被 KanbanPage 等组件使用。
//
// ## 依赖
// - zustand - 状态管理
// - ../../shared/types - 共享类型
//
// ## 维护规则
// - 项目自动从 Agent 同步，不需要手动创建
//
import { create } from "zustand";
import type { ProjectRecord, CreateProjectInput, UpdateProjectInput } from "../../shared/types.js";
import { useNotificationStore } from "./notification-store.js";

const api = () => (window as any).api;

interface ProjectState {
	projects: ProjectRecord[];
	loading: boolean;
	fetchProjects: (filter?: { status?: string }) => Promise<void>;
	syncFromAgents: () => Promise<void>;
	updateProject: (id: string, input: UpdateProjectInput) => Promise<void>;
	removeProject: (id: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
	projects: [],
	loading: false,

	/**
	 * 自动从 Agent 列表同步项目。
	 * 每个 Agent 的 workspaceDir 对应一个 Project。
	 * 如果 Agent 还没有对应的 Project，自动创建。
	 */
	syncFromAgents: async () => {
		try {
			const agents = await api().agentsList();
			const projects = await api().projectsList();
			// v0.8 (M0): ProjectRecord uses workspaceDir (was: path)
			const existingPaths = new Set(projects.map((p: ProjectRecord) => p.workspaceDir));

			for (const agent of agents) {
				if (agent.workspaceDir && !existingPaths.has(agent.workspaceDir)) {
					try {
						await api().projectsCreate({
							name: agent.name,
							workspaceDir: agent.workspaceDir,
						} as any);
					} catch {
						// 可能路径冲突或其他错误，跳过
					}
				}
			}
		} catch {
			// 同步失败不阻塞
		}
	},

	fetchProjects: async (filter?) => {
		set({ loading: true });
		try {
			// 先同步，再拉列表
			await get().syncFromAgents();
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
