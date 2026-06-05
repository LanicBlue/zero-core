// 网页抓取与转换工具
//
// # 文件说明书
//
// ## 核心功能
// 抓取网页内容并转换为 Markdown 格式，支持 HTML 到文本的转换
//
// ## 输入
// URL 地址、抓取选项
//
// ## 输出
// Markdown 格式的网页内容
//
// ## 定位
// src/runtime/mcp-tools/ — 内置 MCP 工具，为 agent 提供网页访问能力
//
// ## 依赖
// zod、turndown、jsdom、tools/tool-factory.ts
//
// ## 维护规则
// 目标网站反爬策略变更需更新 User-Agent 和请求逻辑
//
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

const STRIP_TAGS = ["script", "style", "noscript", "iframe", "svg", "link", "meta"];

function getBody(doc: Document): HTMLElement {
	// Prefer semantic main content regions
	const main = doc.querySelector("main, article, [role='main'], #content, .content");
	if (main) return main as HTMLElement;
	return doc.body ?? doc.documentElement;
}

function htmlToText(html: string): string {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	for (const tag of STRIP_TAGS) {
		for (const el of [...doc.getElementsByTagName(tag)]) {
			el.remove();
		}
	}
	const text = (getBody(doc).textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
	return text;
}

function cleanHtml(html: string): string {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	for (const tag of STRIP_TAGS) {
		for (const el of [...doc.getElementsByTagName(tag)]) {
			el.remove();
		}
	}
	return getBody(doc).innerHTML;
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
	execute: async ({ url, format, headers }, ctx) => {
		try {
			const resp = await fetchUrl(url, headers);
			const fmt = format ?? ctx.toolConfig?.WebFetch?.format ?? "markdown";

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
					return turndown.turndown(cleanHtml(html));
			}
		} catch (err: any) {
			return `Error: ${err.message}`;
		}
	},
});
