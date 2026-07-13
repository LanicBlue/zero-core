// sub-4 (execution-entry-redesign) acceptance tests — Task action tool.
//
// Independent verifier-authored tests encoding acceptance-4.md criteria 1–9.
// Each describe block maps to a written acceptance criterion so PASS/FAIL is
// auditable from the test name. Mirrors the mocking style of
// sub1-subagent-background.test.ts / sub4-task-tools.test.ts (legacy).
//
// # Authoritative spec
// docs/plan/execution-entry-redesign/acceptance-4.md
//
// # Scope
//   - Task action tool (get/list/kill/finish/resume) — merged from 6 prior tools.
//   - Flat z.object schema (top-level type:object, no oneOf/anyOf).
//   - meta + configSchema shape.
//   - 6 old files deleted + no residual imports.
//   - TOOL_DEFS registration (Task in, 6 old names out).
//
// # Not covered here (other criteria)
//   - criterion 8/9 (sub1/sub2 still pass) — verified by full-suite run.
//   - criterion 10 (typecheck) — verified by `npm run build:lib`.

import { describe, test, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths from THIS test file so the test works regardless of where
// vitest bound its cwd. Test lives at tests/unit/ → repo root is ../../.
const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "src", "tools");
import { z } from "zod";
import { taskTool, taskActionSchema } from "../../src/tools/task-tool.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import {
	getToolExecute,
	getToolFormat,
	getToolMeta,
	getToolConfigSchema,
	getToolName,
} from "../../src/tools/tool-factory.js";
import type { TaskInfo } from "../../src/runtime/types.js";

const exec = getToolExecute(taskTool)!;
const fmt = getToolFormat(taskTool)!;

/** Format the LLM-facing string (wrap exec so it returns format(JSON)). */
const run = (i: any, c: any) => exec(i, c).then(fmt);
/** Raw ToolResult JSON. */
const raw = (i: any, c: any) => exec(i, c);
/** Extract the data.text payload (or error) — what the LLM sees. */
const text = async (i: any, c: any) => {
	const r = await exec(i, c);
	return r.ok ? (r as any).data?.text : r.error;
};

// ─── ctx builder (mirrors sub4-task-tools.test.ts legacy style) ───────────

function task(over: Partial<TaskInfo> = {}): TaskInfo {
	return {
		id: "t1",
		type: "subagent",
		task: "do thing",
		status: "running",
		step: 0,
		turns: 0,
		tokens: 0,
		startedAt: Date.now() - 1000,
		...over,
	} as TaskInfo;
}

/**
 * Build a CallerCtx-shape ctx whose delegateFns bridge the legacy per-task
 * map. `extra` adds/overrides delegateFns.* (stopTask, acknowledgeTask, …)
 * or top-level callerCtx fields (toolConfig, …).
 */
function ctxWith(tasks: Record<string, TaskInfo>, extra: Record<string, any> = {}) {
	const delegateFns: any = {
		getTaskResult: (id: string) => tasks[id] ?? null,
	};
	const delegateKeys = new Set([
		"getTaskResult", "listTasks", "stopTask", "abandonTask", "acknowledgeTask",
		"requestTaskFinish", "resumeTaskBackground", "getTaskRecentCalls",
		"runBackground", "delegateTask", "delegateTaskBackground",
		"suspendUntilWake", "beginWait", "endWait", "setWaitStartedAt",
		"setToolCallTaskId",
	]);
	for (const [k, v] of Object.entries(extra)) {
		if (delegateKeys.has(k)) delegateFns[k] = v;
	}
	const ctx: any = {
		caller: "internal" as const,
		agentId: "caller",
		workingDir: ".",
		delegateFns,
	};
	for (const [k, v] of Object.entries(extra)) {
		if (!delegateKeys.has(k)) ctx[k] = v;
	}
	return ctx;
}

// ===========================================================================
// Criterion 1 — 5 actions work (behavior matches the old per-tool logic)
// ===========================================================================

