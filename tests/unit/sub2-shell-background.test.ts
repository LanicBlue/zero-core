// sub-2 (execution-entry-redesign) acceptance tests.
//
// Independent verifier-authored tests encoding acceptance-2.md items 1–9.
// Each describe block maps 1:1 to an acceptance item so PASS/FAIL is auditable
// from the test name. Mirrors the style of sub1-subagent-background.test.ts
// and sub4-task-tools.test.ts.
//
// # Accepted spec
// docs/plan/execution-entry-redesign/acceptance-2.md (authoritative)
//
// # Scope
//   - Shell (bash.ts) `background?:true` restored: immediate task_id return via
//     callerCtx.delegateFns.runBackground.
//   - Blocking path stays the default; timeout default hardcoded to 300s
//     (no longer reads config.timeout — configSchema's timeout removed).
//   - LLM input `timeout` overrides the default.
//
// # MIGRATION NOTICE (sub-3)
//   sub-3 refactored bash.ts's foreground path from `execFile`+`promisify` to
//   `spawn` + manual timeout race + adopt. The previous version of this file
//   mocked `execFile` to capture `opts.timeout` and emit canned stdout/stderr.
//   That mock no longer intercepts anything (bash.ts now imports `spawn`,
//   not `execFile`), so the foreground-path tests have been rewritten to:
//     1. Mock `spawn` and return a controllable FakeChild (stdout/stderr/close).
//     2. Use a setTimeout spy for the timeout-default/override assertions
//        (sub-3 pipes `timeout` into a setTimeout call internally).
//   The "extra: foreground timeout still kills" suite was DELETED — sub-3
//   intentionally inverts that behavior (timeout now auto-backgrounds, not
//   kills). The new contract is exercised in sub3-shell-timeout-background.test.ts.
//
// # Mocking strategy
//   vi.mock("node:child_process", ...) exposes `spawn` returning a hoisted
//   `currentChild` (a FakeChild EventEmitter). Each test configures
//   `nextResult` to drive the child's events; the helper `play()` emits them
//   on nextTick so bash.ts's race listener is registered first.

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ─── spawn mock state (hoisted so vi.mock factory can read it) ──────────────
const spawnState = vi.hoisted(() => ({
  // Most recent FakeChild returned by spawn.
  currentChild: null as any,
  // What the next spawn's child should do. Reset in beforeEach.
  nextResult: {
    kind: "success" as "success" | "fail",
    stdout: "ok",
    stderr: "",
    code: 0,
  },
  // Captured (shell, args) tuple.
  lastCall: null as { shell: string; args: string[] } | null,
}));

// A fake ChildProcess. Bash.ts reads .stdout/.stderr (attaches data listeners),
// awaits .on("close")/.on("error"), and on timeout path checks .exitCode /
// .signalCode / calls .kill(). For sub-2 we only need the success/fail path.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill() { return true; }
}

vi.mock("node:child_process", () => ({
  spawn: (shell: string, args: string[]) => {
    spawnState.lastCall = { shell, args };
    const child = new FakeChild();
    spawnState.currentChild = child;
    return child;
  },
}));

import { bashTool } from "../../src/tools/bash.js";
import {
  getToolExecute,
  getToolFormat,
  getToolConfigSchema,
} from "../../src/tools/tool-factory.js";

const exec = getToolExecute(bashTool)!;
const fmt = getToolFormat(bashTool)!;
const schema = getToolConfigSchema(bashTool);

/** Format the LLM-facing string (data.text via format). */
const run = (i: any, c: any) => exec(i, c).then(fmt);
/** Raw ToolResult JSON. */
const raw = (i: any, c: any) => exec(i, c);

/** Drive the fake child to completion based on nextResult. */
function play(): void {
  const child = spawnState.currentChild as FakeChild | null;
  if (!child) return;
  const r = spawnState.nextResult;
  process.nextTick(() => {
    if (r.stdout) child.stdout.emit("data", Buffer.from(r.stdout));
    if (r.stderr) child.stderr.emit("data", Buffer.from(r.stderr));
    const code = r.kind === "success" ? 0 : (r.code ?? 1);
    child.exitCode = code;
    child.emit("close", code);
  });
}

