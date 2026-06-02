import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { ProviderModel, Provider } from "../shared/types.js";
import { DEFAULT_URLS } from "../core/constants.js";

// ---------------------------------------------------------------------------
// System providers (built-in defaults)
// ---------------------------------------------------------------------------

const SYSTEM_PROVIDERS: Omit<Provider, "id" | "createdAt" | "updatedAt">[] = [
	{
		name: "OpenAI",
		type: "openai",
		apiKey: "",
		baseUrl: DEFAULT_URLS.openai,
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
		baseUrl: DEFAULT_URLS.ollama,
		models: [],
		enabled: false,
		isSystem: true,
	},
];

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "type" },
	{ key: "apiKey", column: "api_key" },
	{ key: "baseUrl", column: "base_url" },
	{ key: "models", json: true },
	{ key: "enabled", bool: true },
	{ key: "isSystem", column: "is_system", bool: true },
		{ key: "enableConcurrencyLimit", column: "enable_concurrency_limit", bool: true },
		{ key: "maxConcurrency", column: "max_concurrency" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// ProviderStore
// ---------------------------------------------------------------------------

export class ProviderStore {
	private store: SqliteStore<Provider>;
	private db: SessionDB;

	constructor(sessionDB: SessionDB) {
		this.db = sessionDB;
		this.store = new SqliteStore<Provider>(sessionDB.getDb(), "providers", COLUMNS);

		// Merge system providers (creates missing ones, adds new models)
		this.mergeSystemProviders();
	}

	private mergeSystemProviders(): void {
		const existing = this.store.list();
		for (const sys of SYSTEM_PROVIDERS) {
			const match = existing.find((p) => p.isSystem && p.name === sys.name);
			if (!match) {
				this.store.create({
					...sys,
					isSystem: true,
				} as any);
			} else {
				// Merge new models
				let dirty = false;
				const models = [...match.models];
				for (const model of sys.models) {
					if (!models.some((m) => m.id === model.id)) {
						models.push(model);
						dirty = true;
					}
				}
				if (dirty) {
					this.store.update(match.id, { models } as any);
				}
			}
		}
	}

	list(): Provider[] {
		return this.store.list();
	}

	get(id: string): Provider | undefined {
		return this.store.get(id);
	}

	create(input: Omit<Provider, "id" | "createdAt" | "updatedAt">): Provider {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<Provider, "id" | "createdAt">>): Provider {
		return this.store.update(id, input as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}

	addModel(providerId: string, model: ProviderModel): Provider {
		const provider = this.get(providerId);
		if (!provider) throw new Error(`Provider not found: ${providerId}`);
		if (provider.models.some((m) => m.id === model.id)) {
			throw new Error(`Model ${model.id} already exists`);
		}
		provider.models.push(model);
		return this.store.update(providerId, { models: provider.models } as any);
	}

	removeModel(providerId: string, modelId: string): Provider {
		const provider = this.get(providerId);
		if (!provider) throw new Error(`Provider not found: ${providerId}`);
		provider.models = provider.models.filter((m) => m.id !== modelId);
		return this.store.update(providerId, { models: provider.models } as any);
	}
}
