// sub-1 (execution-entry-redesign) acceptance tests.
//
// Independent verifier-authored tests encoding acceptance-1.md items 1–10.
// Each describe block maps 1:1 to an acceptance item so PASS/FAIL is auditable
// from the test name. Mirrors the style of sub4-task-tools.test.ts.
//
// # Accepted spec
// docs/plan/execution-entry-redesign/acceptance-1.md (authoritative)
//
// # Scope
//   - Subagent tool `delegate` action: now non-blocking, returns task_id
//     immediately via delegateTaskBackground.
//   - delegateTask (delegator) stays blocking — Orchestrate's task nodes
//     still await it.
//   - configSchema: auto_background / auto_background_timeout removed.

import { describe, test, expect } from "vitest";
import { delegateTool } from "../../src/tools/agent.js";
import { getToolExecute as getExec, getToolFormat as getFmt, getToolConfigSchema } from "../../src/tools/tool-factory.js";
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";

const exec = getExec(delegateTool)!;
const fmt = getFmt(delegateTool)!;
const schema = getToolConfigSchema(delegateTool);

/** Format the LLM-facing string (pre-sub-4 behavior). */
const run = (i: any, c: any) => exec(i, c).then(fmt);
/** Raw ToolResult JSON. */
const raw = (i: any, c: any) => exec(i, c);

/** Build a CallerCtx-shape ctx for the Subagent tool. */
function makeCtx(opts: {
	callerId?: string;
	callerSubagents?: Array<{ agentId: string; name?: string; description?: string }>;
	agents?: Record<string, any>;
	delegateTask?: (task: string, o: any) => Promise<string>;
	delegateTaskBackground?: (task: string, o: any) => string;
	toolCallId?: string;
} = {}) {
	const callerId = opts.callerId ?? "caller-1";
	const agents = opts.agents ?? {};
	agents[callerId] = agents[callerId] ?? {
		id: callerId,
		name: "Caller",
		subagents: opts.callerSubagents ?? [],
	};
	return {
		caller: "internal" as const,
		agentId: callerId,
		workingDir: ".",
		toolCallId: opts.toolCallId,
		agentResolvers: {
			resolveAgent: (id: string) => (agents[id] ? { ...agents[id] } : undefined),
		},
		delegateFns: {
			delegateTask: opts.delegateTask,
			delegateTaskBackground: opts.delegateTaskBackground,
			setToolCallTaskId: opts.toolCallId ? (_tcid: string, _tid: string) => {} : undefined,
		},
	} as any;
}

// ===========================================================================
// Acceptance 1 — delegate 立即返 task_id (不阻塞)
// ===========================================================================

describe("acceptance-1 / item 1: Subagent delegate returns task_id immediately", () => {
	test("delegate → ok:true with text containing `task_id: <id>`", async () => {
		const ctx = makeCtx({
			delegateTaskBackground: () => "sub-fixed-1",
		});
		const r = await raw({ action: "delegate", task: "do thing" }, ctx);
		expect(r.ok).toBe(true);
		expect((r as any).data.taskId).toBe("sub-fixed-1");
		expect((r as any).data.text).toMatch(/task_id: sub-fixed-1/);
	});

	test("formatted text contains `Background sub-agent started.` + task_id", async () => {
		const ctx = makeCtx({
			delegateTaskBackground: () => "sub-fixed-2",
		});
		const text = await run({ action: "delegate", task: "explore" }, ctx);
		expect(text).toMatch(/Background sub-agent started\./);
		expect(text).toMatch(/task_id: sub-fixed-2/);
		expect(text).toMatch(/TaskGet/);
	});
});

// ===========================================================================
// Acceptance 2 — 不阻塞 (delegateTaskBackground 同步返, 不 await 子代理)
// ===========================================================================

describe("acceptance-1 / item 2: delegate is non-blocking", () => {
	test("execute returns BEFORE the deferred sub-agent work fires", async () => {
		// delegateTaskBackground returns task_id immediately AND schedules work
		// via setImmediate (the real delegator's pattern). If execute were to
		// await that work, our flag would be true by the time execute returns.
		let deferredWorkFired = false;
		const ctx = makeCtx({
			delegateTaskBackground: () => {
				setImmediate(() => { deferredWorkFired = true; });
				return "sub-bg-1";
			},
		});
		const r = await raw({ action: "delegate", task: "x" }, ctx);
		// Returned ok with task_id ...
		expect((r as any).data.taskId).toBe("sub-bg-1");
		// ... but the deferred sub-agent work has NOT fired yet (we did not await it).
		expect(deferredWorkFired).toBe(false);
		// Yield once: NOW the deferred work fires (proves the test was meaningful).
		await new Promise((r) => setImmediate(r));
		expect(deferredWorkFired).toBe(true);
	});

	test("execute does NOT call delegateTask (the blocking primitive) — only delegateTaskBackground", async () => {
		let blockingCalled = false;
		const ctx = makeCtx({
			delegateTask: async () => { blockingCalled = true; return "blocking-result"; },
			delegateTaskBackground: () => "sub-bg-2",
		});
		const r = await raw({ action: "delegate", task: "x" }, ctx);
		expect(blockingCalled).toBe(false);
		expect((r as any).data.taskId).toBe("sub-bg-2");
	});
});

