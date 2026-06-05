// 项目上下文收集器
//
// # 文件说明书
//
// ## 核心功能
// 扫描项目目录，收集上下文文件（CLAUDE.md、文档等）供 agent 使用
//
// ## 输入
// 项目根目录路径、配置的上下文文件模式
//
// ## 输出
// ContextFile 数组，包含文件路径和内容
//
// ## 定位
// src/core/ — 核心层，为 system-prompt 提供项目上下文
//
// ## 依赖
// Node.js fs/path 模块
//
// ## 维护规则
// 新增上下文文件类型时需更新文件匹配逻辑
//
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextFile {
	path: string;
	content: string;
}

export interface ProjectInfo {
	name?: string;
	version?: string;
	language?: string;
	framework?: string;
	packageManager?: string;
	rootDir: string;
}

export interface ProjectContextResult {
	contextFiles: ContextFile[];
	projectInfo: ProjectInfo;
	directorySummary: string;
}

// ---------------------------------------------------------------------------
// Context file discovery (wraps Pi Agent's convention)
// ---------------------------------------------------------------------------

const CONTEXT_FILENAMES = ["AGENTS.md", "CLAUDE.md"];

export function loadContextFiles(cwd: string): ContextFile[] {
	const files: ContextFile[] = [];
	const seen = new Set<string>();

	// Walk up from cwd to root, looking for context files
	let dir = resolve(cwd);
	const root = resolve("/");

	while (true) {
		for (const filename of CONTEXT_FILENAMES) {
			const filePath = join(dir, filename);
			if (seen.has(filePath)) continue;
			if (existsSync(filePath)) {
				try {
					files.unshift({ path: filePath, content: readFileSync(filePath, "utf-8") });
					seen.add(filePath);
				} catch { /* skip unreadable */ }
			}
		}
		if (dir === root) break;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}

	return files;
}

// ---------------------------------------------------------------------------
// Project info detection
// ---------------------------------------------------------------------------

export function detectProjectInfo(cwd: string): ProjectInfo {
	const info: ProjectInfo = { rootDir: resolve(cwd) };

	// package.json → Node.js project
	const pkgPath = join(cwd, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			info.name = pkg.name;
			info.version = pkg.version;

			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			if (deps.next) info.framework = "Next.js";
			else if (deps.nuxt) info.framework = "Nuxt";
			else if (deps.react) info.framework = "React";
			else if (deps.vue) info.framework = "Vue";
			else if (deps.express) info.framework = "Express";
			else if (deps.fastify) info.framework = "Fastify";
			else if (deps.svelte) info.framework = "Svelte";

			if (deps.typescript || existsSync(join(cwd, "tsconfig.json"))) {
				info.language = "TypeScript";
			} else {
				info.language = "JavaScript";
			}

			if (existsSync(join(cwd, "pnpm-lock.yaml"))) info.packageManager = "pnpm";
			else if (existsSync(join(cwd, "yarn.lock"))) info.packageManager = "yarn";
			else if (existsSync(join(cwd, "bun.lockb"))) info.packageManager = "bun";
			else info.packageManager = "npm";
		} catch { /* skip invalid package.json */ }
	}

	// Non-Node.js project detection
	if (!info.language) {
		if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
			info.language = "Python";
		} else if (existsSync(join(cwd, "Cargo.toml"))) {
			info.language = "Rust";
		} else if (existsSync(join(cwd, "go.mod"))) {
			info.language = "Go";
		} else if (existsSync(join(cwd, "pom.xml")) || existsSync(join(cwd, "build.gradle"))) {
			info.language = "Java";
		}
	}

	return info;
}

// ---------------------------------------------------------------------------
// Directory summary
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDE = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".cache", ".turbo", "target", ".gradle"]);

export function generateDirectorySummary(
	cwd: string,
	maxDepth = 3,
	excludePatterns?: string[],
): string {
	const exclude = new Set([...DEFAULT_EXCLUDE, ...(excludePatterns ?? [])]);
	const lines: string[] = [];

	function walk(dir: string, prefix: string, depth: number): void {
		if (depth > maxDepth) {
			lines.push(`${prefix}...`);
			return;
		}
		try {
			const entries = readdirSync(dir, { withFileTypes: true })
				.filter((e) => !e.name.startsWith(".") && !exclude.has(e.name))
				.sort((a, b) => {
					if (a.isDirectory() && !b.isDirectory()) return -1;
					if (!a.isDirectory() && b.isDirectory()) return 1;
					return a.name.localeCompare(b.name);
				});

			// Limit entries per level to keep summary concise
			const maxEntries = depth === 0 ? 20 : 10;
			const shown = entries.slice(0, maxEntries);

			for (const entry of shown) {
				if (entry.isDirectory()) {
					lines.push(`${prefix}${entry.name}/`);
					walk(join(dir, entry.name), `${prefix}  `, depth + 1);
				} else {
					lines.push(`${prefix}${entry.name}`);
				}
			}
			if (entries.length > maxEntries) {
				lines.push(`${prefix}... (${entries.length - maxEntries} more)`);
			}
		} catch { /* skip unreadable dirs */ }
	}

	walk(resolve(cwd), "", 0);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full project context
// ---------------------------------------------------------------------------

export function loadProjectContext(
	cwd: string,
	config?: {
		injectProjectContext?: boolean;
		maxDirectoryDepth?: number;
		excludePatterns?: string[];
	},
): ProjectContextResult | null {
	if (config?.injectProjectContext === false) return null;

	const maxDepth = config?.maxDirectoryDepth ?? 3;
	const exclude = config?.excludePatterns;

	return {
		contextFiles: loadContextFiles(cwd),
		projectInfo: detectProjectInfo(cwd),
		directorySummary: generateDirectorySummary(cwd, maxDepth, exclude),
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatProjectContext(ctx: ProjectContextResult): string {
	const parts: string[] = [];

	// Project info header
	const info = ctx.projectInfo;
	const infoParts: string[] = [];
	if (info.name) infoParts.push(`Project: ${info.name}`);
	if (info.language) infoParts.push(`Language: ${info.language}`);
	if (info.framework) infoParts.push(`Framework: ${info.framework}`);
	if (info.packageManager) infoParts.push(`Package Manager: ${info.packageManager}`);
	if (info.version) infoParts.push(`Version: ${info.version}`);
	if (infoParts.length > 0) {
		parts.push("### Project Info\n" + infoParts.join("\n"));
	}

	// Context files
	for (const file of ctx.contextFiles) {
		parts.push(`### ${file.path}\n${file.content}`);
	}

	// Directory tree
	if (ctx.directorySummary) {
		parts.push("### Directory Structure\n```\n" + ctx.directorySummary + "\n```");
	}

	return parts.join("\n\n");
}
