import { tool } from "ai";
import { z } from "zod";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, extname, relative } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Assistant Tools — built-in MCP server for app diagnostics
// ---------------------------------------------------------------------------

const ZERO_CORE_DIR = process.env.ZERO_CORE_DIR ?? join(homedir(), ".zero-core");
const BLOCKED_FILES = new Set([".env", ".env.local", ".env.production", "credentials.json", "secret"]);

function getLatestLogFile(): string | null {
	const logDir = join(ZERO_CORE_DIR, "logs");
	if (!existsSync(logDir)) return null;
	try {
		const files = readdirSync(logDir)
			.filter((f) => f.endsWith(".log"))
			.sort()
			.reverse();
		return files.length > 0 ? join(logDir, files[0]) : null;
	} catch {
		return null;
	}
}

export function createAssistantTools(getAppVersion?: () => string) {
	const version = getAppVersion?.() ?? "0.0.0-dev";

	return {
		assistant_info: tool({
			description: "Get zero-core app runtime information: version, paths, system info, memory usage.",
			inputSchema: z.object({}),
			execute: async () => {
				const mem = process.memoryUsage();
				return JSON.stringify({
					version,
					zeroCoreDir: ZERO_CORE_DIR,
					cwd: process.cwd(),
					pid: process.pid,
					nodeVersion: process.version,
					platform: process.platform,
					arch: process.arch,
					memory: {
						rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
						heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
						heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
					},
					uptime: `${Math.round(process.uptime())}s`,
				}, null, 2);
			},
		}),

		assistant_logs: tool({
			description: "Read recent log entries from the zero-core log file.",
			inputSchema: z.object({
				lines: z.number().optional().default(50).describe("Number of log lines to return (max 500)"),
				level: z.enum(["all", "error", "warn"]).optional().default("all").describe("Filter by log level"),
			}),
			execute: async ({ lines, level }) => {
				const logFile = getLatestLogFile();
				if (!logFile) return "No log files found.";
				try {
					const content = readFileSync(logFile, "utf-8");
					let logLines = content.split("\n").filter(Boolean);
					if (level !== "all") {
						const levelUpper = level.toUpperCase();
						logLines = logLines.filter((l) => l.includes(levelUpper));
					}
					const count = Math.min(lines ?? 50, 500);
					const selected = logLines.slice(-count);
					return selected.join("\n") || "No log entries found.";
				} catch (err: any) {
					return `Error reading logs: ${err.message}`;
				}
			},
		}),

		assistant_config: tool({
			description: "Read the current zero-core configuration (settings, providers, theme). Redacts sensitive values.",
			inputSchema: z.object({}),
			execute: async () => {
				const configPath = join(ZERO_CORE_DIR, "config.json");
				if (!existsSync(configPath)) return "No configuration file found at " + configPath;
				try {
					const content = readFileSync(configPath, "utf-8");
					const config = JSON.parse(content);
					// Redact API keys
					redactSensitive(config);
					return JSON.stringify(config, null, 2);
				} catch (err: any) {
					return `Error reading config: ${err.message}`;
				}
			},
		}),

		assistant_read_source: tool({
			description:
				"Read a source file from the zero-core app directory for debugging. " +
				"Blocks access to sensitive files (.env, credentials). File size limit 200KB.",
			inputSchema: z.object({
				file_path: z.string().describe("Relative file path within the app directory"),
			}),
			execute: async ({ file_path }) => {
				// Security: block sensitive files
				const basename = file_path.split("/").pop() ?? "";
				if (BLOCKED_FILES.has(basename) || basename.startsWith(".env")) {
					return `Error: access denied for sensitive file: ${file_path}`;
				}
				const resolved = resolve(process.cwd(), file_path);
				// Must be within app directory
				if (!resolved.startsWith(resolve(process.cwd()))) {
					return `Error: path outside app directory: ${file_path}`;
				}
				if (!existsSync(resolved)) return `Error: file not found: ${file_path}`;
				try {
					const stat = statSync(resolved);
					if (stat.size > 200 * 1024) {
						return `Error: file too large (${Math.round(stat.size / 1024)}KB). Maximum 200KB.`;
					}
					if (extname(resolved) in BINARY_EXTENSIONS) {
						return `Error: binary file type: ${extname(resolved)}`;
					}
					return readFileSync(resolved, "utf-8");
				} catch (err: any) {
					return `Error reading file: ${err.message}`;
				}
			},
		}),

		assistant_list_providers: tool({
			description: "List configured AI providers with model counts. Redacts API keys.",
			inputSchema: z.object({}),
			execute: async () => {
				const configPath = join(ZERO_CORE_DIR, "config.json");
				if (!existsSync(configPath)) return "No configuration found.";
				try {
					const content = readFileSync(configPath, "utf-8");
					const config = JSON.parse(content);
					const providers = config.providers ?? [];
					const summary = providers.map((p: any) => ({
						name: p.name,
						type: p.type,
						enabled: p.enabled,
						modelCount: p.models?.length ?? 0,
						baseUrl: p.baseUrl,
						apiKey: p.apiKey ? `${p.apiKey.substring(0, 8)}...` : "(none)",
					}));
					return JSON.stringify(summary, null, 2);
				} catch (err: any) {
					return `Error reading providers: ${err.message}`;
				}
			},
		}),

		assistant_list_files: tool({
			description: "List files in a zero-core data directory (config, templates, mcp-servers, knowledge-bases).",
			inputSchema: z.object({
				directory: z.enum(["root", "config", "templates", "mcp-servers", "knowledge", "logs"]).describe("Data directory to list"),
			}),
			execute: async ({ directory }) => {
				const dirMap: Record<string, string> = {
					root: ZERO_CORE_DIR,
					config: ZERO_CORE_DIR,
					templates: ZERO_CORE_DIR,
					"mcp-servers": ZERO_CORE_DIR,
					knowledge: ZERO_CORE_DIR,
					logs: join(ZERO_CORE_DIR, "logs"),
				};
				const targetDir = dirMap[directory];
				if (!targetDir || !existsSync(targetDir)) return `Directory not found: ${directory}`;
				try {
					const files = readdirSync(targetDir)
						.filter((f) => {
							const stat = statSync(join(targetDir, f));
							// For root, show only specific files
							if (directory !== "logs") {
								return f.endsWith(".json") || f.endsWith(".db") || stat.isDirectory();
							}
							return true;
						})
						.map((f) => {
							const stat = statSync(join(targetDir, f));
							const size = stat.isFile() ? `${Math.round(stat.size / 1024)}KB` : "(dir)";
							return `${f} (${size})`;
						});
					return files.join("\n") || "(empty)";
				} catch (err: any) {
					return `Error listing files: ${err.message}`;
				}
			},
		}),
	};
}

const BINARY_EXTENSIONS: Record<string, boolean> = {
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".ico": true,
	".zip": true, ".tar": true, ".gz": true, ".exe": true, ".dll": true,
	".so": true, ".dylib": true, ".woff": true, ".woff2": true, ".ttf": true,
	".eot": true, ".pdf": true, ".sqlite": true,
};

function redactSensitive(obj: any): void {
	if (!obj || typeof obj !== "object") return;
	for (const key of Object.keys(obj)) {
		if (typeof obj[key] === "string" && (key.toLowerCase().includes("apikey") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("password") || key.toLowerCase().includes("token"))) {
			obj[key] = obj[key] ? `${obj[key].substring(0, 8)}***REDACTED***` : "";
		} else if (typeof obj[key] === "object") {
			redactSensitive(obj[key]);
		}
	}
}
