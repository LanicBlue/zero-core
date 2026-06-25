// 知识库前端状态管理
//
// # 文件说明书
//
// ## 核心功能
// 管理知识库列表的前端状态和 IPC 调用
//
// ## 输入
// IPC API 调用结果
//
// ## 输出
// KbState（知识库列表、加载状态、CRUD 操作）
//
// ## 定位
// src/renderer/store/ — 渲染进程状态层，为知识库页面提供数据
//
// ## 依赖
// zustand、shared/types.ts、preload API
//
// ## 维护规则
// 知识库操作字段变更需同步更新 shared/types.ts
//
import { create } from "zustand";
import type { KnowledgeBase, KbFileInfo } from "../../shared/types.js";

const api = () => (window as any).api;

interface KbState {
	knowledgeBases: KnowledgeBase[];
	loading: boolean;
	/** True after the first successful fetch — guards against re-fetching on page re-mount. */
	loaded: boolean;
	fetchList: () => Promise<void>;
	create: (input: Omit<KnowledgeBase, "id" | "createdAt" | "updatedAt">) => Promise<KnowledgeBase>;
	update: (id: string, input: Partial<KnowledgeBase>) => Promise<KnowledgeBase>;
	remove: (id: string) => Promise<void>;
	addFiles: (kbId: string, filePaths: string[]) => Promise<{ path: string; chunks: number; error?: string }[]>;
	removeFile: (kbId: string, filePath: string) => Promise<void>;
	search: (kbIds: string[], query: string) => Promise<{ chunkId: number; filePath: string; content: string; score: number }[]>;
	getChunkCount: (kbId: string) => Promise<number>;
}

export const useKbStore = create<KbState>((set, get) => ({
	knowledgeBases: [],
	loading: true,
	loaded: false,

	fetchList: async () => {
		// Page-driven fetch (KnowledgeBasePage useEffect). Skip if already loaded
		// so re-mounting the page doesn't re-request.
		if (get().loaded) return;
		try {
			const data = await api().kbList();
			set({ knowledgeBases: data, loading: false, loaded: true });
		} catch {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const created = await api().kbCreate(input);
		set((state) => ({ knowledgeBases: [...state.knowledgeBases, created] }));
		return created;
	},

	update: async (id, input) => {
		const updated = await api().kbUpdate(id, input);
		set((state) => ({ knowledgeBases: state.knowledgeBases.map((kb) => (kb.id === id ? updated : kb)) }));
		return updated;
	},

	remove: async (id) => {
		await api().kbDelete(id);
		set((state) => ({ knowledgeBases: state.knowledgeBases.filter((kb) => kb.id !== id) }));
	},

	addFiles: async (kbId, filePaths) => {
		const results = await api().kbAddFiles(kbId, filePaths);
		await get().fetchList();
		return results;
	},

	removeFile: async (kbId, filePath) => {
		await api().kbRemoveFile(kbId, filePath);
		await get().fetchList();
	},

	search: async (kbIds, query) => {
		return api().kbSearch(kbIds, query);
	},

	getChunkCount: async (kbId) => {
		return api().kbChunkCount(kbId);
	},
}));
