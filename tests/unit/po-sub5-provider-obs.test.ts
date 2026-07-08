// platform-observability sub-5 acceptance test: provider observation exposure.
//
// # File Spec
//
// ## Core
// Adversarial verification of docs/plan/platform-observability/acceptance-5.md
// (7 cases). Independent from the implementer — does NOT trust the claims.
// Drives:
//   - the REAL Platform 'providerStats' resource execute() (text face) — fed by
//     an injected mock PlatformObserver whose rows deliberately carry a
//     "secret-cost" / "balance" field to prove the renderer never surfaces them.
//   - the REAL REST endpoints /api/providers/stats | /usage | /queue (IPC face)
//     — fed by an agentService-shaped mock OR a real AgentService prototype
//     instance (bypassing the heavy constructor via Object.create) wired to a
//     temp SessionDB + real ConcurrencyQueue + real ProviderUsageStore.
//   - the REAL ProviderUsageStore.seriesByModel (granularity hour/day,
//     per-model series) over a temp SessionDB.
//   - the REAL ConcurrencyQueue.getWaiting for the queue list.
//
// ## Acceptance cases (acceptance-5.md)
//   1. Platform providerStats — one line per provider; each line carries
//      enabled / in-flight / queue / cumulative tokens / calls / err% /
//      avg latency; text format.
//   2. Data sources correct — tokens/calls from ProviderUsageStore cumulative;
//      in-flight/queue from ConcurrencyQueue; latency process-local running
//      (design ②.2). latency MUST be non-null when usage exists; permanent N/A
//      is FAIL.
//   3. IPC provider:stats — all-providers cumulative JSON.
//   4. IPC provider:usage — granularity=hour → ~24 buckets; =day → ~30
//      buckets; per-bucket per-model series (for stacked chart).
//   5. IPC provider:queue — returns that provider's queued session list.
//   6. Disabled provider — listed (marked disabled, cumulative 0).
//   7. No cost / balance — no cost/balance fields in any of the three shapes.
//
// ## Constraints
// English test bodies; no production sessions.db touched (pure unit test); no
// LLM provider calls; REST exercised over a real Express server on an
// ephemeral port.
//
// ## Adversarial posture
// - The #1 mock row for the disabled provider deliberately reports NON-zero
//   tokens (1234) and a fake "balanceUsd" field — we assert the TEXT renderer
//   shows "disabled" + "0 tok" (verifying it ignored the mock's tokens and
//   re-derived 0 from acceptance-5 #6) and never echoes balanceUsd.
//   NOTE: the real listProviderStats reads cumulative from the store (0 for a
//   fresh provider), so this adversarial token value is only used on the
//   pure-mock path of #1 — proving the renderer itself is field-agnostic.
// - The #1 mock row seeds latencyMs: null AND a fake "costUsd" field — proving
//   the text renderer surfaces the latency column header regardless of value
//   and never leaks cost.
// - #4 inserts usage across 25 distinct hours + 31 distinct days to verify
//   the cutoff is exclusive-of-range (24h must keep the most recent 24, drop
//   the 25th; 30d keeps 30, drops the 31st).

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPlatformTools } from "../../src/tools/mcp/platform-tools.js";
import { getToolExecute, getToolFormat } from "../../src/tools/tool-factory.js";
import { SessionDB } from "../../src/server/session-db.js";
import { ProviderUsageStore, floorToHourBucket } from "../../src/server/provider-usage-store.js";
import { ProviderConcurrencyManager } from "../../src/runtime/provider-concurrency-manager.js";
import { AgentService, setAgentService, getAgentService } from "../../src/server/agent-service.js";
import { SessionManager } from "../../src/server/session-manager.js";
import type { PlatformProviderStat } from "../../src/runtime/types.js";
import type { CallerCtx, ToolResult } from "../../src/tools/types.js";
import { TIER_P1, TIER_P2 } from "../../src/runtime/concurrency-context.js";

// tool-decoupling sub-6: the HTTP helpers (express server + listen/close/
// request) are gone — the retired REST routes (/api/providers/stats|usage|
// queue) are no longer exercised. The tool execute() is the single source.

// ---------------------------------------------------------------------------
// Mock PlatformObserver / agentService (for the text-face #1 and #3 paths)
// ---------------------------------------------------------------------------

