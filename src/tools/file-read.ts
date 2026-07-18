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
import { resolve, basename, dirname, normalize } from "node:path";
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
import { isProtectedPathRealpath, wikiPathRejectMessage } from "./wiki-path-guard.js";
import { resolveSkillPath, replaceSkillDirVars } from "./skill-paths.js";
import { resolveToolOutputPath } from "./tool-output-paths.js";
import type { CallerCtx, ToolResult } from "./types.js";

function resolvePath(path: string, workingDir: string | undefined, restrictToWorkspace: boolean): string | { error: string } {
	if (!workingDir) return path;

	// Normalize: trim whitespace, strip surrounding quotes
	let p = path.trim();
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		p = p.slice(1, -1);
	}

	const resolved = normalize(resolve(workingDir, p));
	if (restrictToWorkspace && !resolved.startsWith(normalize(resolve(workingDir)))) {
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
	// tool-decoupling sub-3(决策 1/3 + G5/G6):workingDir / toolConfig / readScope
	// 从 callerCtx 取(不经 ctx);返 ToolResult{data:{path, text, mode?}}(G6 文本壳,
	// +path/offset/limit 元数据);format(r) = r.data.text。行为与 sub-3 前一致。
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult> => {
		const { path, offset, limit: inputLimit, pages } = input;
		const config = callerCtx.toolConfig?.Read ?? {};
		const maxLines = config.max_lines ?? 2000;
		const maxFileSize = config.max_file_size ?? 256;
		const maxBytes = maxFileSize > 0 ? maxFileSize * 1024 : 0;
		const mode = (offset != null) ? "full" : (input.mode ?? config.default_mode ?? "full");
		const restrictToWorkspace = callerCtx.readScope === "workspace";
		const workingDir = callerCtx.workingDir;

		const wrap = (text: string, extra: Record<string, unknown> = {}): ToolResult => ({
			ok: !/^Error:/.test(text),
			data: { path, text, mode, ...extra },
		});

		// v0.8 (P1 §10.1): block agent reads of the wiki memory store.
		// round-2 Fix 2 (acceptance-08 §B blocker): use the realpath-aware
		// variant so symlink/junction bypass (lexical path in workspace,
		// realpath inside db/wiki/backups) is caught. lexical-only
		// isWikiDiskPath misses Windows junctions (no admin needed to create).
		if (isProtectedPathRealpath(path, workingDir)) return wrap(wikiPathRejectMessage(path));

		// skill-system sub-2: `[skills]/<id>/<rel>` 虚拟路径通道。
		// 读家族始终放行(不经 restrictToWorkspace);解析 → 真实路径直接用(真实路径
		// readScope 不变;这里是受信 skill 读取入口)。沙箱由 resolveSkillPath 保证。
		//
		// sub-5: `[tool-outputs]/<rel>` 虚拟路径通道(外部化指针回读入口)。镜像 skill
		// 通道的"前缀识别 → 真实路径直接用"模式;沙箱由 resolveToolOutputPath 保证
		// (`../` 越界拒,如 `[tool-outputs]/../../etc/passwd`)。
		const skillResolved = resolveSkillPath(path);
		const toolOutputResolved = resolveToolOutputPath(path);
		let resolved: string;
		let skillIdForVarReplace: string | null = null;
		if (skillResolved !== null) {
			if (!skillResolved.ok) return wrap(`Error: ${skillResolved.error}`);
			// skill 通道:始终放行,真实路径直接用(绕过 resolvePath 的 workspace 守卫)。
			resolved = skillResolved.realPath;
			skillIdForVarReplace = skillResolved.skillId;
		} else if (toolOutputResolved !== null) {
			if (!toolOutputResolved.ok) return wrap(`Error: ${toolOutputResolved.error}`);
			// tool-outputs 通道:始终放行,真实路径直接用(绕过 resolvePath 的 workspace 守卫)。
			// 沙箱由 resolveToolOutputPath 保证(防 `../` 越界逃出 tool-outputs 目录)。
			resolved = toolOutputResolved.realPath;
		} else {
			// 非 `[skills]/` 且非 `[tool-outputs]/` 前缀 → 原 resolvePath(readScope 照常)。
			const r = resolvePath(path, workingDir, restrictToWorkspace);
			if (typeof r === "object") return wrap(r.error);
			resolved = r;
		}

		try {
			// 1. Stat the file
			const fileStat = await stat(resolved);

			// 2. Directory check
			if (fileStat.isDirectory()) {
				return wrap(`Error: ${path} is a directory, not a file. Use Glob to list directory contents.`);
			}

			// 3. File type detection
			const fileType = detectFileType(resolved);

			// 4. Binary block
			if (fileType === "block") {
				return wrap(`Error: Cannot read binary file. Binary files (executables, archives, media, fonts, etc.) are not supported.`);
			}

			// 5. File size limit
			if (maxBytes > 0 && fileStat.size > maxBytes) {
				return wrap(`File too large (${formatBytes(fileStat.size)}). Maximum is ${formatBytes(maxBytes)}.\nUse offset and limit parameters to read specific sections of large files.`);
			}

			// 6. Image
			if (fileType === "image") {
				return wrap(formatImageInfo(resolved, fileStat.size), { fileType: "image" });
			}

			// 7. PDF
			if (fileType === "pdf") {
				return wrap(await extractPdfText(resolved, fileStat.size, pages), { fileType: "pdf" });
			}

			// 8. Read raw bytes and decode
			const rawBuffer = await readFile(resolved);
			let content = decodeBuffer(rawBuffer);

			// skill-system sub-2:读 skill md 正文做自引用变量替换(可移植自引用)。
			// ${SKILL_DIR} / ${CLAUDE_SKILL_DIR} → [skills]/<id>(两变量都换)。
			// 仅 md 文件 + 经 [skills]/ 通道读取时做(协议:只换 skill md 正文)。
			if (skillIdForVarReplace !== null && resolved.toLowerCase().endsWith(".md")) {
				content = replaceSkillDirVars(content, skillIdForVarReplace);
			}

			// 9. Jupyter Notebook
			if (fileType === "notebook") {
				return wrap(parseJupyterNotebook(content, resolved, pages), { fileType: "notebook" });
			}

			// 10. Outline mode
			if (mode === "outline") {
				const outline = extractOutline(basename(resolved), content);
				return wrap(renderOutline(outline, { budget: inputLimit ?? maxLines, source: content }));
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
			return wrap(result, { offset: start + 1, limit: end - start, totalLines: lines.length, truncated });
		} catch (err: any) {
			if (err.code === "ENOENT") {
				const parentDir = dirname(resolved as string);
				let parentExists = false;
				try { parentExists = (await stat(parentDir)).isDirectory(); } catch { /* ignore */ }
				let msg = `Error: File not found: ${path}\n  Resolved: ${resolved}`;
				if (!parentExists) {
					msg += `\n  Parent directory does not exist: ${parentDir}`;
				}
				const suggestions = await suggestSimilarFiles(resolved as string, workingDir);
				if (suggestions) msg += "\n\n" + suggestions;
				return wrap(msg);
			}
			if (err.code === "EACCES") {
				return wrap(`Error: Permission denied: ${path}\n  Resolved: ${resolved}`);
			}
			if (err.code === "EISDIR") {
				return wrap(`Error: ${path} is a directory, not a file. Use Glob to list directory contents.`);
			}
			return wrap(`Error reading file: ${err.message}\n  Path: ${path}\n  Resolved: ${resolved}`);
		}
	},
	// format(决策 3,G6):透出 data.text。文本形态与 sub-3 前完全一致。
	format: (result: ToolResult): string => {
		return (result.data as any)?.text ?? result.error ?? "Read failed.";
	},
});
