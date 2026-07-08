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

// ─── platform-observability ① (sub-4): sessions resource helpers ───────────
//
// Text rendering for the 'sessions' resource. The same data shape is served as
// JSON to the ③ kanban via IPC (sessions:parents / sessions:detail) — this is
// the agent self-introspection (text) face of it. Renders relative time
// ("last 2s ago" / "last 1m ago") to match the kanban.

/**
 * Render a wall-clock ms as a short relative-time string. Matches the format
 * the ③ kanban will use ("last 2s ago" / "last 1m ago" / "last 3h ago" /
 * "last 2d ago"). nowMs lets tests inject a fixed clock.
 */
export function formatRelativeTime(atMs: number, nowMs: number = Date.now()): string {
	const diff = Math.max(0, nowMs - atMs);
	const sec = Math.floor(diff / 1000);
	if (sec < 60) return `last ${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `last ${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `last ${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `last ${day}d ago`;
}

/** Short 8-char prefix of a sessionId/uuid for compact display. */
function shortId(id: string): string {
	return id ? id.slice(0, 8) : "(none)";
}

/** Status dot glyph (● running / ◐ waiting / ○ idle) — matches the kanban. */
function statusDot(status: "running" | "waiting" | "idle"): string {
	return status === "running" ? "●" : status === "waiting" ? "◐" : "○";
}

/**
 * Render the sessions LIST (no sessionId arg) as text — one line per parent
 * agent session: `状态点 · agentId · sessionId(short) · status · 相对时间 · turns`.
 * agentId prefers agentName when available (more readable); falls back to id.
 */
function renderSessionsList(
	rows: Array<{ agentId: string; agentName?: string; sessionId: string; status: "running" | "waiting" | "idle"; lastActivityAt: number; turns: number }>,
	nowMs: number = Date.now(),
): string {
	if (rows.length === 0) {
		return "No parent agent sessions. (Agents without an active/main chat session, or delegated sub-agent sessions, are not listed — those surface via TaskList.)";
	}
	// Sort: running first, then waiting, then idle; within a group, most recent activity first.
	const order: Record<string, number> = { running: 0, waiting: 1, idle: 2 };
	const sorted = [...rows].sort((a, b) => {
		const so = order[a.status] - order[b.status];
		if (so !== 0) return so;
		return b.lastActivityAt - a.lastActivityAt;
	});
	const lines = sorted.map((r) => {
		const label = r.agentName || r.agentId;
		return `${statusDot(r.status)} ${label} · ${shortId(r.sessionId)} · ${r.status} · ${formatRelativeTime(r.lastActivityAt, nowMs)} · ${r.turns} turns`;
	});
	return [
		`Parent agent sessions (${sorted.length}):`,
		...lines,
		"",
		"Legend: ● running  ◐ waiting  ○ idle. Use {resource:'sessions', sessionId:'<full-id>'} for a session's task tree + recent steps.",
	].join("\n");
}

/**
 * Render the sessions DETAIL (sessionId arg) as text — task tree (verbatim
 * getRuntimeTaskTree output) + recent N=3 steps ({stepSeq, toolCalls[{name,argsBrief}], status}).
 * No tokens (per design — usage is not a sessions-resource concern).
 */
function renderSessionsDetail(
	sessionId: string,
	taskTree: any[],
	steps: Array<{ stepSeq: number; toolCalls: Array<{ name: string; argsBrief?: string }>; status: string; time: number }>,
	nowMs: number = Date.now(),
): string {
	const out: string[] = [];
	out.push(`Session ${sessionId}`);
	out.push("");
	out.push(`Task tree (${taskTree.length} ${taskTree.length === 1 ? "root" : "roots"}):`);
	if (taskTree.length === 0) {
		out.push("  (no live tasks — this session has no running/completed delegated tasks)");
	} else {
		// Rebuild parent→children once, then render roots recursively. Mirrors the
		// UI TaskTree indent. Each line: `status icon · type · task (turns)`.
		const byParent = new Map<string | undefined, any[]>();
		for (const t of taskTree) {
			const key = t.parentTaskId;
			if (!byParent.has(key)) byParent.set(key, []);
			byParent.get(key)!.push(t);
		}
		const roots = taskTree.filter((t) => !t.parentTaskId || !taskTree.some((x) => x.id === t.parentTaskId));
		const icon = (s: string) => s === "running" ? "▶" : s === "finishing" ? "⏸" : s === "completed" ? "✓" : s === "failed" || s === "killed" || s === "interrupted" ? "✗" : "·";
		const renderNode = (t: any, depth: number): string => {
			const indent = "  ".repeat(depth);
			const label = t.type === "subagent" ? `subagent${t.targetAgentId ? ` (${t.targetAgentId})` : ""}` : t.type;
			const tail = `${t.turns ?? 0} turns`;
			return `${indent}${icon(t.status)} ${label}: ${t.task ?? "(no task text)"} — ${tail}`;
		};
		const walk = (t: any, depth: number): string[] => {
			const lines = [renderNode(t, depth)];
			for (const c of byParent.get(t.id) ?? []) lines.push(...walk(c, depth + 1));
			return lines;
		};
		for (const r of roots) out.push(...walk(r, 0));
	}
	out.push("");
	out.push(`Recent steps (last ${steps.length}):`);
	if (steps.length === 0) {
		out.push("  (no tool calls yet in this session's live loop)");
	} else {
		for (const s of steps) {
			const calls = s.toolCalls.map((c) => `${c.name}${c.argsBrief ? `(${c.argsBrief})` : ""}`).join(", ") || "(none)";
			out.push(`  step ${s.stepSeq} [${s.status}] ${formatRelativeTime(s.time, nowMs)}: ${calls}`);
		}
	}
	return out.join("\n");
}

// ─── platform-observability ② (sub-5): providerStats resource helper ──────
//
// Text rendering for the 'providerStats' resource — per-provider one line,
// same text-face convention as 'sessions'. The IPC faces (provider:stats /
// :usage / :queue) serve the same data as JSON to the ③ kanban.

/**
 * Format a token count with k/M suffix for compact per-line display.
 * 0 → "0"; 1234 → "1.2k"; 1500000 → "1.5M".
 */
function formatTokens(n: number): string {
	if (!n) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/**
 * Render the providerStats LIST as text — one line per provider (ALL providers,
 * including disabled — the agent gets a platform-wide view; the ③ kanban
 * narrows via combobox). Format:
 *   `name · enabled|disabled · in-flight/max · queue:N · tokens · calls · err% · avg latency`
 * latency is N/A (sub-2 did not build a process-local latency accumulator;
 * design ②.2 leaves it process-local, not yet implemented). Returns a friendly
 * empty-state when no providers are configured.
 */
function renderProviderStats(
	stats: Array<{
		name: string; type: string; enabled: boolean; modelCount: number;
		inFlight: number; maxConcurrency: number; queue: number;
		tokens: number; calls: number; errors: number; errRate: number;
		latencyMs: number | null;
	}>,
): string {
	if (stats.length === 0) {
		return (
			"No AI providers configured. Supported provider types: " +
			"openai, anthropic, gemini, openai-compatible, ollama.\n" +
			"Configure via Settings > Providers in the UI (recommended)."
		);
	}
	// Sort: enabled first, then by name — stable + scannable. The ③ kanban does
	// its own combobox filtering; here we give the agent the full ordered list.
	const sorted = [...stats].sort((a, b) => {
		if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const lines = sorted.map((s) => {
		const enabledLabel = s.enabled ? "enabled" : "disabled";
		const inflightMax = s.maxConcurrency > 0 ? `${s.inFlight}/${s.maxConcurrency}` : `${s.inFlight}/∞`;
		const errPct = `${(s.errRate * 100).toFixed(1)}%`;
		const latency = s.latencyMs != null ? `${Math.round(s.latencyMs)}ms` : "N/A";
		return `${s.name} · ${s.type} · ${enabledLabel} · ${inflightMax} · queue:${s.queue} · ${formatTokens(s.tokens)} tok · ${s.calls} calls · ${errPct} err · ${latency} avg`;
	});
	return [
		`Providers (${sorted.length}):`,
		...lines,
		"",
		"Columns: name · type · enabled|disabled · in-flight/max · queue · cumulative tokens · cumulative calls · err% · avg latency.",
		"Tokens/calls/errors are cumulative (process + DB provider_usage). in-flight/queue are live (ConcurrencyQueue). latency is a process-local running avg (restart resets to N/A). Use provider:stats / provider:usage / provider:queue IPC for the kanban JSON.",
	].join("\n");
}

export function createPlatformTools(getAppVersion?: () => string) {
	const version = getAppVersion?.() ?? "0.0.0-dev";

	return {
		Platform: buildTool({
			name: "Platform",
			description: "Inspect the zero-core platform runtime: version/paths/memory (info), logs, workspace config, AI providers. Read-only diagnostics backed by the SQLite DB.",
			prompt:
				"Inspect the zero-core platform runtime (read-only diagnostics). Resources:\n" +
				"- 'info' — app version, paths (see below), pid, node version, platform, memory usage, uptime\n" +
				"- 'logs' — recent log entries (lines?, level?: all|error|warn, source?: module tag, sessionId?: substring). `source` matches the structured [module] tag (e.g. agent|loop|ipc|db|tool|mcp|provider|session); `sessionId` filters to lines mentioning that sessionId anywhere in the line. Filters compose (all must match).\n" +
				"- 'config' — workspace config from the DB (defaultModel, defaultProvider, proxy, workspaceDir)\n" +
				"- 'providers' — AI providers from the DB (name, type, enabled, modelCount, baseUrl, redacted apiKey)\n" +
				"- 'providerStats' — live provider observation: ONE line per provider (all providers, incl. disabled) = `name · type · enabled|disabled · in-flight/max · queue · cumulative tokens · calls · err% · avg latency`. Combines static config + live concurrency (ConcurrencyQueue) + cumulative usage (provider_usage table). Useful to self-introspect provider load/health across the platform. (latency shows N/A until a process-local latency accumulator lands.)\n" +
				"- 'sessions' — parent-agent session observation. OMIT sessionId → LIST (one line per parent agent's active/main chat session: status dot · agent · sessionId(short) · running|waiting|idle · relative time · turns). PASS sessionId → DETAIL (that session's live task tree via getRuntimeTaskTree + last 3 steps' tool calls, no tokens). Useful to self-introspect what the platform's parent agents are doing right now.\n\n" +
				"This tool is for platform self-introspection only. To read files, list directories, or search content, use Read / Glob / Grep instead.\n\n" +
				"Three distinct paths reported across resources — do NOT confuse them:\n" +
				"- info.paths.dataDir   — the .zero-core HOME: DB (sessions.db), logs/, app config. Persistent app data.\n" +
				"- info.paths.processCwd — where the process was LAUNCHED. In dev = the source repo root; in a packaged build = the exe install dir. NOT the agent's working dir.\n" +
				"- config.workspaceDir   — the agent's FILE-WORKING directory (where agents read/write project files). This is the path you almost always want when talking about 'the workspace'.",
			meta: { category: "management", isReadOnly: true },
			inputSchema: z.object({
				resource: z.enum(["info", "logs", "config", "providers", "providerStats", "sessions"])
					.describe("Which platform diagnostic resource to access"),
				lines: z.number().optional().describe("Log lines to return (for 'logs', max 500, default 50)"),
				level: z.enum(["all", "error", "warn"]).optional().describe("Log level filter (for 'logs')"),
				source: z.string().optional().describe("Log source/module filter (for 'logs') — matches the structured [module] tag (agent|loop|ipc|db|tool|mcp|provider|session, or any custom module). Case-insensitive exact match on the tag."),
				sessionId: z.string().optional().describe("Dual-purpose by resource: for 'logs', filters to lines mentioning this sessionId (substring); for 'sessions', switches List→Detail (pass the FULL sessionId to get that session's task tree + recent steps)."),
			}),
			execute: async (input: any, ctx: any) => {
				switch (input.resource) {
					case "info": {
						const mem = process.memoryUsage();
						return JSON.stringify({
							version,
							paths: {
								dataDir: ZERO_CORE_DIR,
								processCwd: process.cwd(),
							},
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
							// Source filter: match the structured [module] tag.
							// Line format: <ISO> [LEVEL] [module] message  (module padded to 7).
							// Capture the second bracket, trimmed; exact case-insensitive match.
							if (input.source) {
								const src = input.source.trim().toLowerCase();
								logLines = logLines.filter((l) => {
									const m = l.match(/^\S+\s+\[[^\]]+\]\s+\[\s*([^\]]+?)\s*\]/);
									return m ? m[1].toLowerCase() === src : false;
								});
							}
							// sessionId filter: substring match on the whole line
							// (sessionId is not a structured field; it appears inline in
							// message/args for sessions that log it).
							if (input.sessionId) {
								const sid = input.sessionId.toLowerCase();
								logLines = logLines.filter((l) => l.toLowerCase().includes(sid));
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
					case "providerStats": {
						// platform-observability ② (sub-5): read-only provider
						// observation. Data comes through ctx.platformObserver
						// (AgentService impl: concurrencyManager + sessionManager→
						// getProviderUsageStore + providers table) — runtime never
						// imports the server. Same source the IPC provider:stats /
						// :usage / :queue channels serve to the ③ kanban.
						const observer = ctx?.platformObserver;
						if (!observer || typeof observer.listProviderStats !== "function") {
							return "Provider observer not available in this context (platform-observability handle not injected).";
						}
						const stats = observer.listProviderStats();
						return renderProviderStats(stats);
					}
					case "sessions": {
						// platform-observability ① (sub-4): read-only session observation.
						// Data comes through ctx.platformObserver (AgentService impl) — the
						// runtime layer never imports the server. Same source the IPC
						// sessions:parents / sessions:detail channels serve to the ③ kanban.
						const observer = ctx?.platformObserver;
						if (!observer || typeof observer.listParentSessions !== "function") {
							return "Session observer not available in this context (platform-observability handle not injected).";
						}
						if (input.sessionId) {
							// Detail: task tree + recent 3 steps (no tokens).
							const tree = observer.getSessionTaskTree?.(input.sessionId) ?? [];
							const steps = observer.getSessionRecentSteps?.(input.sessionId, 3) ?? [];
							return renderSessionsDetail(input.sessionId, tree, steps);
						}
						// List: one line per parent agent session.
						const rows = observer.listParentSessions();
						return renderSessionsList(rows);
					}
					default:
						return `Unknown resource: ${input.resource}`;
				}
			},
		}),
	};
}