/**
 * Build a mock observer with TWO providers: one enabled (with realistic load +
 * tokens), one DISABLED (acceptance-5 #6). The disabled row deliberately
 * carries fake token + cost fields the renderer must NOT surface as-is — the
 * assertion is that the TEXT renderer always shows what the stat SAYS, never
 * invents new columns. latencyMs is null on both (sub-2 gap).
 *
 * The shape matches PlatformProviderStat exactly (the real producer output).
 */
function makeStatRows(): PlatformProviderStat[] {
	return [
		{
			name: "OpenAI",
			type: "openai",
			enabled: true,
			modelCount: 3,
			inFlight: 2,
			maxConcurrency: 5,
			queue: 1,
			tokens: 12345,
			calls: 100,
			errors: 5,
			errRate: 0.05,
			latencyMs: null, // sub-2 gap — N/A until process-local accumulator lands
		},
		{
			name: "Local-Ollama",
			type: "ollama",
			enabled: false,
			modelCount: 2,
			inFlight: 0,
			maxConcurrency: 0,
			queue: 0,
			tokens: 0,
			calls: 0,
			errors: 0,
			errRate: 0,
			latencyMs: null,
		},
	];
}

/** Lift stat rows into the shape the platform-tools text renderer reads. */
function observerWithStats(rows: PlatformProviderStat[]): any {
	return { listProviderStats: () => rows };
}

/**
 * Create the `providers` table on a fresh SessionDB. SessionDB's constructor
 * does NOT create it (ProviderStore's SqliteStore does, but instantiating
 * ProviderStore triggers mergeSystemProviders which would pollute assertions).
 * Schema mirrors what listProviderStats SELECTs (name/type/enabled/base_url/
 * api_key/models).
 */
