// 模板 REST API 路由
//
// # 文件说明书
//
// ## 核心功能
// 提供 Agent 模板的 Express REST API 路由（列表、创建、更新、删除、GitHub 同步）
//
// ## 输入
// HTTP 请求、TemplateStore、CoreDatabase (for cache)
//
// ## 输出
// Express Router，处理模板 CRUD + GitHub 导入 API
//
// ## 定位
// src/server/ — 服务层，为外部 API 提供模板管理端点
//
// ## 依赖
// express、template-store.ts、github-template-utils
//
// ## 维护规则
// 内置模板不可删除，需在路由中保留保护逻辑
//
import { Router } from "express";
import type { TemplateStore } from "./template-store.js";
import type { CoreDatabase } from "./core-database.js";
import { parseFrontmatter, extractTag, shouldSkipMd } from "../shared/github-template-utils.js";
import { log } from "../core/logger.js";

interface GithubCacheEntry {
	sha: string;
	items: any[];
	sourceUrl: string;
	timestamp: number;
}

type GithubCache = Record<string, GithubCacheEntry>;

function loadGithubCache(sessionDB: CoreDatabase): GithubCache {
	try { return sessionDB.getKVStore().getJson("github_cache") ?? {}; } catch { return {}; }
}

function saveGithubCache(sessionDB: CoreDatabase, data: GithubCache): void {
	try { sessionDB.getKVStore().setJson("github_cache", data); }
	catch (err) { log.warn("template-router", "github cache save failed:", (err as Error).message); }
}

