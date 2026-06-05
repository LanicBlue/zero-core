// Glob 文件匹配工具
//
// # 文件说明书
//
// ## 核心功能
// 提供文件模式匹配能力，基于 glob 模式查找文件。
//
// ## 输入
// - glob 模式
// - 搜索路径
//
// ## 输出
// - 匹配的文件路径列表
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - node:fs - 文件系统
//
// ## 维护规则
// - 保持 glob 模式兼容
// - 处理路径分隔符差异
//
import { z } from "zod";
import { resolve, relative } from "node:path";
import { stat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { buildTool } from "./tool-factory.js";

export const globTool = buildTool({
	name: "Glob",
	description: "Fast file pattern matching tool. Returns matching file paths sorted by modification time.",
		prompt: "Fast file pattern matching. Returns matching paths sorted by modification time.\n\n" +
			"When to use Glob:\n" +
			"- Finding files by name, extension, or path pattern\n" +
			"- Discovering project structure\n\n" +
			"When NOT to use: searching file contents — use Grep instead.\n\n" +
			"Pattern examples:\n" +
			"- **/*.ts — all TypeScript files recursively\n" +
			"- src/**/*.test.ts — test files under src/\n" +
			"- *.{json,yaml,yml} — config files\n\n" +
			"Use path parameter to scope search to a directory.\n" +
			"For multi-round searches, use the Agent tool instead.",
	meta: { category: "runtime", isReadOnly: true, isConcurrencySafe: true },
	inputSchema: z.object({
		pattern: z.string().describe('Glob pattern to match files against (e.g., "**/*.ts", "src/**/*.tsx")'),
		path: z.string().optional().describe("Directory to search in (defaults to current working directory)"),
	}),
	execute: async (input, ctx) => {
		const { pattern, path } = input;
		const config = ctx.toolConfig?.Glob ?? {};
		const limit = config.result_limit ?? 250;
		const restrictToWorkspace = ctx.readScope === "workspace";
		const workingDir = ctx.workingDir;

		let searchPath: string;
		if (path) {
			searchPath = workingDir ? resolve(workingDir, path) : resolve(path);
			if (restrictToWorkspace && workingDir && !searchPath.startsWith(resolve(workingDir))) {
				return `Access denied: search path outside workspace (${path})`;
			}
		} else {
			searchPath = workingDir || ".";
		}

		const fullPattern = resolve(searchPath, pattern);

		type FileEntry = { path: string; mtime: number };
		const entries: FileEntry[] = [];

		for await (const file of glob(fullPattern)) {
			try {
				const s = await stat(file);
				if (!s.isFile()) continue;
				entries.push({ path: file, mtime: s.mtimeMs });
			} catch { /* skip inaccessible files */ }
			if (entries.length >= limit * 2) break; // over-collect for sort, but cap memory
		}

		if (entries.length === 0) return `No files matching '${pattern}' found.`;

		// Sort by modification time descending (most recent first)
		entries.sort((a, b) => b.mtime - a.mtime);

		const truncated = entries.length > limit;
		const results = entries.slice(0, limit);

		const display = results.map((e) =>
			relative(workingDir ?? searchPath, e.path).replace(/\\/g, "/"),
		);

		let output = display.join("\n");
		if (truncated) output += `\n\n... (${entries.length} total files, showing first ${limit})`;
		return output;
	},
});
