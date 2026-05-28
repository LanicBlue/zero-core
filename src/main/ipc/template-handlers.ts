import { ipcMain } from "electron";
import { parseFrontmatter, extractTag, shouldSkipMd } from "../../shared/github-template-utils.js";
import { getMainWindow } from "./core.js";
import type { IpcContext } from "./types.js";

export function registerTemplateHandlers(ctx: IpcContext): void {
	ipcMain.handle("templates:list", () => ctx.modulesReady ? ctx.templateStore.list() : []);
	ipcMain.handle("templates:get", (_e, id: string) => ctx.modulesReady ? ctx.templateStore.get(id) : undefined);
	ipcMain.handle("templates:create", (_e, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		return ctx.templateStore.create(input as any);
	});
	ipcMain.handle("templates:update", (_e, id: string, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try { return ctx.templateStore.update(id, input as any); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("templates:delete", (_e, id: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try { ctx.templateStore.delete(id); return { success: true }; }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("templates:export", (_e, id: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try { return ctx.templateStore.exportTemplate(id); }
		catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("templates:import", (_e, json: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try { return ctx.templateStore.importTemplate(json); }
		catch (e) { return { error: (e as Error).message }; }
	});

	// ─── GitHub template cache + preview + import ────
	// Cache for GitHub preview results — backed by SQLite kv_store
	function loadGithubCache(): Record<string, { sha: string; items: any[]; sourceUrl: string; timestamp: number }> {
		try { return ctx.sessionDb?.getKVStore().getJson("github_cache") ?? {}; } catch { return {}; }
	}
	function saveGithubCache(data: Record<string, any>) {
		try { ctx.sessionDb?.getKVStore().setJson("github_cache", data); } catch {}
	}
	let githubCache = loadGithubCache();

	ipcMain.handle("templates:github-preview", async (_e, url: string, subdir?: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try {
			const repoMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
			if (!repoMatch) return { error: "Invalid GitHub URL" };
			const owner = repoMatch[1];
			const repo = repoMatch[2].replace(/.git$/, "");
			const sourceUrl = "https://github.com/" + owner + "/" + repo;

			// Check disk cache first
			const cacheKey = owner + "/" + repo + "/" + (subdir || "");
			const cached = githubCache[cacheKey];
			const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
			if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
				// Cache is fresh — return immediately, no network call needed
				const items = cached.items.map((item: any) => ({
					...item,
					exists: !!ctx.templateStore.findByNameAndSource(item.name, cached.sourceUrl),
				}));
				return { items, sourceUrl: cached.sourceUrl, cached: true };
			}

			// Cache expired or missing — check if repo has new commits
			const repoResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo);
			if (!repoResp.ok) return { error: "GitHub API error: " + repoResp.status };
			const repoData = await repoResp.json() as any;
			const branch = repoData.default_branch || "main";
			const refResp = await fetch("https://api.github.com/repos/" + owner + "/" + repo + "/git/refs/heads/" + branch);
			const refData = refResp.ok ? await refResp.json() as any : null;
			const latestSha = refData?.object?.sha || "";

			// SHA unchanged — refresh cache timestamp and return cached
			if (cached && cached.sha === latestSha) {
				cached.timestamp = Date.now();
				saveGithubCache(githubCache);
				const items = cached.items.map((item: any) => ({
					...item,
					exists: !!ctx.templateStore.findByNameAndSource(item.name, cached.sourceUrl),
				}));
				return { items, sourceUrl: cached.sourceUrl, cached: true };
			}

			// Fetch file tree
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
						const exists = !!ctx.templateStore.findByNameAndSource(fm.name, sourceUrl);
						const tools = fm.tools ? fm.tools.split(",").map((t: string) => t.trim()) : undefined;
						return { name: fm.name, description: fm.description || "", icon: fm.emoji || "", tag, path: f.path, exists, color: fm.color, recommendedTools: tools };
					} catch { return null; }
				}));
				for (const r of results) { if (r) items.push(r); }
				if (win && !win.isDestroyed()) {
					win.webContents.send("github-preview:progress", { current: Math.min(i + CHUNK, mdFiles.length), total: mdFiles.length });
				}
			}

			// Update cache
			githubCache[cacheKey] = { sha: latestSha, items, sourceUrl, timestamp: Date.now() };
			saveGithubCache(githubCache);
			return { items, sourceUrl };
		} catch (err: any) { return { error: err.message }; }
	});

	ipcMain.handle("templates:import-github", async (_e, url: string, selectedPaths: string[]) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try {
			const repoMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
			if (!repoMatch) return { error: "Invalid GitHub URL" };
			const owner = repoMatch[1];
			const repo = repoMatch[2].replace(/\.git\$/, "");
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
					const existing = ctx.templateStore.findByNameAndSource(fm.name, sourceUrl);
					if (existing) {
						ctx.templateStore.update(existing.id, { description: fm.description || existing.description, icon: fm.emoji || existing.icon, systemPrompt: prompt, tags: [tag], color: fm.color || existing.color, recommendedTools: tools });
						updated++;
					} else {
						ctx.templateStore.create({ name: fm.name, description: fm.description || "", icon: fm.emoji || undefined, systemPrompt: prompt, tags: [tag], sourceUrl, color: fm.color, recommendedTools: tools, isBuiltIn: false });
						imported++;
					}
					if (win && !win.isDestroyed()) {
						win.webContents.send("github-import:progress", { current: imported + updated, total: selectedPaths.length });
					}
				} catch { continue; }
			}
			// Invalidate cache after import
			const cacheKey = owner + "/" + repo + "/";
			delete githubCache[cacheKey];
			return { imported, updated, total: selectedPaths.length };
		} catch (err: any) { return { error: err.message }; }
	});
}
