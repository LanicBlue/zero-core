// Grep 搜索工具
//
// # 文件说明书
//
// ## 核心功能
// 提供文件内容搜索能力，基于 ripgrep 实现。
//
// ## 输入
// - 搜索模式
// - 搜索路径
//
// ## 输出
// - 匹配结果
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - node:child_process - 进程执行
//
// ## 维护规则
// - 保持 ripgrep 参数兼容
// - 处理特殊字符转义
//
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, extname, sep } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { buildTool } from "./tool-factory.js";
import { EXEC_MAX_BUFFER_BYTES } from "../core/constants.js";
import { isWikiDiskPath, wikiPathRejectMessage } from "./wiki-path-guard.js";
import type { CallerCtx, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Node-native grep fallback (v0.8: Windows + systems without ripgrep)
// ---------------------------------------------------------------------------
// When `rg` is absent (ENOENT — common on Windows where ripgrep isn't on Node's
// PATH), the old code fell back to system `grep`, which ALSO isn't on Windows,
// so Grep was completely broken there. This pure-Node walker replaces that
// broken fallback so Grep works cross-platform with no external binary. Output
// mirrors ripgrep's content/files_with_matches/count modes closely enough for
// the model to consume.

const TYPE_EXTENSIONS: Record<string, string[]> = {
	js: ["js", "mjs", "cjs", "jsx"], ts: ["ts", "tsx", "mts", "cts"],
	py: ["py", "pyw"], rust: ["rs"], go: ["go"], java: ["java"],
	rb: ["rb"], php: ["php"], c: ["c", "h"], cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
	cs: ["cs"], swift: ["swift"], kt: ["kt", "kts"], scala: ["scala"],
	sh: ["sh", "bash"], md: ["md", "markdown"], json: ["json", "jsonc"],
	yml: ["yaml", "yml"], toml: ["toml"], html: ["html", "htm", "xhtml"],
	css: ["css", "scss", "less"], vue: ["vue"], svelte: ["svelte"],
};

const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp",
	".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
	".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	".pdf", ".sqlite", ".db", ".wasm", ".mp3", ".mp4", ".avi", ".mov",
]);

// Convert a user glob like "*.js" / "*.{ts,tsx}" / "**/*.spec.ts" into a
// function testing a path relative to searchPath.
function compileGlob(glob?: string): (relPath: string) => boolean {
	if (!glob) return () => true;
	const re = new RegExp(
		"^(?:" + glob
			.split(",")
			.map((part) => {
				let p = part.trim().replace(/^\.\//, "");
				// escape regex specials except our wildcard chars
				p = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
				p = p.replace(/\*\*/g, "\0GLOBSTAR\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0GLOBSTAR\0/g, ".*");
				return p;
			})
			.join("|") + ")$",
		"i",
	);
	return (relPath: string) => re.test(relPath.replace(/\\/g, "/"));
}

async function* walkFiles(root: string, skipDirs: Set<string>): AsyncIterable<string> {
	let entries: import("node:fs").Dirent[];
	try { entries = await readdir(root, { withFileTypes: true }); }
	catch { return; }
	for (const ent of entries) {
		if (ent.name === ".git" || skipDirs.has(ent.name)) continue;
		const full = root + sep + ent.name;
		if (ent.isDirectory()) {
			yield* walkFiles(full, skipDirs);
		} else if (ent.isFile()) {
			yield full;
		}
	}
}

export async function nativeGrepSearch(opts: {
	pattern: string; searchPath: string; glob?: string; type?: string;
	output_mode: "content" | "files_with_matches" | "count";
	caseInsensitive?: boolean; context?: number; after?: number; before?: number;
	head_limit: number; max_columns: number;
}): Promise<string> {
	const { pattern, searchPath, output_mode, head_limit, max_columns } = opts;
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, opts.caseInsensitive ? "i" : "");
	} catch {
		return `Invalid regex: ${pattern}`;
	}

	const globOk = compileGlob(opts.glob);
	const typeExts = opts.type ? new Set(TYPE_EXTENSIONS[opts.type] ?? [opts.type]) : null;
	const skipDirs = new Set(["node_modules", ".git"]);
	const ctxBefore = opts.context ?? opts.before ?? 0;
	const ctxAfter = opts.context ?? opts.after ?? 0;

	const matchedFiles: string[] = [];
	const contentLines: string[] = [];
	const countLines: string[] = [];
	let totalMatches = 0;
	let filesScanned = 0;
	const FILE_SCAN_CAP = 8000;

	for await (const file of walkFiles(searchPath, skipDirs)) {
		if (filesScanned++ > FILE_SCAN_CAP) break;
		if (totalMatches >= head_limit && output_mode !== "count") break;
		const relPath = relative(searchPath, file);
		if (!globOk(relPath)) continue;
		const ext = extname(file).toLowerCase();
		if (typeExts && !typeExts.has(ext.slice(1))) continue;
		if (BINARY_EXTENSIONS.has(ext)) continue;

		let content: string;
		try { content = await readFile(file, "utf-8"); } catch { continue; }
		if (content.includes("\0")) continue; // binary

		const lines = content.split(/\r?\n/);
		let fileMatchCount = 0;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!regex.test(line)) continue;
			totalMatches++;
			fileMatchCount++;
			if (output_mode === "files_with_matches") {
				matchedFiles.push(relPath);
				break; // one hit per file is enough for this mode
			}
			if (output_mode === "content") {
				const display = line.length > max_columns ? line.slice(0, max_columns) + " ..." : line;
				if (ctxBefore > 0 || ctxAfter > 0) {
					for (let j = Math.max(0, i - ctxBefore); j <= Math.min(lines.length - 1, i + ctxAfter); j++) {
						const prefix = j === i ? `${relPath}-${j + 1}-` : `${relPath}-${j + 1}-`;
						const dl = lines[j].length > max_columns ? lines[j].slice(0, max_columns) + " ..." : lines[j];
						contentLines.push(`${prefix}${dl}`);
					}
					contentLines.push(""); // blank between groups (rg style)
				} else {
					contentLines.push(`${relPath}:${i + 1}:${display}`);
				}
				if (contentLines.length >= head_limit) break;
			}
		}
		if (output_mode === "count" && fileMatchCount > 0) {
			countLines.push(`${relPath}:${fileMatchCount}`);
		}
	}

	if (output_mode === "files_with_matches") {
		return matchedFiles.length ? matchedFiles.join("\n") : "No matches found.";
	}
	if (output_mode === "count") {
		return countLines.length ? countLines.join("\n") : "No matches found.";
	}
	if (contentLines.length === 0) return "No matches found.";
	return contentLines.slice(0, head_limit).join("\n");
}