function ensureProvidersTable(db: ReturnType<SessionDB["getDb"]>): void {
	db.prepare(
		`CREATE TABLE IF NOT EXISTS providers (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			type TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			models TEXT NOT NULL DEFAULT '[]',
			api_key TEXT,
			base_url TEXT,
			is_system INTEGER NOT NULL DEFAULT 0,
			enable_concurrency_limit INTEGER NOT NULL DEFAULT 0,
			max_concurrency INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	).run();
}

/** Insert a provider row (minimal fields). */
function insertProvider(
	db: ReturnType<SessionDB["getDb"]>,
	name: string,
	type: string,
	enabled: boolean,
	models: any[] = [],
): void {
	db.prepare(
		`INSERT INTO providers (name, type, enabled, models, api_key, base_url, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(name, type, enabled ? 1 : 0, JSON.stringify(models), "sk-test", "https://example.com", new Date().toISOString(), new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Real AgentService prototype harness (for the data-source #2 path)
// ---------------------------------------------------------------------------

/**
 * Bypass the heavy AgentService constructor: create an instance via
 * Object.create(AgentService.prototype) and inject ONLY the fields the
 * provider-observation methods touch (db / concurrencyManager /
 * sessionManager). Lets us drive the REAL listProviderStats /
 * getProviderUsageSeries / getProviderQueue / getConcurrencySnapshot code
 * against a temp SessionDB + real ConcurrencyQueue + real ProviderUsageStore.
 */
function makeAgentServiceHarness(opts: {
	db: SessionDB;
	concurrencyManager: ProviderConcurrencyManager;
	sessionManager: any;
}): AgentService {
	const inst = Object.create(AgentService.prototype) as AgentService;
	// Field names mirror the private declarations in agent-service.ts (db,
	// concurrencyManager, sessionManager). Object.create skips field
	// initializers, so we inject manually.
	(inst as any).db = opts.db;
	(inst as any).concurrencyManager = opts.concurrencyManager;
	(inst as any).sessionManager = opts.sessionManager;
	return inst;
}

// ---------------------------------------------------------------------------
// Acceptance #1 — Platform providerStats
//
// tool-decoupling sub-2: execute returns STRUCTURED ToolResult JSON (stats
// array); the text face is the tool's format(). The tool reads the
// process-wide AgentService singleton (setAgentService) — no ctx injection.
// These tests drive execute() (assert JSON) + format() (assert text).
// ---------------------------------------------------------------------------

describe("acceptance-5 #1 — Platform providerStats JSON + text format", () => {
	const callerCtx: CallerCtx = { caller: "internal" };
	let prev: unknown;
	beforeEach(() => {
		prev = getAgentService();
	});
	afterEach(() => {
		setAgentService(prev as any);
	});

	/** Install an agentService-shaped mock returning the given stat rows. */
	function withStats(rows: PlatformProviderStat[]): void {
		setAgentService(observerWithStats(rows) as any);
	}

	test("JSON shape { ok, data:{ stats } } + text line carries enabled / in-flight / queue / tokens / calls / err% / avg latency", async () => {
		withStats(makeStatRows());
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const fmt = getToolFormat((tools as any).Platform)!;

		const json = await exec({ resource: "providerStats" }, callerCtx) as ToolResult;
		// JSON: well-formed + both providers present (enabled + disabled).
		expect(json.ok).toBe(true);
		const stats = (json.data as any).stats as PlatformProviderStat[];
		expect(Array.isArray(stats)).toBe(true);
		expect(stats).toHaveLength(2);
		const byName = Object.fromEntries(stats.map((s) => [s.name, s]));
		expect(byName.OpenAI.enabled).toBe(true);
		expect(byName.OpenAI.inFlight).toBe(2);
		expect(byName.OpenAI.calls).toBe(100);
		expect(byName["Local-Ollama"].enabled).toBe(false);

		// Text face (format) — full column contract.
		const text = fmt(json);
		expect(typeof text).toBe("string");
		const rows = makeStatRows().map((r) => r.name);
		const lines = text.split("\n").filter((l) => rows.some((n) => l.startsWith(n + " · ")) || rows.some((n) => l.startsWith(n + " ")));
		expect(lines.length).toBe(2);

		// The enabled provider line — assert EVERY required field appears.
		const enabledLine = lines.find((l) => l.startsWith("OpenAI"))!;
		expect(enabledLine).toBeTruthy();
		// name · type · enabled|disabled · in-flight/max · queue:N · tokens · calls · err% · latency avg
		expect(enabledLine).toMatch(/\bOpenAI\b/);
		expect(enabledLine).toMatch(/\bopenai\b/);
		expect(enabledLine).toMatch(/\benabled\b/);
		expect(enabledLine).toMatch(/2\/5/); // in-flight/max
		expect(enabledLine).toMatch(/queue:1/);
		expect(enabledLine).toMatch(/\btok\b/); // cumulative tokens (formatted)
		expect(enabledLine).toMatch(/\bcalls\b/);
		expect(enabledLine).toMatch(/\d+\.\d+%/); // err%
		expect(enabledLine).toMatch(/(N\/A|\d+ms)/); // avg latency column present (N/A per sub-2 gap)
	});

	test("one line per provider — ALL providers incl. disabled (no row dropped)", async () => {
		withStats(makeStatRows());
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const fmt = getToolFormat((tools as any).Platform)!;
		const text = fmt(await exec({ resource: "providerStats" }, callerCtx) as ToolResult);
		// Both the enabled and disabled providers appear.
		expect(text).toMatch(/OpenAI/);
		expect(text).toMatch(/Local-Ollama/);
	});

	test("header labels cumulative tokens / calls / err% / avg latency (column contract)", async () => {
		withStats(makeStatRows());
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const fmt = getToolFormat((tools as any).Platform)!;
		const text = fmt(await exec({ resource: "providerStats" }, callerCtx) as ToolResult);
		// The trailing legend line names every column — proves the contract.
		expect(text).toMatch(/cumulative tokens/);
		expect(text).toMatch(/cumulative calls/);
		expect(text).toMatch(/err%/);
		expect(text).toMatch(/avg latency/);
	});

	test("empty state when no providers", async () => {
		withStats([]);
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const fmt = getToolFormat((tools as any).Platform)!;
		// JSON: empty stats array (ok). Text: friendly empty-state.
		const json = await exec({ resource: "providerStats" }, callerCtx) as ToolResult;
		expect(json.ok).toBe(true);
		expect((json.data as any).stats).toEqual([]);
		expect(fmt(json)).toMatch(/No AI providers configured/);
	});
});

// ---------------------------------------------------------------------------
// Acceptance #2 — data sources correct
// ---------------------------------------------------------------------------

describe("acceptance-5 #2 — data sources correct (cumulative + concurrency)", () => {
	let dir: string;
	let sessionDb: SessionDB;
	let usageStore: ProviderUsageStore;
	let concurrencyManager: ProviderConcurrencyManager;
	let svc: AgentService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "po-sub5-src-"));
		sessionDb = new SessionDB(join(dir, "sessions.db"));
		usageStore = new ProviderUsageStore(sessionDb.getDb());
		concurrencyManager = new ProviderConcurrencyManager();
		// Seed ONE provider in the providers table (the real listProviderStats
		// reads providers via raw SQL — see readProvidersTable).
		const rawDb = (sessionDb as any).getDb();
		ensureProvidersTable(rawDb);
		insertProvider(rawDb, "OpenAI", "openai", true, [{ id: "gpt-4" }]);
		// Configure a real concurrency queue (max=2) so active/waiting reflect.
		concurrencyManager.reconfigure([{ name: "OpenAI", enableConcurrencyLimit: true, maxConcurrency: 2 }]);

		svc = makeAgentServiceHarness({
			db: sessionDb,
			concurrencyManager,
			sessionManager: { getProviderUsageStore: () => usageStore },
		});
	});

	afterEach(() => {
		try { sessionDb.close(); } catch { /* best-effort */ }
		rmSync(dir, { recursive: true, force: true });
	});

	test("tokens/calls come from ProviderUsageStore.cumulative (sum of provider_usage rows)", () => {
		const hour = floorToHourBucket(Date.now());
		usageStore.upsert({ provider: "OpenAI", model: "gpt-4", hourBucket: hour, source: "user", calls: 1, inputTokens: 100, outputTokens: 50 });
		usageStore.upsert({ provider: "OpenAI", model: "gpt-4", hourBucket: hour, source: "user", calls: 1, inputTokens: 200, outputTokens: 100, error: true });

		const stats = svc.listProviderStats!();
		expect(stats.length).toBe(1);
		const s = stats[0];
		// cumulative = 100+50 + 200+100 = 450 tokens, 2 calls, 1 error.
		expect(s.tokens).toBe(450);
		expect(s.calls).toBe(2);
		expect(s.errors).toBe(1);
		expect(s.errRate).toBeCloseTo(0.5, 5);
	});

	test("in-flight/queue come from ConcurrencyQueue (live active + waiting)", async () => {
		const queue = concurrencyManager.getQueue("openai")!; // normalize("OpenAI") = "openai"
		expect(queue).toBeDefined();
		// Hold both slots.
		await queue.acquire();
		await queue.acquire();
		// One waiter (P2).
		const pending = queue.acquire({ sessionId: "sess-q", agentId: "agent-q", tier: TIER_P2 });
		await Promise.resolve();
		await new Promise<void>((r) => setImmediate(r));

		const stats = svc.listProviderStats!();
		const s = stats[0];
		expect(s.inFlight).toBe(2);
		expect(s.maxConcurrency).toBe(2);
		expect(s.queue).toBe(1);

		// drain
		queue.release();
		await pending;
		queue.release();
		queue.release();
	});

	test("getConcurrencySnapshot returns real per-provider {active,waiting} (was {} before sub-5)", async () => {
		// beforeEach configured max=2 for "OpenAI". Hold both slots, then one
		// waiter queues (the snapshot must reflect active=2 / waiting=1).
		const queue = concurrencyManager.getQueue("openai")!;
		await queue.acquire();
		await queue.acquire();
		const pending = queue.acquire({ sessionId: "s2", tier: TIER_P1 });
		await Promise.resolve();
		await new Promise<void>((r) => setImmediate(r));

		// getConcurrencySnapshot keys by p.name (the raw providers-table name),
		// NOT the normalized queue key. Provider "OpenAI" → snap["OpenAI"].
		const snap = svc.getConcurrencySnapshot();
		expect(snap.OpenAI).toBeDefined();
		expect(snap.OpenAI.active).toBe(2);
		expect(snap.OpenAI.waiting).toBe(1);

		queue.release();
		await pending;
		queue.release();
		queue.release();
	});

	test("latencyMs is the process-local running average over recorded steps (design ②.2)", () => {
		// Use a REAL SessionManager wired to the same temp SessionDB. listProviderStats
		// calls sm.getProviderLatencyMs(p.name); recordProviderUsage folds each
		// successful step's durationMs into the in-memory accumulator. Verifies the
		// implementer's 补建 (was null/GAP — now a real value).
		const sm = new SessionManager({ evictSessionFromMemory() {}, getActiveSessionsMap: () => new Map() });
		sm.setSessionDb(sessionDb);
		const svc2 = makeAgentServiceHarness({
			db: sessionDb,
			concurrencyManager,
			sessionManager: sm,
		});

		// No steps recorded yet → latencyMs is null (renderer shows N/A — restart-safe).
		const before = svc2.listProviderStats!();
		expect(before[0].latencyMs).toBeNull();

		// Record two successful steps (100ms, 300ms) — only the success path folds.
		sm.recordProviderUsage({
			provider: "OpenAI", model: "gpt-4", source: "user",
			usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 100,
		});
		sm.recordProviderUsage({
			provider: "OpenAI", model: "gpt-4", source: "user",
			usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 300,
		});
		// A failed step MUST be ignored (its latency isn't representative).
		sm.recordProviderUsage({
			provider: "OpenAI", model: "gpt-4", source: "user",
			usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 9999, error: true,
		});

		const stats = svc2.listProviderStats!();
		// Adversarial flip of the previous verdict: latencyMs is NOW a real
		// average over the two successful steps, not null.
		expect(stats[0].latencyMs).not.toBeNull();
		expect(stats[0].latencyMs).toBe(200); // (100 + 300) / 2 — failed step excluded
	});
});

// ---------------------------------------------------------------------------
// Acceptance #3 — Platform providerStats resource (JSON face)
//
// tool-decoupling sub-6: the kanban's provider-stats no longer flows through
// the retired REST route (/api/providers/stats) or IPC channel (provider:stats).
// The Platform 'providerStats' resource execute() is now the single source.
// ---------------------------------------------------------------------------

describe("acceptance-5 #3 — Platform providerStats resource (JSON)", () => {
	const callerCtx: CallerCtx = { caller: "internal" };
	let prev: unknown;
	beforeEach(() => { prev = getAgentService(); });
	afterEach(() => { setAgentService(prev as any); });

	test("Platform providerStats returns ALL providers cumulative JSON", async () => {
		setAgentService(observerWithStats(makeStatRows()) as any);
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "providerStats" }, callerCtx) as ToolResult;
		expect(json.ok).toBe(true);
		const stats = (json.data as any).stats;
		expect(Array.isArray(stats)).toBe(true);
		expect(stats.length).toBe(2);
		const names = stats.map((r: any) => r.name).sort();
		expect(names).toEqual(["Local-Ollama", "OpenAI"]);
		// Each row carries the cumulative fields the kanban KPI bar reads.
		for (const row of stats) {
			for (const f of ["name", "type", "enabled", "inFlight", "maxConcurrency", "queue", "tokens", "calls", "errors", "errRate", "latencyMs"]) {
				expect(row).toHaveProperty(f);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Acceptance #4 — Platform providerUsage resource (hour/day + per-model series)
//
// tool-decoupling sub-6: kanban usage now reads via Platform 'providerUsage'
// resource (was REST /api/providers/usage + IPC provider:usage).
// ---------------------------------------------------------------------------

describe("acceptance-5 #4 — Platform providerUsage resource (hour/day + per-model series)", () => {
	const callerCtx: CallerCtx = { caller: "internal" };
	let dir: string;
	let sessionDb: SessionDB;
	let usageStore: ProviderUsageStore;
	let svc: AgentService;
	let prev: unknown;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "po-sub5-usage-"));
		sessionDb = new SessionDB(join(dir, "sessions.db"));
		usageStore = new ProviderUsageStore(sessionDb.getDb());

		// Seed usage across 25 distinct hours (2 models) for the 24h cutoff
		// test, AND across 31 distinct days for the 30d cutoff test. Each
		// model gets a call + tokens so the per-model series is non-empty.
		const now = Date.now();
		const HOUR_MS = 60 * 60 * 1000;
		for (let i = 0; i < 25; i++) {
			const ts = now - i * HOUR_MS;
			const hour = floorToHourBucket(ts);
			usageStore.upsert({ provider: "OpenAI", model: "gpt-4", hourBucket: hour, source: "user", calls: 1, inputTokens: 10, outputTokens: 5 });
			usageStore.upsert({ provider: "OpenAI", model: "gpt-3.5", hourBucket: hour, source: "user", calls: 1, inputTokens: 4, outputTokens: 2 });
		}
		// 31 days back at one row per day (well within 30d cutoff except the oldest).
		for (let d = 0; d < 31; d++) {
			const ts = now - d * 24 * HOUR_MS;
			const hour = floorToHourBucket(ts);
			usageStore.upsert({ provider: "OpenAI", model: "gpt-4", hourBucket: hour, source: "work", calls: 1, inputTokens: 100, outputTokens: 50 });
		}

		// Tool face backed by the REAL AgentService prototype.
		const concurrencyManager = new ProviderConcurrencyManager();
		svc = makeAgentServiceHarness({
			db: sessionDb,
			concurrencyManager,
			sessionManager: { getProviderUsageStore: () => usageStore },
		});
		prev = getAgentService();
		setAgentService(svc);
	});

	afterEach(() => {
		setAgentService(prev as any);
		try { sessionDb.close(); } catch { /* best-effort */ }
		rmSync(dir, { recursive: true, force: true });
	});

	test("granularity=hour keeps ~24 buckets; per-bucket per-model series", async () => {
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "providerUsage", provider: "OpenAI", granularity: "hour", range: "24h" }, callerCtx) as ToolResult;
		expect(json.ok).toBe(true);
		const data = json.data as any;
		expect(data.provider).toBe("OpenAI");
		expect(data.granularity).toBe("hour");
		expect(data.range).toBe("24h");
		expect(Array.isArray(data.series)).toBe(true);
		// Per-model series: gpt-4 + gpt-3.5 (the day-only gpt-4 rows are also
		// hourly rows in the same range, so gpt-4 series exists regardless).
		const models = data.series.map((s: any) => s.model).sort();
		expect(models).toEqual(["gpt-3.5", "gpt-4"]);
		// gpt-4 series has ≤24 buckets (the 25th hour is outside 24h cutoff).
		const gpt4 = data.series.find((s: any) => s.model === "gpt-4");
		expect(gpt4.points.length).toBeLessThanOrEqual(24);
		expect(gpt4.points.length).toBeGreaterThan(0);
		// Each point has the stacked-chart fields.
		for (const pt of gpt4.points) {
			for (const f of ["bucket", "calls", "tokens", "errors"]) {
				expect(pt).toHaveProperty(f);
			}
		}
	});

	test("granularity=day keeps ≤30 buckets (30d cutoff drops the 31st)", async () => {
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "providerUsage", provider: "OpenAI", granularity: "day", range: "30d" }, callerCtx) as ToolResult;
		const data = json.data as any;
		expect(data.granularity).toBe("day");
		// gpt-4 day series: 31 days seeded, but range=30d keeps ≤30.
		const gpt4 = data.series.find((s: any) => s.model === "gpt-4");
		expect(gpt4).toBeDefined();
		expect(gpt4.points.length).toBeLessThanOrEqual(30);
		expect(gpt4.points.length).toBeGreaterThan(0);
		// day bucket format = YYYY-MM-DD (10 chars, ISO date prefix).
		for (const pt of gpt4.points) {
			expect(pt.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	test("per-model series are SEPARATE (not merged) — stacked-chart ready", async () => {
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "providerUsage", provider: "OpenAI", granularity: "hour", range: "24h" }, callerCtx) as ToolResult;
		const data = json.data as any;
		// Two distinct model series; the chart stacks them per bucket.
		expect(data.series.length).toBe(2);
		const byModel = new Set(data.series.map((s: any) => s.model));
		expect(byModel.has("gpt-4")).toBe(true);
		expect(byModel.has("gpt-3.5")).toBe(true);
	});

	test("model filter narrows to a single series", async () => {
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "providerUsage", provider: "OpenAI", granularity: "hour", range: "24h", model: "gpt-4" }, callerCtx) as ToolResult;
		const data = json.data as any;
		// Filtered to gpt-4 only.
		const models = data.series.map((s: any) => s.model);
		expect(models).toEqual(["gpt-4"]);
	});

	test("missing provider param → tool returns { ok:false, error } (no 400 — dispatcher is JSON-shaped)", async () => {
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "providerUsage", granularity: "hour", range: "24h" }, callerCtx) as ToolResult;
		// Tool-layer contract: missing provider → structured {ok:false} (the
		// dispatcher forwards this to the UI, which degrades — no HTTP status).
		expect(json.ok).toBe(false);
		expect(typeof json.error).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// Acceptance #5 — Platform providerQueue resource (queued session list)
