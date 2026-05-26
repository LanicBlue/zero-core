import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTool } from "./tool-factory.js";

function resolvePath(path: string, workingDir: string | undefined, restrictToWorkspace: boolean): string | { error: string } {
	if (!workingDir) return path;
	const resolved = resolve(workingDir, path);
	if (restrictToWorkspace && !resolved.startsWith(resolve(workingDir))) {
		return { error: `Access denied: path outside workspace (${path})` };
	}
	return resolved;
}

export const fileReadTool = buildTool({
	name: "read",
	description: "Read the contents of a file. Returns file content with line numbers.",
	userDescription: "读取文件内容并显示行号。支持指定起始行和行数范围。受工作空间读取范围限制。",
	meta: { category: "runtime", isReadOnly: true },
	configSchema: [
		{ key: "max_lines", type: "number", label: "最大行数", default: 2000, description: "单次读取的最大行数（防止大文件撑爆上下文）" },
	],
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative file path"),
		offset: z.number().optional().describe("Start line number (1-based)"),
		limit: z.number().optional().describe("Number of lines to read"),
	}),
	execute: async (input, ctx) => {
		const { path, offset, limit: inputLimit } = input;
		const config = ctx.toolConfig?.read ?? {};
		const maxLines = config.max_lines ?? 2000;
		const restrictToWorkspace = ctx.readScope === "workspace";
		const resolved = resolvePath(path, ctx.workingDir, restrictToWorkspace);
		if (typeof resolved === "object") return resolved.error;
		try {
			const content = await readFile(resolved, "utf-8");
			const lines = content.split("\n");

			const start = Math.max(1, offset ?? 1) - 1;
			const limit = inputLimit ?? maxLines;
			const end = Math.min(start + limit, lines.length);
			const selected = lines.slice(start, end);

			const truncated = start + limit < lines.length;
			let result = selected
				.map((line, i) => `${start + i + 1}\t${line}`)
				.join("\n");
			if (truncated) {
				result += `\n\n[File has ${lines.length} lines, showing ${start + 1}-${end}. Use offset/limit to read more.]`;
			}
			return result;
		} catch (err: any) {
			return `Error reading file: ${err.message}`;
		}
	},
});
