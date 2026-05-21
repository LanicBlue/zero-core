import { z } from "zod";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTool } from "./tool-factory.js";

export const findTool = buildTool({
	name: "find",
	description: "Find files matching a glob pattern. Returns list of matching file paths.",
	meta: { category: "runtime", isReadOnly: true },
	inputSchema: z.object({
		pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.tsx')"),
		path: z.string().optional().describe("Directory to search in (default: workspace)"),
	}),
	execute: async (input, ctx) => {
		const { pattern, path } = input;
		const restrictToWorkspace = ctx.readScope === "workspace";
		const workingDir = ctx.workingDir;

		try {
			let searchPath: string;
			if (path) {
				searchPath = workingDir ? resolve(workingDir, path) : path;
				if (restrictToWorkspace && workingDir && !searchPath.startsWith(resolve(workingDir))) {
					return `Access denied: search path outside workspace (${path})`;
				}
			} else {
				searchPath = workingDir || ".";
			}
			const fullPattern = `${searchPath}/${pattern}`;
			const results: string[] = [];

			const dir = glob(fullPattern);
			for await (const file of dir) {
				results.push(file);
				if (results.length >= 100) break;
			}

			if (results.length === 0) {
				return `No files matching '${pattern}' found.`;
			}

			return results.join("\n");
		} catch (err: any) {
			return `Error finding files: ${err.message}`;
		}
	},
});