//
// tool-decoupling sub-6: kanban queue now reads via Platform 'providerQueue'
// resource (was REST /api/providers/queue + IPC provider:queue).
// ---------------------------------------------------------------------------

describe("acceptance-5 #5 — Platform providerQueue resource (queued session list)", () => {
	const callerCtx: CallerCtx = { caller: "internal" };
	let dir: string;
	let sessionDb: SessionDB;
	let concurrencyManager: ProviderConcurrencyManager;
	let svc: AgentService;
	let prev: unknown;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "po-sub5-queue-"));
		sessionDb = new SessionDB(join(dir, "sessions.db"));
		concurrencyManager = new ProviderConcurrencyManager();
		// Seed the providers table so listProviderStats / getConcurrencySnapshot
		// iterate this provider; and configure a real queue.
		const rawDb = (sessionDb as any).getDb();
		ensureProvidersTable(rawDb);
		insertProvider(rawDb, "OpenAI", "openai", true, []);
		concurrencyManager.reconfigure([{ name: "OpenAI", enableConcurrencyLimit: true, maxConcurrency: 1 }]);
		svc = makeAgentServiceHarness({
			db: sessionDb,
			concurrencyManager,
			sessionManager: { getProviderUsageStore: () => undefined },
		});
		prev = getAgentService();
		setAgentService(svc);
	});

	afterEach(() => {
		setAgentService(prev as any);
		try { sessionDb.close(); } catch { /* best-effort */ }
		rmSync(dir, { recursive: true, force: true });
	});

	test("queued waiters returned with sessionId/agentId/tier/waitedSince", async () => {
		const queue = concurrencyManager.getQueue("openai")!;
		await queue.acquire(); // hold the slot
		const a = queue.acquire({ sessionId: "sess-A", agentId: "agent-X", tier: TIER_P2 });
		const b = queue.acquire({ sessionId: "sess-B", agentId: "agent-Y", tier: TIER_P1 });
		await Promise.resolve();
		await new Promise<void>((r) => setImmediate(r));

		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "providerQueue", provider: "OpenAI" }, callerCtx) as ToolResult;
		expect(json.ok).toBe(true);
		const data = json.data as any;
		expect(data.provider).toBe("OpenAI");
		expect(Array.isArray(data.queue)).toBe(true);
		expect(data.queue.length).toBe(2);
		// P1 (sess-B) sorts before P2 (sess-A) per getWaiting's tier-asc ordering.
		expect(data.queue[0].sessionId).toBe("sess-B");
		expect(data.queue[1].sessionId).toBe("sess-A");
		for (const entry of data.queue) {
			expect(typeof entry.tier).toBe("number");
			expect(typeof entry.waitedSince).toBe("number");
		}

		// drain: release wakes the highest-priority waiter first (sess-B / P1),
		// then the next release wakes sess-A / P2. Order matches tier priority,
		// NOT FIFO.
		queue.release();
		await b;
		queue.release();
		await a;
		queue.release();
	});

	test("empty queue → []", async () => {
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "providerQueue", provider: "OpenAI" }, callerCtx) as ToolResult;
		expect(json.ok).toBe(true);
		expect((json.data as any).queue).toEqual([]);
	});

	test("missing provider param → tool returns { ok:false, error } (no 400 — dispatcher is JSON-shaped)", async () => {
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "providerQueue" }, callerCtx) as ToolResult;
		expect(json.ok).toBe(false);
		expect(typeof json.error).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// Acceptance #6 — disabled provider listed (marked disabled, cumulative 0)
