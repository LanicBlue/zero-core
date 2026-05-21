import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { buildTool } from "./tool-factory.js";

const execFileAsync = promisify(execFile);

export const grepTool = buildTool({
	name: "grep",
	description: "Search file contents for a pattern. Returns matching lines with file paths.",
	meta: { category: "runtime", isReadOnly: true },
	inputSchema: z.object({
		pattern: z.string().describe("Pattern to search for"),
		path: z.string().optional().describe("Directory to search in (default: workspace)"),
		include: z.string().optional().describe("Glob pattern for file filtering (e.g. '*.ts')"),
	}),
	execute: async (input, ctx) => {
		const { pattern, path, include } = input;
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
				"-n", "--no-heading",
				"--max-count", "50",
			];
			if (include) {
				args.push("--glob", include);
			}
			args.push("--", pattern, searchPath);

			try {
				const { stdout } = await execFileAsync("rg", args, {
					cwd: workingDir,
					timeout: 15000,
					maxBuffer: 5 * 1024 * 1024,
				});
				return stdout || "No matches found.";
			} catch (rgErr: any) {
				if (rgErr.stdout) return rgErr.stdout;
				if (rgErr.code === 1) return "No matches found.";
			}

			// Fallback to grep
			const grepArgs = ["-rn", "--max-count=50"];
			if (include) grepArgs.push("--include", include);
			grepArgs.push("--", pattern, searchPath);
			const { stdout } = await execFileAsync("grep", grepArgs, {
				cwd: workingDir,
				timeout: 15000,
				maxBuffer: 5 * 1024 * 1024,
			});
			return stdout || "No matches found.";
		} catch (err: any) {
			if (err.code === 1) return "No matches found.";
			return `Error searching: ${err.message}`;
		}
	},
});
