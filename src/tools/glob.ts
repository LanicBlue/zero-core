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
import { isWikiDiskPath, wikiPathRejectMessage } from "./wiki-path-guard.js";
import { tryParseSkillPath, mapRealToVirtual, isPathInSkillBase, isSkillVirtualPath } from "./skill-paths.js";
import { resolveSkillByName } from "../server/skill-scanner.js";
import type { CallerCtx, ToolResult } from "./types.js";

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
	// tool-decoupling sub-3(决策 1/3 + G5/G6):workingDir / toolConfig / readScope
	// 从 callerCtx 取;返 ToolResult{data:{pattern, text, matches, truncated?}}
	// (G6 文本壳 + 元数据);format(r) = r.data.text。行为同 sub-3 前。
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult> => {
		const { pattern, path, exclude, limit: inputLimit } = input;
		const config = callerCtx.toolConfig?.Glob ?? {};
		const limit = inputLimit ?? config.result_limit ?? 30;
		const skipCommon = config.skip_common_dirs !== false;
		const restrictToWorkspace = callerCtx.readScope === "workspace";
		const workingDir = callerCtx.workingDir;

		const wrap = (text: string, extra: Record<string, unknown> = {}): ToolResult => ({
			ok: !/^Error:|Access denied/.test(text),
			data: { pattern, text, ...extra },
		});

		let searchPath: string;
		// skill-system sub-2:`[skills]/<id>/...` 虚拟路径通道。
		// 读家族始终放行;单 skill 限定(`[skills]/<id>/...`),裸 `[skills]/**` 拒;
		// 结果路径回映射成虚拟形态(防真实路径泄露)。
		// pattern 与 path 任一以 `[skills]/` 开头即走 skill 通道。
		let skillCtx: { skillId: string; baseDir: string } | null = null;
		const parsedFromPattern = tryParseSkillPath(pattern);
		const parsedFromPath = path ? tryParseSkillPath(path) : null;
		// pattern 或 path 是 skill 虚拟前缀但未指名 skill(裸 [skills]/ 或 [skills]/*)→ 拒。
		// tryParseSkillPath 对这些返 null,需用前缀判定兜底(单 skill 边界)。
		if (
			(!parsedFromPattern && isSkillVirtualPath(pattern)) ||
			(path && !parsedFromPath && isSkillVirtualPath(path))
		) {
			return wrap("Access denied: bare `[skills]/` glob is not supported; name a specific skill as `[skills]/<id>/...`.");
		}
		if (parsedFromPattern || parsedFromPath) {
			// 单 skill 边界:必须指名 skill(skillId 非空)。裸 `[skills]/**` / `[skills]/*` 拒。
			const fromPattern = parsedFromPattern && parsedFromPattern.skillId ? parsedFromPattern : null;
			const fromPath = parsedFromPath && parsedFromPath.skillId ? parsedFromPath : null;
			const ref = fromPattern ?? fromPath;
			if (!ref) {
				return wrap("Access denied: bare `[skills]/` glob is not supported; name a specific skill as `[skills]/<id>/...`.");
			}
			// skillId 含 glob 通配字符(* ? [ { )→ 跨 skill 枚举意图,拒(单 skill 边界)。
			if (/[*?\[\]{}]/.test(ref.skillId)) {
				return wrap("Access denied: cross-skill glob is not supported; name a single skill as `[skills]/<id>/...`.");
			}
			const skill = resolveSkillByName(ref.skillId);
			if (!skill) {
				return wrap(`Error: skill not found: ${ref.skillId}`);
			}
			skillCtx = { skillId: skill.id, baseDir: normalize(skill.baseDir) };
			searchPath = skillCtx.baseDir;
		} else if (path) {
			let p = path.trim();
			if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
				p = p.slice(1, -1);
			}
			// v0.8 (P1 §10.1): block agent globbing inside the wiki memory store.
			if (isWikiDiskPath(p, workingDir)) return wrap(wikiPathRejectMessage(p));
			searchPath = workingDir ? normalize(resolve(workingDir, p)) : normalize(resolve(p));
			if (restrictToWorkspace && workingDir && !searchPath.startsWith(normalize(resolve(workingDir)))) {
				return wrap(`Access denied: search path outside workspace (${path})`);
			}
		} else {
			searchPath = workingDir || ".";
		}

		const excludes = exclude ? exclude.split(",").map((s: string) => s.trim()).filter(Boolean) : [];

		// skill 通道:pattern 可能带 `[skills]/<id>/` 虚拟前缀(Glob [skills]/foo/**),
		// 剥离成 rel glob 后再 resolve 到真实 baseDir。
		let realPattern = pattern;
		if (skillCtx) {
			const parsedPat = tryParseSkillPath(pattern);
			if (parsedPat && parsedPat.skillId === skillCtx.skillId) {
				// pattern 起头是 [skills]/<id>/...,rel 部分即真正 glob。
				realPattern = parsedPat.rel || "**";
			}
			// path 通道(pattern 不带虚拟前缀)→ realPattern 保持原样(rel glob)。
		}
		const fullPattern = resolve(searchPath, realPattern);

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
				// skill 通道沙箱兜底:glob 因 pattern 含 `..` 等跑出 baseDir 的结果一律丢。
				if (skillCtx && !isPathInSkillBase(file, skillCtx.baseDir)) continue;
				entries.push({ path: file, mtime: s.mtimeMs });
			} catch { /* skip inaccessible files */ }

			// Cap memory: stop scanning after collecting enough
			if (entries.length >= limit * 5) break;
		}

		if (entries.length === 0) {
			if (totalSkipped > 0) {
				return wrap(`No files matching '${pattern}' found (${totalSkipped} files skipped in excluded directories).`, { matches: [] });
			}
			return wrap(`No files matching '${pattern}' found.`, { matches: [] });
		}

		// Sort by modification time descending (most recent first)
		entries.sort((a, b) => b.mtime - a.mtime);

		const totalMatched = entries.length;
		const truncated = totalMatched > limit;
		const results = entries.slice(0, limit);

		const display = results.map((e) => {
			if (skillCtx) {
				// skill 通道:回映射成虚拟路径,杜绝真实 baseDir 泄露。
				return mapRealToVirtual(e.path, skillCtx.skillId, skillCtx.baseDir);
			}
			return relative(workingDir ?? searchPath, e.path).replace(/\\/g, "/");
		});

		let output = display.join("\n");
		if (truncated) {
			output += `\n\n(${totalMatched} files match, showing ${limit} most recent. Use a more specific pattern or increase limit to see more.)`;
		}
		if (totalSkipped > 0 && !truncated) {
			output += `\n(${totalSkipped} files in excluded directories were skipped)`;
		}
		return wrap(output, { matches: display, totalMatched, truncated });
	},
	// format(决策 3,G6):透出 data.text。文本形态与 sub-3 前完全一致。
	format: (result: ToolResult): string => {
		return (result.data as any)?.text ?? result.error ?? "Glob failed.";
	},
});