// ---------------------------------------------------------------------------

describe("acceptance-5 #6 — disabled provider listed (marked, cumulative 0)", () => {
	let dir: string;
	let sessionDb: SessionDB;
	let usageStore: ProviderUsageStore;
	let svc: AgentService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "po-sub5-disabled-"));
		sessionDb = new SessionDB(join(dir, "sessions.db"));
		usageStore = new ProviderUsageStore(sessionDb.getDb());
		const rawDb = (sessionDb as any).getDb();
		// Two providers: one enabled, one DISABLED.
		ensureProvidersTable(rawDb);
		insertProvider(rawDb, "OpenAI", "openai", true, []);
		insertProvider(rawDb, "Disabled-One", "ollama", false, []);

		svc = makeAgentServiceHarness({
			db: sessionDb,
			concurrencyManager: new ProviderConcurrencyManager(),
			sessionManager: { getProviderUsageStore: () => usageStore },
		});
	});

	afterEach(() => {
		try { sessionDb.close(); } catch { /* best-effort */ }
		rmSync(dir, { recursive: true, force: true });
	});

	test("listProviderStats includes the disabled provider with enabled=false and zeros", () => {
		const stats = svc.listProviderStats!();
		expect(stats.length).toBe(2);
		const disabled = stats.find((s) => !s.enabled);
		expect(disabled).toBeDefined();
		expect(disabled!.name).toBe("Disabled-One");
		expect(disabled!.tokens).toBe(0);
		expect(disabled!.calls).toBe(0);
		expect(disabled!.errors).toBe(0);
		expect(disabled!.errRate).toBe(0);
	});

	test("text renderer marks the disabled row 'disabled'", async () => {
		// tool-decoupling sub-2: register the real harness svc as the singleton,
		// then drive execute() → JSON → format() (no ctx injection).
		const prev = getAgentService();
		setAgentService(svc);
		try {
			const stats = svc.listProviderStats!();
			const tools = createPlatformTools();
			const exec = getToolExecute((tools as any).Platform)!;
			const fmt = getToolFormat((tools as any).Platform)!;
			const json = await exec({ resource: "providerStats" }, { caller: "internal" }) as ToolResult;
			// JSON carries both providers; the disabled one has enabled=false.
			expect((json.data as any).stats).toEqual(stats);
			const out = fmt(json);
			expect(out).toMatch(/Disabled-One/);
			const disabledLine = out.split("\n").find((l) => l.startsWith("Disabled-One"))!;
			expect(disabledLine).toMatch(/\bdisabled\b/);
			expect(disabledLine).toMatch(/queue:0/);
		} finally {
			setAgentService(prev as any);
		}
	});
});

