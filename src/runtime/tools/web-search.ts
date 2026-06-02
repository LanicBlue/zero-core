import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import { DEFAULT_URLS } from "../../core/constants.js";

// ---------------------------------------------------------------------------
// Web Search — adapter pattern for multiple search backends
// ---------------------------------------------------------------------------

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchProvider {
	name: string;
	search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]>;
}

// ---------------------------------------------------------------------------
// DuckDuckGo Lite — free, no API key required
// ---------------------------------------------------------------------------

const DDG_URL = "https://lite.duckduckgo.com/lite";

class DuckDuckGoProvider implements SearchProvider {
	name = "duckduckgo";

	async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
		const maxResults = options?.maxResults ?? 8;
		try {
			const body = new URLSearchParams({ q: query, kl: "us-en" });
			const resp = await fetch(DDG_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				},
				body: body.toString(),
			});
			const html = await resp.text();

			// Parse DuckDuckGo Lite HTML table
			const results: SearchResult[] = [];
			const linkRegex = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
			const snippetRegex = /<td[^>]+class="result-snippet"[^>]*>(.*?)<\/td>/gi;

			const links: { url: string; title: string }[] = [];
			let match: RegExpExecArray | null;
			while ((match = linkRegex.exec(html)) !== null) {
				links.push({
					url: decodeHTMLEntities(match[1]),
					title: decodeHTMLEntities(match[2]),
				});
			}

			const snippets: string[] = [];
			while ((match = snippetRegex.exec(html)) !== null) {
				snippets.push(decodeHTMLEntities(match[1]));
			}

			for (let i = 0; i < Math.min(links.length, maxResults); i++) {
				results.push({
					title: links[i].title,
					url: links[i].url,
					snippet: snippets[i] ?? "",
				});
			}

			return results;
		} catch (err: any) {
			throw new Error(`DuckDuckGo search failed: ${err.message}`);
		}
	}
}

// ---------------------------------------------------------------------------
// SearXNG — self-hosted meta search engine
// ---------------------------------------------------------------------------

class SearXNGProvider implements SearchProvider {
	name = "searxng";
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
		const maxResults = options?.maxResults ?? 8;
		try {
			const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
			const resp = await fetch(url, {
				headers: { "User-Agent": "Mozilla/5.0" },
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json() as any;

			return (data.results ?? [])
				.slice(0, maxResults)
				.map((r: any) => ({
					title: r.title ?? "",
					url: r.url ?? "",
					snippet: r.content ?? "",
				}));
		} catch (err: any) {
			throw new Error(`SearXNG search failed: ${err.message}`);
		}
	}
}

// ---------------------------------------------------------------------------
// SerpAPI — commercial search API
// ---------------------------------------------------------------------------

class SerpAPIProvider implements SearchProvider {
	name = "serpapi";
	private apiKey: string;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
		const maxResults = options?.maxResults ?? 8;
		try {
			const url = `https://serpapi.com/search?q=${encodeURIComponent(query)}&api_key=${this.apiKey}&engine=google&num=${maxResults}`;
			const resp = await fetch(url);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json() as any;

			return (data.organic_results ?? [])
				.slice(0, maxResults)
				.map((r: any) => ({
					title: r.title ?? "",
					url: r.link ?? "",
					snippet: r.snippet ?? "",
				}));
		} catch (err: any) {
			throw new Error(`SerpAPI search failed: ${err.message}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Brave Search — free tier 2000 queries/month
// ---------------------------------------------------------------------------

class BraveSearchProvider implements SearchProvider {
	name = "brave";
	private apiKey: string;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
		const maxResults = options?.maxResults ?? 8;
		try {
			const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
			const resp = await fetch(url, {
				headers: {
					"X-Subscription-Token": this.apiKey,
					"Accept": "application/json",
				},
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json() as any;

			return (data.web?.results ?? [])
				.slice(0, maxResults)
				.map((r: any) => ({
					title: r.title ?? "",
					url: r.url ?? "",
					snippet: r.description ?? "",
				}));
		} catch (err: any) {
			throw new Error(`Brave search failed: ${err.message}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createSearchProvider(config?: {
	type?: "duckduckgo" | "searxng" | "serpapi" | "brave";
	searxngUrl?: string;
	serpApiKey?: string;
	braveApiKey?: string;
}): SearchProvider {
	const type = config?.type ?? "duckduckgo";
	switch (type) {
		case "searxng":
			return new SearXNGProvider(config?.searxngUrl ?? DEFAULT_URLS.searxng);
		case "serpapi":
			if (!config?.serpApiKey) throw new Error("SerpAPI requires an API key");
			return new SerpAPIProvider(config.serpApiKey);
		case "brave":
			if (!config?.braveApiKey) throw new Error("Brave Search requires an API key");
			return new BraveSearchProvider(config.braveApiKey);
		default:
			return new DuckDuckGoProvider();
	}
}

// Singleton provider (configurable at runtime)
let currentProvider: SearchProvider = new DuckDuckGoProvider();

export function setSearchProvider(provider: SearchProvider): void {
	currentProvider = provider;
}

export function getSearchProvider(): SearchProvider {
	return currentProvider;
}

// ---------------------------------------------------------------------------
// WebSearch tool
// ---------------------------------------------------------------------------

export const webSearchTool = buildTool({
	name: "WebSearch",
	description: "Search the web for up-to-date information. Returns titles, URLs, and snippets.",
	prompt:
		"Search the web for up-to-date information. Returns search results with titles, URLs, and snippets. " +
		"Include a 'Sources:' section in your response with the URLs.",
	meta: { category: "web", isReadOnly: true, maxResultSize: 15000 },
	configSchema: [
		{ key: "provider", type: "select", label: "搜索引擎", default: "duckduckgo", options: ["duckduckgo", "searxng", "serpapi", "brave"] },
		{ key: "maxResults", type: "number", label: "最大结果数", default: 8 },
			{ key: "searxngUrl", type: "string", label: "SearXNG URL", description: "SearXNG 自托管地址" },
			{ key: "serpApiKey", type: "string", label: "SerpAPI Key", description: "SerpAPI 所需的 API Key" },
			{ key: "braveApiKey", type: "string", label: "Brave API Key", description: "Brave Search 所需的 API Key" },
	],
	inputSchema: z.object({
		query: z.string().describe("Search query"),
		maxResults: z.number().optional().describe("Max results (default 8, max 20)"),
	}),
	execute: async ({ query, maxResults }) => {
		try {
			const results = await currentProvider.search(query, {
				maxResults: Math.min(maxResults ?? 8, 20),
			});

			if (results.length === 0) {
				return `No search results found for: "${query}"`;
			}

			const lines: string[] = [];
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				lines.push(`[${i + 1}] ${r.title}`);
				lines.push(`    ${r.url}`);
				if (r.snippet) lines.push(`    ${r.snippet}`);
				lines.push("");
			}

			lines.push("Sources:");
			for (const r of results) {
				if (r.url) lines.push(`- [${r.title}](${r.url})`);
			}

			return lines.join("\n");
		} catch (err: any) {
			return `Search error: ${err.message}`;
		}
	},
});

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function decodeHTMLEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/<[^>]+>/g, "")
		.trim();
}
