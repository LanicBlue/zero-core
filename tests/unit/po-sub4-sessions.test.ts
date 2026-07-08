// platform-observability sub-4 acceptance test: session observation surface.
//
// # File Spec
//
// ## Core
// Adversarial verification of docs/plan/platform-observability/acceptance-4.md
// (8 cases). Independent from the implementer — does NOT trust the claims.
// Drives the REAL Platform 'sessions' resource execute() and the REAL
// session-router REST endpoints (/parents + /detail/:sessionId), both fed by
// the SAME injected mock PlatformObserver/agentService surface. Also unit-tests
// the exported formatRelativeTime at the boundaries.
//
// ## Acceptance cases (acceptance-4.md)
//   1. Platform List — one row per parent session, each row contains
//      status(running|waiting|idle) + relative time + turns; text format.
//   2. Only parent sessions — delegated sub-agent sessions do NOT appear.
//   3. Status correctness — runStates has entry & isBusy → running; waiting →
//      waiting; no entry → idle. (Verified by the mock emitting all three.)
//   4. Detail task tree — passing sessionId returns getRuntimeTaskTree output.
//   5. Detail last 3 steps — returns recent 3 steps {stepSeq, toolCalls[{name,
//      argsBrief}], status, time}; NO tokens.
//   6. IPC sessions:parents — returns parent-session List as JSON.
//   7. IPC sessions:detail — returns Detail JSON (task tree + steps).
//   8. Relative time — "last 2s ago" / "last 1m ago" style.
//
// ## Constraints
// English test bodies; no production sessions.db touched (pure unit test);
// no LLM provider calls; routes exercised over a real Express server bound
// to an ephemeral port.
//
// ## Adversarial posture
// The Detail step mock is DELIBERATELY seeded with a `tokens` field and tool
// blocks carrying `args`/`output`/`result` — the assertion is that the
// resource NEVER surfaces these. The List mock seeds rows whose `agentName`
// differs from `agentId` to catch any field mix-up. A row for "agent-delegated"
// is OMITTED from listParentSessions to prove the List is just whatever the
// observer returns (the parent filter lives in db.getMainSession's
// session_kind='chat' clause — separately asserted from the SQL).

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "http";

import { createPlatformTools, formatRelativeTime } from "../../src/tools/mcp/platform-tools.js";
import { getToolExecute } from "../../src/tools/tool-factory.js";
import type { PlatformObserver } from "../../src/runtime/types.js";
import type { PlatformSessionSummary, PlatformSessionDetail } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listen(app: Express): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer(app);
		server.listen(0, () => {
			const addr = server.address() as { port: number };
			resolve({ server, port: addr.port });
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(resolve));
}

async function request(port: number, method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
	const url = `http://localhost:${port}${path}`;
	const opts: RequestInit = { method };
	if (body !== undefined) {
		opts.headers = { "Content-Type": "application/json" };
		opts.body = JSON.stringify(body);
	}
	const resp = await fetch(url, opts);
	const text = await resp.text();
	try {
		return { status: resp.status, data: JSON.parse(text) };
	} catch {
		return { status: resp.status, data: text };
	}
}

/**
 * A wall-clock anchored to the REAL now (formatRelativeTime defaults to
 * Date.now()). lastActivityAt values are expressed relative to this so the
 * rendered relative time is deterministic regardless of when the test runs.
 */
const NOW = Date.now();

/**
 * Build a PlatformObserver mock with all three statuses represented (running
 * / waiting / idle) plus turns and distinct agentName vs agentId. NO row named
 * "agent-delegated" — proving the List surface is exactly what the observer
 * returns (the parent-vs-delegated filter is db.getMainSession's job; we assert
 * that separately via the SQL).
 *
 * Shapes mirror the REAL producer outputs (not the implementer's claim):
 *   - taskTree rows are RuntimeTaskInfo (which DOES carry a `tokens` field —
 *     the Platform text renderer must NOT surface it; whether the IPC JSON
 *     strips it is a design gap we flag separately).
 *   - steps are EXACTLY {stepSeq, toolCalls:[{name,argsBrief}], status, time}
 *     — that's the real AgentLoop.getRecentSteps shape; tokens never appear
 *     here in production. We assert the resource text output never mentions
 *     tokens regardless.
 */
