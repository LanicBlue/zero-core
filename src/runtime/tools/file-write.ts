import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildTool } from "./tool-factory.js";

export const fileWriteTool = buildTool({
	name: "write",
	description: "Create or overwrite a file with the given content. Always restricted to workspace.",
	userDescription: "创建或覆盖文件。自动创建父目录。始终限制在工作目录内。",
	meta: { category: "runtime", isReadOnly: false, isDestructive: true, isConcurrencySafe: false },
	inputSchema: z.object({
		path: z.string().describe("File path to write"),
		content: z.string().describe("Content to write to the file"),
	}),
	execute: async (input, ctx) => {
		const { path, content } = input;
		if (!ctx.workingDir) return "Error: no workspace directory configured";
		const filePath = resolve(ctx.workingDir, path);
		if (!filePath.startsWith(resolve(ctx.workingDir))) {
			return `Access denied: path outside workspace (${path})`;
		}
		try {
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, content, "utf-8");
			return `Successfully wrote ${content.length} bytes to ${path}`;
		} catch (err: any) {
			return `Error writing file: ${err.message}`;
		}
	},
});
