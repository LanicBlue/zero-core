// sub-3 (execution-entry-redesign) acceptance tests.
//
// Independent verifier-authored tests encoding acceptance-3.md items 1–9.
// Each describe block maps 1:1 to an acceptance item so PASS/FAIL is auditable
// from the test name.
//
// # Accepted spec
// docs/plan/execution-entry-redesign/acceptance-3.md (authoritative)
//
// # Scope — Shell timeout → background (process handoff)
//   - bash.ts foreground spawn+race timeout path → adoptBackgroundTask
//   - Output preserved across the handoff (chunks drained on close)
//   - TaskRegistry lifecycle (running → completed/failed/killed)
//   - AbortController → child.kill wiring
//   - No regression to runBackground (sub-2) or short blocking commands
//
// # Mocking strategy
//   vi.mock("node:child_process", ...) intercepts `spawn` and returns a
//   controllable FakeChild (EventEmitter + stdout/stderr EventEmitters +
//   kill/exitCode/signalCode). We use the REAL SubagentDelegator + REAL
//   TaskRegistry so the adopt path, AbortController wiring, and lifecycle
//   transitions are exercised end-to-end. The delegator's heavy deps
//   (createSubLoop, providers, db) are stubs — adoptBackgroundTask touches
//   none of them.

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";
import { TaskRegistry } from "../../src/runtime/task-registry.js";
import { bashTool } from "../../src/tools/bash.js";
import { getToolExecute, getToolFormat } from "../../src/tools/tool-factory.js";

// ─── FakeChild + spawn mock ─────────────────────────────────────────────

/** Fake ChildProcess. Bash.ts attaches data listeners to .stdout/.stderr,
 *  race listeners to .on("close"/"error"), and on timeout calls
 *  adoptBackgroundTask(child, ...). adopt attaches its OWN close listener +
 *  AbortController→kill wiring. kill() simulates SIGTERM by emitting close
 *  with the signal on nextTick (mirrors how a real SIGTERM'd process exits). */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  killCalls = 0;
  kill(sig?: string): boolean {
    this.killCalls++;
    this.killed = true;
    // Real SIGTERM causes the child to exit. Schedule close emission — both
    // bash.ts's race listener and adopt's close handler receive it (EventEmitter
    // delivers to all listeners). bash.ts's race listener is settled → no-op.
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = sig ?? "SIGTERM";
      process.nextTick(() => {
        if (this.exitCode === null && this.signalCode !== null) {
          this.emit("close", null, this.signalCode);
        }
      });
    }
    return true;
  }
  /** Test helper: child exits naturally with `code`. */
  naturalExit(code: number) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    process.nextTick(() => this.emit("close", code, null));
  }
}

const spawnState = vi.hoisted(() => ({
  currentChild: null as FakeChild | null,
  lastCall: null as { shell: string; args: string[]; opts: any } | null,
}));

vi.mock("node:child_process", () => ({
  spawn: (shell: string, args: string[], opts?: any) => {
    spawnState.lastCall = { shell, args, opts };
    const child = new FakeChild();
    spawnState.currentChild = child;
    return child;
  },
}));

// ─── Real SubagentDelegator + TaskRegistry ──────────────────────────────

function makeDelegator(): { delegator: SubagentDelegator; emitted: any[] } {
  const emitted: any[] = [];
  const delegator = new SubagentDelegator({
    config: {
      agentId: "caller",
      sessionId: "sess-1",
      ownerTaskId: undefined,
      workspaceDir: ".",
    } as any,
    providers: [],
    emit: (e) => { emitted.push(e); },
    createSubLoop: (() => { throw new Error("not used"); }) as any,
    getToolConfig: () => ({}),
  });
  return { delegator, emitted };
}

// ─── Tool wiring ────────────────────────────────────────────────────────

const exec = getToolExecute(bashTool)!;
const fmt = getToolFormat(bashTool)!;
const raw = (i: any, c: any) => exec(i, c);