describe("acceptance-4 / criterion 1: Task {action} — 5 actions work", () => {
	// ── get: 3 status branches + not-found ──────────────────────────────

	test("get / running → recent_calls (name+args), current_tool, no result key", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "running", currentTool: "Edit" }) },
			{ getTaskRecentCalls: (_id: string, n?: number) => [
				{ name: "Read", args: "/a/b.ts" },
				{ name: "Grep", args: "pat *.ts" },
				{ name: "Edit", args: "fix" },
			].slice(0, n ?? 3) },
		);
		const parsed = JSON.parse(await text({ action: "get", task_id: "t1" }, ctx));
		expect(parsed.status).toBe("running");
		expect(parsed.current_tool).toBe("Edit");
		expect(parsed.recent_calls).toHaveLength(3);
		expect(parsed.recent_calls[0]).toEqual({ name: "Read", args: "/a/b.ts" });
		expect(parsed.result).toBeUndefined();
	});

	test("get / interrupted → marker + waited_s, recent_calls empty", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "interrupted", startedAt: Date.now() - 5000, currentTool: "Grep" }) },
			{ getTaskRecentCalls: () => [] },
		);
		const parsed = JSON.parse(await text({ action: "get", task_id: "t1" }, ctx));
		expect(parsed.status).toBe("interrupted");
		expect(parsed.marker).toBe("[interrupted by restart]");
		expect(parsed.waited_s).toBeGreaterThanOrEqual(5);
		expect(parsed.recent_calls).toEqual([]);
		expect(parsed.result).toBeUndefined();
	});

	test("get / completed → full result + acknowledge=true consumes task", async () => {
		const tasks: Record<string, TaskInfo> = {
			t1: task({ status: "completed", result: "ALL DONE", completedAt: Date.now() }),
		};
		const ctx = ctxWith(tasks, {
			acknowledgeTask: (id: string) => { delete tasks[id]; return true; },
		});
		const parsed = JSON.parse(await text({ action: "get", task_id: "t1" }, ctx));
		expect(parsed.status).toBe("completed");
		expect(parsed.result).toBe("ALL DONE");
		expect(parsed.acknowledged).toBe(true);
		expect(tasks.t1).toBeUndefined();
	});

	test("get / not-found → friendly not-found text", async () => {
		const r = await text({ action: "get", task_id: "nope" }, ctxWith({}));
		expect(r).toMatch(/not found/i);
	});

	test("get / missing task_id → ok:false error", async () => {
		const r = await raw({ action: "get" }, ctxWith({}));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/task_id.*required/i);
	});

	// ── list: filter / taskIds / tree / empty / config ───────────────────

	test("list / default (all) → running + completed sections + Total line", async () => {
		const ctx = ctxWith({}, {
			listTasks: () => [
				task({ id: "r1", status: "running", currentTool: "Read" }),
				task({ id: "c1", status: "completed", result: "ok", completedAt: Date.now() }),
			],
		});
		const out = await text({ action: "list" }, ctx);
		expect(out).toMatch(/Running \(1\):/);
		expect(out).toMatch(/Completed \(showing 1\):/);
		expect(out).toMatch(/Total: 2 tasks, 1 running/);
	});

	test("list / filter:'running' → listTasks called with 'running'", async () => {
		let captured: any = undefined;
		const ctx = ctxWith({}, {
			listTasks: (f?: string) => { captured = f; return []; },
		});
		await text({ action: "list", filter: "running" }, ctx);
		expect(captured).toBe("running");
	});

	test("list / taskIds → only matching ids kept", async () => {
		const ctx = ctxWith({}, {
			listTasks: () => [
				task({ id: "a", status: "running" }),
				task({ id: "b", status: "running" }),
				task({ id: "c", status: "running" }),
			],
		});
		const out = await text({ action: "list", taskIds: ["a", "c"] }, ctx);
		expect(out).toMatch(/Total: 2 tasks/);
	});

	test("list / empty registry → 'No tasks.' / 'No running tasks.'", async () => {
		const ctx = ctxWith({}, { listTasks: () => [] });
		expect(await text({ action: "list" }, ctx)).toMatch(/No tasks\./);
		expect(await text({ action: "list", filter: "running" }, ctx)).toMatch(/No running tasks\./);
	});

	test("list / nested tasks (parentTaskId) → Tree section appended", async () => {
		const ctx = ctxWith({}, {
			listTasks: () => [
				task({ id: "p", status: "running" }),
				task({ id: "c", status: "running", parentTaskId: "p" } as any),
			],
		});
		const out = await text({ action: "list" }, ctx);
		expect(out).toMatch(/^Tree:/m);
	});

	// ── kill: running→stopTask / interrupted→abandonTask / terminal→get hint ──

	test("kill / running → stopTask invoked, 'killed' text", async () => {
		let killed: string | null = null;
		const ctx = ctxWith(
			{ t1: task({ status: "running" }) },
			{ stopTask: (id: string) => { killed = id; return true; } },
		);
		const r = await text({ action: "kill", task_id: "t1" }, ctx);
		expect(killed).toBe("t1");
		expect(r).toMatch(/killed/i);
	});

	test("kill / interrupted → abandonTask invoked (NOT stopTask), 'abandoned' text", async () => {
		let abandoned: string | null = null;
		let stopCalled = false;
		const ctx = ctxWith(
			{ t1: task({ status: "interrupted" }) },
			{
				abandonTask: (id: string) => { abandoned = id; return true; },
				stopTask: () => { stopCalled = true; return true; },
			},
		);
		const r = await text({ action: "kill", task_id: "t1" }, ctx);
		expect(abandoned).toBe("t1");
		expect(stopCalled).toBe(false);
		expect(r).toMatch(/abandoned/i);
	});

	test("kill / terminal → points at action:'get' (not killable)", async () => {
		const ctx = ctxWith({ t1: task({ status: "completed", completedAt: Date.now() }) });
		const r = await text({ action: "kill", task_id: "t1" }, ctx);
		expect(r).toMatch(/terminal/i);
		expect(r).toMatch(/action:'get'/i);
	});

	test("kill / missing task_id → ok:false error", async () => {
		const r = await raw({ action: "kill" }, ctxWith({}));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/task_id.*required/i);
	});

	// ── finish: agent only + maxTurns ────────────────────────────────────

	test("finish / agent running → requestTaskFinish fires with maxTurns", async () => {
		let captured: any = null;
		const ctx = ctxWith(
			{ t1: task({ status: "running" }) },
			{ requestTaskFinish: (id: string, o: any) => { captured = { id, o }; return true; } },
		);
		const r = await text({ action: "finish", task_id: "t1", maxTurns: 3 }, ctx);
		expect(captured.id).toBe("t1");
		expect(captured.o.maxTurns).toBe(3);
		expect(r).toMatch(/force-stop after 3/);
	});

	test("finish / bash task → rejected ('agent tasks only')", async () => {
		const ctx = ctxWith({ t1: task({ type: "bash", status: "running" }) });
		const r = await text({ action: "finish", task_id: "t1" }, ctx);
		expect(r).toMatch(/agent tasks only/i);
		expect(r).toMatch(/action:'kill'/i);
	});

	test("finish / advisory path (no maxTurns) → 'no hard turn budget' message", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "running" }) },
			{ requestTaskFinish: () => true },
		);
		const r = await text({ action: "finish", task_id: "t1", message: "wrap up" }, ctx);
		expect(r).toMatch(/no hard turn budget/i);
	});

	// ── resume: interrupted + agent only ─────────────────────────────────

	test("resume / interrupted agent → resumeTaskBackground fires, non-blocking msg", async () => {
		let fired = false;
		const ctx = ctxWith(
			{ t1: task({ status: "interrupted" }) },
			{ resumeTaskBackground: () => { fired = true; return "t1"; } },
		);
		const r = await text({ action: "resume", task_id: "t1" }, ctx);
		expect(fired).toBe(true);
		expect(r).toMatch(/resumed/i);
		expect(r).toMatch(/non-blocking/i);
	});

	test("resume / bash task → rejected ('agent tasks only')", async () => {
		const ctx = ctxWith({ t1: task({ type: "bash", status: "interrupted" }) });
		const r = await text({ action: "resume", task_id: "t1" }, ctx);
		expect(r).toMatch(/agent tasks only/i);
	});

	test("resume / non-interrupted → rejected ('not interrupted')", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "running" }) },
			{ resumeTaskBackground: () => "t1" },
		);
		const r = await text({ action: "resume", task_id: "t1" }, ctx);
		expect(r).toMatch(/not interrupted/i);
	});

	test("resume / missing task_id → ok:false error", async () => {
		const r = await raw({ action: "resume" }, ctxWith({}));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/task_id.*required/i);
	});
});

