// 网页抓取与转换工具
//
// # 文件说明书
//
// ## 核心功能
// 抓取网页内容并转换为 Markdown 格式，支持缓存、大结果存盘、图片/链接提取、浏览器渲染
//
// ## 输入
// URL 地址、格式、超时、缓存控制、输出选项、渲染模式
//
// ## 输出
// Markdown / HTML / Text / JSON 格式内容
//
// ## 定位
// src/runtime/mcp-tools/ — 内置 MCP 工具，为 agent 提供网页访问能力
//
// ## 依赖
// zod、turndown、jsdom、node:crypto、node:fs、node:path、tools/tool-factory.ts
//
// ## 维护规则
// 目标网站反爬策略变更需更新 User-Agent 和请求逻辑
//
import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import { buildTool } from "../tools/tool-factory.js";
import { renderWithBrowser } from "./browser-render.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const turndown = new TurndownService();

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const STRIP_TAGS = ["script", "style", "noscript", "iframe", "svg", "link", "meta"];
const STRIP_TAGS_KEEP_IMG = ["script", "style", "noscript", "iframe", "svg", "link", "meta"];

const RESULT_PERSIST_THRESHOLD = 30_000;
const RESULT_PREVIEW_CHARS = 2000;
const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_CACHE_ENTRIES = 50;

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".zero-core", "webfetch");
const CACHE_DIR = join(BASE_DIR, "cache");
const RESULTS_DIR = join(BASE_DIR, "results");
const COOKIES_FILE = join(BASE_DIR, "cookies.json");

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

function getCacheDir(): string {
	ensureDir(CACHE_DIR);
	return CACHE_DIR;
}

function getResultsDir(): string {
	ensureDir(RESULTS_DIR);
	return RESULTS_DIR;
}

