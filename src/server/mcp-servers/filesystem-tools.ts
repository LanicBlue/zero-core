import { tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, mkdir, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join, extname, relative } from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Filesystem Tools — built-in MCP server for file operations
// ---------------------------------------------------------------------------

const MAX_RESULTS = 100;
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "__pycache__", ".next", ".nuxt"]);

interface FilesystemOptions {
	baseDir: string;
}

function safePath(inputPath: string, baseDir: string): string | { error: string } {
	const resolved = resolve(baseDir, inputPath);
	if (!resolved.startsWith(resolve(baseDir))) {
		return { error: `Access denied: path outside workspace (${inputPath})` };
	}
	return resolved;
}

function isBinary(content: string): boolean {
	for (let i = 0; i < Math.min(content.length, 4096); i++) {
		const code = content.charCodeAt(i);
		if (code === 0) return true;
	}
	return false;
}

export function createFilesystemTools(options: FilesystemOptions) {
	const { baseDir } = options;

	return {
		fs_read: tool({
			description:
				"Read file contents with line numbers. Supports offset and limit for large files. " +
				"Rejects binary files. All paths are relative to or within the workspace root.",
			parameters: z.object({
				path: z.string().describe("File path (relative to workspace or absolute within workspace)"),
				offset: z.number().optional().describe("Start line number (1-based, default 1)"),
				limit: z.number().optional().describe("Number of lines to read (default 2000)"),
			}),
			execute: async ({ path, offset, limit }) => {
				const resolved = safePath(path, baseDir);
				if (typeof resolved === "object") return resolved.error;
				try {
					const content = await readFile(resolved, "utf-8");
					if (isBinary(content)) return "Error: binary file detected, cannot display";
					const lines = content.split("\n");
					const start = Math.max(1, offset ?? 1) - 1;
					const end = limit ? start + limit : lines.length;
					const selected = lines.slice(start, end);
					return selected.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
				} catch (err: any) {
					return `Error reading file: ${err.message}`;
				}
			},
		}),

		fs_write: tool({
			description:
				"Create or overwrite a file with the given content. Creates parent directories automatically. " +
				"Paths must be within the workspace root.",
			parameters: z.object({
				path: z.string().describe("File path (relative to workspace or absolute within workspace)"),
				content: z.string().describe("Content to write to the file"),
			}),
			execute: async ({ path, content }) => {
				const resolved = safePath(path, baseDir);
				if (typeof resolved === "object") return resolved.error;
				try {
					await mkdir(dirname(resolved), { recursive: true });
					await writeFile(resolved, content, "utf-8");
					const lineCount = content.split("\n").length;
					return `Wrote ${content.length} bytes (${lineCount} lines) to ${path}`;
				} catch (err: any) {
					return `Error writing file: ${err.message}`;
				}
			},
		}),

		fs_edit: tool({
			description:
				"Perform exact string replacement in a file. Set replace_all to true to replace all occurrences. " +
				"Paths must be within the workspace root.",
			parameters: z.object({
				path: z.string().describe("File path to edit"),
				old_string: z.string().describe("The text to find and replace"),
				new_string: z.string().describe("The replacement text"),
				replace_all: z.boolean().optional().default(false).describe("Replace all occurrences (default: first only)"),
			}),
			execute: async ({ path, old_string, new_string, replace_all }) => {
				const resolved = safePath(path, baseDir);
				if (typeof resolved === "object") return resolved.error;
				if (old_string === new_string) return "Error: old_string and new_string are identical";
				try {
					if (!existsSync(resolved)) return `Error: file not found: ${path}`;
					let content = await readFile(resolved, "utf-8");
					if (!content.includes(old_string)) return `Error: old_string not found in ${path}`;
					const count = content.split(old_string).length - 1;
					if (count > 1 && !replace_all) {
						return `Error: old_string found ${count} times in ${path}. Set replace_all to true to replace all occurrences, or provide more context to make it unique.`;
					}
					if (replace_all) {
						content = content.split(old_string).join(new_string);
					} else {
						content = content.replace(old_string, new_string);
					}
					await writeFile(resolved, content, "utf-8");
					return `Replaced ${replace_all ? count : 1} occurrence(s) in ${path}`;
				} catch (err: any) {
					return `Error editing file: ${err.message}`;
				}
			},
		}),

		fs_delete: tool({
			description:
				"Delete a file or directory. Use recursive=true for directories. " +
				"This operation cannot be undone. Paths must be within workspace root.",
			parameters: z.object({
				path: z.string().describe("Path to file or directory to delete"),
				recursive: z.boolean().optional().default(false).describe("Delete directories recursively"),
			}),
			execute: async ({ path, recursive }) => {
				const resolved = safePath(path, baseDir);
				if (typeof resolved === "object") return resolved.error;
				try {
					if (!existsSync(resolved)) return `Error: path not found: ${path}`;
					await rm(resolved, { recursive, force: false });
					return `Deleted: ${path}`;
				} catch (err: any) {
					if (err.code === "ENOTEMPTY") return `Error: directory not empty. Set recursive=true to delete.`;
					return `Error deleting: ${err.message}`;
				}
			},
		}),

		fs_list: tool({
			description:
				"List directory contents in a tree-like format. Shows directories first, then files. " +
				"Excludes .git, node_modules, dist, build directories.",
			parameters: z.object({
				path: z.string().optional().describe("Directory path (defaults to workspace root)"),
				recursive: z.boolean().optional().default(false).describe("List recursively up to 5 levels"),
			}),
			execute: async ({ path, recursive }) => {
				const resolved = safePath(path ?? ".", baseDir);
				if (typeof resolved === "object") return resolved.error;
				try {
					if (!existsSync(resolved)) return `Error: directory not found: ${path}`;
					const lines: string[] = [];
					let count = 0;
					function walk(dir: string, prefix: string, depth: number): void {
						if (depth > 5 || count >= MAX_RESULTS) return;
						let entries: string[];
						try { entries = readdirSyncSorted(dir); } catch { return; }
						for (const entry of entries) {
							if (count >= MAX_RESULTS) break;
							const fullPath = join(dir, entry);
							if (EXCLUDED_DIRS.has(entry) && entry !== ".env.example") continue;
							if (entry.startsWith(".") && entry !== ".env.example") continue;
							let isDir: boolean;
							try { isDir = statSync(fullPath).isDirectory(); } catch { continue; }
							const icon = isDir ? "📁" : "📄";
							lines.push(`${prefix}${icon} ${entry}`);
							count++;
							if (isDir && recursive) {
								walk(fullPath, prefix + "  ", depth + 1);
							}
						}
					}
					walk(resolved, "", 0);
					if (count >= MAX_RESULTS) lines.push(`... (truncated at ${MAX_RESULTS} entries)`);
					return lines.join("\n");
				} catch (err: any) {
					return `Error listing directory: ${err.message}`;
				}
			},
		}),

		fs_glob: tool({
			description:
				"Find files matching a glob pattern (e.g. '**/*.ts', 'src/**/*.tsx'). " +
				"Returns file paths sorted by modification time.",
			parameters: z.object({
				pattern: z.string().describe("Glob pattern (e.g. '**/*.ts')"),
				path: z.string().optional().describe("Directory to search in (defaults to workspace root)"),
			}),
			execute: async ({ pattern, path }) => {
				const resolved = safePath(path ?? ".", baseDir);
				if (typeof resolved === "object") return resolved.error;
				try {
					// Use find command for glob matching
					let results: string[] = [];
					try {
						const findPattern = pattern.replace(/\*\*/g, '*').replace(/\?/g, '?');
						const cmd = process.platform === 'win32'
							? `dir /s /b "${resolved}\\${findPattern}" 2>nul`
							: `find "${resolved}" -type f -name "${findPattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -${MAX_RESULTS}`;
						const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, windowsHide: true, shell: true });
						results = output.trim().split(/\r?\n/).filter(Boolean).slice(0, MAX_RESULTS);
					} catch {
						results = [];
					}
					if (results.length === 0) return "No files found matching pattern.";
					return results.map((r) => relative(baseDir, r)).join("\n");
				} catch (err: any) {
					return `Error searching files: ${err.message}`;
				}
			},
		}),

		fs_grep: tool({
			description:
				"Search file contents by regex pattern. Returns matching file paths, line numbers, and content. " +
				"Supports include patterns to filter by file type.",
			parameters: z.object({
				pattern: z.string().describe("Regex pattern to search for"),
				path: z.string().optional().describe("Directory to search in (defaults to workspace root)"),
				include: z.string().optional().describe("File pattern to include (e.g. '*.ts', '*.{ts,tsx}')"),
			}),
			execute: async ({ pattern, path, include }) => {
				const resolved = safePath(path ?? ".", baseDir);
				if (typeof resolved === "object") return resolved.error;
				try {
					let grepCmd = `grep -rnI --include="${include ?? "*"}" "${pattern.replace(/"/g, '\\"')}" "${resolved}"`;
					grepCmd += ` --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build`;
					let output: string;
					try {
						output = execSync(grepCmd, { encoding: "utf-8", timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
					} catch (err: any) {
						if (err.status === 1) return "No matches found.";
						return `Error searching: ${err.message}`;
					}
					const lines = output.trim().split("\n").filter(Boolean);
					if (lines.length > MAX_RESULTS) {
						return lines.slice(0, MAX_RESULTS).join("\n") + `\n... (truncated at ${MAX_RESULTS} results)`;
					}
					return lines.join("\n");
				} catch (err: any) {
					return `Error searching content: ${err.message}`;
				}
			},
		}),
	};
}

// Sync helpers for tree listing
import { readdirSync, statSync } from "node:fs";

function readdirSyncSorted(dir: string): string[] {
	return readdirSync(dir).sort((a, b) => {
		const aDir = statSync(join(dir, a)).isDirectory();
		const bDir = statSync(join(dir, b)).isDirectory();
		if (aDir && !bDir) return -1;
		if (!aDir && bDir) return 1;
		return a.localeCompare(b);
	});
}