// ===========================================================================
// Acceptance 3 — task 进 registry, 可 TaskGet 取
// ===========================================================================

describe("acceptance-1 / item 3: dispatched task lands in registry (TaskGet-readable)", () => {
	// Build a real SubagentDelegator with a fake loop factory (immediate-resolve
	// loop), dispatch via delegateTaskBackground, then read via getTaskResult
	// (the exact accessor TaskGet's getTaskResult delegateFn uses). End-to-end
	// through the same path the Subagent tool wires.

	function makeDelegator() {
		// Fake loop: resolves run() immediately on the next tick.
		const fakeLoop: any = {
			run: async () => {},
			resume: async () => {},
			abort: () => {},
			getResult: () => "DONE",
		};
		const config: any = {
			agentId: "caller",
			sessionId: "parent-session",
			workspaceDir: ".",
			systemPrompt: "",
			modelId: "m",
			toolPolicy: {},
			db: {
				createSession: () => ({ id: "child-session" }),
				createDelegatedTask: () => {},
				updateDelegatedTask: () => {},
				getDelegatedTask: () => undefined,
			},
			contextBundle: undefined,
		};
		return new SubagentDelegator({
			config,
			providers: [],
			emit: () => {},
			createSubLoop: () => fakeLoop,
			getToolConfig: () => ({}),
		});
	}

	test("right after dispatch, registry has the task as 'running'", () => {
		const d = makeDelegator();
		const taskId = d.delegateTaskBackground("do thing");
		const info = d.getTaskResult(taskId);
		expect(info).not.toBeNull();
		expect(info?.id).toBe(taskId);
		expect(info?.status).toBe("running");
		expect(info?.type).toBe("subagent");
	});

	test("after the deferred run completes, registry shows the result", async () => {
		const d = makeDelegator();
		const taskId = d.delegateTaskBackground("do thing");
		// Let the setImmediate-deferred run fire.
		await new Promise((r) => setImmediate(r));
		await Promise.resolve();
		const info = d.getTaskResult(taskId);
		expect(info?.status).toBe("completed");
		expect(info?.result).toBe("DONE");
	});

	test("TaskGet via delegateFns.getTaskResult surfaces not-found as null", () => {
		const d = makeDelegator();
		expect(d.getTaskResult("ghost-id")).toBeNull();
	});
});

// ===========================================================================
// Acceptance 4 — named subagent 仍工作 (LIVE 解目标身份)
// ===========================================================================

