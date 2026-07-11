// 文件系统工具函数
//
// # 文件说明书
//
// ## 核心功能
// 提供文件过滤、目录遍历和文件树构建的共享工具函数
//
// ## 输入
// 目录路径、忽略规则、文件扩展名
//
// ## 输出
// IGNORED_DIRS/TEXT_EXTS 常量、buildTree 目录树函数
//
// ## 定位
// src/shared/ — 共享层，为主进程和渲染器提供文件系统工具
//
// ## 依赖
// Node.js fs/path
//
// ## 维护规则
// 新增忽略目录或文本扩展名需在此添加
//
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache"]);

export const TEXT_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".mdx", ".css", ".html", ".htm",
	".yaml", ".yml", ".toml", ".py", ".rs", ".go", ".java", ".txt",
	".sh", ".bash", ".env", ".gitignore", ".sql",
	// Common text/config/log formats — without these the doc viewer treats the
	// file as binary ("(binary file)") because the extension isn't whitelisted.
	".log", ".csv", ".tsv", ".ini", ".conf", ".cfg", ".properties",
	".xml", ".svg", ".diff", ".patch", ".lock",
	".c", ".h", ".cpp", ".cc", ".hpp", ".cs", ".rb", ".php", ".kt", ".swift",
	".scala", ".clj", ".lua", ".r", ".dart", ".vue", ".svelte",
	".dockerfile", ".tf", ".dockerignore", ".editorconfig", ".prettierrc", ".eslintrc",
]);

export interface FileTreeNode {
	name: string;
	path: string;
	type: "dir" | "file";
	children?: FileTreeNode[];
}

export function buildTree(dir: string, basePath: string): FileTreeNode[] {
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

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 * multibyte character. If the string fits, return it unchanged; otherwise cut
 * at the last full-character boundary ≤ maxBytes and append the marker ("…").
 * Used to cap wiki node summaries (byte budget, not UTF-16 code units —
 * `.slice(0, N)` would corrupt multibyte chars and miscount CJK).
 *
 * `maxBytes` excludes the marker; the returned string may be maxBytes + marker
 * bytes long. maxBytes ≤ 0 returns "".
 */
export function truncateUtf8Bytes(str: string | undefined | null, maxBytes: number, marker = "…"): string {
	if (!str) return "";
	if (maxBytes <= 0) return "";
	const bytes = Buffer.byteLength(str, "utf8");
	if (bytes <= maxBytes) return str;
	// Array.from splits on code points (respects surrogate pairs); accumulate
	// bytes and stop at the last full-character boundary that fits.
	let out = "";
	let used = 0;
	for (const ch of Array.from(str)) {
		const chBytes = Buffer.byteLength(ch, "utf8");
		if (used + chBytes > maxBytes) break;
		out += ch;
		used += chBytes;
	}
	return out + marker;
}
