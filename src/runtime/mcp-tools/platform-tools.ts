// 平台自省工具 (Platform)
//
// # 文件说明书
//
// ## 核心功能
// 让 agent 自省 zero-core 平台运行时:版本/路径/内存(info)、日志(logs)、
// workspace 配置(config)、AI provider(providers)。纯只读诊断,无副作用。
//
// ## 数据来源(重要)
// config / providers 读 **SQLite**(经 ctx.db),不是 config.json——app 把配置
// 存在 DB(kv_store / providers 表),config.json 从不被读写。历史上这两个资源
// 读 config.json 导致永远"No configuration found",与 AgentRegistry.list(读
// agents 表)报的 provider 不符。
//
// ## 设计边界
// 通用文件读取是 Read/Glob/Grep 的职责。本工具只做平台自省,数据经 ctx.db
// (ISessionStore)获取,agent-loop 无需为它新增任何字段——保持工具/loop 解耦。
//
// ## 命名
// 原 "Assistant"(通用且语义不清)→ "Platform"。旧 toolPolicy 的 "Assistant"
// 键经 RENAMED_TOOLS 运行时迁移到 "Platform"。
//

import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildTool } from "../tools/tool-factory.js";
import { ZERO_CORE_DIR } from "../../core/config.js";

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

export function createPlatformTools(getAppVersion?: () => string) {
	const version = getAppVersion?.() ?? "0.0.0-dev";

	return {
		Platform: buildTool({
			name: "Platform",
			description: "Inspect the zero-core platform runtime: version/paths/memory (info), logs, workspace config, AI providers. Read-only diagnostics backed by the SQLite DB.",
			prompt:
				"Inspect the zero-core platform runtime (read-only diagnostics). Resources:\n" +
				"- 'info' — app version, data dir, cwd, pid, node version, platform, memory usage, uptime\n" +
				"- 'logs' — recent log entries (lines?, level?: all|error|warn)\n" +
				"- 'config' — workspace config from the DB (defaultModel, defaultProvider, proxy, workspaceDir)\n" +
				"- 'providers' — AI providers from the DB (name, type, enabled, modelCount, baseUrl, redacted apiKey)\n\n" +
				"This tool is for platform self-introspection only. To read files, list directories, or search content, use Read / Glob / Grep instead.",
			meta: { category: "management", isReadOnly: true },
			inputSchema: z.object({
				resource: z.enum(["info", "logs", "config", "providers"])
					.describe("Which platform diagnostic resource to access"),
				lines: z.number().optional().describe("Log lines to return (for 'logs', max 500, default 50)"),
				level: z.enum(["all", "error", "warn"]).optional().describe("Log level filter (for 'logs')"),
			}),
			execute: async (input: any, ctx: any) => {
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
						// Read the REAL workspace config from kv_store (SQLite). config.json is
						// never written by the app. ctx.db (ISessionStore) exposes getKVStore().
						const kv = ctx?.db?.getKVStore?.();
						const stored = kv?.getJson?.("workspace");
						if (!stored) return "No workspace config found (kv_store key 'workspace' is empty).";
						redactSensitive(stored);
						return JSON.stringify(stored, null, 2);
					}
					case "providers": {
						// Read the REAL providers from the `providers` table (SQLite). ProviderStore's
						// constructor has write side-effects (mergeSystemProviders), so we SELECT
						// read-only via the raw DB handle instead of constructing a store. ctx.db is
						// SessionDB at runtime; ISessionStore doesn't expose getDb() → localized cast.
						const rawDb = ctx?.db?.getDb?.();
						if (!rawDb) return "Provider DB not available in this context.";
						let rows: any[] = [];
						try {
							rows = rawDb.prepare("SELECT name, type, enabled, base_url, api_key, models FROM providers").all() as any[];
						} catch (err: any) {
							return `Error reading providers: ${err.message}`;
						}
						const providers = rows.map((r) => {
							let modelCount = 0;
							try {
								modelCount = Array.isArray(r.models) ? r.models.length : (JSON.parse(r.models ?? "[]") as any[]).length;
							} catch { /* models not parseable */ }
							return {
								name: r.name,
								type: r.type,
								enabled: !!r.enabled,
								modelCount,
								baseUrl: r.base_url,
								apiKey: r.api_key ? `${String(r.api_key).substring(0, 8)}...` : "(none)",
							};
						});
						if (providers.length === 0) {
							return (
								"No AI providers configured. Supported provider types: " +
								"openai, anthropic, gemini, openai-compatible, ollama.\n" +
								"Configure via Settings > Providers in the UI (recommended)."
							);
						}
						return JSON.stringify(providers, null, 2);
					}
					default:
						return `Unknown resource: ${input.resource}`;
				}
			},
		}),
	};
}