// ===========================================================================
// Criterion 2 — top-level type:object (no oneOf / anyOf)
// ===========================================================================

describe("acceptance-4 / criterion 2: taskActionSchema → top-level type:object", () => {
	async function toJsonSchema(schema: z.ZodTypeAny): Promise<any> {
		const std = (schema as any)["~standard"];
		return std.jsonSchema.input({ target: "draft-07" });
	}

	test("type is object, no top-level oneOf / anyOf, action property present", async () => {
		const js = await toJsonSchema(taskActionSchema);
		expect(js.type).toBe("object");
		expect(js.oneOf).toBeUndefined();
		expect(js.anyOf).toBeUndefined();
		expect(js.properties?.action).toBeDefined();
	});

	test("action is an enum of the 5 expected values", async () => {
		const js = await toJsonSchema(taskActionSchema);
		const actionProp = js.properties.action;
		// zod v4 → enum with values; some builds surface "enum" array directly.
		const values = actionProp.enum ?? actionProp.anyOf?.flatMap?.((a: any) => a.enum ?? []) ?? [];
		expect(values.sort()).toEqual(["finish", "get", "kill", "list", "resume"]);
	});

	test("action is required (present in required[])", async () => {
		const js = await toJsonSchema(taskActionSchema);
		expect(Array.isArray(js.required)).toBe(true);
		expect(js.required).toContain("action");
	});
});

