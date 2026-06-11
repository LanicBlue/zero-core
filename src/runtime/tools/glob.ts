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
// - 排除模式
// - 结果数量限制
//
// ## 输出
// - 匹配的文件路径列表（按修改时间排序）
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
import { resolve, relative, normalize } from "node:path";
import { stat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { buildTool } from "./tool-factory.js";

// Directories to always skip
const SKIP_DIRS = new Set([
	"node_modules", ".git", ".svn", ".hg",
	"dist", "build", ".next", ".nuxt", ".cache",
	"__pycache__", ".tox", ".venv", "venv",
	".gradle", ".idea", ".vs",
	"coverage", ".nyc_output",
]);

function isUnderSkipDir(filePath: string, root: string): boolean {
	const rel = relative(root, filePath);
	const segments = rel.replace(/\\/g, "/").split("/");
	return segments.some((s) => SKIP_DIRS.has(s));
}

function matchExclude(filePath: string, excludes: string[], root: string): boolean {
	const rel = relative(root, filePath).replace(/\\/g, "/");
	for (const ex of excludes) {
		if (rel.includes(ex) || rel.match(ex)) return true;
	}
	return false;
}

export const globTool = buildTool({
	name: "Glob",
	description: "Fast file pattern matching tool. Returns matching file paths sorted by modification time.",
	prompt:
		"Fast file pattern matching. Returns matching paths sorted by modification time.\n\n" +
		"When to use Glob:\n" +
		"- Finding files by name, extension, or path pattern\n" +
		"- Discovering project structure\n\n" +
		"When NOT to use: searching file contents — use Grep instead.\n\n" +
		"Pattern examples:\n" +
		"- **/*.ts — all TypeScript files recursively\n" +
		"- src/**/*.test.ts — test files under src/\n" +
		"- *.{json,yaml,yml} — config files\n\n" +
		"Common directories (node_modules, .git, dist, __pycache__, etc.) are automatically excluded.\n" +
		"Use `exclude` to add additional patterns to skip.\n" +
		"Use path parameter to scope search to a directory.\n" +
		"For multi-round searches, use the Agent tool instead.",
	meta: { category: "runtime", isReadOnly: true, isConcurrencySafe: true },
	configSchema: [
		{ key: "result_limit", type: "number", label: "Default Limit", default: 30, description: "默认返回的最大文件数量" },
		{ key: "skip_common_dirs", type: "boolean", label: "Skip Common Dirs", default: true, description: "自动跳过 node_modules/.git/dist 等目录" },
	],
	inputSchema: z.object({
		pattern: z.string().describe('Glob pattern to match files against (e.g., "**/*.ts", "src/**/*.tsx")'),
		path: z.string().optional().describe("Directory to search in (defaults to current working directory)"),
		exclude: z.string().optional().describe("Comma-separated patterns to exclude (e.g., '*.test.ts,*.spec.ts,mocks')"),
		limit: z.number().optional().describe("Max number of results to return (default: 30)"),
	}),
	execute: async (input, ctx) => {
		const { pattern, path, exclude, limit: inputLimit } = input;
		const config = ctx.toolConfig?.Glob ?? {};
		const limit = inputLimit ?? config.result_limit ?? 30;
		const skipCommon = config.skip_common_dirs !== false;
		const restrictToWorkspace = ctx.readScope === "workspace";
		const workingDir = ctx.workingDir;

		let searchPath: string;
		if (path) {
			let p = path.trim();
			if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
				p = p.slice(1, -1);
			}
			searchPath = workingDir ? normalize(resolve(workingDir, p)) : normalize(resolve(p));
			if (restrictToWorkspace && workingDir && !searchPath.startsWith(normalize(resolve(workingDir)))) {
				return `Access denied: search path outside workspace (${path})`;
			}
		} else {
			searchPath = workingDir || ".";
		}

		const excludes = exclude ? exclude.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
		const fullPattern = resolve(searchPath, pattern);

		type FileEntry = { path: string; mtime: number };
		const entries: FileEntry[] = [];
		let totalScanned = 0;
		let totalSkipped = 0;

		for await (const file of glob(fullPattern)) {
			totalScanned++;

			// Skip common heavy directories (when enabled)
			if (skipCommon && isUnderSkipDir(file, searchPath)) {
				totalSkipped++;
				continue;
			}

			// Skip user-specified excludes
			if (excludes.length && matchExclude(file, excludes, searchPath)) {
				totalSkipped++;
				continue;
			}

			try {
				const s = await stat(file);
				if (!s.isFile()) continue;
				entries.push({ path: file, mtime: s.mtimeMs });
			} catch { /* skip inaccessible files */ }

			// Cap memory: stop scanning after collecting enough
			if (entries.length >= limit * 5) break;
		}

		if (entries.length === 0) {
			if (totalSkipped > 0) {
				return `No files matching '${pattern}' found (${totalSkipped} files skipped in excluded directories).`;
			}
			return `No files matching '${pattern}' found.`;
		}

		// Sort by modification time descending (most recent first)
		entries.sort((a, b) => b.mtime - a.mtime);

		const totalMatched = entries.length;
		const truncated = totalMatched > limit;
		const results = entries.slice(0, limit);

		const display = results.map((e) =>
			relative(workingDir ?? searchPath, e.path).replace(/\\/g, "/"),
		);

		let output = display.join("\n");
		if (truncated) {
			output += `\n\n(${totalMatched} files match, showing ${limit} most recent. Use a more specific pattern or increase limit to see more.)`;
		}
		if (totalSkipped > 0 && !truncated) {
			output += `\n(${totalSkipped} files in excluded directories were skipped)`;
		}
		return output;
	},
});
