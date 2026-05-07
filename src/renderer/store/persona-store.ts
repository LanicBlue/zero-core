import { create } from "zustand";

export interface PersonaRecord {
	id: string;
	name: string;
	role: string;
	traits: string[];
	expertise: string[];
	communicationStyle: string;
	customInstructions?: string;
	createdAt: string;
	updatedAt: string;
}

interface PersonaState {
	personas: PersonaRecord[];
	loading: boolean;
	fetchPersonas: () => Promise<void>;
	create: (input: Omit<PersonaRecord, "id" | "createdAt" | "updatedAt">) => Promise<PersonaRecord>;
	update: (id: string, input: Partial<PersonaRecord>) => Promise<PersonaRecord>;
	remove: (id: string) => Promise<void>;
}

export const usePersona = create<PersonaState>((set, get) => ({
	personas: [],
	loading: true,

	fetchPersonas: async () => {
		try {
			const res = await fetch("/api/personas");
			const data = await res.json();
			set({ personas: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const res = await fetch("/api/personas", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		const created = await res.json();
		set((state) => ({ personas: [...state.personas, created] }));
		return created;
	},

	update: async (id, input) => {
		const res = await fetch(`/api/personas/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		const updated = await res.json();
		set((state) => ({ personas: state.personas.map((p) => (p.id === id ? updated : p)) }));
		return updated;
	},

	remove: async (id) => {
		await fetch(`/api/personas/${id}`, { method: "DELETE" });
		set((state) => ({ personas: state.personas.filter((p) => p.id !== id) }));
	},
}));

// Auto-fetch on first import
let _fetched = false;
if (!_fetched) {
	_fetched = true;
	usePersona.getState().fetchPersonas();
}
