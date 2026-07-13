// 平台自省工具 (Platform)
//
// # 文件说明书
//
// ## 核心功能
// 让 agent 自省 zero-core 平台运行时:版本/路径/内存(info)、日志(logs)、
// workspace 配置(config)、AI provider(providers)。纯只读诊断,无副作用。
//
// ## 数据来源(tool-decoupling sub-2 之后)
// - **info / logs**:进程级,直接读 process / 日志文件,不依赖任何 ctx 字段。
// - **config / providers**:读 **SQLite**(经 getAgentService().db,kv_store / providers 表),
//   不是 config.json。app 把配置存在 DB,config.json 从不被读写。
// - **sessions / providerStats**:直读 `getAgentService()` 单例(AgentService
//   implements PlatformObserver)—— 不再经 ctx.platformObserver。这是 sub-2 的
//   关键修复:work/cron 路径(sendProjectPrompt)漏注 platformObserver 导致
//   "Session observer not available" bug,直读单例后根除。
//
// ## 输出形态(决策 3:工具返 JSON + 自带 format)
// - `execute(input, callerCtx): Promise<ToolResult>` —— 返**结构化 JSON**。
// - `format(result): string` —— 纯函数,把 ToolResult JSON 转成喂 LLM 的文本。
// - **UI/REST** → execute → JSON 直渲染(不调 format)。
// - **agent loop** → buildTool wrapper 调 execute 拿 JSON → 套 format → 文本喂 LLM。
//
// ## 设计边界
// 通用文件读取是 Read/Glob/Grep 的职责。本工具只做平台自省,agent-loop 无需为它
// 新增任何字段——保持工具/loop 解耦。
//
// ## 命名
// 原 "Assistant"(通用且语义不清)→ "Platform"。旧 toolPolicy 的 "Assistant"
// 键经 RENAMED_TOOLS 运行时迁移到 "Platform"。

import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildTool } from "../tool-factory.js";
import { ZERO_CORE_DIR } from "../../core/config.js";
import type { CallerCtx, ToolResult } from "../types.js";
import { getAgentService } from "../../server/agent-service.js";

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

// ─── platform-observability ① (sub-4): sessions resource text face ───────────
//
// Text rendering for the 'sessions' resource (the format() face; execute now
// returns JSON). The same data shape is served as JSON to the ③ kanban via IPC
// (sessions:parents / sessions:detail). Renders relative time ("last 2s ago" /
// "last 1m ago") to match the kanban.

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
		return "No parent agent sessions. (Agents without an active/main chat session, or delegated sub-agent sessions, are not listed — those surface via `Task action:'list'`.)";
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

// ─── platform-observability ② (sub-5): providerStats text face ──────────────
//
// Text rendering for the 'providerStats' resource (the format() face). The IPC
// faces (provider:stats / :usage / :queue) serve the same data as JSON to the
// ③ kanban.

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

// ─── platform-observability ② (sub-6): providerUsage / providerQueue text face ──
//
// Text rendering for the 'providerUsage' / 'providerQueue' resources (the
// format() face). The dispatcher serves the same data as JSON to the ③ kanban.

/**
 * Render the providerUsage series as text — one block per model, each line a
 * `bucket · calls · tokens · errors`. Buckets are ISO hour (granularity=hour)
 * or YYYY-MM-DD (granularity=day). Tokens formatted compact (k/M). Empty-state
 * friendly so the LLM gets a useful line even when no usage exists in range.
 */
function renderProviderUsage(d: PlatformProviderUsageData): string {
	const head = `Provider ${d.provider} usage (${d.granularity} buckets, last ${d.range}${d.model ? `, model=${d.model}` : ""}):`;
	if (d.series.length === 0) {
		return `${head}\nNo usage rows in range.`;
	}
	const lines: string[] = [head, ""];
	for (const s of d.series) {
		lines.push(`  model: ${s.model} (${s.points.length} buckets)`);
		if (s.points.length === 0) {
			lines.push("    (no buckets)");
			continue;
		}
		for (const pt of s.points) {
			lines.push(`    ${pt.bucket} · ${pt.calls} calls · ${formatTokens(pt.tokens)} tok · ${pt.errors} err`);
		}
	}
	return lines.join("\n");
}

