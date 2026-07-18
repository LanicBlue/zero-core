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
// - overwrite 标志
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
import { writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve, extname, normalize, basename } from "node:path";
import { buildTool } from "./tool-factory.js";
import { checkSyntax, formatDiagnostics } from "./syntax-check.js";
import { isProtectedPathRealpath, wikiPathRejectMessage } from "./wiki-path-guard.js";
import { resolveSkillWritePath, stampAuthorFrontmatter } from "./skill-paths.js";
import { checkSkillAuthorGate } from "./skill-author-gate.js";
import type { CallerCtx, ToolResult } from "./types.js";

function resolvePath(path: string, workingDir: string): string | { error: string } {
	let p = path.trim();
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		p = p.slice(1, -1);
	}
	const resolved = normalize(resolve(workingDir, p));
	if (!resolved.startsWith(normalize(resolve(workingDir)))) {
		return { error: `Access denied: path outside workspace (${path})` };
	}
	return resolved;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const fileWriteTool = buildTool({
	name: "Write",
	description: "Writes a file to the local filesystem. Requires overwrite=true for existing files.",
	prompt:
		"Writes a file to the local filesystem.\n\n" +
		"Usage:\n" +
		"- This tool will overwrite the existing file if there is one at the provided path, BUT only when `overwrite=true` is set.\n" +
		"- If the file already exists and `overwrite` is not set to true, the tool will return a warning with the existing file info instead of writing. Set `overwrite=true` to proceed.\n" +
		"- If this is an existing file, you MUST use the Read tool first to read the file's contents before overwriting.\n" +
		"- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.\n" +
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
		overwrite: z.boolean().optional().describe("Set to true to overwrite an existing file. Without this, writing to an existing file returns a warning."),
	}),
	// tool-decoupling sub-3(决策 1/3 + G5/G6):workingDir / toolConfig 从
	// callerCtx 取;返 ToolResult{data:{path, text, bytes, action}}(G6 文本壳 +
	// 元数据);format(r) = r.data.text。行为同 sub-3 前。
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult> => {
		const { path, content, overwrite } = input;
		const wrap = (text: string, extra: Record<string, unknown> = {}): ToolResult => ({
			ok: !/^Error:|File already exists/.test(text),
			data: { path, text, ...extra },
		});
		if (!callerCtx.workingDir) return wrap("Error: no workspace directory configured");
		// v0.8 (P1 §10.1): block agent writes to the wiki memory store.
		// round-2 Fix 2 (acceptance-08 §B blocker): realpath-aware variant
		// catches symlink/junction bypass; missing-path falls back to
		// lexical check inside isProtectedPathRealpath (Write-create case).
		if (isProtectedPathRealpath(path, callerCtx.workingDir)) return wrap(wikiPathRejectMessage(path));

		// skill-system sub-8/sub-12 (decision 4 write + 11): `[skills]/<id>/<rel>` 虚拟
		// 路径写通道。门禁先行(sub-12: enabledSkills 不含 "skill-creator" → 拒,
		// 不落盘),再做路径解析(新/已存在/外部/越界/id 护栏)。读家族(Read/Glob/Grep)
		// 不经此分支。
		const skillWrite = resolveSkillWritePath(path);
		let resolved: string;
		let writeContent = content;
		if (skillWrite === null) {
			// 非 `[skills]/` 前缀 → 原 resolvePath(workspace 沙箱)。
			const r = resolvePath(path, callerCtx.workingDir);
			if (typeof r === "object") return wrap(r.error);
			resolved = r;
		} else if (!skillWrite.ok) {
			return wrap(`Error: ${skillWrite.error}`);
		} else {
			// skill 写:门禁查当前 agent 的 enabledSkills 是否含 skill-creator(sub-12)。
			const gateError = checkSkillAuthorGate(callerCtx);
			if (gateError) return wrap(gateError);
			resolved = skillWrite.realPath;
			// SKILL.md + markAuthor → 打 author 溯源 frontmatter(不覆盖 agent 自填)。
			if (skillWrite.markAuthor && basename(resolved).toLowerCase() === "skill.md") {
				const agentId = callerCtx.agentId;
				if (agentId) writeContent = stampAuthorFrontmatter(content, agentId);
			}
		}

		try {
			// Check if file already exists
			let existingStat;
			try {
				existingStat = await stat(resolved);
			} catch {
				// File doesn't exist — safe to create
			}

			if (existingStat && !overwrite) {
				const mtime = existingStat.mtime.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
				return wrap(
					`File already exists: ${path}\n` +
					`  Size: ${formatBytes(existingStat.size)}, Last modified: ${mtime}\n\n` +
					`Set overwrite=true to overwrite this file, or use Edit to modify it.`,
					{ exists: true, bytes: existingStat.size },
				);
			}

			await mkdir(dirname(resolved), { recursive: true });
			await writeFile(resolved, writeContent, "utf-8");
			const action = existingStat ? "Overwrote" : "Created";
			let result = `${action} ${path} (${writeContent.length} bytes)`;
			const enabled = callerCtx.toolConfig?.Write?.syntaxCheck ?? true;
			if (enabled) {
				const ext = extname(path).slice(1).toLowerCase();
				const diags = checkSyntax(writeContent, ext);
				if (diags.length) result += formatDiagnostics(path, diags);
			}
			return wrap(result, { action, bytes: writeContent.length });
		} catch (err: any) {
			return wrap(`Error writing file: ${err.message}\n  Path: ${path}\n  Resolved: ${resolved}`);
		}
	},
	// format(决策 3,G6):透出 data.text。文本形态与 sub-3 前完全一致。
	format: (result: ToolResult): string => {
		return (result.data as any)?.text ?? result.error ?? "Write failed.";
	},
});
