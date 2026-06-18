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
import { resolve } from "node:path";
import { buildTool } from "./tool-factory.js";
import { EXEC_MAX_BUFFER_BYTES } from "../../core/constants.js";
import { isWikiDiskPath, wikiPathRejectMessage } from "./wiki-path-guard.js";

const execFileAsync = promisify(execFile);

export const grepTool = buildTool({
	name: "Grep",
	description: "Search file contents using ripgrep with regex support and multiple output modes.",
	prompt:
		"A powerful search tool built on ripgrep.\n\n" +
		"Usage:\n" +
		"- ALWAYS use Grep for search tasks. NEVER run shell grep or rg in Bash. The Grep tool handles encoding, truncation, and formatting.\n" +
		"- Supports full regex syntax (e.g., \"log.*Error\", \"function\\s+\\w+\").\n" +
		"- Filter files with glob parameter (e.g., \"*.js\", \"**/*.tsx\") or type parameter (e.g., \"js\", \"py\", \"rust\").\n" +
		"- Use output_mode to control output: \"content\" shows matching lines, \"files_with_matches\" shows only file paths (default), \"count\" shows match counts.\n" +
		"- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code).\n" +
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
	execute: async (input, ctx) => {
		const {
			pattern, path, glob, type,
			output_mode = "content",
			"-i": caseInsensitive,
			"-C": context,
			"-A": after,
			"-B": before,
			head_limit,
		} = input;

		const config = ctx.toolConfig?.Grep ?? {};
		const resolved_head_limit = input.head_limit ?? config.head_limit ?? 250;
		const resolved_max_columns = config.max_columns ?? 500;
		const restrictToWorkspace = ctx.readScope === "workspace";
		const workingDir = ctx.workingDir;

		let searchPath: string;
		if (path) {
			// v0.8 (P1 §10.1): block agent greps inside the wiki memory store.
			if (isWikiDiskPath(path, workingDir)) return wikiPathRejectMessage(path);
			searchPath = workingDir ? resolve(workingDir, path) : path;
			if (restrictToWorkspace && workingDir && !searchPath.startsWith(resolve(workingDir))) {
				return `Access denied: search path outside workspace (${path})`;
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
				if (!stdout) return "No matches found.";

				// Trim output to head_limit lines for content mode
				if (output_mode === "content") {
					const lines = stdout.split("\n");
					const truncated = lines.length > resolved_head_limit;
					const result = lines.slice(0, resolved_head_limit).join("\n");
					return truncated ? `${result}\n\n... (truncated, ${lines.length} total matches)` : result;
				}
				return stdout;
			} catch (rgErr: any) {
				if (rgErr.stdout) return truncateColumns(rgErr.stdout);
				if (rgErr.code === 1) return "No matches found.";
				if (rgErr.code === 2) return `Search error: ${rgErr.stderr || rgErr.message}`;
			}

			// Fallback to grep
			const grepArgs = ["-rn"];
			if (caseInsensitive) grepArgs.push("-i");
			if (context) { grepArgs.push("-C", String(context)); }
			else {
				if (after) grepArgs.push("-A", String(after));
				if (before) grepArgs.push("-B", String(before));
			}
			if (glob) grepArgs.push("--include", glob);
			if (output_mode === "count") grepArgs.push("-c");
			grepArgs.push("-m", String(resolved_head_limit));
			grepArgs.push("--", pattern, searchPath);

			const { stdout } = await execFileAsync("grep", grepArgs, {
				cwd: workingDir,
				timeout: 20000,
				maxBuffer: EXEC_MAX_BUFFER_BYTES,
			});
			return truncateColumns(stdout || "No matches found.");
		} catch (err: any) {
			if (err.code === 1) return "No matches found.";
			return `Error searching: ${err.message}`;
		}
	},
});
