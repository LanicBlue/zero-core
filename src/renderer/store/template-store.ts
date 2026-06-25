// 模板前端状态管理
//
// # 文件说明书
//
// ## 核心功能
// 管理 Agent 模板的前端状态和 IPC 调用
//
// ## 输入
// IPC API 调用结果
//
// ## 输出
// TemplateState（模板列表、加载状态、CRUD 操作）
//
// ## 定位
// src/renderer/store/ — 渲染进程状态层，为模板页面提供数据
//
// ## 依赖
// zustand、shared/types.ts、preload API
//
// ## 维护规则
// 模板字段变更需同步更新 shared/types.ts
//
import { create } from "zustand";
import type { PromptTemplate } from "../../shared/types.js";

const api = () => (window as any).api;

interface TemplateState {
	templates: PromptTemplate[];
	loading: boolean;
	/** True after the first successful fetch — guards against re-fetching on page re-mount. */
	loaded: boolean;
	fetchTemplates: () => Promise<void>;
	create: (input: Omit<PromptTemplate, "id" | "createdAt" | "updatedAt">) => Promise<PromptTemplate>;
	update: (id: string, input: Partial<PromptTemplate>) => Promise<PromptTemplate>;
	remove: (id: string) => Promise<void>;
	exportTemplate: (id: string) => Promise<string>;
	importTemplate: (json: string) => Promise<PromptTemplate>;
		githubPreview: (url: string, subdir?: string) => Promise<{ items: { name: string; description: string; icon: string; tag: string; path: string; exists: boolean }[]; sourceUrl: string; error?: string }>;
		importFromGithub: (url: string, selectedPaths: string[]) => Promise<{ imported: number; updated: number; total: number; error?: string }>;
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
	templates: [],
	loading: true,
	loaded: false,

	fetchTemplates: async () => {
		// Page-driven fetch (TemplateGallery useEffect). Skip if already loaded.
		if (get().loaded) return;
		try {
			const data = await api().templatesList();
			set({ templates: data, loading: false, loaded: true });
		} catch {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const created = await api().templatesCreate(input);
		set((state) => ({ templates: [...state.templates, created] }));
		return created;
	},

	update: async (id, input) => {
		const updated = await api().templatesUpdate(id, input);
		set((state) => ({ templates: state.templates.map((t) => (t.id === id ? updated : t)) }));
		return updated;
	},

	remove: async (id) => {
		await api().templatesDelete(id);
		set((state) => ({ templates: state.templates.filter((t) => t.id !== id) }));
	},

	exportTemplate: async (id) => {
		return api().templatesExport(id);
	},

	importTemplate: async (json) => {
		const imported = await api().templatesImport(json);
		set((state) => ({ templates: [...state.templates, imported] }));
		return imported;
	},

		githubPreview: async (url: string, subdir?: string) => {
			return api().templatesGithubPreview(url, subdir);
		},

		importFromGithub: async (url: string, selectedPaths: string[]) => {
			const result = await api().templatesImportGithub(url, selectedPaths);
			set({ loaded: false }); await get().fetchTemplates();
			return result;
		},
}));