// ===========================================================================
// Criterion 3 — action required (empty {} rejected)
// ===========================================================================

describe("acceptance-4 / criterion 3: Task {} (no action) → rejected", () => {
	test("empty input fails validation (issues present)", async () => {
		const std = (taskActionSchema as any)["~standard"];
		const res = await std.validate({});
		expect(res).toHaveProperty("issues");
		expect(Array.isArray(res.issues)).toBe(true);
		expect(res.issues.length).toBeGreaterThan(0);
	});

	test("unknown action value → rejected", async () => {
		const std = (taskActionSchema as any)["~standard"];
		const res = await std.validate({ action: "bogus" });
		expect(res).toHaveProperty("issues");
	});

	test("null / undefined action → rejected", async () => {
		const std = (taskActionSchema as any)["~standard"];
		expect((await std.validate({ action: null })).issues).toBeDefined();
		expect((await std.validate({ action: undefined })).issues).toBeDefined();
	});
});

// ===========================================================================
// Criterion 4 — meta = {category:task, isReadOnly:false, isConcurrencySafe:false, isDestructive:false}
// ===========================================================================

describe("acceptance-4 / criterion 4: meta (4 named fields)", () => {
	const meta = getToolMeta(taskTool)!;

	test("category === 'task'", () => {
		expect(meta.category).toBe("task");
	});
	test("isReadOnly === false", () => {
		expect(meta.isReadOnly).toBe(false);
	});
	test("isConcurrencySafe === false", () => {
		expect(meta.isConcurrencySafe).toBe(false);
	});
	test("isDestructive === false", () => {
		expect(meta.isDestructive).toBe(false);
	});
});

// ===========================================================================
// Criterion 5 — max_completed config on Task (default 5)
// ===========================================================================

describe("acceptance-4 / criterion 5: configSchema has max_completed (default 5)", () => {
	const cfg = getToolConfigSchema(taskTool) ?? [];

	test("configSchema is an array with max_completed entry", () => {
		expect(Array.isArray(cfg)).toBe(true);
		const entry = cfg.find((f: any) => f.key === "max_completed");
		expect(entry).toBeDefined();
		expect(entry.default).toBe(5);
		expect(entry.type).toBe("number");
	});
});

// ===========================================================================
// Criterion 6 — 6 old files deleted + no residual imports in src/tools/
// ===========================================================================

