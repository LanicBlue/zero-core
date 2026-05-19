import { tool } from "ai";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function resolvePath(path: string, workingDir: string | undefined, restrictToWorkspace: boolean): string | { error: string } {
	if (!workingDir) return path;
	const resolved = resolve(workingDir, path);
	if (restrictToWorkspace && !resolved.startsWith(resolve(workingDir))) {
		return { error: `Access denied: path outside workspace (${path})` };
	}
	return resolved;
}

export const fileReadTool = tool({
	description: "Read the contents of a file. Returns file content with line numbers.",
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative file path"),
		offset: z.number().optional().describe("Start line number (1-based)"),
		limit: z.number().optional().describe("Number of lines to read"),
	}),
	execute: async (input, options) => {
		const { path, offset, limit } = input;
		const ctx = options.experimental_context as { workingDir?: string; readScope?: string } | undefined;
		const restrictToWorkspace = ctx?.readScope === "workspace";
		const resolved = resolvePath(path, ctx?.workingDir, restrictToWorkspace);
		if (typeof resolved === "object") return resolved.error;
		try {
			const content = await readFile(resolved, "utf-8");
			const lines = content.split("\n");

			const start = Math.max(1, offset ?? 1) - 1;
			const end = limit ? start + limit : lines.length;
			const selected = lines.slice(start, end);

			return selected
				.map((line, i) => `${start + i + 1}\t${line}`)
				.join("\n");
		} catch (err: any) {
			return `Error reading file: ${err.message}`;
		}
	},
});
