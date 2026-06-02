import { typedHandle } from "./typed-ipc.js";
import { parseFrontmatter, extractTag, shouldSkipMd } from "../../shared/github-template-utils.js";
import { getMainWindow } from "./core.js";
import { log } from "../../core/logger.js";
import type { IpcContext } from "./types.js";
import type { PromptTemplate, CreateTemplateInput, UpdateTemplateInput } from "../../shared/types.js";

export function registerTemplateHandlers(ctx: IpcContext): void {
	// Template delete can throw (built-in templates), so all handlers are manual.
	typedHandle("templates:list", "templateStore",
		(_ctx) => (_ctx.templateStore as any).list(),
	);

	typedHandle("templates:get", "templateStore",
		(_ctx, id) => (_ctx.templateStore as any).get(id),
	);

	typedHandle("templates:create", "templateStore",
		(_ctx, input) => (_ctx.templateStore as any).create(input),
	);

	typedHandle("templates:update", "templateStore",
		(_ctx, id, input) => {
			try { return (_ctx.templateStore as any).update(id, input); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("templates:delete", "templateStore",
		(_ctx, id) => {
			try { (_ctx.templateStore as any).delete(id); return { success: true as const }; }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("templates:export", "templateStore",
		(_ctx, id) => {
			try { return (_ctx.templateStore as any).exportTemplate(id); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("templates:import", "templateStore",
		(_ctx, json) => {
			try { return (_ctx.templateStore as any).importTemplate(json); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	// ─── GitHub template cache + preview + import ─────────────────────────
	function loadGithubCache(): Record<string, { sha: string; items: any[]; sourceUrl: string; timestamp: number }> {
		try { return ctx.sessionDb?.getKVStore().getJson("github_cache") ?? {}; } catch { return {}; }
	}
	function saveGithubCache(data: Record<string, any>) {
		try { ctx.sessionDb?.getKVStore().setJson("github_cache", data); } catch (err) { log.warn("ipc", "github cache save failed:", (err as Error).message); }
	}
	let githubCache = loadGithubCache();

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
					saveGithubCache(githubCache);
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
				saveGithubCache(githubCache);
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
