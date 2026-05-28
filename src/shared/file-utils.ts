import { readdirSync } from "node:fs";
import { join } from "node:path";

export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache"]);

export const TEXT_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html",
	".yaml", ".yml", ".toml", ".py", ".rs", ".go", ".java", ".txt",
	".sh", ".bash", ".env", ".gitignore", ".sql",
]);

export function buildTree(dir: string, basePath: string): unknown[] {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		return entries
			.filter((e) => !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
			.sort((a, b) => {
				if (a.isDirectory() && !b.isDirectory()) return -1;
				if (!a.isDirectory() && b.isDirectory()) return 1;
				return a.name.localeCompare(b.name);
			})
			.map((e) => {
				const fullPath = join(dir, e.name);
				const relPath = join(basePath, e.name);
				if (e.isDirectory()) {
					return {
						name: e.name,
						path: relPath,
						type: "dir",
						children: buildTree(fullPath, relPath),
					};
				}
				return { name: e.name, path: relPath, type: "file" };
			});
	} catch {
		return [];
	}
}
