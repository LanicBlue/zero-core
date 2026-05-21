import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTool } from "./tool-factory.js";

export const fileEditTool = buildTool({
	name: "edit",
	description: "Make a targeted edit to a file by replacing exact text matches. Always restricted to workspace.",
	meta: { category: "runtime", isReadOnly: false, isDestructive: true, isConcurrencySafe: false },
	inputSchema: z.object({
		path: z.string().describe("File path to edit"),
		oldText: z.string().describe("Exact text to find and replace"),
		newText: z.string().describe("Replacement text"),
	}),
	execute: async (input, ctx) => {
		const { path, oldText, newText } = input;
		if (!ctx.workingDir) return "Error: no workspace directory configured";
		const filePath = resolve(ctx.workingDir, path);
		if (!filePath.startsWith(resolve(ctx.workingDir))) {
			return `Access denied: path outside workspace (${path})`;
		}
		try {
			const content = await readFile(filePath, "utf-8");
			if (!content.includes(oldText)) {
				return `Error: Text not found in ${path}. The oldText must match exactly.`;
			}
			const newContent = content.replace(oldText, newText);
			await writeFile(filePath, newContent, "utf-8");
			return `Successfully edited ${path}`;
		} catch (err: any) {
			return `Error editing file: ${err.message}`;
		}
	},
});