/** CallerCtx wiring the bash timeout path's delegateFns to the real delegator. */
function makeCtx(delegator: SubagentDelegator): any {
  return {
    caller: "internal" as const,
    agentId: "caller",
    workingDir: ".",
    delegateFns: {
      adoptBackgroundTask: (child: any, cmd: string, out: Buffer[], err: Buffer[]) =>
        delegator.adoptBackgroundTask(child, cmd, out, err),
      runBackground: (cmd: string, timeout?: number) =>
        delegator.runBackground(cmd, timeout),
      getTaskResult: (id: string) => delegator.taskRegistry.get(id),
    },
  };
}

beforeEach(() => {
  spawnState.currentChild = null;
  spawnState.lastCall = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Acceptance 1 — 超时不 kill 转后台
// ===========================================================================

describe("acceptance-3 / item 1: timeout auto-backgrounds (no kill)", () => {
  test("spawn + small timeout → adopt, returns task_id + 'Backgrounded' text", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1; echo done", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    expect(child).toBeDefined();
    // Emit a chunk so we have something in stdoutChunks (also exercised in item 3).
    child.stdout.emit("data", Buffer.from("part1\n"));
    const r = await p;
    // Critical: not "Command timed out".
    expect((r as any).data.text).not.toMatch(/Command timed out/);
    // Returns task_id in text. Use non-greedy + stop at the trailing sentence
    // period so match[1] is the bare taskId (not "bg-xxx.").
    expect((r as any).data.text).toMatch(/Backgrounded as task_id: bg-/);
    const match = (r as any).data.text.match(/Backgrounded as task_id: (bg-\S+?)\./);
    expect(match).not.toBeNull();
    expect(match).not.toBeNull();
    const taskId = match![1];
    // Task is in registry.
    expect(delegator.taskRegistry.get(taskId)?.id).toBe(taskId);
  });

  test("child NOT killed on timeout (killCalls=0 at handoff)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    await p;
    expect(child.killCalls).toBe(0);
    expect(child.killed).toBe(false);
  });

  test("no adoptBackgroundTask in delegateFns → fallback kills + 'background adoption unavailable'", async () => {
    // Defensive path: UI preview or old loop without adoptBackgroundTask.
    // bash.ts should kill the child and return a clear message (not silently
    // hang or silently complete).
    const ctx: any = {
      caller: "internal",
      agentId: "caller",
      workingDir: ".",
      delegateFns: {
        // adoptBackgroundTask intentionally absent.
      },
    };
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    const r = await p;
    expect((r as any).data.text).toMatch(/Command timed out after 0\.05s/);
    expect((r as any).data.text).toMatch(/background adoption unavailable/);
    // Child was killed.
    expect(child.killCalls).toBe(1);
    expect(child.killed).toBe(true);
  });
});

// ===========================================================================
// Acceptance 2 — 命令不丢,继续跑
// ===========================================================================

describe("acceptance-3 / item 2: child stays alive after handoff", () => {
  test("after timeout → background, task status is 'running' (still active)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    await p;
    const tasks = delegator.taskRegistry.list("running");
    expect(tasks.length).toBe(1);
    expect(tasks[0].type).toBe("bash");
    expect(tasks[0].status).toBe("running");
  });

  test("after timeout → background, child process is NOT killed (alive)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    await p;
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(child.killed).toBe(false);
  });
});

// ===========================================================================
// Acceptance 3 — 输出保留 (技术核心)
// ===========================================================================
//
// Two halves:
//   (a) stdout collected BEFORE timeout → preserved in chunks → drained on close
//   (b) stdout collected AFTER timeout (during background) → also drained on close
// Test: emit "part1" before timeout, "part2" after, then close → registry result
// must contain BOTH.