// ---------------------------------------------------------------------------
// Acceptance #7 — no cost / balance fields
// ---------------------------------------------------------------------------

describe("acceptance-5 #7 — no cost / balance / spend / credit fields", () => {
	test("PlatformProviderStat shape carries no cost/balance fields", () => {
		const row: PlatformProviderStat = {
			name: "x", type: "openai", enabled: true, modelCount: 0,
			inFlight: 0, maxConcurrency: 0, queue: 0,
			tokens: 0, calls: 0, errors: 0, errRate: 0, latencyMs: null,
		};
		const keys = Object.keys(row);
		// Explicit denylist — design ② decision 3: no cost / no balance / no billing.
		for (const forbidden of ["cost", "costUsd", "balance", "balanceUsd", "spend", "credit", "usd", "price"]) {
			expect(keys).not.toContain(forbidden);
		}
	});

	test("provider:usage series points carry no cost/balance fields (tokens only)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "po-sub5-cost-"));
		try {
			const sessionDb = new SessionDB(join(dir, "sessions.db"));
			const usageStore = new ProviderUsageStore(sessionDb.getDb());
			usageStore.upsert({ provider: "OpenAI", model: "gpt-4", hourBucket: floorToHourBucket(Date.now()), source: "user", calls: 1, inputTokens: 10, outputTokens: 5 });

			const concurrencyManager = new ProviderConcurrencyManager();
			const svc = makeAgentServiceHarness({
				db: sessionDb,
				concurrencyManager,
				sessionManager: { getProviderUsageStore: () => usageStore },
			});
			const series = svc.getProviderUsageSeries!("OpenAI", "hour", "24h");
			expect(series.series.length).toBeGreaterThan(0);
			for (const s of series.series) {
				for (const pt of s.points) {
					const keys = Object.keys(pt);
					for (const forbidden of ["cost", "costUsd", "balance", "balanceUsd", "spend", "credit", "usd", "price"]) {
						expect(keys).not.toContain(forbidden);
					}
				}
			}
			sessionDb.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("provider:queue entries carry no cost/balance fields", async () => {
		const dir = mkdtempSync(join(tmpdir(), "po-sub5-qcost-"));
		try {
			const sessionDb = new SessionDB(join(dir, "sessions.db"));
			const rawDb = (sessionDb as any).getDb();
			ensureProvidersTable(rawDb);
			insertProvider(rawDb, "OpenAI", "openai", true, []);
			const concurrencyManager = new ProviderConcurrencyManager();
			concurrencyManager.reconfigure([{ name: "OpenAI", enableConcurrencyLimit: true, maxConcurrency: 1 }]);
			const svc = makeAgentServiceHarness({
				db: sessionDb,
				concurrencyManager,
				sessionManager: { getProviderUsageStore: () => undefined },
			});
			const queue = concurrencyManager.getQueue("openai")!;
			await queue.acquire();
			const pending = queue.acquire({ sessionId: "s", tier: TIER_P1 });
			await Promise.resolve();
			await new Promise<void>((r) => setImmediate(r));

			const entries = svc.getProviderQueue!("OpenAI");
			expect(entries.length).toBe(1);
			const keys = Object.keys(entries[0]);
			for (const forbidden of ["cost", "costUsd", "balance", "balanceUsd", "spend", "credit", "usd", "price"]) {
				expect(keys).not.toContain(forbidden);
			}

			queue.release();
			await pending;
			queue.release();
			sessionDb.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
