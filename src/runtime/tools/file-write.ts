// 文件写入工具
//
// # 文件说明书
//
// ## 核心功能
// 提供文件写入能力，支持新建和覆盖文件。
//
// ## 输入
// - 文件路径
// - 文件内容
//
// ## 输出
// - 写入结果
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
// - 保持安全限制（路径限制）
// - 新增文件格式支持时需更新
//
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, extname } from "node:path";
import { buildTool } from "./tool-factory.js";
import { checkSyntax, formatDiagnostics } from "./syntax-check.js";

export const fileWriteTool = buildTool({
	name: "Write",
	description: "Writes a file to the local filesystem. Overwrites existing files.",
	prompt:
		"Writes a file to the local filesystem.\n\n" +
		"Usage:\n" +
		"- This tool will overwrite the existing file if there is one at the provided path.\n" +
		"- If this is an existing file, you MUST use the Read tool first to read the file's contents before overwriting.\n" +
		"- Prefer the Edit tool for modifying existing files - it only sends the diff. Only use this tool to create new files or for complete rewrites.\n" +
		"- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.\n" +
		"- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.\n" +
		"- Write operations are always restricted to the workspace directory.",
	meta: { category: "runtime", isReadOnly: false, isDestructive: true, isConcurrencySafe: false },
	configSchema: [
		{
			key: "syntaxCheck",
			type: "boolean",
			label: "Syntax Check",
			description: "写入后检查括号、引号等语法结构，发现问题提醒 agent",
			default: true,
		},
	],
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
			let result = `Successfully wrote ${content.length} bytes to ${path}`;
			const enabled = ctx.toolConfig?.Write?.syntaxCheck ?? true;
			if (enabled) {
				const ext = extname(path).slice(1).toLowerCase();
				const diags = checkSyntax(content, ext);
				if (diags.length) result += formatDiagnostics(path, diags);
			}
			return result;
		} catch (err: any) {
			return `Error writing file: ${err.message}`;
		}
	},
});