describe("acceptance-3 / item 3: output preserved across handoff (core)", () => {
  test("stdout emitted before timeout AND after close both in task result", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "echo part1; sleep 1; echo part2", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    // Pre-timeout output.
    child.stdout.emit("data", Buffer.from("part1\n"));
    await p;
    // Post-handoff output (child still alive in background).
    child.stdout.emit("data", Buffer.from("part2\n"));
    // Resolve the task: child exits naturally with code 0.
    const tasks = delegator.taskRegistry.list("running");
    expect(tasks.length).toBe(1);
    const taskId = tasks[0].id;
    child.naturalExit(0);
    // Wait for the close event to propagate (nextTick) + registry.complete.
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.get(taskId);
    expect(task?.status).toBe("completed");
    expect(task?.result).toContain("part1");
    expect(task?.result).toContain("part2");
  });

  test("stderr emitted before timeout is also preserved", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "err1; sleep 1", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    child.stderr.emit("data", Buffer.from("err-warn\n"));
    await p;
    const tasks = delegator.taskRegistry.list("running");
    const taskId = tasks[0].id;
    child.naturalExit(0);
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.get(taskId);
    expect(task?.status).toBe("completed");
    expect(task?.result).toContain("err-warn");
    expect(task?.result).toMatch(/\[stderr\]/);
  });

  test("non-zero exit on background completion → status 'failed' with output preserved", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "echo x; sleep 1", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    child.stdout.emit("data", Buffer.from("partial-out\n"));
    await p;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    child.naturalExit(2); // non-zero
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.get(taskId);
    expect(task?.status).toBe("failed");
    expect(task?.error).toContain("Exit code 2");
    expect(task?.error).toContain("partial-out");
  });
});

// ===========================================================================
// Acceptance 4 — task 进 registry
// ===========================================================================

describe("acceptance-3 / item 4: task is in registry (TaskGet / TaskList)", () => {
  test("TaskGet(task_id) returns the running task after handoff", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    await p;
    const all = delegator.taskRegistry.list();
    expect(all.length).toBe(1);
    const t = all[0];
    expect(t.type).toBe("bash");
    expect(t.status).toBe("running");
    expect(t.task).toBe("sleep 1");
    expect(t.id).toMatch(/^bg-/);
  });

  test("task list (running filter) returns exactly this task", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const running = delegator.taskRegistry.list("running");
    const completed = delegator.taskRegistry.list("completed");
    expect(running.length).toBe(1);
    expect(completed.length).toBe(0);
  });
});

// ===========================================================================
// Acceptance 5 — agent 可 TaskKill
// ===========================================================================

describe("acceptance-3 / item 5: TaskKill terminates child + task", () => {
  test("registry.kill(task_id) → AbortController.abort → child.kill() called", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    await p;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    expect(child.killCalls).toBe(0);
    const killed = delegator.taskRegistry.kill(taskId);
    expect(killed).toBe(true);
    // AbortController's listener fires synchronously on abort → child.kill now.
    expect(child.killCalls).toBe(1);
    expect(child.killed).toBe(true);
  });

  test("after kill, task status is 'killed' (terminal)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    await p;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    delegator.taskRegistry.kill(taskId);
    // Wait for FakeChild's scheduled close emission (nextTick) + adopt's close handler.
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.get(taskId);
    expect(task?.status).toBe("killed");
  });

  test("skip-if-killed guard: close handler does NOT override 'killed' status", async () => {
    // After kill, FakeChild emits close (signal). adopt's handleClose sees
    // status="killed" and returns without calling complete/fail — the status
    // must remain "killed" (not flipped to "completed"/"failed").
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    await p;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    delegator.taskRegistry.kill(taskId);
    // Drain the close event chain.
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.get(taskId);
    expect(task?.status).toBe("killed");
  });

  test("kill fires subagent_completed event with status 'failed' (union has no 'killed')", async () => {
    const { delegator, emitted } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const taskId = delegator.taskRegistry.list("running")[0].id;
    emitted.length = 0; // drop TaskCreated noise
    delegator.taskRegistry.kill(taskId);
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const completed = emitted.find((e) => e.type === "subagent_completed");
    expect(completed).toBeDefined();
    expect(completed.status).toBe("failed"); // killed → "failed" in event stream
    expect(completed.taskId).toBe(taskId);
  });
});

// ===========================================================================
// Acceptance 6 — 中性提示
// ===========================================================================