/** Build a CallerCtx-shape ctx with the delegateFns the Shell bg branch reads. */
function makeCtx(opts: {
  runBackground?: (cmd: string, timeout?: number) => string;
  getTaskResult?: (id: string) => any;
  workingDir?: string;
} = {}) {
  return {
    caller: "internal" as const,
    agentId: "caller",
    workingDir: opts.workingDir ?? ".",
    delegateFns: {
      runBackground: opts.runBackground,
      getTaskResult: opts.getTaskResult ?? (() => null),
      // adoptBackgroundTask wired so the timeout path can resolve (sub-3 path
      // exercised separately in sub3-shell-timeout-background.test.ts).
      adoptBackgroundTask: () => "bg-stub",
    },
  } as any;
}

beforeEach(() => {
  spawnState.currentChild = null;
  spawnState.lastCall = null;
  spawnState.nextResult = { kind: "success", stdout: "ok", stderr: "", code: 0 };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Acceptance 1 — background?:true 立即后台返 task_id
// ===========================================================================

describe("acceptance-2 / item 1: background:true returns task_id immediately", () => {
  test("background:true → runBackground called, result text contains task_id", async () => {
    let captured: { cmd?: string; timeout?: number } = {};
    const ctx = makeCtx({
      runBackground: (cmd: string, timeout?: number) => {
        captured = { cmd, timeout };
        return "bg-fixed-1";
      },
    });
    const r = await raw({ command: "npm test", background: true }, ctx);
    expect(r.ok).toBe(true);
    expect((r as any).data.text).toMatch(/task_id: bg-fixed-1/);
    // runBackground received the command.
    expect(captured.cmd).toBe("npm test");
  });

  test("background:true does NOT invoke spawn (no waiting on the command)", async () => {
    const ctx = makeCtx({ runBackground: () => "bg-fixed-2" });
    await raw({ command: "long-running-watch", background: true }, ctx);
    // spawn must NOT have been called — background returns before exec.
    expect(spawnState.lastCall).toBeNull();
    expect(spawnState.currentChild).toBeNull();
  });

  test("background:true returns synchronously after runBackground (no deferred wait)", async () => {
    let deferredFired = false;
    const ctx = makeCtx({
      runBackground: () => {
        setImmediate(() => { deferredFired = true; });
        return "bg-immediate-1";
      },
    });
    const r = await raw({ command: "x", background: true }, ctx);
    expect((r as any).data.text).toMatch(/task_id: bg-immediate-1/);
    expect(deferredFired).toBe(false);
    await new Promise((res) => setImmediate(res));
    expect(deferredFired).toBe(true);
  });
});

// ===========================================================================
// Acceptance 2 — background 默认 blocking (无 background → spawn path)
// ===========================================================================

describe("acceptance-2 / item 2: background defaults to blocking", () => {
  test("no background flag → spawn IS invoked (blocking path)", async () => {
    spawnState.nextResult = { kind: "success", stdout: "BLOCKING_OK", stderr: "", code: 0 };
    const ctx = makeCtx({ runBackground: () => "should-not-fire" });
    const p = raw({ command: "echo hi" }, ctx);
    play();
    const r = await p;
    expect(r.ok).toBe(true);
    expect(spawnState.lastCall).not.toBeNull();
    expect((r as any).data.text).toContain("BLOCKING_OK");
  });

  test("background:false explicit → same as blocking (spawn invoked)", async () => {
    spawnState.nextResult = { kind: "success", stdout: "EXPLICIT_FALSE_OK", stderr: "", code: 0 };
    const ctx = makeCtx({ runBackground: () => "should-not-fire" });
    const p = raw({ command: "echo hi", background: false }, ctx);
    play();
    const r = await p;
    expect(spawnState.lastCall).not.toBeNull();
    expect((r as any).data.text).toContain("EXPLICIT_FALSE_OK");
  });
});

// ===========================================================================
// Acceptance 3 — timeout 默认 300s
// ===========================================================================
//
// sub-3 changed the mechanism (no longer `opts.timeout` on execFile — it's now
// a setTimeout(delay) inside bash.ts's race). Spy on setTimeout to capture the
// delay bash.ts arms when no input timeout is supplied.

describe("acceptance-2 / item 3: timeout defaults to 300s", () => {
  test("no input timeout, no config → setTimeout armed with 300000ms", async () => {
    const spies: number[] = [];
    const spy = vi.spyOn(global, "setTimeout").mockImplementation((fn: any, delay?: number) => {
      if (typeof delay === "number") spies.push(delay);
      // Don't actually arm — we don't want the race to fire on a real 300s timer.
      // Return a fake handle; clearTimeout is also stubbed below.
      return 0 as any;
    });
    vi.spyOn(global, "clearTimeout").mockImplementation(() => {});
    const ctx = makeCtx();
    const p = raw({ command: "echo default-timeout" }, ctx);
    play();
    await p;
    spy.mockRestore();
    vi.restoreAllMocks();
    expect(spies).toContain(300000);
  });

  test("callerCtx.toolConfig.Shell.timeout is NOT consulted (default still 300)", async () => {
    const spies: number[] = [];
    const spy = vi.spyOn(global, "setTimeout").mockImplementation((fn: any, delay?: number) => {
      if (typeof delay === "number") spies.push(delay);
      return 0 as any;
    });
    vi.spyOn(global, "clearTimeout").mockImplementation(() => {});
    const ctx: any = {
      caller: "internal",
      agentId: "caller",
      workingDir: ".",
      toolConfig: { Shell: { timeout: 5 } },
      delegateFns: { adoptBackgroundTask: () => "bg-stub" },
    };
    const p = raw({ command: "echo should-not-be-5" }, ctx);
    play();
    await p;
    spy.mockRestore();
    vi.restoreAllMocks();
    expect(spies).toContain(300000);
    expect(spies).not.toContain(5000);
  });
});

// ===========================================================================
// Acceptance 4 — timeout input 可覆盖
// ===========================================================================

describe("acceptance-2 / item 4: input timeout overrides default 300s", () => {
  test("input timeout:10 → setTimeout armed with 10000ms", async () => {
    const spies: number[] = [];
    const spy = vi.spyOn(global, "setTimeout").mockImplementation((fn: any, delay?: number) => {
      if (typeof delay === "number") spies.push(delay);
      return 0 as any;
    });
    vi.spyOn(global, "clearTimeout").mockImplementation(() => {});
    const ctx = makeCtx();
    const p = raw({ command: "echo ten", timeout: 10 }, ctx);
    play();
    await p;
    spy.mockRestore();
    vi.restoreAllMocks();
    expect(spies).toContain(10000);
  });

  test("input timeout:1 → setTimeout armed with 1000ms — beats 300s default", async () => {
    const spies: number[] = [];
    const spy = vi.spyOn(global, "setTimeout").mockImplementation((fn: any, delay?: number) => {
      if (typeof delay === "number") spies.push(delay);
      return 0 as any;
    });
    vi.spyOn(global, "clearTimeout").mockImplementation(() => {});
    const ctx = makeCtx();
    const p = raw({ command: "echo one", timeout: 1 }, ctx);
    play();
    await p;
    spy.mockRestore();
    vi.restoreAllMocks();
    expect(spies).toContain(1000);
    expect(spies).not.toContain(300000);
  });
});

// ===========================================================================
// Acceptance 5 — configSchema 去 timeout
// ===========================================================================

describe("acceptance-2 / item 5: configSchema has no timeout", () => {
  test("getToolConfigSchema(bashTool) returns undefined or no field with key 'timeout'", () => {
    const keys = (schema ?? []).map((f: any) => f.key);
    expect(keys).not.toContain("timeout");
  });

  test("no field whose key contains 'timeout' (case-insensitive)", () => {
    for (const f of schema ?? []) {
      expect(String((f as any).key).toLowerCase()).not.toMatch(/timeout/);
    }
  });
});

// ===========================================================================
// Acceptance 6 — blocking 命令仍工作 (stdout + [Completed in Xs])
// ===========================================================================

describe("acceptance-2 / item 6: blocking command still works", () => {
  test("success → text contains stdout + '[Completed in Xs]'", async () => {
    spawnState.nextResult = { kind: "success", stdout: "REAL_OUTPUT_42", stderr: "", code: 0 };
    const ctx = makeCtx();
    const p = raw({ command: "echo REAL_OUTPUT_42" }, ctx);
    play();
    const r = await p;
    expect(r.ok).toBe(true);
    const text = (r as any).data.text;
    expect(text).toContain("REAL_OUTPUT_42");
    expect(text).toMatch(/\[Completed in [\d.]+s\]/);
  });

  test("formatted output (LLM-facing) contains stdout + completion marker", async () => {
    spawnState.nextResult = { kind: "success", stdout: "FMT_OUTPUT", stderr: "", code: 0 };
    const ctx = makeCtx();
    const p = run({ command: "echo FMT_OUTPUT" }, ctx);
    play();
    const text = await p;
    expect(text).toContain("FMT_OUTPUT");
    expect(text).toMatch(/\[Completed in [\d.]+s\]/);
  });

  test("non-zero exit (fail path) → text contains 'Exit code N' + completion", async () => {
    spawnState.nextResult = { kind: "fail", stdout: "PARTIAL", stderr: "boom", code: 42 };
    const ctx = makeCtx();
    const p = raw({ command: "exit 42" }, ctx);
    play();
    const r = await p;
    expect(r.ok).toBe(false);
    const text = (r as any).data.text;
    expect(text).toMatch(/Exit code 42/);
    expect(text).toContain("PARTIAL");
    expect(text).toMatch(/\[Completed in [\d.]+s\]/);
  });
});

// ===========================================================================
// Acceptance 7 — TaskStart{shell} 仍工作 (sub-4 才删; sub-2 不动)
// ===========================================================================
// REMOVED in sub-4: TaskStart{type:shell} was the pre-sub-2 background-shell
// entry. sub-2 replaced it with Shell `background:true` (already covered by
// items 1–2 above), and sub-4 deleted the TaskStart tool entirely. The
// cross-check described by acceptance-2 item 7 is therefore obsolete; the
// equivalent coverage (background:true → runBackground → task_id, no spawn)
// lives in item 1.

// ===========================================================================
// Acceptance 8 — ToolsPage 不渲染 Shell timeout config (静态:configSchema 空)
// ===========================================================================

describe("acceptance-2 / item 8: ToolsPage will not render Shell timeout (configSchema empty)", () => {
  test("configSchema is empty or undefined → ToolsPage render guard skips it", () => {
    const renderableLen = (schema ?? []).length;
    expect(renderableLen).toBe(0);
  });

  test("no configSchema field with key 'timeout' would render", () => {
    const keys = (schema ?? []).map((f: any) => f.key);
    expect(keys).not.toContain("timeout");
  });
});

// ===========================================================================
// Extra — background mode without delegateFns (UI preview) is benign
// ===========================================================================

describe("extra: background without delegateFns returns benign preview (G1)", () => {
  test("background:true + no delegateFns → ok:true with preview text", async () => {
    const ctx: any = {
      caller: "ui",
      agentId: "preview",
      workingDir: ".",
    };
    const r = await raw({ command: "x", background: true }, ctx);
    expect(r.ok).toBe(true);
    expect((r as any).data.text).toMatch(/preview|unavailable|background/i);
  });

  test("background:true + delegateFns but no runBackground → ok:false with error", async () => {
    const ctx: any = {
      caller: "internal",
      agentId: "caller",
      workingDir: ".",
      delegateFns: {
        getTaskResult: () => null,
      },
    };
    const r = await raw({ command: "x", background: true }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/not available/i);
  });

  test("background:true surfaces launch failures synchronously (status:failed)", async () => {
    const ctx = makeCtx({
      runBackground: () => "bg-boom",
      getTaskResult: () => ({ status: "failed", result: "spawn ENOENT" }),
    });
    const r = await raw({ command: "x", background: true }, ctx);
    expect(r.ok).toBe(true);
    const text = (r as any).data.text;
    expect(text).toMatch(/failed to launch/i);
    expect(text).toContain("bg-boom");
    expect(text).toContain("spawn ENOENT");
  });
});

// ===========================================================================
// Acceptance 9 — typecheck (verified by `npm run build:lib`)
// ===========================================================================

describe("acceptance-2 / item 9: typecheck sentinel", () => {
  test("bashTool + helpers are importable (module loads)", () => {
    expect(typeof bashTool).toBe("object");
    expect(typeof exec).toBe("function");
    expect(typeof fmt).toBe("function");
  });
});
