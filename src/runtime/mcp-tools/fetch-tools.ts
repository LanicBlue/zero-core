import { z } from "zod";
import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import { buildTool } from "../tools/tool-factory.js";

const turndown = new TurndownService();

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchUrl(url: string, headers?: Record<string, string>): Promise<Response> {
	const resp = await fetch(url, {
		headers: { "User-Agent": UA, ...headers },
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
	return resp;
}

function htmlToText(html: string): string {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	for (const el of [...doc.getElementsByTagName("script"), ...doc.getElementsByTagName("style")]) {
		el.remove();
	}
	return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

export const webFetchTool = buildTool({
	name: "WebFetch",
	description: "Fetch a URL and return the content in markdown, HTML, text, or JSON format.",
	prompt: "Fetch a URL and return its content in the specified format.\n\n" +
		"When to use WebFetch:\n" +
		"- Reading documentation pages found via WebSearch\n" +
		"- Fetching API endpoint responses (use format=\"json\")\n" +
		"- Reading raw content from GitHub or similar platforms\n\n" +
		"Format selection:\n" +
		"- markdown (default): best for web pages, converts HTML to clean markdown\n" +
		"- json: best for API endpoints, returns raw JSON\n" +
		"- text: plain text extraction, strips all HTML\n" +
		"- html: raw HTML source\n\n" +
		"Combine with WebSearch: search first, then fetch the most promising results.\n" +
		"Use headers parameter for APIs requiring authentication or specific content types.",
	meta: { category: "web", isReadOnly: true },
	configSchema: [
		{ key: "format", type: "select", label: "Default format", default: "markdown", options: ["markdown", "html", "text", "json"], description: "默认输出格式" },
	],
	inputSchema: z.object({
		url: z.string().describe("URL to fetch"),
		format: z.enum(["markdown", "html", "text", "json"]).optional().describe("Output format (default: markdown)"),
		headers: z.record(z.string(), z.string()).optional().describe("Optional request headers"),
	}),
	execute: async ({ url, format, headers }) => {
		try {
			const resp = await fetchUrl(url, headers);
			const fmt = format ?? "markdown";

			if (fmt === "json") {
				const json = await resp.json();
				return JSON.stringify(json, null, 2);
			}

			const html = await resp.text();

			switch (fmt) {
				case "html":
					return html;
				case "text":
					return htmlToText(html);
				case "markdown":
				default:
					return turndown.turndown(html);
			}
		} catch (err: any) {
			return `Error: ${err.message}`;
		}
	},
});
