import { create } from "zustand";

export interface AgentRecord {
	id: string;
	name: string;
	role: string;
	traits: string[];
	expertise: string[];
	communicationStyle: string;
	customInstructions?: string;
	workspaceDir?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	contextConfig?: {
		injectProjectContext?: boolean;
		maxDirectoryDepth?: number;
		excludePatterns?: string[];
		additionalFiles?: string[];
	};
	createdAt: string;
	updatedAt: string;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
}

interface AgentState {
	agents: AgentRecord[];
	models: ModelInfo[];
	loading: boolean;
	fetchAgents: () => Promise<void>;
	fetchModels: () => Promise<void>;
	create: (input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">) => Promise<AgentRecord>;
	update: (id: string, input: Partial<AgentRecord>) => Promise<AgentRecord>;
	remove: (id: string) => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
	agents: [],
	models: [],
	loading: true,

	fetchAgents: async () => {
		try {
			const res = await fetch("/api/agents");
			const data = await res.json();
			set({ agents: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	fetchModels: async () => {
		try {
			const res = await fetch("/api/models");
			const data = await res.json();
			set({ models: data });
		} catch {
			set({ models: [] });
		}
	},

	create: async (input) => {
		const res = await fetch("/api/agents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		const created = await res.json();
		set((state) => ({ agents: [...state.agents, created] }));
		return created;
	},

	update: async (id, input) => {
		const res = await fetch(`/api/agents/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		const updated = await res.json();
		set((state) => ({ agents: state.agents.map((a) => (a.id === id ? updated : a)) }));
		return updated;
	},

	remove: async (id) => {
		await fetch(`/api/agents/${id}`, { method: "DELETE" });
		set((state) => ({ agents: state.agents.filter((a) => a.id !== id) }));
	},
}));

// Auto-fetch on first import
let _fetched = false;
if (!_fetched) {
	_fetched = true;
	useAgentStore.getState().fetchAgents();
	useAgentStore.getState().fetchModels();
}