export const grepTool = buildTool({
	name: "Grep",
	description: "Search file contents with regex (ripgrep when available, else a built-in fallback) and multiple output modes.",
	prompt:
		"A powerful content-search tool. Uses ripgrep when available; falls back to a built-in Node-native search on systems without ripgrep (e.g. Windows), so it works cross-platform regardless.\n\n" +
		"Usage:\n" +
		"- ALWAYS use Grep for search tasks. NEVER run shell grep or rg in Bash. The Grep tool handles encoding, truncation, and formatting.\n" +
		"- Supports full regex syntax (e.g., \"log.*Error\", \"function\\s+\\w+\").\n" +
		"- Filter files with glob parameter (e.g., \"*.js\", \"**/*.tsx\") or type parameter (e.g., \"js\", \"py\", \"rust\").\n" +
		"- Use output_mode to control output: \"content\" shows matching lines, \"files_with_matches\" shows only file paths (default), \"count\" shows match counts.\n" +
		"- Pattern syntax: full regex (ripgrep or the built-in fallback engine — both standard regex). Literal braces need escaping (use `interface\\{\\}` to find `interface{}`).\n" +
		"- Multiline matching: By default patterns match within single lines only. For cross-line patterns, use `multiline: true`.",
	configSchema: [
		{ key: "head_limit", type: "number", label: "默认结果上限 (items)", default: 250, description: "搜索结果最大返回条数" },
		{ key: "max_columns", type: "number", label: "最大列宽 (chars)", default: 500, description: "超过此宽度的行会被截断" },
	],
	meta: { category: "runtime", isReadOnly: true, isConcurrencySafe: true },
	inputSchema: z.object({
		pattern: z.string().describe("The regular expression pattern to search for in file contents"),
		path: z.string().optional().describe("File or directory to search in (defaults to current working directory)"),
		glob: z.string().optional().describe('Glob pattern to filter files (e.g., "*.js", "*.{ts,tsx}")'),
		type: z.string().optional().describe('File type to search (e.g., "js", "py", "rust", "go", "java")'),
		output_mode: z.enum(["content", "files_with_matches", "count"]).optional()
			.describe('Output mode (default: "content"). "files_with_matches" returns only file paths.'),
		"-i": z.boolean().optional().describe("Case insensitive search"),
		"-C": z.number().optional().describe("Number of lines to show before and after each match"),
		"-A": z.number().optional().describe("Number of lines to show after each match"),
		"-B": z.number().optional().describe("Number of lines to show before each match"),
		head_limit: z.number().optional().describe("Limit output to first N results (default: 250)"),
	}),
	// tool-decoupling sub-3(决策 1/3 + G5/G6):workingDir / toolConfig / readScope
	// 从 callerCtx 取(不经 ctx);返 ToolResult{data:{pattern, text, outputMode,
	// searchPath}}(G6 文本壳 + 元数据);format(r) = r.data.text。行为同 sub-3 前。
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult> => {
		const {
			pattern, path, glob, type,
			output_mode = "content",
			"-i": caseInsensitive,
			"-C": context,
			"-A": after,
			"-B": before,
			head_limit,
		} = input;

		const config = callerCtx.toolConfig?.Grep ?? {};
		const resolved_head_limit = input.head_limit ?? config.head_limit ?? 250;
		const resolved_max_columns = config.max_columns ?? 500;
		const restrictToWorkspace = callerCtx.readScope === "workspace";
		const workingDir = callerCtx.workingDir;

		const wrap = (text: string, extra: Record<string, unknown> = {}): ToolResult => ({
			ok: !/^Error:|Search error/.test(text),
			data: { pattern, outputMode: output_mode, searchPath: path, text, ...extra },
		});

		let searchPath: string;
		if (path) {
			// v0.8 (P1 §10.1): block agent greps inside the wiki memory store.
			if (isWikiDiskPath(path, workingDir)) return wrap(wikiPathRejectMessage(path));
			searchPath = workingDir ? resolve(workingDir, path) : path;
			if (restrictToWorkspace && workingDir && !searchPath.startsWith(resolve(workingDir))) {
				return wrap(`Access denied: search path outside workspace (${path})`);
			}
		} else {
			searchPath = workingDir || ".";
		}

		// Apply max_columns truncation to content-mode output
		function truncateColumns(text: string): string {
			if (output_mode !== "content") return text;
			const maxCols = resolved_max_columns;
			const lines = text.split("\n");
			let changed = false;
			const truncated = lines.map(line => {
				// Lines have format: "path:linenum:content" or "path:content" or just "content"
				const colonIdx = line.indexOf(":");
				if (colonIdx < 0) return line;
				const secondColon = line.indexOf(":", colonIdx + 1);
				const prefixEnd = secondColon > colonIdx ? secondColon + 1 : colonIdx + 1;
				const prefix = line.slice(0, prefixEnd);
				const content = line.slice(prefixEnd);
				if (content.length <= maxCols) return line;
				changed = true;
				return prefix + content.slice(0, maxCols) + " ...";
			});
			return changed ? truncated.join("\n") : text;
		}

		try {
			const args: string[] = [
				"--hidden",
				"--glob", "!.git",
				"--max-columns", String(resolved_max_columns),
			];

			// Output mode
			if (output_mode === "files_with_matches") {
				args.push("-l");
			} else if (output_mode === "count") {
				args.push("-c");
			} else {
				args.push("-n", "--no-heading");
			}

			if (caseInsensitive) args.push("-i");
			if (context) args.push("-C", String(context));
			if (after) args.push("-A", String(after));
			if (before) args.push("-B", String(before));
			if (glob) args.push("--glob", glob);
			if (type) args.push("--type", type);

			// Pagination
			if (output_mode === "content" || output_mode === "count") {
				args.push("-m", String(resolved_head_limit));
			}

			// Pattern starting with - needs -e flag
			if (pattern.startsWith("-")) {
				args.push("-e", pattern);
			} else {
				args.push("--", pattern);
			}
			args.push(searchPath);

			try {
				const { stdout } = await execFileAsync("rg", args, {
					cwd: workingDir,
					timeout: 20000,
					maxBuffer: EXEC_MAX_BUFFER_BYTES,
				});
				if (!stdout) return wrap("No matches found.", { matchCount: 0 });

				// Trim output to head_limit lines for content mode
				if (output_mode === "content") {
					const lines = stdout.split("\n");
					const truncated = lines.length > resolved_head_limit;
					const result = lines.slice(0, resolved_head_limit).join("\n");
					return wrap(
						truncated ? `${result}\n\n... (truncated, ${lines.length} total matches)` : result,
						{ matchCount: lines.length, truncated },
					);
				}
				return wrap(stdout);
			} catch (rgErr: any) {
				if (rgErr.stdout) return wrap(truncateColumns(rgErr.stdout));
				if (rgErr.code === 1) return wrap("No matches found.", { matchCount: 0 });
				if (rgErr.code === 2) return wrap(`Search error: ${rgErr.stderr || rgErr.message}`);
				// rg not installed (ENOENT on Windows, etc.) → Node-native fallback
				// (replaces the old `grep` fallback, which is also absent on Windows).
			}

			const fallbackText = await nativeGrepSearch({
				pattern, searchPath, glob, type, output_mode,
				caseInsensitive, context, after, before,
				head_limit: resolved_head_limit, max_columns: resolved_max_columns,
			});
			return wrap(fallbackText);
		} catch (err: any) {
			if (err.code === 1) return wrap("No matches found.", { matchCount: 0 });
			return wrap(`Error searching: ${err.message}`);
		}
	},
	// format(决策 3,G6):透出 data.text。文本形态与 sub-3 前完全一致。
	format: (result: ToolResult): string => {
		return (result.data as any)?.text ?? result.error ?? "Grep failed.";
	},
});
