import { resolve, extname } from "path";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { IGNORED_DIRS, TEXT_EXTS, buildTree } from "../../shared/file-utils.js";
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export function registerFileHandlers(ctx: IpcContext): void {
	typedHandle("files:tree", "workspaceConfig",
		(_ctx, root) => {
			const dir = expandHome(root || _ctx.workspaceConfig.workspaceDir);
			try {
				const s = statSync(dir);
				if (!s.isDirectory()) return { error: "not a directory" };
			} catch {
				return { error: "directory not found" };
			}
			return buildTree(dir, "");
		},
	);

	typedHandle("files:content", "workspaceConfig",
		(_ctx, filePath, root) => {
			if (!filePath) return { error: "path required" };
			const ext = extname(filePath);
			if (!TEXT_EXTS.has(ext) && ext !== "") {
				return { content: "(binary file)" };
			}
			const r = expandHome(root || _ctx.workspaceConfig.workspaceDir);
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
		},
	);

	typedHandle("files:resolve-path", "workspaceConfig",
		(_ctx, filePath, root) => {
			if (!filePath) return { error: "path required" };
			const r = expandHome(root || _ctx.workspaceConfig.workspaceDir);
			const full = resolve(r, filePath);
			if (!full.startsWith(resolve(r))) {
				return { error: "access denied" };
			}
			return { path: full };
		},
	);

	typedHandle("files:save", "workspaceConfig",
		(_ctx, filePath, fileContent, root) => {
			if (!filePath) return { error: "path required" };
			const r = expandHome(root || _ctx.workspaceConfig.workspaceDir);
			const full = resolve(r, filePath);
			if (!full.startsWith(resolve(r))) {
				return { error: "access denied" };
			}
			try {
				const { writeFileSync } = require("node:fs");
				writeFileSync(full, fileContent, "utf-8");
				return { success: true as const };
			} catch (err: any) {
				return { error: err.message };
			}
		},
	);
}