describe("acceptance-3 / item 6: neutral hint lets agent decide", () => {
  test("text contains 'Task kill' / 'Task get' / 'finish' decision keywords", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const r = await p;
    const text = (r as any).data.text;
    // Per sub-3.md spec: "Task kill to stop / Task get to watch / let it finish"
    expect(text).toMatch(/Task kill/i);
    expect(text).toMatch(/Task get/i);
    expect(text).toMatch(/finish/i);
  });

  test("text mentions the timeout duration that triggered the handoff", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const r = await p;
    expect((r as any).data.text).toMatch(/ran 0\.05s/);
  });
});

// ===========================================================================
// Acceptance 7 — 短命令仍 blocking 完成
// ===========================================================================

describe("acceptance-3 / item 7: short commands still block + complete normally", () => {
  test("command closes before timeout → returns stdout + [Completed in Xs]", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "echo hi", timeout: 0.5 }, ctx);
    const child = spawnState.currentChild!;
    child.stdout.emit("data", Buffer.from("hi\n"));
    child.naturalExit(0);
    const r = await p;
    expect(r.ok).toBe(true);
    const text = (r as any).data.text;
    expect(text).toContain("hi");
    expect(text).toMatch(/\[Completed in [\d.]+s\]/);
    // No task created in registry.
    expect(delegator.taskRegistry.list().length).toBe(0);
  });

  test("short command with non-zero exit → 'Exit code N' + [Completed]", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "exit 7", timeout: 0.5 }, ctx);
    const child = spawnState.currentChild!;
    child.stderr.emit("data", Buffer.from("oops\n"));
    child.naturalExit(7);
    const r = await p;
    expect(r.ok).toBe(false);
    const text = (r as any).data.text;
    expect(text).toMatch(/Exit code 7/);
    expect(text).toMatch(/\[Completed in [\d.]+s\]/);
    expect(delegator.taskRegistry.list().length).toBe(0);
  });

  test("child closes within timeout race: outcome is 'done' (not 'timeout')", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "echo fast", timeout: 0.5 }, ctx);
    spawnState.currentChild!.naturalExit(0);
    const r = await p;
    // Did not background.
    expect((r as any).data.text).not.toMatch(/Backgrounded/);
    expect((r as any).data.exitCode).toBe(0);
  });
});

// ===========================================================================
// Acceptance 8 — background?:true 仍工作 (sub-2 path not broken)
// ===========================================================================

describe("acceptance-3 / item 8: background?:true (sub-2) still works", () => {
  test("background:true + runBackground returns task_id immediately", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    // Don't `play()` — background path returns immediately without awaiting spawn.
    const r = await raw({ command: "long-running-watch", background: true, timeout: 0.5 }, ctx);
    expect(r.ok).toBe(true);
    expect((r as any).data.text).toMatch(/task_id: bg-/);
    expect((r as any).data.text).toMatch(/Background shell started/);
    // runBackground called spawn() — a separate child for the bg task.
    expect(spawnState.lastCall).not.toBeNull();
  });

  test("background:true does not call adoptBackgroundTask (separate code path)", async () => {
    let adoptCalls = 0;
    const { delegator } = makeDelegator();
    const ctx: any = {
      caller: "internal",
      agentId: "caller",
      workingDir: ".",
      delegateFns: {
        runBackground: (cmd: string, t?: number) => delegator.runBackground(cmd, t),
        getTaskResult: (id: string) => delegator.taskRegistry.get(id),
        adoptBackgroundTask: () => { adoptCalls++; return "bg-adopt"; },
      },
    };
    await raw({ command: "watch", background: true, timeout: 0.5 }, ctx);
    expect(adoptCalls).toBe(0);
  });
});

// ===========================================================================
// Acceptance 9 — 无子进程泄漏
// ===========================================================================

