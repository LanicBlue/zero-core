import { create } from "zustand";
import type { McpServerConfig } from "../../shared/types.js";

const api = () => (window as any).api;

export interface McpPreset {
	id: string;
	name: string;
	description: string;
	category: string;
	transport: "stdio" | "sse" | "streamable-http";
	envKeys: string[];
}

interface McpState {
	servers: McpServerConfig[];
	loading: boolean;
	fetchServers: () => Promise<void>;
	create: (input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">) => Promise<McpServerConfig>;
	update: (id: string, input: Partial<McpServerConfig>) => Promise<McpServerConfig>;
	remove: (id: string) => Promise<void>;
	testConnection: (input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">) => Promise<{ tools: { name: string; description?: string }[]; error?: string }>;
	connect: (id: string) => Promise<{ tools: { name: string; description?: string }[]; error?: string }>;
	disconnect: (id: string) => Promise<void>;
	getStatus: () => Promise<{ id: string; name: string; connected: boolean; toolCount: number }[]>;
	scan: () => Promise<{ detected: number; added: number }>;
	presets: () => Promise<McpPreset[]>;
	addPreset: (presetId: string, envValues: Record<string, string>) => Promise<McpServerConfig>;
}

export const useMcpStore = create<McpState>((set, get) => ({
	servers: [],
	loading: true,

	fetchServers: async () => {
		try {
			const data = await api().mcpList();
			set({ servers: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const created = await api().mcpCreate(input);
		await get().fetchServers();
		return created;
	},

	update: async (id, input) => {
		const updated = await api().mcpUpdate(id, input);
		await get().fetchServers();
		return updated;
	},

	remove: async (id) => {
		await api().mcpDelete(id);
		set((state) => ({ servers: state.servers.filter((s) => s.id !== id) }));
	},

	testConnection: async (input) => {
		return api().mcpTest(input);
	},

	connect: async (id) => {
		return api().mcpConnect(id);
	},

	disconnect: async (id) => {
		await api().mcpDisconnect(id);
	},

	getStatus: async () => {
		return api().mcpStatus();
	},

	scan: async () => {
		return api().mcpScan();
	},

	presets: async () => {
		return api().mcpPresets();
	},

	addPreset: async (presetId, envValues) => {
		const created = await api().mcpAddPreset(presetId, envValues);
		await get().fetchServers();
		return created;
	},
}));

let _fetched = false;
if (!_fetched) {
	_fetched = true;
	useMcpStore.getState().fetchServers();
}