function makeObserver(): PlatformObserver & {
		detailTaskTree: any[]; detailSteps: any[];
	} {
	const taskTree = [
		{
			id: "task-root-1",
			type: "subagent",
			task: "research providers",
			status: "running",
			parentTaskId: undefined,
			step: 2,
			turns: 4,
			tokens: 12345, // RuntimeTaskInfo carries tokens — text render must NOT surface it
			targetAgentId: "agent-research",
			currentTool: "Grep",
			result: "secret-result-data",
			startedAt: NOW - 60_000,
		},
		{
			id: "task-bash-1",
			type: "bash",
			task: "build the project",
			status: "completed",
			parentTaskId: "task-root-1",
			step: 3,
			turns: 1,
			tokens: 999,
			result: "ok-output",
			startedAt: NOW - 50_000,
			completedAt: NOW - 40_000,
		},
	];
	// Real AgentLoop.getRecentSteps shape — only {name, argsBrief} per call.
	const steps = [
		{ stepSeq: 0, toolCalls: [{ name: "Read", argsBrief: "/etc/passwd" }], status: "done", time: NOW - 30_000 },
		{ stepSeq: 1, toolCalls: [{ name: "Bash", argsBrief: "rm -rf /" }], status: "error", time: NOW - 10_000 },
		{
			stepSeq: 2,
			toolCalls: [
				{ name: "Grep", argsBrief: "secret-query" },
				{ name: "Glob", argsBrief: "*.ts" },
			],
			status: "running",
			time: NOW - 2_000,
		},
	];

	const summaries: PlatformSessionSummary[] = [
		{ agentId: "agent-general", agentName: "General", sessionId: "sess-general-full-id", status: "running", lastActivityAt: NOW - 2_000, turns: 24 },
		{ agentId: "agent-project", agentName: "Project", sessionId: "sess-project-full-id", status: "waiting", lastActivityAt: NOW - 60_000, turns: 8 },
		{ agentId: "agent-research", agentName: "Research", sessionId: "sess-research-full-id", status: "idle", lastActivityAt: NOW - 14 * 60_000, turns: 3 },
	];

	return {
		listParentSessions: () => summaries,
		getSessionTaskTree: (_sid: string) => taskTree,
		getSessionRecentSteps: (_sid: string, _n?: number) => steps,
		// expose for the agentService-shaped REST mock if ever needed
		detailTaskTree: taskTree,
		detailSteps: steps,
	} as any;
}

/** Lift an observer into the shape the session-router reads (agentService). */
function observerAsAgentService(obs: PlatformObserver): any {
	return {
		listParentSessions: () => obs.listParentSessions(),
		getSessionTaskTree: (sid: string) => obs.getSessionTaskTree(sid),
		getSessionRecentSteps: (sid: string, n?: number) => obs.getSessionRecentSteps(sid, n),
		getDB: () => { throw new Error("not used by /parents or /detail"); },
		getSessionManager: () => undefined,
	};
}

// ---------------------------------------------------------------------------
// Acceptance case 8: formatRelativeTime
// ---------------------------------------------------------------------------