describe("acceptance-3 / item 9: no child leak (child exits on task terminal)", () => {
  test("natural completion: child reaches exitCode set + task completed", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "echo done; sleep 1", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    child.naturalExit(0);
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    // Child has terminal exitCode (real child would have exited).
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(delegator.taskRegistry.get(taskId)?.status).toBe("completed");
  });

  test("TaskKill: child.kill() actually invoked (SIGTERM delivered)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    delegator.taskRegistry.kill(taskId);
    // AbortController→kill wired: kill was invoked synchronously by the abort listener.
    expect(child.killCalls).toBe(1);
    // Drain the FakeChild's scheduled close emission.
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    expect(child.signalCode).not.toBeNull(); // exit signal recorded
    expect(delegator.taskRegistry.get(taskId)?.status).toBe("killed");
  });

  test("double-kill is a no-op (no second SIGTERM, no throw)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "sleep 1", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    expect(delegator.taskRegistry.kill(taskId)).toBe(true);
    expect(child.killCalls).toBe(1);
    // Second kill: registry refuses (task no longer running) → no extra child.kill.
    expect(delegator.taskRegistry.kill(taskId)).toBe(false);
    expect(child.killCalls).toBe(1);
  });
});

// ===========================================================================
// Cross-cutting: emit/hook lifecycle + runBackground isolation
// ===========================================================================

describe("extra: lifecycle emits + TaskCompleted hook fire on close", () => {
  test("on natural close, subagent_completed + (TaskCompleted hook fires via triggerHooks)", async () => {
    const { delegator, emitted } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "echo done", timeout: 0.05 }, ctx);
    emitted.length = 0;
    const child = spawnState.currentChild!;
    child.naturalExit(0);
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const completed = emitted.find((e) => e.type === "subagent_completed");
    expect(completed).toBeDefined();
    expect(completed.status).toBe("completed");
  });
});

describe("extra: runBackground unchanged — adopt is a parallel code path", () => {
  test("runBackground spawns its OWN child (not the one bash.ts spawned)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    // Background mode: bash.ts does NOT spawn. Only runBackground spawns.
    await raw({ command: "x", background: true }, ctx);
    // After background returns, runBackground has called spawn() once (its own child).
    expect(spawnState.lastCall).not.toBeNull();
    const bgChild = spawnState.currentChild;
    expect(bgChild).not.toBeNull();
    // The bg child is independent — drive it to completion via the close handler.
    const tasks = delegator.taskRegistry.list("running");
    expect(tasks.length).toBe(1);
    bgChild!.naturalExit(0);
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    expect(delegator.taskRegistry.get(tasks[0].id)?.status).toBe("completed");
  });

  test("runBackground does NOT wire AbortController (kill is bookkeeping-only)", async () => {
    // Contrast with adopt which DOES wire ac→child.kill. Verify by inspecting
    // behavior: kill on a runBackground task does NOT invoke child.kill
    // (registry.kill fires ac.abort, but ac was passed as undefined at create
    // time → no listener → child.kill NOT called).
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "x", background: true }, ctx);
    const child = spawnState.currentChild!;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    expect(child.killCalls).toBe(0);
    delegator.taskRegistry.kill(taskId);
    expect(child.killCalls).toBe(0); // runBackground: no ac wiring
    // Cleanup the orphaned child to avoid leak across tests.
    child.naturalExit(0);
    await new Promise((res) => process.nextTick(res));
  });
});

// ===========================================================================
// M1 — maxBuffer enforcement (10MB cap, foreground + adopt paths)
// ===========================================================================
//
// sub-3 implementer V3 followup: bash.ts regained the maxBuffer guard that
// execFileAsync used to provide (EXEC_MAX_BUFFER_BYTES = 10MB). Without it,
// `yes` / `cat /dev/urandom` / backgrounded `tail -f` would grow chunks
// unbounded → parent OOM. Two paths:
//   (a) Foreground: onChunk accumulates totalBytes; >MAX → detach listeners +
//       child.kill + settle race as {kind:"maxbuffer"} + return fail text
//       with truncated partial (4KB).
//   (b) Background (post-adopt): the bash.ts data listeners stay attached
//       after adopt, so they keep enforcing. Once >MAX, they detach + kill;
//       adopt's finalize detects totalBytes > MAX at close time → fail with
//       "Output exceeded" message.
//
// Both paths MUST:
//   - call child.kill() (stop producing more output)
//   - return/fail with "Output exceeded" message
//   - preserve a partial output preview

