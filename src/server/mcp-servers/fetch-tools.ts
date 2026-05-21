import { z } from "zod";
import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import { buildTool } from "../../runtime/tools/tool-factory.js";

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

export function createFetchTools() {
	return {
		fetch_html: buildTool({
			name: "fetch_html",
			description: "Fetch a website and return the content as HTML",
			meta: { category: "fetch", maxResultSize: 50000 },
			inputSchema: z.object({
				url: z.string().describe("URL of the website to fetch"),
				headers: z.record(z.string(), z.string()).optional().describe("Optional headers"),
			}),
			execute: async ({ url, headers }) => {
				try {
					const resp = await fetchUrl(url, headers);
					return await resp.text();
				} catch (err: any) {
					return `Error: ${err.message}`;
				}
			},
		}),
		fetch_markdown: buildTool({
			name: "fetch_markdown",
			description: "Fetch a website and return the content as Markdown",
			meta: { category: "fetch", maxResultSize: 50000 },
			inputSchema: z.object({
				url: z.string().describe("URL of the website to fetch"),
				headers: z.record(z.string(), z.string()).optional().describe("Optional headers"),
			}),
			execute: async ({ url, headers }) => {
				try {
					const resp = await fetchUrl(url, headers);
					const html = await resp.text();
					return turndown.turndown(html);
				} catch (err: any) {
					return `Error: ${err.message}`;
				}
			},
		}),
		fetch_text: buildTool({
			name: "fetch_text",
			description: "Fetch a website and return the content as plain text (no HTML tags)",
			meta: { category: "fetch", maxResultSize: 50000 },
			inputSchema: z.object({
				url: z.string().describe("URL of the website to fetch"),
				headers: z.record(z.string(), z.string()).optional().describe("Optional headers"),
			}),
			execute: async ({ url, headers }) => {
				try {
					const resp = await fetchUrl(url, headers);
					const html = await resp.text();
					const dom = new JSDOM(html);
					const doc = dom.window.document;
					for (const el of [...doc.getElementsByTagName("script"), ...doc.getElementsByTagName("style")]) {
						el.remove();
					}
					return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
				} catch (err: any) {
					return `Error: ${err.message}`;
				}
			},
		}),
		fetch_json: buildTool({
			name: "fetch_json",
			description: "Fetch a JSON file from a URL",
			meta: { category: "fetch", maxResultSize: 50000 },
			inputSchema: z.object({
				url: z.string().describe("URL of the JSON to fetch"),
				headers: z.record(z.string(), z.string()).optional().describe("Optional headers"),
			}),
			execute: async ({ url, headers }) => {
				try {
					const resp = await fetchUrl(url, headers);
					const json = await resp.json();
					return JSON.stringify(json, null, 2);
				} catch (err: any) {
					return `Error: ${err.message}`;
				}
			},
		}),
	};
}