describe("acceptance-4 / criterion 6: 6 old files deleted + no residual imports", () => {
	const oldFiles = [
		"task-start.ts", "task-get.ts", "task-list.ts",
		"task-kill.ts", "task-finish.ts", "task-resume.ts",
	];
	for (const f of oldFiles) {
		test(`src/tools/${f} does not exist`, () => {
			expect(existsSync(join(TOOLS_DIR, f))).toBe(false);
		});
	}

	test("no src/tools/*.ts imports taskStartTool / taskGetTool / ... / taskResumeTool", () => {
		const oldSymbols = [
			"taskStartTool", "taskGetTool", "taskListTool",
			"taskKillTool", "taskFinishTool", "taskResumeTool",
		];
		const toolsDir = TOOLS_DIR;
		const files = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
		const offenders: string[] = [];
		for (const f of files) {
			// task-tool.ts legitimately references the old NAMES in comments —
			// we only flag real imports / symbol uses (word boundary, not in a
			// comment-only line). Read source and check for `import ... from`.
			const src = readFileSync(join(toolsDir, f), "utf8");
			for (const sym of oldSymbols) {
				// Match an import binding of the symbol. Comment-line mentions
				// (task-tool.ts header) don't count.
				const re = new RegExp(`^\\s*(?:import|export)[^\\n]*\\b${sym}\\b`, "m");
				if (re.test(src)) offenders.push(`${f}: ${sym}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no src/tools/*.ts has `from \"./task-(start|get|list|kill|finish|resume).js\"` import", () => {
		const toolsDir = TOOLS_DIR;
		const files = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
		const offenders: string[] = [];
		const re = /from\s+["']\.\/task-(start|get|list|kill|finish|resume)\.js["']/;
		for (const f of files) {
			const src = readFileSync(join(toolsDir, f), "utf8");
			if (re.test(src)) offenders.push(f);
		}
		expect(offenders).toEqual([]);
	});
});

// ===========================================================================
// Criterion 7 — TOOL_DEFS registration: Task in, 6 old names out
// ===========================================================================

describe("acceptance-4 / criterion 7: ALL_TOOLS registration", () => {
	test("ALL_TOOLS['Task'] is defined and === taskTool", () => {
		expect(ALL_TOOLS["Task"]).toBeDefined();
		expect(ALL_TOOLS["Task"]).toBe(taskTool);
	});

	test("getToolName(taskTool) === 'Task'", () => {
		expect(getToolName(taskTool)).toBe("Task");
	});

	test("ALL_TOOLS has none of the 6 old names", () => {
		expect(ALL_TOOLS["TaskStart"]).toBeUndefined();
		expect(ALL_TOOLS["TaskGet"]).toBeUndefined();
		expect(ALL_TOOLS["TaskList"]).toBeUndefined();
		expect(ALL_TOOLS["TaskKill"]).toBeUndefined();
		expect(ALL_TOOLS["TaskFinish"]).toBeUndefined();
		expect(ALL_TOOLS["TaskResume"]).toBeUndefined();
	});
});

// ===========================================================================
// Criterion 9 (implicit) — config key rename: TaskList → Task
// ===========================================================================

describe("acceptance-4 / criterion 9 (implicit): list reads toolConfig.Task (not .TaskList)", () => {
	function mkCtxWithCompleted(n: number) {
		const arr: TaskInfo[] = [];
		for (let i = 0; i < n; i++) {
			arr.push(task({
				id: `c${i}`,
				status: "completed",
				result: `done-${i}`,
				completedAt: Date.now() + i,
			}));
		}
		return ctxWith({}, { listTasks: () => arr });
	}

	test("toolConfig.Task.max_completed=2 → only 2 completed shown", async () => {
		const ctx = mkCtxWithCompleted(5);
		ctx.toolConfig = { Task: { max_completed: 2 } };
		const out = await text({ action: "list" }, ctx);
		// Header reflects the cap.
		expect(out).toMatch(/Completed \(showing 2 of 5\):/);
		expect(out).toMatch(/... and 3 older tasks/);
	});

	test("toolConfig.TaskList.max_completed=2 is NOT read → default 5 used", async () => {
		// Old key must be ignored: with 3 completed and only the OLD key set,
		// default (5) wins → all 3 shown (not capped at 2).
		const ctx = mkCtxWithCompleted(3);
		ctx.toolConfig = { TaskList: { max_completed: 2 } };
		const out = await text({ action: "list" }, ctx);
		expect(out).toMatch(/Completed \(showing 3\):/);
		expect(out).not.toMatch(/older tasks/);
	});

	test("no toolConfig → default 5 used", async () => {
		const ctx = mkCtxWithCompleted(7);
		// no toolConfig at all
		const out = await text({ action: "list" }, ctx);
		expect(out).toMatch(/Completed \(showing 5 of 7\):/);
		expect(out).toMatch(/... and 2 older tasks/);
	});
});

// ===========================================================================
// Edge-case probes (beyond the written criteria)
// ===========================================================================

describe("edge cases: G1 top-level guard (no delegateFns)", () => {
	test("no delegateFns at all → benign preview text, ok:true", async () => {
		const ctx: any = { caller: "ui", workingDir: "." };
		const r = await raw({ action: "list" }, ctx);
		expect(r.ok).toBe(true);
		expect((r as any).data.text).toMatch(/preview|no tasks/i);
	});

	test("get with no delegateFns → benign preview (not a crash)", async () => {
		const ctx: any = { caller: "ui", workingDir: "." };
		const r = await raw({ action: "get", task_id: "x" }, ctx);
		expect(r.ok).toBe(true);
	});
});

describe("edge cases: per-action delegateFn-missing handling", () => {
	test("kill / interrupted but no abandonTask → ok:false 'not available'", async () => {
		const ctx = ctxWith({ t1: task({ status: "interrupted" }) }); // no abandonTask
		const r = await raw({ action: "kill", task_id: "t1" }, ctx);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/not available/i);
	});

	test("kill / running but no stopTask → ok:false 'not available'", async () => {
		const ctx = ctxWith({ t1: task({ status: "running" }) }); // no stopTask
		const r = await raw({ action: "kill", task_id: "t1" }, ctx);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/not available/i);
	});

	test("resume / interrupted but no resumeTaskBackground → ok:false 'not available'", async () => {
		const ctx = ctxWith({ t1: task({ status: "interrupted" }) });
		const r = await raw({ action: "resume", task_id: "t1" }, ctx);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/not available/i);
	});

	test("resume / resumeTaskBackground throws → ok:false with err.message", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "interrupted" }) },
			{ resumeTaskBackground: () => { throw new Error("boom"); } },
		);
		const r = await raw({ action: "resume", task_id: "t1" }, ctx);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/boom/);
	});

	test("finish / agent but no requestTaskFinish → ok:false 'not available'", async () => {
		const ctx = ctxWith({ t1: task({ status: "running" }) });
		const r = await raw({ action: "finish", task_id: "t1" }, ctx);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/not available/i);
	});

	test("finish / requestTaskFinish returns false → 'not found or not running'", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "running" }) },
			{ requestTaskFinish: () => false },
		);
		const r = await text({ action: "finish", task_id: "t1" }, ctx);
		expect(r).toMatch(/not found or not running/i);
	});
});