describe("acceptance-1 / item 4: named subagent resolves to target identity", () => {
	test("delegate {subagent:'Developer'} → delegateTaskBackground receives targetAgentId + systemPrompt + model + toolPolicy", async () => {
		let captured: any;
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "dev-1", name: "Developer" }],
			agents: {
				"dev-1": {
					id: "dev-1",
					name: "Developer",
					model: "glm-5.2",
					systemPrompt: "DEV-PROMPT",
					toolPolicy: { tools: { Read: true } },
				},
			},
			delegateTaskBackground: (_t: string, o: any) => {
				captured = { task: _t, o };
				return "sub-named-1";
			},
		});
		const r = await raw({ action: "delegate", task: "write code", subagent: "Developer" }, ctx);
		expect((r as any).data.taskId).toBe("sub-named-1");
		expect(captured.o.targetAgentId).toBe("dev-1");
		expect(captured.o.systemPrompt).toBe("DEV-PROMPT");
		expect(captured.o.model).toBe("glm-5.2");
		expect(captured.o.toolPolicy).toEqual({ tools: { Read: true } });
	});

	test("entry.name override wins over target.name", async () => {
		let matched: any;
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "dev-1", name: "Coder" }],
			agents: { "dev-1": { id: "dev-1", name: "Developer" } },
			delegateTaskBackground: (_t, o) => { matched = o; return "x"; },
		});
		// "Coder" matches via entry.name; "Developer" (target.name) does NOT match.
		await raw({ action: "delegate", task: "t", subagent: "Coder" }, ctx);
		expect(matched.targetAgentId).toBe("dev-1");
		const miss = await raw({ action: "delegate", task: "t", subagent: "Developer" }, ctx);
		expect((miss as any).ok).toBe(false);
		expect((miss as any).error).toMatch(/no subagent named "Developer"/);
	});

	test("named subagent not in caller's list → ok:false with available list", async () => {
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "dev-1", name: "Developer" }],
			agents: { "dev-1": { id: "dev-1", name: "Developer" } },
			delegateTaskBackground: () => "should-not-be-called",
		});
		const r = await raw({ action: "delegate", task: "t", subagent: "Nope" }, ctx);
		expect((r as any).ok).toBe(false);
		expect((r as any).error).toMatch(/no subagent named "Nope"/);
		expect((r as any).error).toMatch(/Available.*Developer/);
	});

	test("stale target (entry exists, agentId resolves to nothing) → ok:false", async () => {
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "gone-1", name: "Ghost" }],
			agents: {}, // target missing
			delegateTaskBackground: () => "should-not-be-called",
		});
		const r = await raw({ action: "delegate", task: "t", subagent: "Ghost" }, ctx);
		expect((r as any).ok).toBe(false);
		expect((r as any).error).toMatch(/no longer exists|stale/i);
	});

	test("ephemeral delegate (no subagent) → targetAgentId undefined, inline model/systemPrompt passed", async () => {
		let captured: any;
		const ctx = makeCtx({
			delegateTaskBackground: (_t, o) => { captured = o; return "sub-eph-1"; },
		});
		await raw({ action: "delegate", task: "x", model: "m1", systemPrompt: "custom" }, ctx);
		expect(captured.targetAgentId).toBeUndefined();
		expect(captured.model).toBe("m1");
		expect(captured.systemPrompt).toBe("custom");
	});
});

// ===========================================================================
// Acceptance 5 — list action 不变
// ===========================================================================

describe("acceptance-1 / item 5: list action unchanged", () => {
	test("list with subagents → JSON summary (name/description/model, no systemPrompt)", async () => {
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "dev-1", name: "Developer", description: "代码实现" }],
			agents: {
				"dev-1": { id: "dev-1", name: "Developer", model: "glm-5.2", systemPrompt: "BIG" },
			},
		});
		const text = await run({ action: "list" }, ctx);
		const parsed = JSON.parse(text);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].name).toBe("Developer");
		expect(parsed[0].model).toBe("glm-5.2");
		expect(parsed[0].description).toBe("代码实现");
		expect(parsed[0]).not.toHaveProperty("systemPrompt");
	});

	test("list with no subagents → empty hint message", async () => {
		const text = await run({ action: "list" }, makeCtx());
		expect(text).toMatch(/no registered subagents/i);
	});

	test("list marks stale target (deleted agentId)", async () => {
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "gone-1", name: "Ghost" }],
			agents: {},
		});
		const parsed = JSON.parse(await run({ action: "list" }, ctx));
		expect(parsed[0].name).toBe("Ghost");
		expect(parsed[0].note).toMatch(/not found/i);
	});
});

// ===========================================================================
// Acceptance 6 — configSchema 去掉 auto_background / auto_background_timeout
// ===========================================================================

describe("acceptance-1 / item 6: configSchema has no auto_background(_timeout)", () => {
	test("getToolConfigSchema(delegateTool) returns no auto_background fields", () => {
		// schema may legitimately be undefined (configSchema omitted entirely) —
		// either way, neither key may appear.
		const keys = (schema ?? []).map((f: any) => f.key);
		expect(keys).not.toContain("auto_background");
		expect(keys).not.toContain("auto_background_timeout");
	});

	test("configSchema (if defined) carries no field whose key contains 'auto_background'", () => {
		for (const f of schema ?? []) {
			expect(String((f as any).key)).not.toMatch(/auto_background/);
		}
	});
});

// ===========================================================================
// Acceptance 7 — Orchestrate 仍 blocking (delegateTask 保持 blocking)
// ===========================================================================
//
// Two-pronged verification:
//   (a) Static: the Subagent tool does NOT touch fns.delegateTask (it goes via
//       delegateTaskBackground); orchestrate-tool.ts:262 still `await`s
//       delegateTask. The static side is verified by reading source; we assert
//       the dynamic side here.
//   (b) Dynamic: SubagentDelegator.delegateTask awaits subLoop.run() — the
//       caller does not get a result until the sub-loop finishes. We race it
//       against a deferred and prove the call only resolves after the loop
//       resolves.