export function createTemplateRouter(templateStore: TemplateStore, sessionDB: CoreDatabase): Router {
	const router = Router();
	let githubCache: GithubCache = loadGithubCache(sessionDB);

	// templates:list — list all templates
	router.get("/", (_req, res) => {
		try {
			res.json(templateStore.list());
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// templates:github-preview — preview templates from a GitHub repo
	router.post("/github-preview", async (req, res) => {
		try {
			const { url, subdir } = req.body as { url: string; subdir?: string };
			const repoMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
			if (!repoMatch) { res.json({ error: "Invalid GitHub URL" }); return; }
			const owner = repoMatch[1];
			const repo = repoMatch[2].replace(/\.git$/, "");
			const sourceUrl = "https://github.com/" + owner + "/" + repo;

			const cacheKey = owner + "/" + repo + "/" + (subdir || "");
			const cached = githubCache[cacheKey];
			const CACHE_TTL = 24 * 60 * 60 * 1000;
			if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
				const items = cached.items.map((item: any) => ({
					...item,
					exists: !!(templateStore as any).findByNameAndSource(item.name, cached.sourceUrl),
				}));
				res.json({ items, sourceUrl: cached.sourceUrl, cached: true });
				return;
			}

			const repoResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo);
			if (!repoResp.ok) { res.json({ error: "GitHub API error: " + repoResp.status }); return; }
			const repoData = await repoResp.json() as any;
			const branch = repoData.default_branch || "main";
			const refResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo + "/git/refs/heads/" + branch);
			const refData = refResp.ok ? await refResp.json() as any : null;
			const latestSha = refData?.object?.sha || "";

			if (cached && cached.sha === latestSha) {
				cached.timestamp = Date.now();
				saveGithubCache(sessionDB, githubCache);
				const items = cached.items.map((item: any) => ({
					...item,
					exists: !!(templateStore as any).findByNameAndSource(item.name, cached.sourceUrl),
				}));
				res.json({ items, sourceUrl: cached.sourceUrl, cached: true });
				return;
			}

			const treeResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo + "/git/trees/" + branch + "?recursive=1", {
				headers: { "Accept": "application/vnd.github.v3+json" },
			});
			if (!treeResp.ok) { res.json({ error: "GitHub tree API error: " + treeResp.status }); return; }
			const treeData = await treeResp.json() as any;
			const allFiles: any[] = (treeData.tree || []).filter((f: any) => f.type === "blob");
			let mdFiles = allFiles
				.filter((f: any) => f.path.endsWith(".md"))
				.filter((f: any) => !shouldSkipMd(f.path));
			if (subdir) mdFiles = mdFiles.filter((f: any) => f.path.startsWith(subdir + "/"));

			const CHUNK = 10;
			const items: any[] = [];
			for (let i = 0; i < mdFiles.length; i += CHUNK) {
				const chunk = mdFiles.slice(i, i + CHUNK);
				const results = await Promise.all(chunk.map(async (f: any) => {
					try {
						const resp = await fetch("https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + branch + "/" + f.path);
						if (!resp.ok) return null;
						const content = await resp.text();
						const fm = parseFrontmatter(content);
						if (!fm || !fm.name) return null;
						const tag = extractTag(f.path);
						const exists = !!(templateStore as any).findByNameAndSource(fm.name, sourceUrl);
						const tools = fm.tools ? fm.tools.split(",").map((t: string) => t.trim()) : undefined;
						return { name: fm.name, description: fm.description || "", icon: fm.emoji || "", tag, path: f.path, exists, color: fm.color, recommendedTools: tools };
					} catch { return null; }
				}));
				for (const r of results) { if (r) items.push(r); }
			}

			githubCache[cacheKey] = { sha: latestSha, items, sourceUrl, timestamp: Date.now() };
			saveGithubCache(sessionDB, githubCache);
			res.json({ items, sourceUrl });
		} catch (err: any) {
			res.json({ error: err.message });
		}
	});

	// templates:import-github — import selected templates from a GitHub repo
	router.post("/import-github", async (req, res) => {
		try {
			const { url, selectedPaths } = req.body as { url: string; selectedPaths: string[] };
			const repoMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
			if (!repoMatch) { res.json({ error: "Invalid GitHub URL" }); return; }
			const owner = repoMatch[1];
			const repo = repoMatch[2].replace(/\.git$/, "");
			const sourceUrl = "https://github.com/" + owner + "/" + repo;

			const repoResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo);
			if (!repoResp.ok) { res.json({ error: "GitHub API error: " + repoResp.status }); return; }
			const repoData = await repoResp.json() as any;
			const branch = repoData.default_branch || "main";

			let imported = 0;
			let updated = 0;

			for (const filePath of selectedPaths) {
				try {
					const resp = await fetch("https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + branch + "/" + filePath);
					if (!resp.ok) continue;
					const content = await resp.text();
					const fm = parseFrontmatter(content);
					if (!fm || !fm.name) continue;
					const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
					if (!body) continue;
					const prompt = fm.vibe ? fm.vibe + "\n\n" + body : body;
					const tag = extractTag(filePath);
					const tools = fm.tools ? fm.tools.split(",").map((t: string) => t.trim()) : undefined;
					const existing = (templateStore as any).findByNameAndSource(fm.name, sourceUrl);
					if (existing) {
						(templateStore as any).update(existing.id, { description: fm.description || existing.description, icon: fm.emoji || existing.icon, systemPrompt: prompt, tags: [tag], color: fm.color || existing.color, recommendedTools: tools });
						updated++;
					} else {
						(templateStore as any).create({ name: fm.name, description: fm.description || "", icon: fm.emoji || undefined, systemPrompt: prompt, tags: [tag], sourceUrl, color: fm.color, recommendedTools: tools, isBuiltIn: false });
						imported++;
					}
				} catch { continue; }
			}

			const cacheKey = owner + "/" + repo + "/";
			delete githubCache[cacheKey];
			res.json({ imported, updated, total: selectedPaths.length });
		} catch (err: any) {
			res.json({ error: err.message });
		}
	});

	// templates:create — create a new template
	router.post("/", (req, res) => {
		try {
			const template = templateStore.create(req.body);
			res.status(201).json(template);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// templates:update — update an existing template
	router.put("/:id", (req, res) => {
		try {
			const template = templateStore.update(req.params.id, req.body);
			res.json(template);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// templates:delete — delete a template
	router.delete("/:id", (req, res) => {
		try {
			templateStore.delete(req.params.id);
			res.json({ success: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// templates:export — export a template as JSON string
	router.post("/:id/export", (req, res) => {
		try {
			const json = templateStore.exportTemplate(req.params.id);
			res.json(json);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// templates:import — import a template from JSON string
	router.post("/import", (req, res) => {
		try {
			const { json } = req.body;
			if (!json || typeof json !== "string") {
				res.status(400).json({ error: "Request body must include a 'json' string field" });
				return;
			}
			const template = templateStore.importTemplate(json);
			res.status(201).json(template);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// templates:get — get a single template (must be LAST among /:id routes)
	router.get("/:id", (req, res) => {
		try {
			const template = templateStore.get(req.params.id);
			if (!template) {
				res.status(404).json({ error: "Template not found" });
				return;
			}
			res.json(template);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}