/**
 * Render the providerQueue as text — one line per waiter:
 * `T{tier} · agentId|sessionId(short) · waiting {rel}`. Sorted by tier asc
 * (the ConcurrencyQueue.getWaiting order). Empty-state friendly.
 */
function renderProviderQueue(d: PlatformProviderQueueData, nowMs: number = Date.now()): string {
	if (d.queue.length === 0) {
		return `Provider ${d.provider} queue: empty (no waiters).`;
	}
	const lines = d.queue.map((w) => {
		const who = w.agentId ?? (w.sessionId ? shortId(w.sessionId) : "?");
		const wait = formatRelativeTime(w.waitedSince, nowMs);
		return `  T${w.tier} · ${who} · waiting ${wait}`;
	});
	return [`Provider ${d.provider} queue (${d.queue.length}):`, ...lines].join("\n");
}

// ─── ToolResult data shapes (decision 3: JSON) ──────────────────────────────
//
// Each resource carries a typed `data` payload so a UI dispatcher (sub-5) can
// render JSON directly. The text face (format()) renders the SAME data the way
// the LLM wants it. Keeping one shape (not a parallel "text-only" path) avoids
// drift between the agent text output and the UI JSON.

export interface PlatformInfoData {
	version: string;
	paths: { dataDir: string; processCwd: string };
	pid: number;
	nodeVersion: string;
	platform: string;
	arch: string;
	memory: { rss: string; heapUsed: string; heapTotal: string };
	uptime: string;
}

export interface PlatformLogsData {
	/** Log lines already filtered + sliced to the requested count. Empty when no log file / no matches. */
	lines: string[];
	/** Path of the log file that was read (null when none found). */
	logFile: string | null;
}

export interface PlatformConfigData {
	/** The redacted workspace config object (kv_store key 'workspace'). null when not set. */
	config: any;
}

export interface PlatformProvidersData {
	providers: Array<{
		name: string;
		type: string;
		enabled: boolean;
		modelCount: number;
		baseUrl: string | null;
		apiKey: string;
	}>;
}

export interface PlatformProviderStatsData {
	stats: Array<{
		name: string; type: string; enabled: boolean; modelCount: number;
		inFlight: number; maxConcurrency: number; queue: number;
		tokens: number; calls: number; errors: number; errRate: number;
		latencyMs: number | null;
	}>;
}

export interface PlatformSessionsListData {
	rows: Array<{
		agentId: string; agentName?: string; sessionId: string;
		status: "running" | "waiting" | "idle";
		lastActivityAt: number; turns: number;
	}>;
}

export interface PlatformSessionsDetailData {
	sessionId: string;
	taskTree: any[];
	recentSteps: Array<{
		stepSeq: number;
		toolCalls: Array<{ name: string; argsBrief?: string }>;
		status: string;
		time: number;
	}>;
}

/**
 * platform-observability ② (sub-6): 'providerUsage' resource data shape — a
 * series per model for the stacked-bar chart (tool-decoupling sub-6). Mirrors
 * PlatformProviderSeries in shared/types.ts. Kept local so the tool layer
 * doesn't import the renderer-facing copy.
 */
export interface PlatformProviderUsageData {
	provider: string;
	granularity: "hour" | "day";
	range: "24h" | "30d";
	model?: string;
	series: Array<{
		model: string;
		points: Array<{ bucket: string; calls: number; tokens: number; errors: number }>;
	}>;
}

/**
 * platform-observability ② (sub-6): 'providerQueue' resource data shape —
 * one entry per queued waiter for the provider's live ConcurrencyQueue.
 */
