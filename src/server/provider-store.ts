import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { v4 as uuidv4 } from "uuid";

export interface ProviderModel {
	id: string;
	name: string;
	group?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface Provider {
	id: string;
	name: string;
	type: "openai" | "anthropic" | "gemini" | "openai-compatible" | "ollama";
	apiKey: string;
	baseUrl: string;
	models: ProviderModel[];
	enabled: boolean;
	isSystem?: boolean;
	createdAt: string;
	updatedAt: string;
}

interface ProviderStoreData {
	providers: Provider[];
}

const SYSTEM_PROVIDERS: Omit<Provider, "id" | "createdAt" | "updatedAt">[] = [
	{
		name: "OpenAI",
		type: "openai",
		apiKey: "",
		baseUrl: "https://api.openai.com/v1",
		models: [
			{ id: "gpt-4o", name: "GPT-4o", group: "GPT-4o", contextWindow: 128000, maxTokens: 16384 },
			{ id: "gpt-4o-mini", name: "GPT-4o Mini", group: "GPT-4o", contextWindow: 128000, maxTokens: 16384 },
			{ id: "gpt-4-turbo", name: "GPT-4 Turbo", group: "GPT-4", contextWindow: 128000, maxTokens: 4096 },
			{ id: "o1", name: "o1", group: "o1", contextWindow: 200000, maxTokens: 100000 },
			{ id: "o1-mini", name: "o1 Mini", group: "o1", contextWindow: 128000, maxTokens: 65536 },
			{ id: "o3-mini", name: "o3 Mini", group: "o3", contextWindow: 200000, maxTokens: 100000 },
		],
		enabled: false,
		isSystem: true,
	},
	{
		name: "Anthropic",
		type: "anthropic",
		apiKey: "",
		baseUrl: "https://api.anthropic.com",
		models: [
			{ id: "claude-opus-4-20250514", name: "Claude Opus 4", group: "Claude 4", contextWindow: 200000, maxTokens: 32000 },
			{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", group: "Claude 4", contextWindow: 200000, maxTokens: 16000 },
			{ id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet", group: "Claude 3.7", contextWindow: 200000, maxTokens: 128000 },
			{ id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", group: "Claude 3.5", contextWindow: 200000, maxTokens: 8192 },
		],
		enabled: false,
		isSystem: true,
	},
	{
		name: "Google Gemini",
		type: "gemini",
		apiKey: "",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		models: [
			{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", group: "Gemini 2.5", contextWindow: 1048576, maxTokens: 65536 },
			{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", group: "Gemini 2.5", contextWindow: 1048576, maxTokens: 65536 },
			{ id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", group: "Gemini 2.0", contextWindow: 1048576, maxTokens: 8192 },
		],
		enabled: false,
		isSystem: true,
	},
	{
		name: "Ollama",
		type: "ollama",
		apiKey: "",
		baseUrl: "http://localhost:11434",
		models: [],
		enabled: false,
		isSystem: true,
	},
];

export class ProviderStore {
	private filePath: string;
	private data: ProviderStoreData;

	constructor(filePath?: string) {
		this.filePath = filePath ?? join(homedir(), ".zero-core", "providers.json");
		this.data = this.load();
	}

	private load(): ProviderStoreData {
		if (existsSync(this.filePath)) {
			try {
				const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
				// Merge in any new system providers
				this.mergeSystemProviders(data);
				return data;
			} catch {
				// fall through
			}
		}

		const providers = SYSTEM_PROVIDERS.map((p) => this.createRecord(p));
		const data: ProviderStoreData = { providers };
		this.save(data);
		return data;
	}

	private mergeSystemProviders(data: ProviderStoreData): void {
		let dirty = false;
		for (const sys of SYSTEM_PROVIDERS) {
			const existing = data.providers.find((p) => p.isSystem && p.name === sys.name);
			if (!existing) {
				data.providers.push(this.createRecord(sys));
				dirty = true;
			} else {
				// Merge new models into existing provider
				for (const model of sys.models) {
					if (!existing.models.some((m) => m.id === model.id)) {
						existing.models.push(model);
						dirty = true;
					}
				}
			}
		}
		if (dirty) this.save(data);
	}

	private save(data: ProviderStoreData): void {
		const dir = join(this.filePath, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
	}

	private createRecord(input: Omit<Provider, "id" | "createdAt" | "updatedAt">): Provider {
		const now = new Date().toISOString();
		return { id: uuidv4(), ...input, createdAt: now, updatedAt: now };
	}

	list(): Provider[] {
		return this.data.providers;
	}

	get(id: string): Provider | undefined {
		return this.data.providers.find((p) => p.id === id);
	}

	create(input: Omit<Provider, "id" | "createdAt" | "updatedAt">): Provider {
		const record = this.createRecord(input);
		this.data.providers.push(record);
		this.save(this.data);
		return record;
	}

	update(id: string, input: Partial<Omit<Provider, "id" | "createdAt">>): Provider {
		const index = this.data.providers.findIndex((p) => p.id === id);
		if (index === -1) throw new Error(`Provider not found: ${id}`);
		this.data.providers[index] = {
			...this.data.providers[index],
			...input,
			updatedAt: new Date().toISOString(),
		};
		this.save(this.data);
		return this.data.providers[index];
	}

	delete(id: string): void {
		this.data.providers = this.data.providers.filter((p) => p.id !== id);
		this.save(this.data);
	}

	addModel(providerId: string, model: ProviderModel): Provider {
		const provider = this.get(providerId);
		if (!provider) throw new Error(`Provider not found: ${providerId}`);
		if (provider.models.some((m) => m.id === model.id)) {
			throw new Error(`Model ${model.id} already exists`);
		}
		provider.models.push(model);
		provider.updatedAt = new Date().toISOString();
		this.save(this.data);
		return provider;
	}

	removeModel(providerId: string, modelId: string): Provider {
		const provider = this.get(providerId);
		if (!provider) throw new Error(`Provider not found: ${providerId}`);
		provider.models = provider.models.filter((m) => m.id !== modelId);
		provider.updatedAt = new Date().toISOString();
		this.save(this.data);
		return provider;
	}
}
