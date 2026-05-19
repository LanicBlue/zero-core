import { create } from "zustand";

export interface PromptTemplate {
	id: string;
	name: string;
	description: string;
	icon?: string;
	systemPrompt: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	toolPolicy?: {
		autoApprove?: string[];
		blockedTools?: string[];
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
		readScope?: "filesystem" | "workspace";
	};
	tags: string[];
	isBuiltIn: boolean;
	createdAt: string;
	updatedAt: string;
}

const api = () => (window as any).api;

interface TemplateState {
	templates: PromptTemplate[];
	loading: boolean;
	fetchTemplates: () => Promise<void>;
	create: (input: Omit<PromptTemplate, "id" | "createdAt" | "updatedAt">) => Promise<PromptTemplate>;
	update: (id: string, input: Partial<PromptTemplate>) => Promise<PromptTemplate>;
	remove: (id: string) => Promise<void>;
	exportTemplate: (id: string) => Promise<string>;
	importTemplate: (json: string) => Promise<PromptTemplate>;
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
	templates: [],
	loading: true,

	fetchTemplates: async () => {
		try {
			const data = await api().templatesList();
			set({ templates: data, loading: false });
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
}));

// Auto-fetch on first import
let _fetched = false;
if (!_fetched) {
	_fetched = true;
	useTemplateStore.getState().fetchTemplates();
}