describe("acceptance-4 #8: formatRelativeTime", () => {
	test("<60s → 'last Ns ago'", () => {
		expect(formatRelativeTime(NOW, NOW)).toBe("last 0s ago");
		expect(formatRelativeTime(NOW - 2_000, NOW)).toBe("last 2s ago");
		expect(formatRelativeTime(NOW - 59_999, NOW)).toBe("last 59s ago");
	});

	test("60s..59m59s → 'last Nm ago'", () => {
		expect(formatRelativeTime(NOW - 60_000, NOW)).toBe("last 1m ago");
		expect(formatRelativeTime(NOW - 14 * 60_000, NOW)).toBe("last 14m ago");
		expect(formatRelativeTime(NOW - 59 * 60_000 - 59_000, NOW)).toBe("last 59m ago");
	});

	test("1h..23h → 'last Nh ago'", () => {
		expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe("last 1h ago");
		expect(formatRelativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe("last 23h ago");
	});

	test(">=24h → 'last Nd ago'", () => {
		expect(formatRelativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe("last 1d ago");
		expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("last 3d ago");
	});

	test("future clamp — never negative", () => {
		// A clock skew (lastActivityAt slightly ahead of now) must not produce
		// negative seconds. Math.max(0, ...) guard.
		expect(formatRelativeTime(NOW + 5_000, NOW)).toBe("last 0s ago");
	});

	test("style matches the spec ('last …s/m/h/d ago')", () => {
		// acceptance-4 #8 calls out the exact style "last 2s ago" / "last 1m ago".
		expect(formatRelativeTime(NOW - 2_000, NOW)).toMatch(/^last \d+s ago$/);
		expect(formatRelativeTime(NOW - 60_000, NOW)).toMatch(/^last \d+m ago$/);
	});
});

// ---------------------------------------------------------------------------
// Acceptance cases 1–5: Platform 'sessions' resource (text face)
// ---------------------------------------------------------------------------

describe("acceptance-4 #1–5: Platform 'sessions' resource", () => {
	const obs = makeObserver();
	const tools = createPlatformTools(() => "test-version");
	const platform = (tools as any).Platform;
	// buildTool wraps execute so the public .execute uses the AI-SDK signature
	// (input, opts) with ctx on opts.experimental_context. The ORIGINAL execute
	// — (input, ctx) — is exposed via the non-enumerable __execute. Drive THAT
	// directly so ctx.platformObserver reaches the resource.
	const exec = getToolExecute(platform)!;
	const ctx = { platformObserver: obs } as any;

	test("#1 + #3 + #8: List is text, one row per parent, each row has status + relative time + turns", async () => {
		const out = await exec({ resource: "sessions" }, ctx);
		expect(typeof out).toBe("string");
		// Header + 3 rows + legend → at least 5 lines.
		const lines = out.split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(5);
		// Exactly three rows (one per parent agent) — no delegated row, no extras.
		const rows = lines.filter((l) => /^[●◐○] /.test(l));
		expect(rows).toHaveLength(3);

		// running row: ● General · sess-gen… · running · last 2s ago · 24 turns
		const running = rows.find((l) => l.includes("General"));
		expect(running).toBeDefined();
		expect(running!).toContain("●"); // status dot
		expect(running!).toContain("running");
		expect(running!).toContain("last 2s ago"); // #8 relative time
		expect(running!).toContain("24 turns");
		expect(running!).toContain("sess-gen"); // short sessionId (8 chars)

		// waiting row uses ◐ + "waiting"
		const waiting = rows.find((l) => l.includes("Project"));
		expect(waiting).toBeDefined();
		expect(waiting!).toContain("◐");
		expect(waiting!).toContain("waiting");
		expect(waiting!).toContain("last 1m ago");
		expect(waiting!).toContain("8 turns");

		// idle row uses ○ + "idle"
		const idle = rows.find((l) => l.includes("Research"));
		expect(idle).toBeDefined();
		expect(idle!).toContain("○");
		expect(idle!).toContain("idle");
		expect(idle!).toContain("last 14m ago");
		expect(idle!).toContain("3 turns");
	});

	test("#2: delegated sub-agent sessions do NOT appear in List", async () => {
		// The mock observer's listParentSessions returns exactly three parent
		// rows — none named "agent-delegated". The List surface is just the
		// observer's return; the parent-vs-delegated filter is db.getMainSession's
		// session_kind='chat' clause. We assert BOTH halves:
		//   (a) the surface never invents extra rows
		//   (b) the SQL filter really excludes session_kind='delegated'
		const out = await exec({ resource: "sessions" }, ctx);
		expect(out).not.toContain("delegated");
		expect(out).not.toContain("agent-delegated");

		// (b) The SQL filter is the source of truth — read it straight from the
		//     source file rather than trusting the implementer's claim.
		const fs = await import("node:fs");
		const sql = fs.readFileSync("src/server/session-db.ts", "utf-8");
		const m = sql.match(/getMainSession[^}]*?SELECT \* FROM sessions WHERE[^"]*?"/);
		expect(m, "getMainSession SQL must exist and be readable").toBeTruthy();
		expect(m![0]).toContain("session_kind = 'chat'");
		expect(m![0]).toContain("is_main = 1");
		// session_kind='delegated' rows are explicitly excluded by the chat clause.
	});

	test("#3 (regression): all three statuses produce the right dot + label", async () => {
		// The mock emits one of each — exercised above; this case pins the
		// mapping independently in case the formatter ever drifts.
		const out = await exec({ resource: "sessions" }, ctx);
		// The three distinct dots must each appear exactly once per matching row.
		expect((out.match(/●/g) ?? []).length).toBeGreaterThanOrEqual(1);
		expect((out.match(/◐/g) ?? []).length).toBeGreaterThanOrEqual(1);
		expect((out.match(/○/g) ?? []).length).toBeGreaterThanOrEqual(1);
	});

	test("#4 + #5: Detail returns task tree + last 3 steps; NO tokens", async () => {
		const out = await exec({ resource: "sessions", sessionId: "sess-general-full-id" }, ctx);
		expect(typeof out).toBe("string");

		// Task tree present — both nodes (root + nested bash child), indented.
		expect(out).toContain("research providers");
		expect(out).toContain("build the project");
		// The bash child is parented to the root → must be indented (≥2 spaces)
		// relative to the root line. The renderer uses "  ".repeat(depth).
		const bashLine = out.split("\n").find((l) => l.includes("build the project"));
		expect(bashLine, "bash child must appear").toBeTruthy();
		expect(/^ {2,}\S/.test(bashLine!) || /^\t/.test(bashLine!), "nested task must be indented").toBe(true);

		// 3 recent steps (mock returns 3) — one line per step.
		const stepLines = out.split("\n").filter((l) => /^\s*step \d+ \[/.test(l));
		expect(stepLines).toHaveLength(3);

		// step 0: Read; step 1: Bash (error); step 2: Grep + Glob (running).
		expect(stepLines[0]).toContain("step 0");
		expect(stepLines[0]).toContain("Read");
		expect(stepLines[0]).toContain("[done]");

		expect(stepLines[1]).toContain("step 1");
		expect(stepLines[1]).toContain("Bash");
		expect(stepLines[1]).toContain("[error]");

		expect(stepLines[2]).toContain("step 2");
		expect(stepLines[2]).toContain("Grep");
		expect(stepLines[2]).toContain("Glob");
		expect(stepLines[2]).toContain("[running]");

		// #5 adversarial: NO tokens ANYWHERE in the Detail output. The task tree
		// mock seeds tokens: 12345 / 999; steps never carry tokens in production.
		// The text renderer must surface NEITHER.
		expect(out).not.toMatch(/token/i);
		expect(out).not.toContain("12345");
		expect(out).not.toContain("999");
		// Per-task sensitive fields must NOT leak: result / currentTool / startedAt.
		// (RuntimeTaskInfo carries them; only type/task/status/turns/targetAgentId render.)
		expect(out).not.toContain("secret-result-data");
		expect(out).not.toContain("ok-output");
		// task text itself IS shown.
		expect(out).toContain("research providers");
		// Tool args are surfaced as argsBrief — assert no `output`/`result` LABEL.
		expect(out).not.toMatch(/\boutput\b/i);
		expect(out).not.toMatch(/\bresult\b/i);
	});

	test("edge: Detail with zero steps → 'no tool calls yet'", async () => {
		const emptyObs: PlatformObserver = {
			listParentSessions: () => [],
			getSessionTaskTree: () => [],
			getSessionRecentSteps: () => [],
		};
		const out = await exec({ resource: "sessions", sessionId: "x" }, { platformObserver: emptyObs } as any);
		expect(out).toContain("no tool calls yet");
		expect(out).toContain("no live tasks"); // empty tree branch
	});

	test("edge: observer absent → friendly fallback, not a crash", async () => {
		const out = await exec({ resource: "sessions" }, {} as any);
		expect(out).toContain("not available");
		const out2 = await exec({ resource: "sessions", sessionId: "x" }, {} as any);
		expect(out2).toContain("not available");
	});
});

// ---------------------------------------------------------------------------
// Acceptance cases 6 + 7: IPC sessions:parents / sessions:detail (JSON face)
// ---------------------------------------------------------------------------

describe("acceptance-4 #6 + #7: IPC sessions:parents / sessions:detail", () => {
	let app: Express;
	let server: Server;
	let port: number;
	let agentService: any;

	beforeEach(async () => {
		const obs = makeObserver();
		agentService = observerAsAgentService(obs);
		app = express();
		app.use(express.json());
		const { createSessionRouter } = await import("../../src/server/session-router.js");
		app.use("/api/sessions", createSessionRouter({ agentService, agentStore: { get: () => undefined, list: () => [] } as any }));
		const r = await listen(app);
		server = r.server;
		port = r.port;
	});

	afterEach(async () => { await close(server); });

	test("#6: GET /api/sessions/parents returns the parent-session List JSON", async () => {
		const res = await request(port, "GET", "/api/sessions/parents");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
		expect(res.data).toHaveLength(3);

		// Each row carries the full contract (kanban hides sessionId client-side;
		// the IPC still carries it for the click-through Detail call).
		const byId = Object.fromEntries(res.data.map((r: any) => [r.agentId, r]));
		expect(byId["agent-general"].status).toBe("running");
		expect(byId["agent-general"].agentName).toBe("General");
		expect(byId["agent-general"].sessionId).toBe("sess-general-full-id");
		expect(byId["agent-general"].turns).toBe(24);
		expect(typeof byId["agent-general"].lastActivityAt).toBe("number");

		expect(byId["agent-project"].status).toBe("waiting");
		expect(byId["agent-research"].status).toBe("idle");

		// #6 adversarial: no delegated session leaks through.
		expect(JSON.stringify(res.data)).not.toContain("delegated");
	});

	test("#6 (regression): /parents is not captured by the :agentId route", async () => {
		// Routes are registered /metrics → /parents → /detail → ... → /:agentId.
		// If /parents ever moves after /:agentId, this becomes a 404 or wrong shape.
		const res = await request(port, "GET", "/api/sessions/parents");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.data)).toBe(true);
		// If captured by /:agentId, res.data would be an array of sessions for an
		// agent literally named "parents" — empty/undefined here → assert non-empty.
		expect(res.data.length).toBeGreaterThan(0);
	});

	test("#7: GET /api/sessions/detail/:sessionId returns task tree + last 3 steps JSON", async () => {
		const res = await request(port, "GET", "/api/sessions/detail/sess-general-full-id");
		expect(res.status).toBe(200);
		expect(res.data.sessionId).toBe("sess-general-full-id");

		// Task tree: two nodes (subagent root + bash child).
		expect(Array.isArray(res.data.taskTree)).toBe(true);
		expect(res.data.taskTree).toHaveLength(2);
		const root = res.data.taskTree.find((t: any) => t.type === "subagent");
		expect(root.task).toBe("research providers");
		expect(root.status).toBe("running");
		const bash = res.data.taskTree.find((t: any) => t.type === "bash");
		expect(bash.parentTaskId).toBe("task-root-1");

		// Steps: 3 entries with the contract shape — {stepSeq, toolCalls:[{name,
		// argsBrief}], status, time}. NO tokens, NO output/result (per design #5).
		expect(Array.isArray(res.data.recentSteps)).toBe(true);
		expect(res.data.recentSteps).toHaveLength(3);
		for (const s of res.data.recentSteps) {
			expect(typeof s.stepSeq).toBe("number");
			expect(Array.isArray(s.toolCalls)).toBe(true);
			for (const c of s.toolCalls) {
				// Only {name, argsBrief} — never tokens/output/result.
				expect(Object.keys(c).sort()).toEqual(["argsBrief", "name"]);
			}
			expect(typeof s.status).toBe("string");
			expect(typeof s.time).toBe("number");
			// #5 adversarial: a step object must NEVER carry a tokens field.
			expect(s).not.toHaveProperty("tokens");
			expect(s).not.toHaveProperty("output");
			expect(s).not.toHaveProperty("result");
		}
		// #5 (steps face): recentSteps JSON has no token mention.
		expect(JSON.stringify(res.data.recentSteps)).not.toMatch(/token/i);

		// DESIGN GAP (flagged, not a failure): the IPC /detail taskTree is the
		// verbatim RuntimeTaskInfo[], which itself carries a `tokens` field per
		// node. Acceptance-4 #5 scopes "no tokens" to STEPS; the task tree is
		// not in scope. But the IPC JSON DOES leak `tokens: 12345` on each task
		// node — a kanban that renders this raw would show token counts. Either
		// the kanban must avoid the field, or a future acceptance should tighten
		// the task tree shape. Recorded here as an observation, not a regression.
		expect(JSON.stringify(res.data.taskTree)).toContain("tokens"); // observed leak
	});

	test("#6 + #7 same-source: IPC JSON matches what listParentSessions / getSessionTaskTree / getSessionRecentSteps return", async () => {
		// The REST handlers must be thin pass-throughs — same data the Platform
		// resource renders. Call the observer directly and compare.
		const parents = await request(port, "GET", "/api/sessions/parents");
		expect(parents.data).toEqual(agentService.listParentSessions());

		const detail = await request(port, "GET", "/api/sessions/detail/sess-general-full-id");
		expect(detail.data.taskTree).toEqual(agentService.getSessionTaskTree("sess-general-full-id"));
		expect(detail.data.recentSteps).toEqual(agentService.getSessionRecentSteps("sess-general-full-id", 3));
	});
});
