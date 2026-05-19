// ---------------------------------------------------------------------------
// Embedding providers — OpenAI and Ollama
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
	embed(texts: string[]): Promise<Float32Array[]>;
	dimension: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
	private apiKey: string;
	private baseUrl: string;
	private model: string;
	readonly dimension: number;

	constructor(apiKey: string, baseUrl: string, model: string = "text-embedding-3-small", dimension: number = 1536) {
		this.apiKey = apiKey;
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.model = model;
		this.dimension = dimension;
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return [];

		const resp = await fetch(`${this.baseUrl}/embeddings`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				input: texts,
			}),
		});

		if (!resp.ok) {
			const errText = await resp.text();
			throw new Error(`Embedding API error: ${resp.status} ${errText}`);
		}

		const json = await resp.json() as any;
		return json.data
			.sort((a: any, b: any) => a.index - b.index)
			.map((d: any) => new Float32Array(d.embedding));
	}
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
	private baseUrl: string;
	private model: string;
	readonly dimension: number;

	constructor(baseUrl: string = "http://localhost:11434", model: string = "nomic-embed-text", dimension: number = 768) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.model = model;
		this.dimension = dimension;
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		const results: Float32Array[] = [];
		// Ollama processes one at a time via /api/embeddings
		for (const text of texts) {
			const resp = await fetch(`${this.baseUrl}/api/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.model, prompt: text }),
			});

			if (!resp.ok) {
				throw new Error(`Ollama embedding error: ${resp.status}`);
			}

			const json = await resp.json() as any;
			results.push(new Float32Array(json.embedding));
		}
		return results;
	}
}

export function createEmbeddingProvider(
	provider: string,
	config: { apiKey?: string; baseUrl?: string; model?: string },
): EmbeddingProvider {
	if (provider === "ollama") {
		return new OllamaEmbeddingProvider(
			config.baseUrl ?? "http://localhost:11434",
			config.model ?? "nomic-embed-text",
		);
	}
	// Default to OpenAI-compatible
	return new OpenAIEmbeddingProvider(
		config.apiKey ?? "",
		config.baseUrl ?? "https://api.openai.com/v1",
		config.model ?? "text-embedding-3-small",
	);
}
