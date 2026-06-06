// 文件读取工具
//
// # 文件说明书
//
// ## 核心功能
// 提供文件读取能力，支持多种文件格式（文本、图片、PDF 等）。
//
// ## 输入
// - 文件路径
// - 工作目录
//
// ## 输出
// - 文件内容
// - 元数据（大小、类型等）
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - node:fs - 文件系统
// - ./outline - 大纲提取
//
// ## 维护规则
// - 新增文件格式支持时需更新
// - 保持安全性（路径限制）
//
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { buildTool } from "./tool-factory.js";
import { extractOutline } from "./outline/index.js";
import { renderOutline } from "./outline/renderer.js";
import {
	detectFileType,
	decodeBuffer,
	formatImageInfo,
	extractPdfText,
	parseJupyterNotebook,
	suggestSimilarFiles,
	formatBytes,
	MAX_FILE_SIZE,
} from "./file-read-helpers.js";

function resolvePath(path: string, workingDir: string | undefined, restrictToWorkspace: boolean): string | { error: string } {
	if (!workingDir) return path;
	const resolved = resolve(workingDir, path);
	if (restrictToWorkspace && !resolved.startsWith(resolve(workingDir))) {
		return { error: `Access denied: path outside workspace (${path})` };
	}
	return resolved;
}

export const fileReadTool = buildTool({
	name: "Read",
	description: "Reads a file from the local filesystem. Supports text, PDF, Jupyter notebooks, and outline mode.",
	prompt:
		"Reads a file from the local filesystem. You can access any file directly by using this tool.\n" +
		"Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist — an error will be returned.\n\n" +
		"Usage:\n" +
		"- The file_path parameter must be an absolute path, not a relative path\n" +
		"- By default, it reads up to max_lines lines starting from the beginning of the file\n" +
		"- You can optionally specify a line offset and limit (especially handy for large files), but it's recommended to read the whole file by not providing these parameters\n" +
		"- Results are returned using cat -n format, with line numbers starting at 1\n" +
		"- This tool can read Jupyter notebooks (.ipynb files) — returns all cells with their outputs\n" +
		"- This tool can extract text from PDF files\n" +
		"- Use `mode='outline'` to get a structured code outline showing the file's symbol hierarchy. Prefer outline mode when:\n" +
		"  - First reading a file you haven't seen before, especially large files (saves tokens)\n" +
		"  - You need to understand the file's structure and find specific functions/classes before reading details\n" +
		"  - Exploring a codebase to locate relevant code\n" +
		"- In outline mode, collapsed sections appear as `L10-45  myFunction [collapsed, lines 10-45]`. To read the collapsed content, call Read again with the matching offset and limit (e.g., offset=10 limit=36), or use mode='full' to read the entire file\n" +
		"- Any file which appears to be binary (images, executables, etc) will be rejected",
	meta: { category: "runtime", isReadOnly: true },
	configSchema: [
		{ key: "max_lines", type: "number", label: "Max Lines (lines)", default: 2000, description: "单次读取/大纲输出的最大行数" },
		{ key: "default_mode", type: "select", label: "Default Mode", default: "full", options: ["full", "outline"], description: "未指定 mode 时的默认读取模式" },
		{ key: "max_file_size", type: "number", label: "Max File Size (KB)", default: 256, description: "最大文件大小 (KB，0 = 不限制)" },
	],
	inputSchema: z.object({
		path: z.string().describe("Absolute or relative file path"),
		offset: z.number().optional().describe("Line number to start reading from (1-based). Only provide for large files where you know which part to read."),
		limit: z.number().optional().describe("Number of lines to read. Only provide for large files where you know which part to read."),
		mode: z.enum(["full", "outline"]).optional().describe("full=raw text with line numbers, outline=structured code outline"),
		pages: z.string().optional().describe("Page range for PDF/notebook files (e.g., '1-5', '3', '10-20'). Only applies to PDF and .ipynb files."),
	}),
	execute: async (input, ctx) => {
		const { path, offset, limit: inputLimit, pages } = input;
		const config = ctx.toolConfig?.Read ?? {};
		const maxLines = config.max_lines ?? 2000;
		const maxFileSize = config.max_file_size ?? 256;
		const maxBytes = maxFileSize > 0 ? maxFileSize * 1024 : 0;
		const mode = (offset != null) ? "full" : (input.mode ?? config.default_mode ?? "full");
		const restrictToWorkspace = ctx.readScope === "workspace";
		const resolved = resolvePath(path, ctx.workingDir, restrictToWorkspace);
		if (typeof resolved === "object") return resolved.error;

		try {
			// 1. Stat the file
			const fileStat = await stat(resolved);

			// 2. Directory check
			if (fileStat.isDirectory()) {
				return `Error: ${path} is a directory, not a file. Use Glob to list directory contents.`;
			}

			// 3. File type detection
			const fileType = detectFileType(resolved);

			// 4. Binary block
			if (fileType === "block") {
				return `Error: Cannot read binary file. Binary files (executables, archives, media, fonts, etc.) are not supported.`;
			}

			// 5. File size limit
			if (maxBytes > 0 && fileStat.size > maxBytes) {
				return `File too large (${formatBytes(fileStat.size)}). Maximum is ${formatBytes(maxBytes)}.\nUse offset and limit parameters to read specific sections of large files.`;
			}

			// 6. Image
			if (fileType === "image") {
				return formatImageInfo(resolved, fileStat.size);
			}

			// 7. PDF
			if (fileType === "pdf") {
				return await extractPdfText(resolved, fileStat.size, pages);
			}

			// 8. Read raw bytes and decode
			const rawBuffer = await readFile(resolved);
			const content = decodeBuffer(rawBuffer);

			// 9. Jupyter Notebook
			if (fileType === "notebook") {
				return parseJupyterNotebook(content, resolved, pages);
			}

			// 10. Outline mode
			if (mode === "outline") {
				const outline = extractOutline(basename(resolved), content);
				return renderOutline(outline, { budget: inputLimit ?? maxLines, source: content });
			}

			// 11. Full mode
			const lines = content.split(/\r?\n/);
			// Remove trailing empty line from split if file ends with newline
			if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

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
			if (err.code === "ENOENT") {
				const suggestions = await suggestSimilarFiles(resolved as string, ctx.workingDir);
				return `Error: File not found: ${path}${suggestions ? "\n\n" + suggestions : ""}`;
			}
			if (err.code === "EACCES") {
				return `Error: Permission denied: ${path}`;
			}
			if (err.code === "EISDIR") {
				return `Error: ${path} is a directory, not a file. Use Glob to list directory contents.`;
			}
			return `Error reading file: ${err.message}`;
		}
	},
});