describe("edge cases: get / acknowledge=false warning", () => {
	test("acknowledgeTask returns false → acknowledge_warning surfaced", async () => {
		const ctx = ctxWith(
			{ t1: task({ status: "completed", result: "x", completedAt: Date.now() }) },
			{ acknowledgeTask: () => false },
		);
		const parsed = JSON.parse(await text({ action: "get", task_id: "t1" }, ctx));
		expect(parsed.acknowledged).toBe(false);
		expect(parsed.acknowledge_warning).toBeTruthy();
	});

	test("no acknowledgeTask delegateFn → defaults to false (warning)", async () => {
		const ctx = ctxWith({ t1: task({ status: "completed", result: "x", completedAt: Date.now() }) });
		const parsed = JSON.parse(await text({ action: "get", task_id: "t1" }, ctx));
		expect(parsed.acknowledged).toBe(false);
		expect(parsed.acknowledge_warning).toBeTruthy();
	});
});

describe("edge cases: unknown action", () => {
	test("action:'bogus' bypasses schema → execute default branch (ok:false)", async () => {
		// Schema rejects this; but if execute is called directly (mock path),
		// it must NOT silently succeed.
		const r = await raw({ action: "bogus" }, ctxWith({}));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/Unknown Task action/);
	});
});

describe("edge cases: format() fn", () => {
	test("format on ok result → returns data.text", () => {
		const out = fmt({ ok: true, data: { text: "hello" } });
		expect(out).toBe("hello");
	});
	test("format on ok result without data.text → falls back to error / default", () => {
		expect(fmt({ ok: true, data: {} })).toBe("Task action failed.");
		expect(fmt({ ok: false, error: "ERR" })).toBe("ERR");
	});
});
