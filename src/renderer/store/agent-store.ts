import { create } from "zustand";
import type { AgentRecord } from "../../shared/types.js";

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
}

export interface ToolInfo {
	name: string;
	description: string;
	group?: string;
	source?: string;
	mcpServerName?: string;
	userDescription?: string;
	configSchema?: any[];
	meta?: {
		isReadOnly: boolean;
		isDestructive: boolean;
		isConcurrencySafe: boolean;
		requiresConfirmation: boolean;
	};
}

const api = () => (window as any).api;

interface AgentState {
	agents: AgentRecord[];
	models: ModelInfo[];
	tools: ToolInfo[];
	loading: boolean;
	fetchAgents: () => Promise<void>;
	fetchModels: () => Promise<void>;
	fetchTools: () => Promise<void>;
	create: (input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">) => Promise<AgentRecord>;
	update: (id: string, input: Partial<AgentRecord>) => Promise<AgentRecord>;
	remove: (id: string) => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
	agents: [],
	models: [],
	tools: [],
	loading: true,

	fetchAgents: async () => {
		try {
			const data = await api().agentsList();
			set({ agents: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	fetchModels: async () => {
		try {
			const data = await api().modelsList();
			set({ models: data });
		} catch {
			set({ models: [] });
		}
	},

	fetchTools: async () => {
		try {
			const data = await api().toolsList();
			set({ tools: data });
		} catch {
			set({ tools: [] });
		}
	},

	create: async (input) => {
		const created = await api().agentsCreate(input);
		set((state) => ({ agents: [...state.agents, created] }));
		return created;
	},

	update: async (id, input) => {
		const updated = await api().agentsUpdate(id, input);
		set((state) => ({ agents: state.agents.map((a) => (a.id === id ? updated : a)) }));
		return updated;
	},

	remove: async (id) => {
		await api().agentsDelete(id);
		set((state) => ({ agents: state.agents.filter((a) => a.id !== id) }));
	},
}));

// Auto-fetch on first import
let _fetched = false;
if (!_fetched) {
	_fetched = true;
	useAgentStore.getState().fetchAgents();
	useAgentStore.getState().fetchModels();
	useAgentStore.getState().fetchTools();

	// Refresh tools when agent tools change (expose/disable)
	const unsub = api().onToolsChanged(() => {
		useAgentStore.getState().fetchTools();
	});
}
