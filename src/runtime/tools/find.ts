import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative } from "node:path";
import { buildTool } from "./tool-factory.js";

const execFileAsync = promisify(execFile);

export const findTool = buildTool({
	name: "find",
	description:
		"Fast file pattern matching tool. Supports glob patterns like \"**/*.js\" or \"src/**/*.tsx\". " +
		"Returns matching file paths sorted by modification time.",
	userDescription: "使用 ripgrep --files 快速查找匹配 glob 模式的文件，按修改时间排序。支持标准 glob 模式（如 **/*.ts）。ripgrep 不可用时自动回退到 Node.js glob。",
	configSchema: [
		{ key: "result_limit", type: "number", label: "最大结果数", default: 200, description: "返回的最大文件数" },
	],
	meta: { category: "runtime", isReadOnly: true, isConcurrencySafe: true },
	inputSchema: z.object({
		pattern: z.string().describe('Glob pattern to match files against (e.g., "**/*.ts", "src/**/*.tsx")'),
		path: z.string().optional().describe("Directory to search in (defaults to current working directory)"),
	}),
	execute: async (input, ctx) => {
		const { pattern, path } = input;
		const config = ctx.toolConfig?.find ?? {};
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
			// Try ripgrep --files first (much faster than Node glob)
			const rgArgs = [
				"--files",
				"--sort=modified",
				"--hidden",
				"--glob", "!.git",
				"--glob", pattern,
			];

			try {
				const { stdout } = await execFileAsync("rg", rgArgs, {
					cwd: searchPath,
					timeout: 15000,
					maxBuffer: 10 * 1024 * 1024,
				});

				if (!stdout) return `No files matching '${pattern}' found.`;

				const files = stdout.split("\n").filter(Boolean);
				const limit = config.result_limit ?? 200;
				const truncated = files.length > limit;
				const results = files.slice(0, limit);

				// Use relative paths if possible
				const display = workingDir
					? results.map((f) => relative(workingDir, resolve(searchPath, f)).replace(/\\/g, "/"))
					: results;

				let output = display.join("\n");
				if (truncated) output += `\n\n... (${files.length} total files, showing first ${limit})`;
				return output;
			} catch (rgErr: any) {
				if (rgErr.code !== 1 && rgErr.code !== 2) {
					// rg not found or other error, fall through to Node glob
				}
			}

			// Fallback to Node.js glob
			const { glob } = await import("node:fs/promises");
			const fullPattern = `${searchPath}/${pattern}`;
			const results: string[] = [];
			const nodeLimit = config.result_limit ?? 200;

			for await (const file of glob(fullPattern)) {
				const rel = workingDir ? relative(workingDir, file).replace(/\\/g, "/") : file;
				results.push(rel);
				if (results.length >= nodeLimit) break;
			}

			if (results.length === 0) return `No files matching '${pattern}' found.`;
			return results.join("\n");
		} catch (err: any) {
			return `Error finding files: ${err.message}`;
		}
	},
});
