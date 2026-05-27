import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { buildTool } from "./tool-factory.js";
import { extractOutline } from "./outline/index.js";
import { renderOutline } from "./outline/renderer.js";

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
	description:
		"Read the contents of a file. Returns file content with line numbers. " +
		"Use mode='outline' to get a structured code outline (tree view with symbol hierarchy).",
	userDescription: "读取文件内容并显示行号。支持 outline 模式：按代码结构生成树状大纲，快速了解文件整体架构。支持指定起始行和行数范围。受工作空间读取范围限制。",
	meta: { category: "runtime", isReadOnly: true },
	configSchema: [
		{ key: "max_lines", type: "number", label: "Max Lines", default: 2000, description: "单次读取/大纲输出的最大行数" },
		{ key: "default_mode", type: "select", label: "Default Mode", default: "full", options: ["full", "outline"], description: "未指定 mode 时的默认读取模式" },
	],
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative file path"),
		offset: z.number().optional().describe("Start line number (1-based)"),
		limit: z.number().optional().describe("Number of lines to read"),
		mode: z.enum(["full", "outline"]).optional().describe("full=raw text with line numbers, outline=structured code outline"),
	}),
	execute: async (input, ctx) => {
		const { path, offset, limit: inputLimit } = input;
		const config = ctx.toolConfig?.read ?? {};
		const maxLines = config.max_lines ?? 2000;
		const mode = input.mode ?? config.default_mode ?? "full";
		const restrictToWorkspace = ctx.readScope === "workspace";
		const resolved = resolvePath(path, ctx.workingDir, restrictToWorkspace);
		if (typeof resolved === "object") return resolved.error;
		try {
			const content = await readFile(resolved, "utf-8");

			// Outline mode
			if (mode === "outline") {
				const outline = extractOutline(basename(resolved), content);
				return renderOutline(outline, { budget: maxLines });
			}

			// Full mode
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
