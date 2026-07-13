// sub-10 (端到端集成测): full parent↔background-task delegation lifecycle.
//
// # 文件说明书
//
// ## 核心功能
// 串成完整链路(acceptance-10 case 1-4,补完 sub-6 单测覆盖的"环节契约"
// 之间的端到端缝隙):
//
//   1. 父 TaskStart 后台 agent task → registry 有 running task。
//   2. 父 turn 想结束 → TurnEndCheck(force-Wait hook)检测 hasRunning
//      → nudge 注入 + 跑一步(不结束)。
//   3. 父调 Wait → 挂起。
//   4. 后台 task 完成 → tryWake → 父 Wait 唤醒(reason: "task finished")。
//   5. workbench Task 数据源更新(task 终态)。
//   6. 父 TaskGet(task_id) → 取 result + acknowledge → task 出 registry。
//   7. hasRunning()=false → 下次 TurnEndCheck 放行 → turn 正常结束。
//
// ## 驱动方式
// "状态机链路"驱动(确定性 mock,不靠真实 LLM stream,不靠真实 setTimeout race):
//   - 真实 TaskRegistry(内存,无 DB,无 Electron)。
//   - 真实 force-wait-hooks(注册 TurnStart/TurnEnd/TurnEndCheck)。
//   - 真实工具 execute(TaskStart / Wait / TaskGet)经由一个轻量 fake ctx,
//     ctx 里把 registry 的方法直接当 ctx.* 接进去(getTaskResult /
//     acknowledgeTask / suspendUntilWake / delegateTaskBackground /
//     beginWait / endWait)—— 测的就是这些工具 + registry + hook 串起来
//     的真实状态机行为,而不是某个 mock 替身。
//
// ## 为什么不启真 LLM stream
// acceptance-10 §"测试粒度(PASS 判据)"明确:"覆盖状态机链路全转换即 PASS,
// 不强求真 LLM stream"。本测用确定性 mock provider 模拟"父 turn 想结束"
// 这一动作(直接 trigger TurnEndCheck),覆盖到 force-Wait 决策 + nudge 注入
// + Wait 挂起/唤醒 + TaskGet 消费的状态机转换,而不是模型的自然语言输出。
//
// ## 确定性(acceptance case 4)
// - 时钟:Wait 用绝对 until 在近未来 + 同步 complete() 触发 tryWake
//   (suspendUntilWake 的 resolver 被 any-task-finish 直接调用,不靠真实
//   setTimeout 计时;timer 即便先到也只是把 reason 变成 timeout,仍确定)。
//   另有纯 task-finish wake case 完全不依赖 timer。
// - nudge 防死循环:TurnEndCheck 同 turn 第二次不 nudge,直接断言(同 sub-6
//   单测的契约,本测在完整链路里再走一遍)。
//
// ## 验收对应
// docs/plan/subagent-recovery/acceptance-10.md case 1-4。
//
// ## 注意点(留给验证 agent)
// - workbench 渲染段(renderWorkbench)目前尚未注入 task/wait 状态(那属后续
//   subs);本测的"workbench Task 段更新"断言打在 workbench 的**数据源**
//   registry.list() 上 —— registry 是 workbench Task 段最终消费的对象,
//   终态在 registry 里可见 = workbench 拉取时能看见。
// - AgentLoop 的 TurnEndCheck checkpoint / forceContinue 消费(agent-loop.ts
//   1146-1162)的源码契约由 sub-6 case 6 已覆盖;本测把同一 checkpoint 在
//   完整链路里再触发一次,确认链路里它的输入(taskRegistry)和输出
//   (forceContinue + message)正确衔接。

import { describe, test, expect, beforeEach, vi } from "vitest";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { TaskRegistry } from "../../src/runtime/task-registry.js";
import {
	registerForceWaitHooks,
	_resetForceWaitNudgeState,
} from "../../src/runtime/hooks/force-wait-hooks.js";
import { taskTool } from "../../src/tools/task-tool.js";
import { waitTool } from "../../src/tools/wait.js";
import type { TaskInfo } from "../../src/runtime/types.js";

// Stub provider-factory BEFORE any import that pulls agent-loop transitively
// (task-start → tool-factory → ... avoids static model resolution at import).
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: () => ({}),
	getContextWindow: () => 128000,
	getMultimodal: () => false,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

/** A minimal tool execution context that wires the REAL TaskRegistry methods
 * onto the ctx surface the tools use (TaskStart/Wait/TaskGet). begin/endWait
 * are tracked as no-op flags so we can assert suspend/resume coordination
 * without standing up an AgentLoop. */
