// 项目状态管理
//
// # 文件说明书
//
// ## 核心功能
// 项目相关的 Zustand 状态管理，包括项目列表和 CRUD 操作。
//
// ## 输入
// - IPC 调用（projects:list 等）
//
// ## 输出
// - 项目列表
// - CRUD 操作
//
// ## 定位
// 渲染进程状态管理，被 KanbanPage 等组件使用。
//
// ## 依赖
// - zustand - 状态管理
// - ../../shared/types - 共享类型
//
// ## 维护规则
// - 新增项目字段时需更新类型
// - 保持与 IPC 接口一致
//
import { create } from "zustand";
import type { ProjectRecord, CreateProjectInput, UpdateProjectInput } from "../../shared/types.js";

const api = () => (window as any).api;

interface ProjectState {
	projects: ProjectRecord[];
	loading: boolean;
	fetchProjects: (filter?: { status?: string }) => Promise<void>;
	createProject: (input: CreateProjectInput) => Promise<ProjectRecord>;
	updateProject: (id: string, input: UpdateProjectInput) => Promise<void>;
	removeProject: (id: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
	projects: [],
	loading: false,

	fetchProjects: async (filter?) => {
		set({ loading: true });
		try {
			const data = await api().projectsList(filter);
			set({ projects: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	createProject: async (input) => {
		const created = await api().projectsCreate(input);
		set((state) => ({ projects: [...state.projects, created] }));
		return created;
	},

	updateProject: async (id, input) => {
		const updated = await api().projectsUpdate(id, input);
		if ("error" in updated) throw new Error(updated.error);
		set((state) => ({
			projects: state.projects.map((p) => (p.id === id ? updated : p)),
		}));
	},

	removeProject: async (id) => {
		await api().projectsDelete(id);
		set((state) => ({ projects: state.projects.filter((p) => p.id !== id) }));
	},
}));
