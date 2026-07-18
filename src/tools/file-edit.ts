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
import { resolve, extname, basename } from "node:path";
import { buildTool } from "./tool-factory.js";
import { checkSyntax, formatDiagnostics } from "./syntax-check.js";
import { isProtectedPathRealpath, wikiPathRejectMessage } from "./wiki-path-guard.js";
import { resolveSkillWritePath, stampAuthorFrontmatter } from "./skill-paths.js";
import { checkSkillAuthorGate } from "./skill-author-gate.js";
import type { CallerCtx, ToolResult } from "./types.js";

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
	// tool-decoupling sub-3(决策 1/3 + G5/G6):workingDir / toolConfig 从
	// callerCtx 取;返 ToolResult{data:{path, text, replaced}}(G6 文本壳 + 元数据);
	// format(r) = r.data.text。行为同 sub-3 前。
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult> => {
		const { path, oldText, newText } = input;
		const wrap = (text: string, extra: Record<string, unknown> = {}): ToolResult => ({
			ok: !/^Error:|Text not found/.test(text),
			data: { path, text, ...extra },
		});
		if (!callerCtx.workingDir) return wrap("Error: no workspace directory configured");
		// v0.8 (P1 §10.1): block agent edits to the wiki memory store.
		// round-2 Fix 2 (acceptance-08 §B blocker): realpath-aware variant
		// catches symlink/junction bypass.
		if (isProtectedPathRealpath(path, callerCtx.workingDir)) return wrap(wikiPathRejectMessage(path));

		// skill-system sub-8 (decision 4 write + 11): `[skills]/<id>/<rel>` 虚拟
		// 路径写通道(Edit)。门禁先行,再做路径解析。读家族不经此分支。
		const skillWrite = resolveSkillWritePath(path);
		let filePath: string;
		let skillMarkAuthor = false;
		if (skillWrite === null) {
			// 非 `[skills]/` 前缀 → 原 workspace 沙箱解析。
			filePath = resolve(callerCtx.workingDir, path);
			if (!filePath.startsWith(resolve(callerCtx.workingDir))) {
				return wrap(`Access denied: path outside workspace (${path})`);
			}
		} else if (!skillWrite.ok) {
			return wrap(`Error: ${skillWrite.error}`);
		} else {
			const gateError = checkSkillAuthorGate(callerCtx);
			if (gateError) return wrap(gateError);
			filePath = skillWrite.realPath;
			skillMarkAuthor = skillWrite.markAuthor;
		}
		try {
			const content = await readFile(filePath, "utf-8");
			if (!content.includes(oldText)) {
				return wrap(buildNotFoundMessage(path, content, oldText));
			}
			let newContent = content.replace(oldText, newText);
			// SKILL.md + markAuthor → 编辑后再保证 author 溯源(不覆盖已有 author)。
			if (skillMarkAuthor && basename(filePath).toLowerCase() === "skill.md") {
				const agentId = callerCtx.agentId;
				if (agentId) newContent = stampAuthorFrontmatter(newContent, agentId);
			}
			await writeFile(filePath, newContent, "utf-8");
			let result = `Successfully edited ${path}`;
			const enabled = callerCtx.toolConfig?.Edit?.syntaxCheck ?? true;
			if (enabled) {
				const ext = extname(path).slice(1).toLowerCase();
				const diags = checkSyntax(newContent, ext);
				if (diags.length) result += formatDiagnostics(path, diags);
			}
			return wrap(result, { replaced: 1 });
		} catch (err: any) {
			return wrap(`Error writing file: ${err.message}`);
		}
	},
	// format(决策 3,G6):透出 data.text。文本形态与 sub-3 前完全一致。
	format: (result: ToolResult): string => {
		return (result.data as any)?.text ?? result.error ?? "Edit failed.";
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
