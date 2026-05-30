import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { buildTool } from "./tool-factory.js";
import { checkSyntax, formatDiagnostics } from "./syntax-check.js";

export const fileEditTool = buildTool({
	name: "Edit",
	description: "Performs exact string replacements in files.",
	prompt:
		"Performs exact string replacements in files.\n\n" +
		"Usage:\n" +
		"- You must use your `Read` tool at least once in the conversation before editing.\n" +
		"- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. Never include any part of the line number prefix in the old_string or new_string.\n" +
		"- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n" +
		"- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance.\n" +
		"- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n" +
		"- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n" +
		"- Edit operations are always restricted to the workspace directory.",
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
			const enabled = ctx.toolConfig?.Edit?.syntaxCheck ?? true;
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
