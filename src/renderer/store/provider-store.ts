import { create } from "zustand";
import type { ProviderModel, Provider } from "../../shared/types.js";

const api = () => (window as any).api;

interface ProviderState {
	providers: Provider[];
	loading: boolean;
	fetchProviders: () => Promise<void>;
	create: (input: Omit<Provider, "id" | "createdAt" | "updatedAt">) => Promise<Provider>;
	update: (id: string, input: Partial<Provider>) => Promise<Provider>;
	remove: (id: string) => Promise<void>;
	addModel: (providerId: string, model: ProviderModel) => Promise<Provider>;
	removeModel: (providerId: string, modelId: string) => Promise<Provider>;
	fetchModels: (providerId: string) => Promise<ProviderModel[]>;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
	providers: [],
	loading: true,

	fetchProviders: async () => {
		try {
			const data = await api().providersList();
			set({ providers: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const created = await api().providersCreate(input);
		set((state) => ({ providers: [...state.providers, created] }));
		return created;
	},

	update: async (id, input) => {
		const updated = await api().providersUpdate(id, input);
		set((state) => ({
			providers: state.providers.map((p) => (p.id === id ? updated : p)),
		}));
		return updated;
	},

	remove: async (id) => {
		await api().providersDelete(id);
		set((state) => ({ providers: state.providers.filter((p) => p.id !== id) }));
	},

	addModel: async (providerId, model) => {
		const updated = await api().providersAddModel(providerId, model);
		set((state) => ({
			providers: state.providers.map((p) => (p.id === providerId ? updated : p)),
		}));
		return updated;
	},

	removeModel: async (providerId, modelId) => {
		const updated = await api().providersRemoveModel(providerId, modelId);
		set((state) => ({
			providers: state.providers.map((p) => (p.id === providerId ? updated : p)),
		}));
		return updated;
	},

	fetchModels: async (providerId) => {
		const models = await api().providersFetchModels(providerId);
		return models as ProviderModel[];
	},
}));