function urlHash(url: string): string {
	return createHash("sha256").update(url).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

function readCache(key: string, ttlMs: number): string | null {
	const dir = getCacheDir();
	try {
		const files = readdirSync(dir).filter(f => f.startsWith(key + "."));
		if (files.length === 0) return null;
		const filePath = join(dir, files[0]);
		const stat = statSync(filePath);
		if (Date.now() - stat.mtimeMs > ttlMs) {
			unlinkSync(filePath);
			return null;
		}
		return readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function writeCache(key: string, format: string, content: string): void {
	const dir = getCacheDir();
	const filePath = join(dir, `${key}.${format}`);
	try {
		writeFileSync(filePath, content, "utf-8");
		// LRU: evict oldest files if over limit
		const files = readdirSync(dir).map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => a.mtime - b.mtime);
		while (files.length > MAX_CACHE_ENTRIES) {
			unlinkSync(join(dir, files.shift()!.name));
		}
	} catch { /* cache write failure is non-critical */ }
}

// ---------------------------------------------------------------------------
// Result persistence (large outputs / binary)
// ---------------------------------------------------------------------------

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function persistResult(content: string, ext: string): string {
	const dir = getResultsDir();
	const filePath = join(dir, `webfetch-${generateId()}.${ext}`);
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

function persistBinary(buffer: ArrayBuffer, ext: string): string {
	const dir = getResultsDir();
	const filePath = join(dir, `webfetch-${generateId()}.${ext}`);
	writeFileSync(filePath, Buffer.from(buffer));
	return filePath;
}

function cleanupExpired(dir: string, maxAgeMs: number): void {
	try {
		const now = Date.now();
		for (const f of readdirSync(dir)) {
			const fp = join(dir, f);
			if (now - statSync(fp).mtimeMs > maxAgeMs) {
				unlinkSync(fp);
			}
		}
	} catch { /* cleanup failure is non-critical */ }
}

// ---------------------------------------------------------------------------
// Binary content detection
// ---------------------------------------------------------------------------

const BINARY_TYPES = [
	"image/", "application/pdf", "application/zip", "application/x-",
	"application/octet-stream", "audio/", "video/",
	"application/vnd.openxmlformats", "application/vnd.ms-",
];

function isBinaryContentType(ct: string): boolean {
	const lower = ct.toLowerCase().split(";")[0].trim();
	return BINARY_TYPES.some(t => lower.startsWith(t));
}

const MIME_EXT: Record<string, string> = {
	"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
	"image/svg+xml": "svg", "image/bmp": "bmp", "image/x-icon": "ico",
	"application/pdf": "pdf", "application/zip": "zip",
	"application/x-tar": "tar", "application/gzip": "gz",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.ms-excel": "xls",
	"audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
	"video/mp4": "mp4", "video/webm": "webm",
};

function mimeToExt(ct: string): string {
	const base = ct.toLowerCase().split(";")[0].trim();
	return MIME_EXT[base] ?? "bin";
}

// ---------------------------------------------------------------------------
// HTML processing
// ---------------------------------------------------------------------------

function getBody(doc: Document): HTMLElement {
	const main = doc.querySelector("main, article, [role='main'], #content, .content");
	if (main) return main as HTMLElement;
	return doc.body ?? doc.documentElement;
}

function stripTags(doc: Document, tags: string[]): void {
	for (const tag of tags) {
		for (const el of [...doc.getElementsByTagName(tag)]) {
			el.remove();
		}
	}
}

function htmlToText(html: string, retainImages: boolean): string {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const tags = retainImages ? STRIP_TAGS_KEEP_IMG : [...STRIP_TAGS_KEEP_IMG, "img"];
	stripTags(doc, tags);
	const text = (getBody(doc).textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
	return text;
}

function cleanHtml(html: string, retainImages: boolean): string {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const tags = retainImages ? STRIP_TAGS_KEEP_IMG : [...STRIP_TAGS_KEEP_IMG, "img"];
	stripTags(doc, tags);
	return getBody(doc).innerHTML;
}

// ---------------------------------------------------------------------------
// Image / Link extraction
// ---------------------------------------------------------------------------

function extractImageSummary(html: string): string[] {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const imgs = [...doc.querySelectorAll("img")];
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const img of imgs) {
		const src = img.getAttribute("src");
		if (!src || seen.has(src)) continue;
		seen.add(src);
		const alt = img.getAttribute("alt") ?? "";
		lines.push(`- ![${alt}](${src})`);
	}
	return lines;
}

function extractLinksSummary(html: string): string[] {
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const anchors = [...doc.querySelectorAll("a[href]")];
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const a of anchors) {
		const href = a.getAttribute("href");
		if (!href || href.startsWith("#") || href.startsWith("javascript:") || seen.has(href)) continue;
		seen.add(href);
		const text = (a.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
		lines.push(`- [${text}](${href})`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// SPA detection
// ---------------------------------------------------------------------------

function looksLikeSpa(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;
	const body = bodyMatch[1];
	const hasSpaRoot = /<div\s+id=["'](?:root|app|__next|__nuxt|___gatsby)["']/i.test(body);
	if (!hasSpaRoot) return false;
	const hasScriptBundle = /<script[^>]+src=["'][^"']+\.(js|mjs)["']/i.test(body);
	if (!hasScriptBundle) return false;
	const textContent = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "").trim();
	return textContent.length < 200;
}

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

async function fetchUrl(url: string, headers: Record<string, string>, timeoutSec: number, cookies?: Record<string, string>): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
	try {
		const resp = await fetch(url, {
			headers: (() => {
			const h: Record<string, string> = { "User-Agent": UA, "Accept": "text/markdown, text/html, */*" };
			if (cookies && Object.keys(cookies).length > 0) {
				h["Cookie"] = Object.entries(cookies).map(([k, v]) => k + "=" + v).join("; ");
			}
			Object.assign(h, headers);
			return h;
		})(),
			signal: controller.signal,
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
		return resp;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Cookie jar — persisted to ~/.zero-core/webfetch/cookies.json
// Structure: { domain: { name: { value, expires, path } } }
// ---------------------------------------------------------------------------

interface CookieEntry { value: string; expires: number; path: string }
type CookieJar = Record<string, Record<string, CookieEntry>>;

let cookieJar: CookieJar = {};

function loadCookies(): void {
	try {
		ensureDir(BASE_DIR);
		const raw = readFileSync(COOKIES_FILE, "utf-8");
		cookieJar = JSON.parse(raw);
		// Purge expired
		const now = Date.now();
		for (const domain of Object.keys(cookieJar)) {
			const entries = cookieJar[domain];
			for (const name of Object.keys(entries)) {
				if (entries[name].expires > 0 && entries[name].expires < now) {
					delete entries[name];
				}
			}
			if (Object.keys(entries).length === 0) delete cookieJar[domain];
		}
	} catch { /* file may not exist yet */ }
}

function saveCookies(): void {
	try {
		ensureDir(BASE_DIR);
		writeFileSync(COOKIES_FILE, JSON.stringify(cookieJar, null, 2), "utf-8");
	} catch { /* non-critical */ }
}

function getDomain(url: string): string {
	try { return new URL(url).hostname; } catch { return ""; }
}

function getCookiesForUrl(url: string): Record<string, string> {
	const domain = getDomain(url);
	if (!domain) return {};
	const now = Date.now();
	const cookies: Record<string, string> = {};
	for (const [jarDomain, entries] of Object.entries(cookieJar)) {
		// Match exact domain or parent domain (subdomain sharing)
		if (jarDomain !== domain && !domain.endsWith('.' + jarDomain)) continue;
		for (const [name, entry] of Object.entries(entries)) {
			if (entry.expires > 0 && entry.expires < now) continue;
			if (entry.path && !url.includes(entry.path)) continue;
			cookies[name] = entry.value;
		}
	}
	return cookies;
}

function storeCookiesFromResponse(url: string, resp: Response): void {
	const domain = getDomain(url);
	if (!domain) return;
	const setCookieHeaders = resp.headers.getSetCookie?.() ?? [];
	if (setCookieHeaders.length === 0) {
		const raw = resp.headers.get('set-cookie');
		if (raw) setCookieHeaders.push(...raw.split(', ').filter((h: string) => h.includes('=')));
	}
	if (setCookieHeaders.length === 0) return;
	if (!cookieJar[domain]) cookieJar[domain] = {};
	for (const header of setCookieHeaders) {
		const parts = header.split(';').map((p: string) => p.trim());
		const nameVal = parts[0] ?? '';
		const eqIdx = nameVal.indexOf('=');
		if (eqIdx === -1) continue;
		const name = nameVal.slice(0, eqIdx);
		const value = nameVal.slice(eqIdx + 1);
		let expires = 0;
		let path = '/';
		for (const part of parts.slice(1)) {
			const lower = part.toLowerCase();
			if (lower.startsWith('max-age=')) {
				const sec = parseInt(part.split('=')[1], 10);
				if (!isNaN(sec) && sec > 0) expires = Date.now() + sec * 1000;
			} else if (lower.startsWith('expires=')) {
				const d = new Date(part.split('=').slice(1).join('='));
				if (!isNaN(d.getTime())) expires = d.getTime();
			} else if (lower.startsWith('path=')) {
				path = part.split('=')[1] ?? '/';
			}
		}
		cookieJar[domain][name] = { value, expires, path };
	}
	saveCookies();
}

// Exported for login handler
export function importCookies(domain: string, cookies: Array<{ name: string; value: string; expires?: number; path?: string }>): number {
	if (!cookieJar[domain]) cookieJar[domain] = {};
	let count = 0;
	for (const c of cookies) {
		cookieJar[domain][c.name] = { value: c.value, expires: c.expires ?? 0, path: c.path ?? "/" };
		count++;
	}
	saveCookies();
	return count;
}

export function getCookieCount(): Record<string, number> {
	const result: Record<string, number> = {};
	for (const [domain, entries] of Object.entries(cookieJar)) {
		result[domain] = Object.keys(entries).length;
	}
	return result;
}

export function clearCookies(domain?: string): void {
	if (domain) {
		delete cookieJar[domain];
	} else {
		cookieJar = {};
	}
	saveCookies();
}

// Load cookies on module init
loadCookies();

// ---------------------------------------------------------------------------
// Startup cleanup
// ---------------------------------------------------------------------------

try {
	cleanupExpired(CACHE_DIR, 24 * 60 * 60 * 1000);
	cleanupExpired(RESULTS_DIR, 24 * 60 * 60 * 1000);
} catch { /* dirs may not exist yet */ }

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const webFetchTool = buildTool({
	name: "WebFetch",
	description: "Fetch a URL and return the content in markdown, HTML, text, or JSON format.",
	prompt:
		"Fetch a URL and return its content in the specified format.\n\n" +
		"When to use WebFetch:\n" +
		"- Reading documentation pages found via WebSearch\n" +
		"- Fetching API endpoint responses (use format=\"json\")\n" +
		"- Reading raw content from GitHub or similar platforms\n\n" +
		"Format selection:\n" +
		"- markdown (default): best for web pages, converts HTML to clean markdown\n" +
		"- json: best for API endpoints, returns raw JSON\n" +
		"- text: plain text extraction, strips all HTML\n" +
		"- html: raw HTML source\n\n" +
		"Options:\n" +
		"- retainImages: keep images in markdown output (default: true)\n" +
		"- withLinksSummary: append a list of all links found on the page\n" +
		"- withImageSummary: append a list of all images found on the page\n" +
		"- timeout: override request timeout in seconds (default: 30)\n" +
		"- noCache: force fresh fetch, ignoring cached response\n\n" +
		"Render modes (configurable in Tools page):\n" +
		"- fetch: plain HTTP request (fastest, but cannot render JavaScript)\n" +
		"- browser: renders the page in a browser, executing JavaScript (slower)\n" +
		"- auto (default): tries HTTP first, automatically switches to browser for SPA sites\n\n" +
		"Large results: if the response exceeds 30,000 characters, the full content is saved to disk " +
		"and a preview with the file path is returned. Use FileRead to access the full content.\n\n" +
		"Combine with WebSearch: search first, then fetch the most promising results.\n" +
		"Use headers parameter for APIs requiring authentication or specific content types.\n\n" +
		"Cookie support: WebFetch automatically sends saved cookies for matching domains. " +
		"Use the login feature in the Tools page to save cookies by logging into websites through a browser window.",
	meta: { category: "web", isReadOnly: true },
	configSchema: [
		{ key: "format", type: "select", label: "Default format", default: "markdown", options: ["markdown", "html", "text", "json"], description: "默认输出格式" },
		{ key: "timeout", type: "number", label: "请求超时 (s)", default: 30, description: "HTTP 请求超时时间" },
		{ key: "noCache", type: "boolean", label: "禁用缓存", default: false, description: "每次都重新抓取" },
		{ key: "cacheTTL", type: "number", label: "缓存过期 (s)", default: 300, description: "缓存有效期（秒）" },
		{ key: "retainImages", type: "boolean", label: "保留图片", default: true, description: "Markdown 输出中保留图片" },
		{ key: "maxContentSize", type: "number", label: "最大响应 (MB)", default: 10, description: "最大允许的响应体大小" },
		{ key: "useCookies", type: "boolean", label: "启用 Cookie", default: true, description: "自动发送已保存的 Cookie" },
		{ key: "renderMode", type: "select", label: "渲染模式", default: "auto", options: ["fetch", "browser", "auto"], description: "fetch=纯HTTP, browser=浏览器渲染, auto=自动检测SPA" },
		{ key: "renderDelay", type: "number", label: "渲染等待 (s)", default: 3, description: "浏览器渲染后等待JS执行的秒数" },
	],
	inputSchema: z.object({
		url: z.string().describe("URL to fetch"),
		format: z.enum(["markdown", "html", "text", "json"]).optional().describe("Output format (default: markdown)"),
		headers: z.record(z.string(), z.string()).optional().describe("Optional request headers"),
		timeout: z.number().optional().describe("Request timeout in seconds (default: 30)"),
		retainImages: z.boolean().optional().describe("Keep images in markdown output (default: true)"),
		withLinksSummary: z.boolean().optional().describe("Append extracted links summary"),
		withImageSummary: z.boolean().optional().describe("Append extracted images summary"),
		noCache: z.boolean().optional().describe("Skip cache, force fresh fetch"),
		renderMode: z.enum(["fetch", "browser", "auto"]).optional().describe("Override render mode: fetch=HTTP only, browser=render JS, auto=detect SPA"),
	}),
	execute: async (input, ctx) => {
		const { url, headers } = input;
		const config = ctx.toolConfig?.WebFetch ?? {};
		const fmt = input.format ?? config.format ?? "markdown";
		const timeoutSec = input.timeout ?? config.timeout ?? 30;
		const retainImages = input.retainImages ?? config.retainImages ?? true;
		const noCache = input.noCache ?? config.noCache ?? false;
		const cacheTTL = (config.cacheTTL ?? 300) * 1000;
		const maxBytes = (config.maxContentSize ?? 10) * 1024 * 1024;
		const renderMode = input.renderMode ?? config.renderMode ?? "auto";
		const renderDelay = config.renderDelay ?? 3;

		// Step 1: Check cache
		const cacheKey = urlHash(url);
		if (!noCache && fmt !== "json") {
			const cached = readCache(cacheKey + "." + fmt, cacheTTL);
			if (cached !== null) {
				let result = cached;
				result = appendSummaries(result, input, url);
				return handleLargeResult(result);
			}
		}

		// Step 2: Get HTML content
		try {
			let html: string;

			if (renderMode === "browser") {
				// Browser-only: render page with BrowserWindow (login cookies are automatic)
				const rendered = await renderWithBrowser(url, { renderDelay, timeout: timeoutSec });
				html = rendered.html;
			} else {
				// HTTP fetch (fetch or auto mode)
				const useCookies = config.useCookies !== false;
				const cookies = useCookies ? getCookiesForUrl(url) : undefined;
				const resp = await fetchUrl(url, headers ?? {}, timeoutSec, cookies);
				if (useCookies) storeCookiesFromResponse(url, resp);
				const ct = resp.headers.get("content-type") ?? "";

				// Binary content — return directly (not applicable to browser rendering)
				if (isBinaryContentType(ct)) {
					const buf = await resp.arrayBuffer();
					if (buf.byteLength > maxBytes) {
						throw new Error(`Response too large (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB). Maximum is ${(maxBytes / 1024 / 1024).toFixed(0)}MB.`);
					}
					const ext = mimeToExt(ct);
					const path = persistBinary(buf, ext);
					return `Binary content saved to: ${path}\nSize: ${(buf.byteLength / 1024).toFixed(1)}KB\nType: ${ct}`;
				}

				// JSON format — return directly
				if (fmt === "json") {
					if (ct.includes("html")) {
						const rawHtml = await resp.text();
						const md = turndown.turndown(cleanHtml(rawHtml, retainImages));
						throw new Error(
							`The response from ${url} is HTML (Content-Type: ${ct}), not JSON. ` +
							`Use format="markdown" or format="html" instead. ` +
							`Preview of the page content:\n${md.slice(0, 2000)}`,
						);
					}
					const json = await resp.json();
					const result = JSON.stringify(json, null, 2);
					return handleLargeResult(result);
				}

				html = await resp.text();

				// Size check
				if (html.length > maxBytes) {
					throw new Error(`Response too large (${(html.length / 1024 / 1024).toFixed(1)}MB). Maximum is ${(maxBytes / 1024 / 1024).toFixed(0)}MB.`);
				}

				// Auto mode: detect SPA and retry with browser rendering
				if (renderMode === "auto" && looksLikeSpa(html)) {
					const rendered = await renderWithBrowser(url, { renderDelay, timeout: timeoutSec });
					html = rendered.html;
				}
			}

			// Step 3: Convert to requested format
			let result: string;
			switch (fmt) {
				case "html":
					result = html;
					break;
				case "text":
					result = htmlToText(html, retainImages);
					break;
				case "markdown":
				default:
					result = turndown.turndown(cleanHtml(html, retainImages));
					break;
			}

			// Truncate very long markdown
			if (result.length > MAX_MARKDOWN_LENGTH) {
				result = result.slice(0, MAX_MARKDOWN_LENGTH) +
					`\n\n[Content truncated: ${result.length.toLocaleString()} → ${MAX_MARKDOWN_LENGTH.toLocaleString()} characters]`;
			}

			// Write to cache
			if (!noCache) {
				writeCache(cacheKey, fmt, result);
			}

			// Step 4: Append summaries
			result = appendSummaries(result, input, html);

			return handleLargeResult(result);
		} catch (err: any) {
			const msg = err.message ?? String(err);
			if (/HTTP (401|403)/.test(msg)) {
				throw new Error(`Access denied fetching ${url}. The site may require authentication. Try using the login feature in Tools page to save cookies, or check if the site blocks automated requests.`);
			}
			if (/HTTP (404|410)/.test(msg)) {
				throw new Error(`Page not found: ${url}. The URL may be incorrect or the page has been removed. Verify the URL and try again.`);
			}
			if (/HTTP (429|503)/.test(msg)) {
				throw new Error(`Rate-limited or temporarily unavailable: ${url}. The server is throttling requests or under maintenance. Wait a moment and retry.`);
			}
			if (/HTTP 5\d\d/.test(msg)) {
				throw new Error(`Server error fetching ${url}: ${msg}. The remote server encountered an internal error. Try again later.`);
			}
			if (/is not valid JSON/.test(msg)) {
				throw new Error(`The response from ${url} is not valid JSON. The URL likely returns HTML. Use format="markdown" or format="html" instead of format="json".`);
			}
			if (/abort/i.test(msg)) {
				throw new Error(`Request to ${url} timed out after ${timeoutSec}s. The server may be slow or unresponsive. Try increasing the timeout.`);
			}
			if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
				throw new Error(`Network error fetching ${url}: ${msg}. Check that the URL is correct, the host is reachable, and proxy settings are configured if needed.`);
			}
			throw new Error(`Failed to fetch ${url}: ${msg}`);
		}
	},
});

// ---------------------------------------------------------------------------
// Helpers for execute
// ---------------------------------------------------------------------------

function appendSummaries(result: string, input: any, html: string): string {
	if (input.withImageSummary) {
		const images = extractImageSummary(html);
		if (images.length > 0) {
			result += `\n\n---\n## Images (${images.length})\n${images.join("\n")}`;
		}
	}
	if (input.withLinksSummary) {
		const links = extractLinksSummary(html);
		if (links.length > 0) {
			result += `\n\n---\n## Links (${links.length})\n${links.slice(0, 200).join("\n")}`;
		}
	}
	return result;
}

function handleLargeResult(result: string): string {
	if (result.length <= RESULT_PERSIST_THRESHOLD) return result;
	const ext = result.trimStart().startsWith("{") ? "json" : "md";
	const filePath = persistResult(result, ext);
	const preview = result.slice(0, RESULT_PREVIEW_CHARS);
	return (
		`${preview}\n\n` +
		`---\n[Result too large (${result.length.toLocaleString()} chars). Full content saved to: ${filePath}]\n` +
		`Use the Read tool to access the complete content.`
	);
}
