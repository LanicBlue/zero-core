import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { buildTool } from "./tool-factory.js";

const execFileAsync = promisify(execFile);

export const grepTool = buildTool({
	name: "grep",
	description:
		"A powerful search tool built on ripgrep. " +
		"Supports full regex syntax (e.g., \"log.*Error\", \"function\\s+\\w+\"). " +
		"Filter files with glob parameter (e.g., \"*.js\", \"*.{ts,tsx}\") or type parameter (e.g., \"js\", \"py\", \"rust\"). " +
		"Use output_mode to control output: \"content\" shows matching lines, \"files_with_matches\" shows only file paths, \"count\" shows match counts.",
	userDescription: "使用 ripgrep 搜索文件内容。支持正则表达式、上下文行（-A/-B/-C）、大小写忽略、文件类型过滤和多种输出模式。ripgrep 不可用时自动回退到 grep。",
	configSchema: [
		{ key: "head_limit", type: "number", label: "默认结果上限", default: 250, description: "搜索结果最大返回条数" },
		{ key: "max_columns", type: "number", label: "最大列宽", default: 500, description: "超过此宽度的行会被截断" },
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

		const config = ctx.toolConfig?.grep ?? {};
		const resolved_head_limit = input.head_limit ?? config.head_limit ?? 250;
		const restrictToWorkspace = ctx.readScope === "workspace";
		const workingDir = ctx.workingDir;

		let searchPath: string;
		if (path) {
			searchPath = workingDir ? resolve(workingDir, path) : path;
			if (restrictToWorkspace && workingDir && !searchPath.startsWith(resolve(workingDir))) {
				return `Access denied: search path outside workspace (${path})`;
			}
		} else {
			searchPath = workingDir || ".";
		}

		try {
			const args: string[] = [
				"--hidden",
				"--glob", "!.git",
				"--max-columns", String(config.max_columns ?? 500),
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
					maxBuffer: 10 * 1024 * 1024,
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
				if (rgErr.stdout) return rgErr.stdout;
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
			grepArgs.push("-m", String(head_limit));
			grepArgs.push("--", pattern, searchPath);

			const { stdout } = await execFileAsync("grep", grepArgs, {
				cwd: workingDir,
				timeout: 20000,
				maxBuffer: 10 * 1024 * 1024,
			});
			return stdout || "No matches found.";
		} catch (err: any) {
			if (err.code === 1) return "No matches found.";
			return `Error searching: ${err.message}`;
		}
	},
});
