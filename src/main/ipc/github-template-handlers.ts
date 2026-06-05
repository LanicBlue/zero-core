// GitHub 模板同步 IPC handlers
//
// # 文件说明书
//
// ## 核心功能
// 从 GitHub 仓库同步模板文件，支持 frontmatter 解析和缓存
//
// ## 输入
// GitHub 仓库 URL、模板目录路径
//
// ## 输出
// 解析后的模板列表，带 SHA 缓存
//
// ## 定位
// src/main/ipc/ — 主进程 IPC 层，支持远程模板导入
//
// ## 依赖
// typed-ipc.ts、shared/github-template-utils.ts、core/logger.ts
//
// ## 维护规则
// GitHub API 变更或模板格式变更需更新解析逻辑
//
import { typedHandle } from "./typed-ipc.js";
import { parseFrontmatter, extractTag, shouldSkipMd } from "../../shared/github-template-utils.js";
import { getMainWindow } from "./core.js";
import { log } from "../../core/logger.js";
import type { IpcContext } from "./types.js";

interface GithubCacheEntry {
	sha: string;
	items: any[];
	sourceUrl: string;
	timestamp: number;
}

type GithubCache = Record<string, GithubCacheEntry>;

function loadGithubCache(ctx: IpcContext): GithubCache {
	try { return ctx.sessionDb?.getKVStore().getJson("github_cache") ?? {}; } catch { return {}; }
}

function saveGithubCache(ctx: IpcContext, data: GithubCache): void {
	try { ctx.sessionDb?.getKVStore().setJson("github_cache", data); }
	catch (err) { log.warn("ipc", "github cache save failed:", (err as Error).message); }
}

export function registerGithubTemplateHandlers(ctx: IpcContext): void {
	let githubCache: GithubCache = loadGithubCache(ctx);

	typedHandle("templates:github-preview", ["templateStore", "sessionDb"],
		async (_ctx, url, subdir) => {
			try {
				const repoMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
				if (!repoMatch) return { error: "Invalid GitHub URL" };
				const owner = repoMatch[1];
				const repo = repoMatch[2].replace(/.git$/, "");
				const sourceUrl = "https://github.com/" + owner + "/" + repo;

				const cacheKey = owner + "/" + repo + "/" + (subdir || "");
				const cached = githubCache[cacheKey];
				const CACHE_TTL = 24 * 60 * 60 * 1000;
				if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
					const items = cached.items.map((item: any) => ({
						...item,
						exists: !!(_ctx.templateStore as any).findByNameAndSource(item.name, cached.sourceUrl),
					}));
					return { items, sourceUrl: cached.sourceUrl, cached: true };
				}

				const repoResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo);
				if (!repoResp.ok) return { error: "GitHub API error: " + repoResp.status };
				const repoData = await repoResp.json() as any;
				const branch = repoData.default_branch || "main";
				const refResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo + "/git/refs/heads/" + branch);
				const refData = refResp.ok ? await refResp.json() as any : null;
				const latestSha = refData?.object?.sha || "";

				if (cached && cached.sha === latestSha) {
					cached.timestamp = Date.now();
					saveGithubCache(_ctx, githubCache);
					const items = cached.items.map((item: any) => ({
						...item,
						exists: !!(_ctx.templateStore as any).findByNameAndSource(item.name, cached.sourceUrl),
					}));
					return { items, sourceUrl: cached.sourceUrl, cached: true };
				}

				const treeResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo + "/git/trees/" + branch + "?recursive=1", {
					headers: { "Accept": "application/vnd.github.v3+json" },
				});
				if (!treeResp.ok) return { error: "GitHub tree API error: " + treeResp.status };
				const treeData = await treeResp.json() as any;
				const allFiles: any[] = (treeData.tree || []).filter((f: any) => f.type === "blob");
				let mdFiles = allFiles
					.filter((f: any) => f.path.endsWith(".md"))
					.filter((f: any) => !shouldSkipMd(f.path));
				if (subdir) mdFiles = mdFiles.filter((f: any) => f.path.startsWith(subdir + "/"));

				const CHUNK = 10;
				const items: { name: string; description: string; icon: string; tag: string; path: string; exists: boolean; color?: string; recommendedTools?: string[] }[] = [];
				const win = getMainWindow();
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
							const exists = !!(_ctx.templateStore as any).findByNameAndSource(fm.name, sourceUrl);
							const tools = fm.tools ? fm.tools.split(",").map((t: string) => t.trim()) : undefined;
							return { name: fm.name, description: fm.description || "", icon: fm.emoji || "", tag, path: f.path, exists, color: fm.color, recommendedTools: tools };
						} catch { return null; }
					}));
					for (const r of results) { if (r) items.push(r); }
					if (win && !win.isDestroyed()) {
						win.webContents.send("github-preview:progress", { current: Math.min(i + CHUNK, mdFiles.length), total: mdFiles.length });
					}
				}

				githubCache[cacheKey] = { sha: latestSha, items, sourceUrl, timestamp: Date.now() };
				saveGithubCache(_ctx, githubCache);
				return { items, sourceUrl };
			} catch (err: any) { return { error: err.message }; }
		},
	);

	typedHandle("templates:import-github", ["templateStore", "sessionDb"],
		async (_ctx, url, selectedPaths) => {
			try {
				const repoMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
				if (!repoMatch) return { error: "Invalid GitHub URL" };
				const owner = repoMatch[1];
				const repo = repoMatch[2].replace(/\.git$/, "");
				const sourceUrl = "https://github.com/" + owner + "/" + repo;

				const repoResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo);
				if (!repoResp.ok) return { error: "GitHub API error: " + repoResp.status };
				const repoData = await repoResp.json() as any;
				const branch = repoData.default_branch || "main";

				let imported = 0;
				let updated = 0;
				const win = getMainWindow();

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
						const existing = (_ctx.templateStore as any).findByNameAndSource(fm.name, sourceUrl);
						if (existing) {
							(_ctx.templateStore as any).update(existing.id, { description: fm.description || existing.description, icon: fm.emoji || existing.icon, systemPrompt: prompt, tags: [tag], color: fm.color || existing.color, recommendedTools: tools });
							updated++;
						} else {
							(_ctx.templateStore as any).create({ name: fm.name, description: fm.description || "", icon: fm.emoji || undefined, systemPrompt: prompt, tags: [tag], sourceUrl, color: fm.color, recommendedTools: tools, isBuiltIn: false });
							imported++;
						}
						if (win && !win.isDestroyed()) {
							win.webContents.send("github-import:progress", { current: imported + updated, total: selectedPaths.length });
						}
					} catch { continue; }
				}
				const cacheKey = owner + "/" + repo + "/";
				delete githubCache[cacheKey];
				return { imported, updated, total: selectedPaths.length };
			} catch (err: any) { return { error: err.message }; }
		},
	);
}
