import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { buildTool } from "./tool-factory.js";
import { checkSyntax, formatDiagnostics } from "./syntax-check.js";

export const fileEditTool = buildTool({
	name: "edit",
	description: "Make a targeted edit to a file by replacing exact text matches. Always restricted to workspace.",
	userDescription: "通过精确查找替换编辑文件中的指定文本。oldText 必须与文件中的内容完全匹配。始终限制在工作目录内。",
	meta: { category: "runtime", isReadOnly: false, isDestructive: true, isConcurrencySafe: false },
	configSchema: [
		{
			key: "syntaxCheck",
			type: "boolean",
			label: "Syntax Check",
			description: "编辑后检查括号、引号等语法结构，发现问题提醒 agent",
			default: true,
		},
	],
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
			let result = `Successfully edited ${path}`;
			const enabled = ctx.toolConfig?.edit?.syntaxCheck ?? true;
			if (enabled) {
				const ext = extname(path).slice(1).toLowerCase();
				const diags = checkSyntax(newContent, ext);
				if (diags.length) result += formatDiagnostics(path, diags);
			}
			return result;
		} catch (err: any) {
			return `Error writing file: ${err.message}`;
		}
	},
});