export interface PlatformProviderQueueData {
	provider: string;
	queue: Array<{
		sessionId?: string;
		agentId?: string;
		tier: number;
		waitedSince: number;
	}>;
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
				"- 'providerUsage' — one provider's per-model time series (stacked chart data). PASS provider; granularity 'hour'|'day' (default 'hour'); range '24h'|'30d' (default '24h'); optional model filter. Returns a series per model with per-bucket {bucket, calls, tokens, errors}.\n" +
				"- 'providerQueue' — one provider's live queued waiters (sessionId/agentId/tier/waitedSince per entry). PASS provider. Empty when the provider has no queue or no current waiters.\n" +
				"- 'sessions' — parent-agent session observation. OMIT sessionId → LIST (one line per parent agent's active/main chat session: status dot · agent · sessionId(short) · running|waiting|idle · relative time · turns). PASS sessionId → DETAIL (that session's live task tree via getRuntimeTaskTree + last 3 steps' tool calls, no tokens). Useful to self-introspect what the platform's parent agents are doing right now.\n\n" +
				"This tool is for platform self-introspection only. To read files, list directories, or search content, use Read / Glob / Grep instead.\n\n" +
				"Three distinct paths reported across resources — do NOT confuse them:\n" +
				"- info.paths.dataDir   — the .zero-core HOME: DB (sessions.db), logs/, app config. Persistent app data.\n" +
				"- info.paths.processCwd — where the process was LAUNCHED. In dev = the source repo root; in a packaged build = the exe install dir. NOT the agent's working dir.\n" +
				"- config.workspaceDir   — the agent's FILE-WORKING directory (where agents read/write project files). This is the path you almost always want when talking about 'the workspace'.",
			meta: { category: "management", isReadOnly: true },
			inputSchema: z.object({
				resource: z.enum(["info", "logs", "config", "providers", "providerStats", "providerUsage", "providerQueue", "sessions"])
					.describe("Which platform diagnostic resource to access"),
				lines: z.number().optional().describe("Log lines to return (for 'logs', max 500, default 50)"),
				level: z.enum(["all", "error", "warn"]).optional().describe("Log level filter (for 'logs')"),
				source: z.string().optional().describe("Log source/module filter (for 'logs') — matches the structured [module] tag (agent|loop|ipc|db|tool|mcp|provider|session, or any custom module). Case-insensitive exact match on the tag."),
				sessionId: z.string().optional().describe("Dual-purpose by resource: for 'logs', filters to lines mentioning this sessionId (substring); for 'sessions', switches List→Detail (pass the FULL sessionId to get that session's task tree + recent steps)."),
				// providerUsage / providerQueue (sub-6): both require a provider name.
				// Optional at schema level (flat object, provider-compat); enforced
				// inside the case branches with a friendly error.
				provider: z.string().optional().describe("Provider name (REQUIRED for 'providerUsage' / 'providerQueue')"),
				granularity: z.enum(["hour", "day"]).optional().describe("Bucket granularity for 'providerUsage' (default 'hour')"),
				range: z.enum(["24h", "30d"]).optional().describe("Range window for 'providerUsage' (default '24h')"),
				model: z.string().optional().describe("Optional model filter for 'providerUsage' (narrows to a single series)"),
			}),
			execute: async (input: any, _callerCtx: CallerCtx): Promise<ToolResult> => {
				switch (input.resource) {
					case "info": {
						const mem = process.memoryUsage();
						const data: PlatformInfoData = {
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
						};
						return { ok: true, data };
					}
					case "logs": {
						const logFile = getLatestLogFile();
						if (!logFile) {
							return { ok: true, data: { lines: [], logFile: null } satisfies PlatformLogsData };
						}
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
							return { ok: true, data: { lines: selected, logFile } satisfies PlatformLogsData };
						} catch (err: any) {
							return { ok: false, error: `Error reading logs: ${err.message}` };
						}
					}
					case "config": {
						// Read the REAL workspace config from kv_store (SQLite). config.json is
						// never written by the app. The AgentService exposes its db via
						// getDB(); ISessionStore.getKVStore() returns the kv reader.
						const svc = getAgentService();
						const db = svc?.getDB?.();
						const kv = db?.getKVStore?.();
						const stored = kv?.getJson?.("workspace");
						if (!stored) {
							return { ok: false, error: "No workspace config found (kv_store key 'workspace' is empty)." };
						}
						redactSensitive(stored);
						return { ok: true, data: { config: stored } satisfies PlatformConfigData };
					}
					case "providers": {
						// Read the REAL providers from the `providers` table (SQLite). ProviderStore's
						// constructor has write side-effects (mergeSystemProviders), so we SELECT
						// read-only via the raw DB handle instead of constructing a store.
						const svc = getAgentService();
						const rawDb = svc?.getDB?.()?.getDb?.();
						if (!rawDb) {
							return { ok: false, error: "Provider DB not available in this context." };
						}
						let rows: any[] = [];
						try {
							rows = rawDb.prepare("SELECT name, type, enabled, base_url, api_key, models FROM providers").all() as any[];
						} catch (err: any) {
							return { ok: false, error: `Error reading providers: ${err.message}` };
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
						return { ok: true, data: { providers } satisfies PlatformProvidersData };
					}
					case "providerStats": {
						// platform-observability ② (sub-5): read-only provider observation.
						// Reads the process-wide AgentService singleton (it implements
						// PlatformObserver: concurrencyManager + sessionManager→
						// getProviderUsageStore + providers table). Same source the IPC
						// provider:stats / :usage / :queue channels serve to the ③ kanban.
						const svc = getAgentService();
						if (!svc || typeof svc.listProviderStats !== "function") {
							return { ok: false, error: "Provider observer not available in this context (AgentService singleton not registered)." };
						}
						const stats = svc.listProviderStats();
						return { ok: true, data: { stats } satisfies PlatformProviderStatsData };
					}
					case "providerUsage": {
						// platform-observability ② (sub-6): per-model time series for one
						// provider (stacked-chart data). Same source the kanban reads via
						// dispatcher today (was the IPC provider:usage channel).
						const provider = input.provider;
						if (!provider || typeof provider !== "string") {
							return { ok: false, error: "provider is required for the 'providerUsage' resource." };
						}
						const svc = getAgentService();
						if (!svc || typeof svc.getProviderUsageSeries !== "function") {
							return { ok: false, error: "Provider observer not available in this context (AgentService singleton not registered)." };
						}
						const granularity = input.granularity === "day" ? "day" : "hour";
						const range = input.range === "30d" ? "30d" : "24h";
						const model = typeof input.model === "string" && input.model ? input.model : undefined;
						const series = svc.getProviderUsageSeries(provider, granularity, range, model);
						return {
							ok: true,
							data: {
								provider: series.provider,
								granularity: series.granularity,
								range: series.range,
								model: series.model,
								series: series.series,
							} satisfies PlatformProviderUsageData,
						};
					}
					case "providerQueue": {
						// platform-observability ② (sub-6): live queued waiters for one
						// provider's ConcurrencyQueue. Same source the kanban reads via
						// dispatcher today (was the IPC provider:queue channel).
						const provider = input.provider;
						if (!provider || typeof provider !== "string") {
							return { ok: false, error: "provider is required for the 'providerQueue' resource." };
						}
						const svc = getAgentService();
						if (!svc || typeof svc.getProviderQueue !== "function") {
							return { ok: false, error: "Provider observer not available in this context (AgentService singleton not registered)." };
						}
						const queue = svc.getProviderQueue(provider);
						return {
							ok: true,
							data: { provider, queue } satisfies PlatformProviderQueueData,
						};
					}
					case "sessions": {
						// platform-observability ① (sub-4): read-only session observation.
						// Reads the process-wide AgentService singleton (the service is the
						// PlatformObserver impl). Same source the IPC sessions:parents /
						// sessions:detail channels serve to the ③ kanban.
						const svc = getAgentService();
						if (!svc || typeof svc.listParentSessions !== "function") {
							return { ok: false, error: "Session observer not available in this context (AgentService singleton not registered)." };
						}
						if (input.sessionId) {
							// Detail: task tree + recent 3 steps (no tokens).
							const tree = svc.getSessionTaskTree?.(input.sessionId) ?? [];
							const steps = svc.getSessionRecentSteps?.(input.sessionId, 3) ?? [];
							return {
								ok: true,
								data: {
									sessionId: input.sessionId,
									taskTree: tree,
									recentSteps: steps,
								} satisfies PlatformSessionsDetailData,
							};
						}
						// List: one line per parent agent session.
						const rows = svc.listParentSessions();
						return { ok: true, data: { rows } satisfies PlatformSessionsListData };
					}
					default:
						return { ok: false, error: `Unknown resource: ${input.resource}` };
				}
			},
			// format(): pure function. Takes the ToolResult JSON returned by execute
			// and produces the LLM-facing text. Mirrors the pre-sub-2 text output so
			// agent behavior is unchanged; the JSON shape (above) is what a future UI
			// dispatcher will consume directly.
			format: (result: ToolResult): string => {
				if (!result.ok) {
					// Error path: surface the message verbatim (same as the old code's
					// string returns on error/empty branches).
					return result.error ?? "Platform resource unavailable.";
				}
				const data = result.data;
				// Discriminate by shape. Each branch reconstructs the text the LLM
				// saw before sub-2 (kept stable to avoid behavior drift).
				if (data && typeof data === "object" && "version" in (data as any)) {
					// info
					return JSON.stringify(data, null, 2);
				}
				if (data && typeof data === "object" && "lines" in (data as any) && "logFile" in (data as any)) {
					const d = data as PlatformLogsData;
					if (!d.logFile) return "No log files found.";
					return d.lines.join("\n") || "No log entries found.";
				}
				if (data && typeof data === "object" && "config" in (data as any)) {
					const d = data as PlatformConfigData;
					return JSON.stringify(d.config, null, 2);
				}
				if (data && typeof data === "object" && "providers" in (data as any)) {
					const d = data as PlatformProvidersData;
					if (d.providers.length === 0) {
						return (
							"No AI providers configured. Supported provider types: " +
							"openai, anthropic, gemini, openai-compatible, ollama.\n" +
							"Configure via Settings > Providers in the UI (recommended)."
						);
					}
					return JSON.stringify(d.providers, null, 2);
				}
				if (data && typeof data === "object" && "stats" in (data as any)) {
					const d = data as PlatformProviderStatsData;
					return renderProviderStats(d.stats);
				}
				if (data && typeof data === "object" && "series" in (data as any) && "provider" in (data as any)) {
					const d = data as PlatformProviderUsageData;
					return renderProviderUsage(d);
				}
				if (data && typeof data === "object" && "queue" in (data as any) && "provider" in (data as any)) {
					const d = data as PlatformProviderQueueData;
					return renderProviderQueue(d);
				}
				if (data && typeof data === "object" && "sessionId" in (data as any) && "taskTree" in (data as any)) {
					const d = data as PlatformSessionsDetailData;
					return renderSessionsDetail(d.sessionId, d.taskTree, d.recentSteps);
				}
				if (data && typeof data === "object" && "rows" in (data as any)) {
					const d = data as PlatformSessionsListData;
					return renderSessionsList(d.rows);
				}
				// Fallback: best-effort JSON dump (should not normally be reached).
				try {
					return typeof data === "string" ? data : JSON.stringify(data, null, 2);
				} catch {
					return "Platform resource returned non-serializable data.";
				}
			},
		}),
	};
}
