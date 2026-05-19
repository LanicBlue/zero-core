import { tool } from "ai";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const fileWriteTool = tool({
	description: "Create or overwrite a file with the given content. Always restricted to workspace.",
	inputSchema: z.object({
		path: z.string().describe("File path to write"),
		content: z.string().describe("Content to write to the file"),
	}),
	execute: async (input, options) => {
		const { path, content } = input;
		const ctx = options.experimental_context as { workingDir?: string } | undefined;
		if (!ctx?.workingDir) return "Error: no workspace directory configured";
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
