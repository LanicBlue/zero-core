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

import { createPlatformTools, formatRelativeTime } from "../../src/tools/mcp/platform-tools.js";
import { getToolExecute, getToolFormat } from "../../src/tools/tool-factory.js";
import { setAgentService, getAgentService } from "../../src/server/agent-service.js";
import type { PlatformObserver } from "../../src/runtime/types.js";
import type { PlatformSessionSummary, PlatformSessionDetail } from "../../src/shared/types.js";
import type { CallerCtx, ToolResult } from "../../src/tools/types.js";

// tool-decoupling sub-6: the HTTP helpers (express server + listen/close/
// request) are gone — the retired REST routes (/api/sessions/parents +
// /detail/:id) are no longer exercised. The Platform 'sessions' resource
// execute() is the single source.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Acceptance cases 1–5: Platform 'sessions' resource
//
// tool-decoupling sub-2: execute now returns a STRUCTURED ToolResult (JSON),
// and the text face is produced by the tool's format(). The tool reads the
// process-wide AgentService singleton (setAgentService) instead of
// ctx.platformObserver. These tests:
//   - drive execute() and assert the JSON data shape (decisions 1 + 3);
//   - drive format() on the same result and assert the text (decision 3, the
//     agent-facing face);
//   - mutate the registered singleton per-test (beforeEach) and clear it
//     (afterEach) so the singleton never leaks across files.
// ---------------------------------------------------------------------------