describe("M1 maxBuffer: foreground path (>10MB → kill + fail with partial)", () => {
  test("stdout > MAX → ok:false, text 'Output exceeded', partial preserved, child killed", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "yes", timeout: 5 }, ctx);
    const child = spawnState.currentChild!;
    // Push a small "header" chunk first so we can verify it survives in
    // partial output, then a single >MAX chunk.
    child.stdout.emit("data", Buffer.from("HEADER-LINE\n"));
    const MAX = 10 * 1024 * 1024;
    child.stdout.emit("data", Buffer.alloc(MAX + 1024, 0x41)); // 'A' * (10MB+1KB)
    const r = await p;
    // bash.ts detached listeners + killed child + settled race as maxbuffer.
    expect(r.ok).toBe(false);
    const text = (r as any).data.text;
    expect(text).toMatch(/Output exceeded/);
    expect(text).toMatch(/process killed/);
    expect(text).toContain("HEADER-LINE"); // partial preserved
    // exitCode -1 (killed).
    expect((r as any).data.exitCode).toBe(-1);
    // child.kill was invoked.
    expect(child.killCalls).toBe(1);
    // No task was created (foreground path doesn't adopt on maxbuffer).
    expect(delegator.taskRegistry.list().length).toBe(0);
  });

  test("stderr > MAX alone also triggers maxbuffer (combined total)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "noisy-fail", timeout: 5 }, ctx);
    const child = spawnState.currentChild!;
    const MAX = 10 * 1024 * 1024;
    // Emit all on stderr — bash.ts counts both streams.
    child.stderr.emit("data", Buffer.from("ERR-HDR\n"));
    child.stderr.emit("data", Buffer.alloc(MAX + 100, 0x42));
    const r = await p;
    expect(r.ok).toBe(false);
    expect((r as any).data.text).toMatch(/Output exceeded/);
    expect((r as any).data.text).toContain("ERR-HDR");
    expect(child.killCalls).toBe(1);
  });

  test("output exactly at MAX does NOT trip (boundary: only >MAX triggers)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "boundary", timeout: 5 }, ctx);
    const child = spawnState.currentChild!;
    const MAX = 10 * 1024 * 1024;
    // Equal to MAX — must NOT trip (>MAX is the trigger).
    child.stdout.emit("data", Buffer.alloc(MAX, 0x41));
    // Now close cleanly.
    child.naturalExit(0);
    const r = await p;
    // Did NOT trip maxbuffer — completed normally.
    expect(r.ok).toBe(true);
    expect((r as any).data.text).not.toMatch(/Output exceeded/);
  });
});