describe("acceptance-1 / item 7: delegateTask stays blocking (Orchestrate safe)", () => {
	test("SubagentDelegator.delegateTask awaits subLoop.run — does NOT return before sub-loop finishes", async () => {
		let loopResolve: () => void = () => {};
		let runStarted = false;
		const fakeLoop: any = {
			run: () => new Promise<void>((res) => { runStarted = true; loopResolve = res; }),
			abort: () => {},
			getResult: () => "BLOCKING-RESULT",
		};
		const config: any = {
			agentId: "caller",
			sessionId: "p",
			workspaceDir: ".",
			systemPrompt: "",
			modelId: "m",
			toolPolicy: {},
			db: {
				createSession: () => ({ id: "child" }),
				createDelegatedTask: () => {},
				updateDelegatedTask: () => {},
				getDelegatedTask: () => undefined,
			},
			contextBundle: undefined,
		};
		const d = new SubagentDelegator({
			config, providers: [], emit: () => {},
			createSubLoop: () => fakeLoop,
			getToolConfig: () => ({}),
		});

		let delegateResolved = false;
		const p = d.delegateTask("orchestrate task").then((r) => {
			delegateResolved = true;
			return r;
		});

		// Poll for runStarted (delegateTask has some pre-await setup before it
		// calls subLoop.run; let the microtask queue drain past that).
		for (let i = 0; i < 50 && !runStarted; i++) {
			await new Promise((r) => setImmediate(r));
		}
		expect(runStarted).toBe(true);
		// Sub-loop is mid-flight (we haven't resolved loopResolve) → delegateTask
		// MUST still be pending. This is the blocking invariant.
		expect(delegateResolved).toBe(false);

		// Now finish the sub-loop → delegateTask resolves with its result.
		loopResolve();
		const result = await p;
		expect(delegateResolved).toBe(true);
		expect(result).toBe("BLOCKING-RESULT");
	});

	test("Subagent tool's `delegate` action does NOT call delegateTask (it must use delegateTaskBackground)", async () => {
		// Same assertion as item 2's blocking-call check, restated here under
		// the Orchestrate-safety lens: the blocking primitive is reserved for
		// Orchestrate only.
		let blockingCalls = 0;
		let bgCalls = 0;
		const ctx = makeCtx({
			delegateTask: async () => { blockingCalls++; return "x"; },
			delegateTaskBackground: () => { bgCalls++; return "sub-x"; },
		});
		await raw({ action: "delegate", task: "t" }, ctx);
		expect(blockingCalls).toBe(0);
		expect(bgCalls).toBe(1);
	});
});

// ===========================================================================
// Acceptance 8 — TaskStart{agent} 仍工作 (sub-4 才删;sub-1 不动)
// ===========================================================================
// REMOVED in sub-4: TaskStart{type:agent} was the pre-sub-1 background-agent
// entry. sub-1 replaced it with Subagent `delegate` (already covered by items
// 1–7 above), and sub-4 deleted the TaskStart tool entirely. The cross-check
// described by acceptance-1 item 8 is therefore obsolete; the equivalent
// coverage (delegate → delegateTaskBackground → task_id) lives in items 1–3.

// ===========================================================================
// Acceptance 9 — ToolsPage 不渲染 Subagent config (静态:configSchema 已空)
// ===========================================================================
//
// ToolsPage.tsx renders config fields by iterating selectedTool.configSchema
// (line 319 guard: `selectedTool.configSchema?.length > 0`). With configSchema
// undefined/empty, the entire config tab body is skipped. We assert the
// schema-side invariant here; the UI render is a mechanical consequence.

describe("acceptance-1 / item 9: ToolsPage will not render Subagent config (schema empty)", () => {
	test("configSchema is empty or undefined → ToolsPage render guard skips it", () => {
		// ToolsPage.tsx:319 guard: `selectedTool.configSchema?.length > 0`.
		const renderableLen = (schema ?? []).length;
		expect(renderableLen).toBe(0);
	});
});

// ===========================================================================
// Acceptance 10 — typecheck 过 (verified by `npm run build:lib`)
// ===========================================================================
//
// This acceptance item is exercised outside vitest — see the verifier report
// which captures `npm run build:lib` exit code. The test below is a sentinel:
// if the agent module fails to import (type error would surface at TS build,
// not at runtime), this file fails to load. So a green run is weak evidence
// the module compiles.

describe("acceptance-1 / item 10: typecheck sentinel", () => {
	test("delegateTool + SubagentDelegator are importable (module loads)", () => {
		expect(typeof delegateTool).toBe("object");
		expect(typeof SubagentDelegator).toBe("function");
		expect(typeof exec).toBe("function");
	});
});
