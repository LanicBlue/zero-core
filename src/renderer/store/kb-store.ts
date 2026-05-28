import { create } from "zustand";
import type { KnowledgeBase, KbFileInfo } from "../../shared/types.js";

const api = () => (window as any).api;

interface KbState {
	knowledgeBases: KnowledgeBase[];
	loading: boolean;
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

	fetchList: async () => {
		try {
			const data = await api().kbList();
			set({ knowledgeBases: data, loading: false });
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

let _fetched = false;
if (!_fetched) {
	_fetched = true;
	useKbStore.getState().fetchList();
}