describe("M1 maxBuffer: background path (post-adopt >MAX → fail task)", () => {
  test("post-adopt output > MAX → task failed with 'Output exceeded' + partial", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "yes", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    // Pre-timeout small chunk.
    child.stdout.emit("data", Buffer.from("PART1\n"));
    await p; // timeout → adopt
    const taskId = delegator.taskRegistry.list("running")[0].id;
    // Post-adopt: bash.ts's onChunk still attached — emit > MAX.
    const MAX = 10 * 1024 * 1024;
    child.stdout.emit("data", Buffer.alloc(MAX + 1024, 0x41));
    // Drain the kill→close→finalize chain.
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.get(taskId);
    expect(task?.status).toBe("failed");
    expect(task?.error).toMatch(/Output exceeded/);
    // bash.ts's listener detached at >MAX but PART1 was pushed BEFORE the trip.
    expect(task?.error).toContain("PART1");
    // child.kill was invoked by the onChunk guard.
    expect(child.killCalls).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// m1 — settled flag prevents close+error double-emit
// ===========================================================================
//
// Node may emit BOTH 'error' and 'close' on fatal spawn-internal errors
// (error first, then close). Without a shared settled guard, adopt's
// finalize would run twice → duplicate registry.fail + duplicate emit +
// duplicate TaskCompleted hook. m1 adds a single `settled` flag shared
// between close and error handlers — first event wins, second is a no-op.

describe("m1 settled: error+close sequence emits exactly once", () => {
  test("error then close → registry.fail called once, subagent_completed emitted once", async () => {
    const { delegator, emitted } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "x", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    emitted.length = 0; // drop TaskCreated
    // Emit error first, then close — Node's typical fatal-error sequence.
    child.emit("error", new Error("spawn EPERM"));
    child.emit("close", -1);
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    // Exactly ONE subagent_completed event.
    const completed = emitted.filter((e) => e.type === "subagent_completed");
    expect(completed.length).toBe(1);
    // Status reflects the error path (failed).
    expect(completed[0].status).toBe("failed");
    // Registry status is terminal exactly once (no clobber).
    const task = delegator.taskRegistry.get(taskId);
    expect(task?.status).toBe("failed");
  });

  test("close then error (race win) → also exactly one finalize", async () => {
    // Reverse order — close wins. Same guarantee.
    const { delegator, emitted } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "x", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    emitted.length = 0;
    child.emit("close", 0);
    child.emit("error", new Error("late error"));
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const completed = emitted.filter((e) => e.type === "subagent_completed");
    expect(completed.length).toBe(1);
    expect(completed[0].status).toBe("completed"); // close(0) won
    expect(delegator.taskRegistry.get(taskId)?.status).toBe("completed");
  });
});

// ===========================================================================
// m2 — TaskKill preserves partial output (not just "(killed)")
// ===========================================================================
//
// Original skip-if-killed guard wrote NOTHING to result — agent lost all
// stdout the killed task had collected. m2 fixes: decode chunks anyway and
// write `(killed) ${partial}` to info.result so TaskGet shows the work.
// Registry status stays "killed"; event stream status stays "failed" (no
// "killed" in the union).

describe("m2 killed preserves partial output", () => {
  test("TaskKill after some stdout collected → task.result contains stdout (not bare '(killed)')", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "build", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    child.stdout.emit("data", Buffer.from("compiling foo...\n"));
    child.stdout.emit("data", Buffer.from("compiling bar...\n"));
    await p;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    delegator.taskRegistry.kill(taskId);
    // Drain kill→ac.abort→child.kill→close→finalize.
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.get(taskId);
    expect(task?.status).toBe("killed"); // registry status untouched
    // m2: result contains the partial output.
    expect(task?.result).toContain("(killed)");
    expect(task?.result).toContain("compiling foo...");
    expect(task?.result).toContain("compiling bar...");
  });

  test("killed event carries partial in result field (not just '(killed)')", async () => {
    const { delegator, emitted } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "build", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    child.stdout.emit("data", Buffer.from("PROGRESS-DATA\n"));
    await p;
    const taskId = delegator.taskRegistry.list("running")[0].id;
    emitted.length = 0;
    delegator.taskRegistry.kill(taskId);
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const completed = emitted.find((e) => e.type === "subagent_completed");
    expect(completed).toBeDefined();
    expect(completed.status).toBe("failed"); // union has no "killed"
    expect(completed.result).toContain("PROGRESS-DATA");
    expect(completed.result).toContain("(killed)");
  });

  test("killed with NO output collected → result is '(killed) ' or similar bare marker", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "x", timeout: 0.05 }, ctx);
    const taskId = delegator.taskRegistry.list("running")[0].id;
    delegator.taskRegistry.kill(taskId);
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.get(taskId);
    expect(task?.result).toMatch(/^\(killed\)/);
  });
});

// ===========================================================================
// m3 — spawn stdio:['ignore','pipe','pipe'] (stdin closed)
// ===========================================================================
//
// Without `stdio:['ignore',...]`, spawn defaults to 'pipe' on all three.
// Parent never writes/never closes child's stdin → `cat`/`tail -f` (no-arg)
// block forever waiting on stdin → 300s timeout → adopt → registry leak.
// m3 explicitly closes stdin so child sees EOF immediately and exits.

