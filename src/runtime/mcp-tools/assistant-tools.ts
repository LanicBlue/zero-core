import { z } from "zod";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { buildTool } from "../tools/tool-factory.js";
import { ZERO_CORE_DIR } from "../../core/config.js";

const BLOCKED_FILES = new Set([".env", ".env.local", ".env.production", "credentials.json", "secret"]);

const BINARY_EXTENSIONS: Record<string, boolean> = {
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".ico": true,
	".zip": true, ".tar": true, ".gz": true, ".exe": true, ".dll": true,
	".so": true, ".dylib": true, ".woff": true, ".woff2": true, ".ttf": true,
	".eot": true, ".pdf": true, ".sqlite": true,
};

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

export function createAssistantTools(getAppVersion?: () => string) {
	const version = getAppVersion?.() ?? "0.0.0-dev";

	return {
		Assistant: buildTool({
			name: "Assistant",
			description: "Access zero-core app diagnostics: version, logs, config, providers, and files.",
			prompt:
				"Access zero-core app diagnostics. Resources: " +
				"'info' — app version, paths, memory usage; " +
				"'logs' — recent log entries; " +
				"'config' — current configuration (redacted); " +
				"'source' — read a source file from the app directory; " +
				"'providers' — list configured AI providers; " +
				"'files' — list files in a data directory.",
			meta: { category: "assistant", isReadOnly: true },
			inputSchema: z.object({
				resource: z.enum(["info", "logs", "config", "source", "providers", "files"])
					.describe("Which diagnostic resource to access"),
				lines: z.number().optional().describe("Log lines to return (for 'logs', max 500, default 50)"),
				level: z.enum(["all", "error", "warn"]).optional().describe("Log level filter (for 'logs')"),
				file_path: z.string().optional().describe("Relative file path (for 'source')"),
				directory: z.enum(["root", "config", "templates", "mcp-servers", "knowledge", "logs"])
					.optional().describe("Data directory to list (for 'files')"),
			}),
			execute: async (input) => {
				switch (input.resource) {
					case "info": {
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
					}
					case "logs": {
						const logFile = getLatestLogFile();
						if (!logFile) return "No log files found.";
						try {
							const content = readFileSync(logFile, "utf-8");
							let logLines = content.split("\n").filter(Boolean);
							if (input.level && input.level !== "all") {
								const levelUpper = input.level.toUpperCase();
								logLines = logLines.filter((l) => l.includes(levelUpper));
							}
							const count = Math.min(input.lines ?? 50, 500);
							const selected = logLines.slice(-count);
							return selected.join("\n") || "No log entries found.";
						} catch (err: any) {
							return `Error reading logs: ${err.message}`;
						}
					}
					case "config": {
						const configPath = join(ZERO_CORE_DIR, "config.json");
						if (!existsSync(configPath)) return "No configuration file found at " + configPath;
						try {
							const content = readFileSync(configPath, "utf-8");
							const config = JSON.parse(content);
							redactSensitive(config);
							return JSON.stringify(config, null, 2);
						} catch (err: any) {
							return `Error reading config: ${err.message}`;
						}
					}
					case "source": {
						const filePath = input.file_path;
						if (!filePath) return "Error: file_path is required for 'source' resource.";
						const basename = filePath.split("/").pop() ?? "";
						if (BLOCKED_FILES.has(basename) || basename.startsWith(".env")) {
							return `Error: access denied for sensitive file: ${filePath}`;
						}
						const resolved = resolve(process.cwd(), filePath);
						if (!resolved.startsWith(resolve(process.cwd()))) {
							return `Error: path outside app directory: ${filePath}`;
						}
						if (!existsSync(resolved)) return `Error: file not found: ${filePath}`;
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
					}
					case "providers": {
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
					}
					case "files": {
						const directory = input.directory ?? "root";
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
					}
					default:
						return `Unknown resource: ${input.resource}`;
				}
			},
		}),
	};
}
