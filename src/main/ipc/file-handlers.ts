import { ipcMain } from "electron";
import { resolve, extname, join } from "path";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { IGNORED_DIRS, TEXT_EXTS, buildTree } from "../../shared/file-utils.js";
import type { IpcContext } from "./types.js";

const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export function registerFileHandlers(ctx: IpcContext): void {
	ipcMain.handle("files:tree", (_e, root?: string) => {
		if (!ctx.modulesReady) return [];
		const dir = expandHome(root || ctx.workspaceConfig.workspaceDir);
		try {
			const s = statSync(dir);
			if (!s.isDirectory()) return { error: "not a directory" };
		} catch {
			return { error: "directory not found" };
		}
		return buildTree(dir, "");
	});

	ipcMain.handle("files:content", (_e, filePath: string, root?: string) => {
		if (!filePath) return { error: "path required" };
		const ext = extname(filePath);
		if (!TEXT_EXTS.has(ext) && ext !== "") {
			return { content: "(binary file)" };
		}
		const r = expandHome(root || (ctx.modulesReady ? ctx.workspaceConfig.workspaceDir : homedir()));
		const full = resolve(r, filePath);
		if (!full.startsWith(resolve(r))) {
			return { error: "access denied" };
		}
		try {
			const s = statSync(full);
			if (s.size > 500_000) return { content: "(file too large, > 500KB)" };
			return { content: readFileSync(full, "utf-8") };
		} catch {
			return { error: "file not found" };
		}
	});

	ipcMain.handle("files:resolve-path", (_e, filePath: string, root?: string) => {
		if (!filePath) return { error: "path required" };
		const r = expandHome(root || (ctx.modulesReady ? ctx.workspaceConfig.workspaceDir : homedir()));
		const full = resolve(r, filePath);
		if (!full.startsWith(resolve(r))) {
			return { error: "access denied" };
		}
		return { path: full };
	});

	ipcMain.handle("files:save", (_e, filePath: string, fileContent: string, root?: string) => {
		if (!filePath) return { error: "path required" };
		const r = expandHome(root || (ctx.modulesReady ? ctx.workspaceConfig.workspaceDir : homedir()));
		const full = resolve(r, filePath);
		if (!full.startsWith(resolve(r))) {
			return { error: "access denied" };
		}
		try {
			const { writeFileSync } = require("node:fs");
			writeFileSync(full, fileContent, "utf-8");
			return { success: true };
		} catch (err: any) {
			return { error: err.message };
		}
	});
}