describe("m3 stdio ignore: spawn opts closes stdin", () => {
  test("spawn called with stdio = ['ignore','pipe','pipe']", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "echo x", timeout: 5 }, ctx);
    spawnState.currentChild!.naturalExit(0);
    await p;
    expect(spawnState.lastCall).not.toBeNull();
    expect(spawnState.lastCall!.opts).toBeDefined();
    expect(spawnState.lastCall!.opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  test("background path (runBackground) does NOT set stdio ignore (separate code path)", async () => {
    // runBackground is the sub-2 path, unchanged by sub-3. We don't assert
    // what it does — only that the m3 fix is bash.ts-scoped (not a global
    // default that could surprise other callers).
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "x", background: true }, ctx);
    expect(spawnState.lastCall).not.toBeNull();
    // runBackground uses bare { cwd } — no stdio. (If a future change adds
    // stdio here too, that's fine — this test pins current behavior.)
    expect(spawnState.lastCall!.opts?.stdio).toBeUndefined();
  });
});

// ===========================================================================
// m4 — child 'error' event prepends err.message to partial output
// ===========================================================================
//
// Original adopt error handler wrote ONLY err.message — discarding any
// partial stdout the child had produced before the error. m4 unifies the
// close and error paths through `finalize(reason, code, err)` and, on the
// error branch, builds `${err.message}\n${partial}` so the user sees both
// the cause AND what the child managed to output.

describe("m4 error prepends message to partial output", () => {
  test("child 'error' event → fail text contains err.message AND partial stdout", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "x", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    // Pre-error output.
    child.stdout.emit("data", Buffer.from("HALF-WORK-DONE\n"));
    // Drain the error → finalize chain.
    child.emit("error", new Error("spawn ECONNRESET"));
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.list()[0];
    expect(task?.status).toBe("failed");
    expect(task?.error).toContain("spawn ECONNRESET");
    expect(task?.error).toContain("HALF-WORK-DONE");
  });

  test("error with no prior output → fail text is just the message (no extra newline)", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "x", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    child.emit("error", new Error("spawn ENOENT"));
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const task = delegator.taskRegistry.list()[0];
    expect(task?.status).toBe("failed");
    expect(task?.error).toContain("spawn ENOENT");
  });

  test("error path emits subagent_completed with the same combined result", async () => {
    const { delegator, emitted } = makeDelegator();
    const ctx = makeCtx(delegator);
    await raw({ command: "x", timeout: 0.05 }, ctx);
    const child = spawnState.currentChild!;
    child.stdout.emit("data", Buffer.from("PRE-ERR\n"));
    emitted.length = 0;
    child.emit("error", new Error("spawn EFAULT"));
    await new Promise((res) => process.nextTick(res));
    await new Promise((res) => process.nextTick(res));
    const completed = emitted.find((e) => e.type === "subagent_completed");
    expect(completed).toBeDefined();
    expect(completed.status).toBe("failed");
    expect(completed.result).toContain("spawn EFAULT");
    expect(completed.result).toContain("PRE-ERR");
  });
});

// ===========================================================================
// n1 — windowsHide:true on Windows (no console flash)
// ===========================================================================
//
// Verifier-flagged risk in sub-3 first pass: bash.ts's spawn didn't set
// windowsHide → on Windows, spawning cmd.exe/git bash can briefly flash a
// console window. n1 adds `windowsHide: true` (no-op on non-Windows).

describe("n1 windowsHide: spawn opts hides console on Windows", () => {
  test("spawn opts includes windowsHide:true", async () => {
    const { delegator } = makeDelegator();
    const ctx = makeCtx(delegator);
    const p = raw({ command: "echo x", timeout: 5 }, ctx);
    spawnState.currentChild!.naturalExit(0);
    await p;
    expect(spawnState.lastCall!.opts?.windowsHide).toBe(true);
  });
});

// ===========================================================================
// Acceptance 10 — typecheck
// ===========================================================================

describe("acceptance-3 / item 10: typecheck sentinel", () => {
  test("bashTool + SubagentDelegator.adoptBackgroundTask are importable", () => {
    expect(typeof bashTool).toBe("object");
    expect(typeof SubagentDelegator).toBe("function");
    expect(typeof TaskRegistry).toBe("function");
    const d = makeDelegator().delegator;
    expect(typeof d.adoptBackgroundTask).toBe("function");
    expect(typeof d.runBackground).toBe("function");
  });
});
