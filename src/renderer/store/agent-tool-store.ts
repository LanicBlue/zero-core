import { create } from "zustand";

export interface AgentToolEntry {
	id: string;
	name: string;
	description?: string;
	type: "internal" | "external";
	enabled: boolean;
	agentId?: string;
	transport?: "cli" | "http";
	command?: string;
	argsTemplate?: string;
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	bodyTemplate?: string;
	responsePath?: string;
	timeout?: number;
	blocking?: boolean;
		auto_background_timeout?: number;
	createdAt: string;
	updatedAt: string;
}

const api = () => (window as any).api;

interface AgentToolState {
	entries: AgentToolEntry[];
	loading: boolean;
	fetchEntries: () => Promise<void>;
	create: (input: Omit<AgentToolEntry, "id" | "createdAt" | "updatedAt">) => Promise<AgentToolEntry>;
	update: (id: string, input: Partial<AgentToolEntry>) => Promise<AgentToolEntry>;
	remove: (id: string) => Promise<void>;
	getByAgentId: (agentId: string) => Promise<AgentToolEntry | undefined>;
}

export const useAgentToolStore = create<AgentToolState>((set, get) => ({
	entries: [],
	loading: true,

	fetchEntries: async () => {
		try {
			const data = await api().agentToolsList();
			set({ entries: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const created = await api().agentToolsCreate(input);
		set((state) => ({ entries: [...state.entries, created] }));
		return created;
	},

	update: async (id, input) => {
		const updated = await api().agentToolsUpdate(id, input);
		set((state) => ({
			entries: state.entries.map((e) => (e.id === id ? updated : e)),
		}));
		return updated;
	},

	remove: async (id) => {
		await api().agentToolsDelete(id);
		set((state) => ({ entries: state.entries.filter((e) => e.id !== id) }));
	},

	getByAgentId: async (agentId: string) => {
		return api().agentToolsGetByAgent(agentId);
	},
}));

// Auto-fetch on first import
let _fetched = false;
if (!_fetched) {
	_fetched = true;
	useAgentToolStore.getState().fetchEntries();

	// Refresh when tools change
	const unsub = api().onToolsChanged(() => {
		useAgentToolStore.getState().fetchEntries();
	});
}