interface HarnessCtx {
	registry: TaskRegistry;
	beginWaitCalls: number;
	endWaitCalls: number;
	lastWakeReason?: string;
}

function makeCtx(registry: TaskRegistry): HarnessCtx {
	const h: HarnessCtx = {
		registry,
		beginWaitCalls: 0,
		endWaitCalls: 0,
	};
	// Wrap into the ToolExecutionContext shape the tools read.
	// Only the fields used by TaskStart/Wait/TaskGet are populated.
	(h as any).toToolCtx = () => ({
		workingDir: ".",
		agentId: "parent-agent",
		sessionId: "parent-session",
		emit: () => {},
		// TaskStart (type:"agent"): mint a taskId + register in registry. We
		// don't actually spawn a sub-loop (no LLM in unit test); we directly
		// create the registry entry, which is the state-machine effect.
		delegateTaskBackground: (task: string, _options?: any) => {
			const taskId = `parent-agent:sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			registry.create(taskId, "subagent", task);
			return taskId;
		},
		// TaskStart (type:"shell"): same — register a bash task, no real spawn.
		runBackground: (command: string, _timeoutSec?: number) => {
			const taskId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			registry.create(taskId, "bash", command);
			return taskId;
		},
		getTaskResult: (taskId: string) => registry.get(taskId) ?? null,
		acknowledgeTask: (taskId: string) => registry.acknowledge(taskId),
		// Wait: real suspendUntilWake so the task-finish wake path is real.
		suspendUntilWake: (opts: any) => registry.suspendUntilWake(opts),
		beginWait: () => { h.beginWaitCalls++; },
		endWait: (reason: any) => { h.endWaitCalls++; h.lastWakeReason = reason; },
		setWaitStartedAt: () => {},
		currentToolCallId: "tc-wait-1",
	});
	return h;
}

/** Invoke a built tool's execute via the factory's wrapped entry, passing the
 * fake ctx as experimental_context (matches how buildTool dispatches). */
async function runTool(tool: any, input: any, toolCtx: any): Promise<string> {
	// buildTool wraps execute into an object whose .execute(input, opts) reads
	// opts.experimental_context. Call that shape directly.
	return tool.execute(input, { experimental_context: toolCtx });
}

/** Microtask pump: drain the queue up to `max` times, stopping early once
 * `pred()` is true. The buildTool wrapper awaits PreToolUse/PostToolUse hooks
 * (each a microtask round-trip even with no handlers) before/after the inner
 * execute, so a single `await Promise.resolve()` is NOT enough to observe
 * side effects like beginWait/endWait. This pump deterministically advances
 * the wrapper's async chain without resorting to real setTimeout. */
async function pump(pred: () => boolean, max = 50): Promise<void> {
	for (let i = 0; i < max; i++) {
		if (pred()) return;
		await Promise.resolve();
	}
}

/** Fire TurnEndCheck the way AgentLoop does (agent-loop.ts:1146). */
async function fireEndCheck(
	reg: HookRegistry,
	registry: TaskRegistry,
	sessionId = "parent-session",
): Promise<{ forceContinue?: boolean; message?: string }> {
	return reg.trigger("TurnEndCheck", {
		agentId: "parent-agent",
		sessionId,
		resultText: "",
		taskRegistry: registry,
	});
}

async function fireStart(reg: HookRegistry, sessionId = "parent-session") {
	return reg.trigger("TurnStart", { agentId: "parent-agent", sessionId, userMessage: "go" });
}

/**
 * Seed a running task directly in the registry and return its id.
 *
 * Sub-1 / sub-2 replaced the pre-sub-4 entry points:
 *   - `TaskStart{type:'agent'}` → Subagent `delegate` action (sub-1)
 *   - `TaskStart{type:'shell'}` → Shell `background:true`      (sub-2)
 * Both new entry paths ultimately call `registry.create(...)` (via the loop's
 * delegateFns.delegateTaskBackground / runBackground). This e2e file focuses
 * on the force-wait + Wait + wake lifecycle that FOLLOWS task creation, so we
 * skip the (now tool-specific) entry dispatch and seed the registry directly —
 * same end state, no dependency on any background-entry tool. The new entry
 * paths themselves are covered by sub1-subagent-background.test.ts and
 * sub2-shell-background.test.ts.
 */
function seedRunningTask(
	registry: TaskRegistry,
	type: "subagent" | "bash",
	label: string,
): string {
	const taskId = `${type === "subagent" ? "parent-agent:sub" : "shell"}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	registry.create(taskId, type, label);
	return taskId;
}

// ─── Case 1: full lifecycle — every state-machine transition ──────────────

describe("sub-10 case 1: full delegation lifecycle (state machine end-to-end)", () => {
	let reg: HookRegistry;
	let registry: TaskRegistry;
	let h: HarnessCtx;
	let toolCtx: any;

	beforeEach(() => {
		reg = new HookRegistry();
		registry = new TaskRegistry();
		_resetForceWaitNudgeState();
		registerForceWaitHooks(reg);
		h = makeCtx(registry);
		toolCtx = (h as any).toToolCtx();
	});

	test("TaskStart → nudge → Wait → task done → wake → TaskGet consume → TurnEndCheck放行", async () => {
		// (1) Seed a running background agent task in the registry.
		// (Pre-sub-4 this was `TaskStart{type:'agent'}`; sub-1 replaced that entry
		// with Subagent `delegate`. This e2e case focuses on the lifecycle AFTER
		// task creation, so we seed the registry directly — see seedRunningTask.)
		const taskId = seedRunningTask(registry, "subagent", "research the bug");

		// registry 有 running task.
		expect(registry.hasRunning(), "after seed: hasRunning=true").toBe(true);
		const created = registry.get(taskId);
		expect(created, "task present in registry").toBeDefined();
		expect(created!.status).toBe("running");
		expect(created!.type).toBe("subagent");

		// (2) 父 turn 想结束 → TurnEndCheck 检测 hasRunning → nudge + 跑一步(不结束).
		//     AgentLoop 的行为 = "收到 forceContinue → 注入 message,继续 while 循环".
		//     本测直接断言 hook 返回的 forceContinue/message 契约(就是 AgentLoop
		//     在 1152 行消费的东西),证明这一步会让 turn 不结束.
		const endCheck1 = await fireEndCheck(reg, registry);
		expect(endCheck1.forceContinue, "forceContinue=true (turn does not end)").toBe(true);
		expect(typeof endCheck1.message).toBe("string");
		expect((endCheck1.message as string).toLowerCase()).toContain("wait");
		expect((endCheck1.message as string).length).toBeGreaterThan(0);

		// 模拟"nudge 后跑了一步,模型决定调 Wait". 父调 Wait → 挂起(busy→waiting).
		// 用绝对 until 在近未来 + 有 running task —— 等我们 complete() 后立即唤醒.
		const until = new Date(Date.now() + 5000).toISOString();
		// 不 await:Wait 会挂起直到 task-finish 唤醒. 我们先把它发出去,再触发
		// task 完成,然后 await —— 这是 suspendUntilWake 设计的 any-task-finish
		// wake 路径,完全确定(不靠真实 setTimeout 计时).
		const waitPromise = runTool(waitTool, { until }, toolCtx);
		// 让 buildTool wrapper 跑完 PreToolUse + 进入 options.execute(beginWait
		// + suspendUntilWake 的 resolver 同步注册). 多 microtask pump —— wrapper
		// 有若干 await,单 `await Promise.resolve()` 不够.
		await pump(() => h.beginWaitCalls > 0);

		// Wait 工具一进 suspend 就 beginWait.
		expect(h.beginWaitCalls, "Wait entered suspend → beginWait fired").toBe(1);

		// (3) 后台 task 完成 → tryWake.
		registry.complete(taskId, "the bug is in module X");
		expect(registry.hasRunning(), "after complete: hasRunning=false").toBe(false);

		// (4) 父 Wait 唤醒(reason: task finished).
		const waitOut = await waitPromise;
		expect(waitOut).toContain("woke: task finished");
		expect(h.endWaitCalls, "Wait resumed → endWait fired").toBe(1);
		expect(h.lastWakeReason, "endWait carried the wake reason").toBe("task finished");

		// (5) workbench Task 段数据源更新(task 终态可见).
		//     renderWorkbench 当前尚未注入 task 段(future subs);断言数据源 ——
		//     registry.list() 是 workbench Task 段最终消费的对象.
		const allTasks = registry.list();
		const finished = allTasks.find((t) => t.id === taskId);
		expect(finished, "completed task still in registry (inbox: consumed via TaskGet)").toBeDefined();
		expect(finished!.status, "terminal status visible to workbench data source").toBe("completed");
		expect(finished!.result).toBe("the bug is in module X");

		// (6) 父 TaskGet(task_id) → 取 result + acknowledge → task 出 registry.
		const getOut = await runTool(taskTool, { action: "get", task_id: taskId }, toolCtx);
		const parsed = JSON.parse(getOut);
		expect(parsed.status).toBe("completed");
		expect(parsed.result).toBe("the bug is in module X");
		expect(parsed.acknowledged, "TaskGet(completed) acknowledges (drops from registry)").toBe(true);
		expect(registry.get(taskId), "after acknowledge: task out of registry").toBeUndefined();

		// (7) hasRunning()=false → 下次 TurnEndCheck 放行 → turn 正常结束.
		expect(registry.hasRunning(), "no running task left").toBe(false);
		const endCheck2 = await fireEndCheck(reg, registry);
		expect(endCheck2.forceContinue, "no running task → no nudge → turn ends").toBeUndefined();
		expect(endCheck2.message).toBeUndefined();
	});

	test("shell-task variant: same lifecycle through type:'shell'", async () => {
		// Smoke: same chain with a shell task (sub-2's runBackground entry path).
		const taskId = seedRunningTask(registry, "bash", "echo hi");
		expect(registry.get(taskId)!.type).toBe("bash");
		expect(registry.hasRunning()).toBe(true);

		const endCheck = await fireEndCheck(reg, registry);
		expect(endCheck.forceContinue).toBe(true);

		registry.complete(taskId, "done");
		const getOut = await runTool(taskTool, { action: "get", task_id: taskId }, toolCtx);
		expect(JSON.parse(getOut).status).toBe("completed");
		expect(registry.get(taskId)).toBeUndefined();

		expect(registry.hasRunning()).toBe(false);
		expect((await fireEndCheck(reg, registry)).forceContinue).toBeUndefined();
	});
});

// ─── Case 2: regression guard — no running task → no nudge ────────────────

describe("sub-10 case 2: no running task → TurnEndCheck放行 (regression guard)", () => {
	let reg: HookRegistry;
	let registry: TaskRegistry;

	beforeEach(() => {
		reg = new HookRegistry();
		registry = new TaskRegistry();
		_resetForceWaitNudgeState();
		registerForceWaitHooks(reg);
	});

	test("empty registry → turn ends directly", async () => {
		expect(registry.hasRunning()).toBe(false);
		const endCheck = await fireEndCheck(reg, registry);
		expect(endCheck.forceContinue).toBeUndefined();
		expect(endCheck.message).toBeUndefined();
	});

	test("only completed (terminal) tasks → no nudge (turn ends)", async () => {
		// A completed-but-not-yet-acknowledged task is terminal, NOT running.
		registry.create("t-done", "subagent", "x");
		registry.complete("t-done", "result");
		expect(registry.hasRunning()).toBe(false);
		const endCheck = await fireEndCheck(reg, registry);
		expect(endCheck.forceContinue).toBeUndefined();
	});
});

// ─── Case 3: anti-loop — nudge once per turn ──────────────────────────────

describe("sub-10 case 3: nudge anti-loop (same-turn marker; agent ignores nudge and ends)", () => {
	let reg: HookRegistry;
	let registry: TaskRegistry;
	let toolCtx: any;

	beforeEach(() => {
		reg = new HookRegistry();
		registry = new TaskRegistry();
		_resetForceWaitNudgeState();
		registerForceWaitHooks(reg);
		toolCtx = (makeCtx(registry) as any).toToolCtx();
	});

	test("second TurnEndCheck in the SAME turn does not nudge again", async () => {
		// Seed a running background task.
		seedRunningTask(registry, "subagent", "work");
		expect(registry.hasRunning()).toBe(true);

		// 第一次 TurnEndCheck → nudge.
		const first = await fireEndCheck(reg, registry);
		expect(first.forceContinue).toBe(true);

		// 模型收 nudge 后不 Wait 直接再结束 → 同 turn 第二次 TurnEndCheck.
		// hook 必须不再 nudge(标记生效),turn 结束 —— 不无限续步.
		const second = await fireEndCheck(reg, registry);
		expect(second.forceContinue, "same-turn marker: no second nudge").toBeUndefined();
		expect(second.message).toBeUndefined();

		// task 仍在 registry(Wait 是 backstop;这一 turn 放过 = 等 Wait 超时兜底).
		expect(registry.hasRunning(), "task still running (Wait timeout is the backstop)").toBe(true);
	});

	test("TurnStart clears marker → next turn CAN nudge again", async () => {
		seedRunningTask(registry, "subagent", "work");
		await fireEndCheck(reg, registry); // nudge #1
		await fireEndCheck(reg, registry); // dedup'd

		// 新 turn:TurnStart 清标记.
		await fireStart(reg);
		const again = await fireEndCheck(reg, registry);
		expect(again.forceContinue, "new turn → nudge allowed again").toBe(true);
	});
});

// ─── Case 4: determinism — no real setTimeout race ────────────────────────

describe("sub-10 case 4: determinism (no real setTimeout race)", () => {
	let reg: HookRegistry;
	let registry: TaskRegistry;
	let toolCtx: any;

	beforeEach(() => {
		reg = new HookRegistry();
		registry = new TaskRegistry();
		_resetForceWaitNudgeState();
		registerForceWaitHooks(reg);
		toolCtx = (makeCtx(registry) as any).toToolCtx();
	});

	test("task-finish wake does not depend on the timer firing (any-task-finish path is direct)", async () => {
		// Far-future until: the timer would NOT fire during this test. The wake
		// comes ONLY from registry.complete() → tryWake. If that path were
		// timer-dependent, this test would hang (or fail on the 5s timer). It
		// resolves immediately on complete() — deterministic.
		const taskId = seedRunningTask(registry, "subagent", "work");

		// Track beginWait via this local ctx's harness. The default case-4
		// toolCtx already wires beginWait; but we need a handle to pump on it.
		// Re-make the ctx with an observable counter so we can pump until the
		// Wait actually entered suspend.
		let began = false;
		const observedCtx = (makeCtx(registry) as any).toToolCtx();
		(observedCtx as any).beginWait = () => { began = true; };
		// Carry over the registry handle the test uses.
		(observedCtx as any).delegateTaskBackground = toolCtx.delegateTaskBackground;

		const farFuture = new Date(Date.now() + 60_000).toISOString();
		const waitPromise = runTool(waitTool, { until: farFuture }, observedCtx);
		await pump(() => began); // resolver registered synchronously after beginWait

		registry.complete(taskId, "done");
		const out = await waitPromise;
		expect(out).toContain("woke: task finished");
		// Confirm the wake beat the 60s timer (i.e. task-finish, not timeout).
		expect(out).not.toContain("woke: timeout");
	});

	test("timeout-only wake (no task) is also bounded and deterministic", async () => {
		// No running task, very short until → immediate-ish timeout wake. This
		// is the OTHER wake source; we assert it resolves fast (< 2s wall) and
		// with the right reason, so neither wake path is flaky.
		const near = new Date(Date.now() + 30).toISOString();
		const start = Date.now();
		const out = await runTool(waitTool, { until: near }, toolCtx);
		const elapsed = Date.now() - start;
		expect(out).toContain("woke: timeout");
		expect(elapsed, "timer wake resolves within budget (no flaky long wait)").toBeLessThan(2000);
	});
});

// ─── Bonus: failure wake + the workbench-inbox contract (terminal stays until consumed) ─

describe("sub-10 supporting — fail/kill wake + inbox (terminal stays until TaskGet)", () => {
	let registry: TaskRegistry;
	let toolCtx: any;

	beforeEach(() => {
		registry = new TaskRegistry();
		toolCtx = (makeCtx(registry) as any).toToolCtx();
	});

	test("task fail() wakes Wait with 'task finished'", async () => {
		const taskId = seedRunningTask(registry, "subagent", "x");
		let began = false;
		const observedCtx = (makeCtx(registry) as any).toToolCtx();
		(observedCtx as any).beginWait = () => { began = true; };
		(observedCtx as any).delegateTaskBackground = toolCtx.delegateTaskBackground;
		const until = new Date(Date.now() + 60_000).toISOString();
		const p = runTool(waitTool, { until }, observedCtx);
		await pump(() => began);
		registry.fail(taskId, "boom");
		const out = await p;
		expect(out).toContain("woke: task finished");
	});

	test("terminal task stays in registry (inbox) until TaskGet acknowledges it", async () => {
		// 收件箱契约: 终态留到 TaskGet 消费才删 —— workbench Task 段在消费前
		// 一直显示该 task.
		const taskId = seedRunningTask(registry, "subagent", "x");
		registry.complete(taskId, "result");

		// 终态后仍在 registry(workbench 能看见).
		expect(registry.get(taskId)?.status).toBe("completed");
		expect(registry.list().some((t) => t.id === taskId)).toBe(true);

		// TaskGet(completed) 消费 → acknowledge → 出 registry.
		await runTool(taskTool, { action: "get", task_id: taskId }, toolCtx);
		expect(registry.get(taskId), "consumed → out of registry").toBeUndefined();
		expect(registry.list().some((t) => t.id === taskId)).toBe(false);
	});
});
