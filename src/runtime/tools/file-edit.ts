// 文件编辑工具
//
// # 文件说明书
//
// ## 核心功能
// 提供文件编辑能力，支持精确字符串替换。
//
// ## 输入
// - 文件路径
// - old_string - 要替换的字符串
// - new_string - 替换后的字符串
//
// ## 输出
// - 编辑结果
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - node:fs - 文件系统
// - ./syntax-check - 语法检查
//
// ## 维护规则
// - 保持精确匹配逻辑
// - 处理 tab/空格格式问题
//
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { buildTool } from "./tool-factory.js";
import { checkSyntax, formatDiagnostics } from "./syntax-check.js";
import { isWikiDiskPath, wikiPathRejectMessage } from "./wiki-path-guard.js";

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
		// v0.8 (P1 §10.1): block agent edits to the wiki memory store.
		if (isWikiDiskPath(path, ctx.workingDir)) return wikiPathRejectMessage(path);
		const filePath = resolve(ctx.workingDir, path);
		if (!filePath.startsWith(resolve(ctx.workingDir))) {
			return `Access denied: path outside workspace (${path})`;
		}
		try {
			const content = await readFile(filePath, "utf-8");
			if (!content.includes(oldText)) {
				return buildNotFoundMessage(path, content, oldText);
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

// ---------------------------------------------------------------------------
// "Text not found" diagnostics
// ---------------------------------------------------------------------------

function buildNotFoundMessage(path: string, content: string, oldText: string): string {
	const lines = content.split("\n");
	const totalLines = lines.length;
	const header = `Error: Text not found in ${path} (${totalLines} lines).`;

	// Check for partial match — first line of oldText
	const hints: string[] = [];
	const firstLine = oldText.split("\n")[0];
	if (firstLine && content.includes(firstLine)) {
		const idx = lines.findIndex((l) => l.includes(firstLine));
		if (idx >= 0) {
			const start = Math.max(0, idx - 1);
			const end = Math.min(lines.length, idx + 4);
			const snippet = lines.slice(start, end)
				.map((l, i) => `${start + i + 1}: ${l}`)
				.join("\n");
			hints.push(`Partial match found near line ${idx + 1}:\n${snippet}`);
		}
	} else {
		// Show file head
		const head = lines.slice(0, 8)
			.map((l, i) => `${i + 1}: ${l}`)
			.join("\n");
		hints.push(`File starts with:\n${head}`);
	}

	// Common whitespace issues
	if (content.includes("\r\n") && !oldText.includes("\r\n")) {
		hints.push("Hint: file uses CRLF line endings but oldText uses LF.");
	}
	if (!content.includes("\r\n") && oldText.includes("\r\n")) {
		hints.push("Hint: file uses LF line endings but oldText uses CRLF.");
	}
	const oldFirstNonSpace = oldText.match(/^([ \t]+)/)?.[1];
	if (oldFirstNonSpace && oldFirstNonSpace.includes("\t")) {
		const hasTabs = lines.some((l) => l.startsWith("\t"));
		if (!hasTabs) hints.push("Hint: oldText uses tab indentation but file uses spaces.");
	}

	return [header, ...hints, "Use Read to re-read the file and verify exact content."].join("\n\n");
}