describe("acceptance-4 #1–5: Platform 'sessions' resource", () => {
	const tools = createPlatformTools(() => "test-version");
	const platform = (tools as any).Platform;
	// buildTool exposes the ORIGINAL execute — (input, callerCtx) — via the
	// non-enumerable __execute, and format via __format. Drive both directly.
	const exec = getToolExecute(platform)!;
	const fmt = getToolFormat(platform)!;
	// A minimal callerCtx (internal agent). The sessions resource is app-level
	// so it doesn't actually read sessionId/agentId — the ctx just has to be a
	// valid CallerCtx so the new signature is satisfied.
	const callerCtx: CallerCtx = { caller: "internal", sessionId: "test-sess", agentId: "test-agent" };

	let prev: unknown;
	beforeEach(() => {
		// Stash whatever singleton is currently registered (could be undefined
		// or a real AgentService from a prior test file) and install ours.
		prev = getAgentService();
		setAgentService(makeObserver() as any);
	});
	afterEach(() => {
		setAgentService(prev as any);
	});

	/** Run execute → assert JSON is well-formed → run format → return text. */
	async function runBoth(input: any): Promise<{ json: ToolResult; text: string }> {
		const json = await exec(input, callerCtx) as ToolResult;
		const text = fmt(json);
		return { json, text };
	}

	test("#1 + #3 + #8: List JSON has one row per parent; text has status + relative time + turns", async () => {
		const { json, text } = await runBoth({ resource: "sessions" });

		// JSON shape: { ok:true, data:{ rows: PlatformSessionSummary[] } }.
		expect(json.ok).toBe(true);
		const rows = (json.data as any).rows as PlatformSessionSummary[];
		expect(Array.isArray(rows)).toBe(true);
		expect(rows).toHaveLength(3);
		const byName = Object.fromEntries(rows.map((r) => [r.agentName, r]));
		expect(byName.General.status).toBe("running");
		expect(byName.General.turns).toBe(24);
		expect(byName.Project.status).toBe("waiting");
		expect(byName.Research.status).toBe("idle");

		// Text face (format) — header + 3 rows + legend → at least 5 lines.
		expect(typeof text).toBe("string");
		const lines = text.split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(5);
		const textRows = lines.filter((l) => /^[●◐○] /.test(l));
		expect(textRows).toHaveLength(3);

		// running row: ● General · sess-gen… · running · last 2s ago · 24 turns
		const running = textRows.find((l) => l.includes("General"));
		expect(running).toBeDefined();
		expect(running!).toContain("●"); // status dot
		expect(running!).toContain("running");
		expect(running!).toContain("last 2s ago"); // #8 relative time
		expect(running!).toContain("24 turns");
		expect(running!).toContain("sess-gen"); // short sessionId (8 chars)

		// waiting row uses ◐ + "waiting"
		const waiting = textRows.find((l) => l.includes("Project"));
		expect(waiting).toBeDefined();
		expect(waiting!).toContain("◐");
		expect(waiting!).toContain("waiting");
		expect(waiting!).toContain("last 1m ago");
		expect(waiting!).toContain("8 turns");

		// idle row uses ○ + "idle"
		const idle = textRows.find((l) => l.includes("Research"));
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
		const { json, text } = await runBoth({ resource: "sessions" });
		expect((json.data as any).rows).toHaveLength(3);
		expect(text).not.toContain("delegated");
		expect(text).not.toContain("agent-delegated");

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
		const { text } = await runBoth({ resource: "sessions" });
		// The three distinct dots must each appear exactly once per matching row.
		expect((text.match(/●/g) ?? []).length).toBeGreaterThanOrEqual(1);
		expect((text.match(/◐/g) ?? []).length).toBeGreaterThanOrEqual(1);
		expect((text.match(/○/g) ?? []).length).toBeGreaterThanOrEqual(1);
	});

	test("#4 + #5: Detail JSON has task tree + last 3 steps; text renders them; NO tokens", async () => {
		const { json, text } = await runBoth({ resource: "sessions", sessionId: "sess-general-full-id" });

		// JSON shape: { ok:true, data:{ sessionId, taskTree, recentSteps } }.
		expect(json.ok).toBe(true);
		const data = json.data as any;
		expect(data.sessionId).toBe("sess-general-full-id");
		expect(Array.isArray(data.taskTree)).toBe(true);
		expect(data.taskTree).toHaveLength(2);
		expect(Array.isArray(data.recentSteps)).toBe(true);
		expect(data.recentSteps).toHaveLength(3);

		// Text face — task tree present, bash child indented.
		expect(text).toContain("research providers");
		expect(text).toContain("build the project");
		const bashLine = text.split("\n").find((l) => l.includes("build the project"));
		expect(bashLine, "bash child must appear").toBeTruthy();
		expect(/^ {2,}\S/.test(bashLine!) || /^\t/.test(bashLine!), "nested task must be indented").toBe(true);

		// 3 recent steps (mock returns 3) — one line per step.
		const stepLines = text.split("\n").filter((l) => /^\s*step \d+ \[/.test(l));
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

		// #5 adversarial: NO tokens ANYWHERE in the Detail TEXT output. The task
		// tree mock seeds tokens: 12345 / 999; steps never carry tokens in
		// production. The text renderer must surface NEITHER.
		expect(text).not.toMatch(/token/i);
		expect(text).not.toContain("12345");
		expect(text).not.toContain("999");
		// Per-task sensitive fields must NOT leak: result / currentTool / startedAt.
		// (RuntimeTaskInfo carries them; only type/task/status/turns/targetAgentId render.)
		expect(text).not.toContain("secret-result-data");
		expect(text).not.toContain("ok-output");
		// task text itself IS shown.
		expect(text).toContain("research providers");
		// Tool args are surfaced as argsBrief — assert no `output`/`result` LABEL.
		expect(text).not.toMatch(/\boutput\b/i);
		expect(text).not.toMatch(/\bresult\b/i);
	});

	test("edge: Detail with zero steps → 'no tool calls yet'", async () => {
		const emptyObs: PlatformObserver = {
			listParentSessions: () => [],
			getSessionTaskTree: () => [],
			getSessionRecentSteps: () => [],
		};
		setAgentService(emptyObs as any);
		const json = await exec({ resource: "sessions", sessionId: "x" }, callerCtx) as ToolResult;
		const text = fmt(json);
		expect(text).toContain("no tool calls yet");
		expect(text).toContain("no live tasks"); // empty tree branch
		// JSON still well-formed: empty tree + empty steps.
		expect((json.data as any).taskTree).toEqual([]);
		expect((json.data as any).recentSteps).toEqual([]);
	});

	test("edge: observer absent (singleton undefined) → friendly fallback, not a crash", async () => {
		// Clear the singleton → getAgentService() returns undefined → the resource
		// must report "not available" rather than throw. This is the work/cron
		// path before AgentService registers, and the headless/CLI path entirely.
		setAgentService(undefined);
		const json = await exec({ resource: "sessions" }, callerCtx) as ToolResult;
		expect(json.ok).toBe(false);
		expect(fmt(json)).toContain("not available");
		const json2 = await exec({ resource: "sessions", sessionId: "x" }, callerCtx) as ToolResult;
		expect(json2.ok).toBe(false);
		expect(fmt(json2)).toContain("not available");
	});
});

// ---------------------------------------------------------------------------
// Acceptance cases 6 + 7: Platform 'sessions' resource (JSON face)
//
// tool-decoupling sub-6: the kanban's sessions List + Detail no longer flow
// through the retired REST routes (/api/sessions/parents + /detail/:id) or the
// retired IPC channels (sessions:parents / sessions:detail). The Platform
// 'sessions' resource execute() is now the single source — the dispatcher
// unwraps `result.data.rows` (List) / `result.data` (Detail). These cases
// drive that execute() directly against the same injected agentService.
// ---------------------------------------------------------------------------

describe("acceptance-4 #6 + #7: Platform sessions resource (List + Detail JSON)", () => {
	const callerCtx: CallerCtx = { caller: "internal" };
	let prev: unknown;
	let agentService: any;

	beforeEach(() => {
		prev = getAgentService();
		const obs = makeObserver();
		agentService = observerAsAgentService(obs);
		setAgentService(agentService);
	});
	afterEach(() => {
		setAgentService(prev as any);
	});

	test("#6: Platform sessions List returns the parent-session List JSON", async () => {
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "sessions" }, callerCtx) as ToolResult;
		expect(json.ok).toBe(true);
		const rows = (json.data as any).rows;
		expect(Array.isArray(rows)).toBe(true);
		expect(rows).toHaveLength(3);

		// Each row carries the full contract (kanban hides sessionId client-side;
		// the dispatcher still carries it for the click-through Detail call).
		const byId = Object.fromEntries(rows.map((r: any) => [r.agentId, r]));
		expect(byId["agent-general"].status).toBe("running");
		expect(byId["agent-general"].agentName).toBe("General");
		expect(byId["agent-general"].sessionId).toBe("sess-general-full-id");
		expect(byId["agent-general"].turns).toBe(24);
		expect(typeof byId["agent-general"].lastActivityAt).toBe("number");

		expect(byId["agent-project"].status).toBe("waiting");
		expect(byId["agent-research"].status).toBe("idle");

		// #6 adversarial: no delegated session leaks through.
		expect(JSON.stringify(rows)).not.toContain("delegated");
	});

	test("#7: Platform sessions Detail returns task tree + last 3 steps JSON", async () => {
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;
		const json = await exec({ resource: "sessions", sessionId: "sess-general-full-id" }, callerCtx) as ToolResult;
		expect(json.ok).toBe(true);
		const data = json.data as any;
		expect(data.sessionId).toBe("sess-general-full-id");

		// Task tree: two nodes (subagent root + bash child).
		expect(Array.isArray(data.taskTree)).toBe(true);
		expect(data.taskTree).toHaveLength(2);
		const root = data.taskTree.find((t: any) => t.type === "subagent");
		expect(root.task).toBe("research providers");
		expect(root.status).toBe("running");
		const bash = data.taskTree.find((t: any) => t.type === "bash");
		expect(bash.parentTaskId).toBe("task-root-1");

		// Steps: 3 entries with the contract shape — {stepSeq, toolCalls:[{name,
		// argsBrief}], status, time}. NO tokens, NO output/result (per design #5).
		expect(Array.isArray(data.recentSteps)).toBe(true);
		expect(data.recentSteps).toHaveLength(3);
		for (const s of data.recentSteps) {
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
		expect(JSON.stringify(data.recentSteps)).not.toMatch(/token/i);

		// DESIGN GAP (flagged, not a failure): the Detail taskTree is the
		// verbatim RuntimeTaskInfo[], which itself carries a `tokens` field per
		// node. Acceptance-4 #5 scopes "no tokens" to STEPS; the task tree is
		// not in scope. But the JSON DOES leak `tokens: 12345` on each task
		// node — a kanban that renders this raw would show token counts. Either
		// the kanban must avoid the field, or a future acceptance should tighten
		// the task tree shape. Recorded here as an observation, not a regression.
		expect(JSON.stringify(data.taskTree)).toContain("tokens"); // observed leak
	});

	test("#6 + #7 same-source: resource JSON matches what listParentSessions / getSessionTaskTree / getSessionRecentSteps return", async () => {
		// The resource execute() must be a thin pass-through — same data the
		// observer returns. Call the observer directly and compare.
		const tools = createPlatformTools();
		const exec = getToolExecute((tools as any).Platform)!;

		const listJson = await exec({ resource: "sessions" }, callerCtx) as ToolResult;
		expect((listJson.data as any).rows).toEqual(agentService.listParentSessions());

		const detailJson = await exec({ resource: "sessions", sessionId: "sess-general-full-id" }, callerCtx) as ToolResult;
		const detailData = detailJson.data as any;
		expect(detailData.taskTree).toEqual(agentService.getSessionTaskTree("sess-general-full-id"));
		expect(detailData.recentSteps).toEqual(agentService.getSessionRecentSteps("sess-general-full-id", 3));
	});
});
