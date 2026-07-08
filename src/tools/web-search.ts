// 网页搜索工具
//
// # 文件说明书
//
// ## 核心功能
// 提供网页搜索能力，支持多个搜索后端。
//
// ## 输入
// - 搜索查询
// - 搜索后端（可选）
//
// ## 输出
// - 搜索结果列表
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - ../../core/constants - 默认配置
//
// ## 维护规则
// - 新增搜索后端时需更新
// - 保持结果格式一致
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import { DEFAULT_URLS } from "../core/constants.js";

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
// DuckDuckGo HTML — free, no API key required
// Uses html.duckduckgo.com which has stable class names: result__a, result__snippet
// Falls back to lite.duckduckgo.com with generic table parsing.
// ---------------------------------------------------------------------------

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_LITE_URL = "https://lite.duckduckgo.com/lite";

function isDDGCaptcha(html: string): boolean {
	return /anomaly-modal|bots use DuckDuckGo|challenge to confirm/i.test(html);
}

class DuckDuckGoProvider implements SearchProvider {
	name = "duckduckgo";

	async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
		const maxResults = options?.maxResults ?? 8;
		// Try the HTML endpoint first (stable class names)
		const htmlResults = await this.searchHtml(query, maxResults);
		if (htmlResults.length > 0) return htmlResults;

		// Fallback to Lite endpoint with generic table parsing
		return this.searchLite(query, maxResults);
	}

	private async searchHtml(query: string, maxResults: number): Promise<SearchResult[]> {
		const resp = await fetch(`${DDG_HTML_URL}?q=${encodeURIComponent(query)}`, {
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			},
		});
		const html = await resp.text();
		if (isDDGCaptcha(html)) throw new Error("DuckDuckGo returned a CAPTCHA challenge — try another search provider (SearXNG, Brave, SerpAPI) in Tools > WebSearch");

		const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
		const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

		const links: { url: string; title: string }[] = [];
		let match: RegExpExecArray | null;
		while ((match = linkRegex.exec(html)) !== null) {
			links.push({ url: decodeHTMLEntities(match[1]), title: decodeHTMLEntities(match[2]) });
		}

		const snippets: string[] = [];
		while ((match = snippetRegex.exec(html)) !== null) {
			snippets.push(decodeHTMLEntities(match[1]));
		}

		const results: SearchResult[] = [];
		for (let i = 0; i < Math.min(links.length, maxResults); i++) {
			results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
		}
		return results;
	}

	private async searchLite(query: string, maxResults: number): Promise<SearchResult[]> {
		const body = new URLSearchParams({ q: query, kl: "us-en" });
		const resp = await fetch(DDG_LITE_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			},
			body: body.toString(),
		});
		const html = await resp.text();
		if (isDDGCaptcha(html)) throw new Error("DuckDuckGo returned a CAPTCHA challenge — try another search provider (SearXNG, Brave, SerpAPI) in Tools > WebSearch");

		// Generic table parsing: extract external links from table rows
		const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
		const rows: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = rowRegex.exec(html)) !== null) rows.push(match[1]);

		const results: SearchResult[] = [];
		for (let i = 0; i < rows.length && results.length < maxResults; i++) {
			const aMatch = /<a[^>]+href="(https?:\/\/(?!duckduckgo\.com)[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(rows[i]);
			if (!aMatch) continue;
			const title = decodeHTMLEntities(aMatch[2]);
			if (!title) continue;

			// Look for snippet in the next row
			let snippet = "";
			if (i + 1 < rows.length) {
				const tdMatch = /<td[^>]*>([\s\S]*?)<\/td>/gi.exec(rows[i + 1]);
				if (tdMatch) snippet = decodeHTMLEntities(tdMatch[1]);
			}

			results.push({ title, url: decodeHTMLEntities(aMatch[1]), snippet });
		}
		return results;
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
			throw new Error(`SearXNG search failed: ${err.message}.`);
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
			throw new Error(`SerpAPI search failed: ${err.message}.`);
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
			throw new Error(`Brave search failed: ${err.message}.`);
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

// ---------------------------------------------------------------------------
// WebSearch tool
// ---------------------------------------------------------------------------

export const webSearchTool = buildTool({
	name: "WebSearch",
	description: "Search the web for up-to-date information. Returns titles, URLs, and snippets.",
		prompt: "Search the web for up-to-date information not available locally.\n\n" +
			"When to use WebSearch:\n" +
			"- Current events, recent data, or information after your knowledge cutoff\n" +
			"- Documentation or API references not available locally\n" +
			"- Factual verification of claims or technical details\n\n" +
			"When NOT to use:\n" +
			"- Code understanding: use Read, Grep, Glob instead\n" +
			"- File contents: use Read or Grep instead\n\n" +
			"Query tips: be specific, include year for time-sensitive topics.\n" +
			"IMPORTANT: Always include a Sources section with markdown links.",
	meta: { category: "web", isReadOnly: true, maxResultSize: 15000 },
	configSchema: [
		{ key: "provider", type: "select", label: "搜索引擎", options: ["duckduckgo", "searxng", "serpapi", "brave"] },
		{ key: "maxResults", type: "number", label: "最大结果数", default: 8 },
			{ key: "searxngUrl", type: "string", label: "SearXNG URL", description: "SearXNG 自托管地址" },
			{ key: "serpApiKey", type: "string", label: "SerpAPI Key", description: "SerpAPI 所需的 API Key" },
			{ key: "braveApiKey", type: "string", label: "Brave API Key", description: "Brave Search 所需的 API Key" },
			{ key: "minInterval", type: "number", label: "最小间隔(ms)", default: 0, description: "两次调用最小间隔，0=不限速" },
			{ key: "maxConcurrent", type: "number", label: "最大并发", default: 0, description: "最大并发数，0=不限制" },
	],
	inputSchema: z.object({
		query: z.string().describe("Search query"),
		maxResults: z.number().optional().describe("Max results (default 8, max 20)"),
	}),
	execute: async ({ query, maxResults }, ctx) => {
		const cfg = ctx.toolConfig?.WebSearch;
		const provider = cfg?.provider
			? createSearchProvider({ type: cfg.provider, searxngUrl: cfg.searxngUrl, serpApiKey: cfg.serpApiKey, braveApiKey: cfg.braveApiKey })
			: currentProvider;
		console.log(`[WebSearch] provider=${provider.name}, proxy checking...`);
		try { const { isProxyActive } = await import("../runtime/proxy-manager.js"); console.log(`[WebSearch] proxy active=${isProxyActive()}`); } catch {}

		const results = await provider.search(query, {
			maxResults: Math.min(maxResults ?? cfg?.maxResults ?? 8, 20),
		});

		if (results.length === 0) {
			throw new Error(`No search results found for: "${query}". DuckDuckGo may be blocked in your network — configure a different search provider (SearXNG, Brave, SerpAPI) in Tools > WebSearch.`);
		}

		const lines: string[] = [];
		lines.push(`Found ${results.length} result${results.length > 1 ? "s" : ""} for: "${query}"`);
		lines.push("");

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

		return lines.join(String.fromCharCode(10));
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
