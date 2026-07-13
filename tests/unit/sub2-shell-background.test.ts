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
// # Mocking strategy
//   We mock node:child_process's execFile (and node:util's promisify to identity)
//   so that bash.ts's `const execFileAsync = promisify(execFile)` ends up calling
//   our mock directly. This lets us assert the opts passed to exec (notably
//   `opts.timeout`) without running a real 300s command. The mock also lets us
//   simulate success / failure / timeout for the kill-path test.
//
//   IMPORTANT: vi.mock is file-scoped in vitest — other test files (eg.
//   skill-shell.test.ts) still run real commands because they don't mock
//   node:child_process.

import { describe, test, expect, vi, beforeEach } from "vitest";

// ─── exec mock state (hoisted so vi.mock factory can read it) ──────────────
const execState = vi.hoisted(() => ({
  // Most recent opts passed to execFile. Reset in beforeEach.
  lastOpts: null as any,
  // Last (file, args) tuple passed to execFile.
  lastCall: null as { file: string; args: string[] } | null,
  // What the next exec invocation should resolve/reject with. Reset in beforeEach.
  nextResult: { kind: "success", stdout: "ok", stderr: "" } as {
    kind: "success" | "fail" | "timeout";
    stdout?: string;
    stderr?: string;
    code?: number;
  },
}));

// Mock node:util's promisify to identity, so that bash.ts's
// `promisify(execFile)` simply IS our mocked execFile (which returns a Promise).
vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: (fn: any) => fn,
  };
});

// Mock node:child_process. execFile returns a Promise (because promisify is
// identity above). Bash.ts casts the resolved value to {stdout: Buffer, stderr:
// Buffer}, so we resolve with that shape.
vi.mock("node:child_process", () => ({
  execFile: (file: string, args: string[], opts: any): Promise<{ stdout: Buffer; stderr: Buffer }> => {
    execState.lastOpts = opts ?? null;
    execState.lastCall = { file, args };
    const r = execState.nextResult;
    return new Promise((resolve, reject) => {
      process.nextTick(() => {
        if (r.kind === "timeout") {
          // Mimic node's timeout-killed error: err.killed + err.signal=SIGTERM.
          const err: any = new Error("Command killed");
          err.killed = true;
          err.signal = "SIGTERM";
          err.stdout = Buffer.from(r.stdout ?? "");
          err.stderr = Buffer.from(r.stderr ?? "");
          reject(err);
        } else if (r.kind === "fail") {
          const err: any = new Error("Command failed");
          err.code = r.code ?? 1;
          err.status = r.code ?? 1;
          err.stdout = Buffer.from(r.stdout ?? "");
          err.stderr = Buffer.from(r.stderr ?? "");
          reject(err);
        } else {
          resolve({
            stdout: Buffer.from(r.stdout ?? ""),
            stderr: Buffer.from(r.stderr ?? ""),
          });
        }
      });
    });
  },
}));

import { bashTool } from "../../src/tools/bash.js";
import { taskStartTool } from "../../src/tools/task-start.js";
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
    },
  } as any;
}

beforeEach(() => {
  execState.lastOpts = null;
  execState.lastCall = null;
  execState.nextResult = { kind: "success", stdout: "ok", stderr: "" };
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

  test("background:true does NOT invoke execFile (no waiting on the command)", async () => {
    const ctx = makeCtx({ runBackground: () => "bg-fixed-2" });
    await raw({ command: "long-running-watch", background: true }, ctx);
    // execFile must NOT have been called — background returns before exec.
    expect(execState.lastOpts).toBeNull();
    expect(execState.lastCall).toBeNull();
  });

  test("background:true returns synchronously after runBackground (no deferred wait)", async () => {
    // If execute were to await a deferred task, our flag would flip before raw
    // resolves. Here runBackground is sync, so execute must resolve immediately.
    let deferredFired = false;
    const ctx = makeCtx({
      runBackground: () => {
        // schedule something that would only fire on a later tick
        setImmediate(() => { deferredFired = true; });
        return "bg-immediate-1";
      },
    });
    const r = await raw({ command: "x", background: true }, ctx);
    expect((r as any).data.text).toMatch(/task_id: bg-immediate-1/);
    // The deferred work has NOT fired yet (execute didn't await it).
    expect(deferredFired).toBe(false);
    await new Promise((res) => setImmediate(res));
    expect(deferredFired).toBe(true);
  });
});

// ===========================================================================
// Acceptance 2 — background 默认 blocking (无 background → execFile path)
// ===========================================================================

describe("acceptance-2 / item 2: background defaults to blocking", () => {
  test("no background flag → execFile IS invoked (blocking path)", async () => {
    execState.nextResult = { kind: "success", stdout: "BLOCKING_OK", stderr: "" };
    const ctx = makeCtx({
      // runBackground is wired but must NOT be called.
      runBackground: () => "should-not-fire",
    });
    const r = await raw({ command: "echo hi" }, ctx);
    expect(r.ok).toBe(true);
    expect(execState.lastCall).not.toBeNull();
    expect((r as any).data.text).toContain("BLOCKING_OK");
  });

  test("background:false explicit → same as blocking (execFile invoked)", async () => {
    execState.nextResult = { kind: "success", stdout: "EXPLICIT_FALSE_OK", stderr: "" };
    const ctx = makeCtx({ runBackground: () => "should-not-fire" });
    const r = await raw({ command: "echo hi", background: false }, ctx);
    expect(execState.lastCall).not.toBeNull();
    expect((r as any).data.text).toContain("EXPLICIT_FALSE_OK");
  });
});

// ===========================================================================
// Acceptance 3 — timeout 默认 300s
// ===========================================================================

describe("acceptance-2 / item 3: timeout defaults to 300s", () => {
  test("no input timeout, no config → opts.timeout = 300000 (ms)", async () => {
    // No config in callerCtx (no toolConfig.Shell.timeout) and no input.timeout.
    const ctx = makeCtx();
    await raw({ command: "echo default-timeout" }, ctx);
    expect(execState.lastOpts).not.toBeNull();
    expect(execState.lastOpts.timeout).toBe(300000);
  });

  test("even with callerCtx.toolConfig.Shell.timeout set, the default is still 300 (config no longer read)", async () => {
    // Pre-sub-2 the tool read callerCtx.toolConfig?.Shell?.timeout. Post-sub-2
    // that field is ignored. Verify by setting it to a small value and
    // confirming the exec still got 300000ms — proving config is NOT consulted.
    const ctx: any = {
      caller: "internal",
      agentId: "caller",
      workingDir: ".",
      toolConfig: { Shell: { timeout: 5 } },
      delegateFns: {},
    };
    await raw({ command: "echo should-not-be-5" }, ctx);
    expect(execState.lastOpts.timeout).toBe(300000);
  });
});

// ===========================================================================
// Acceptance 4 — timeout input 可覆盖
// ===========================================================================

describe("acceptance-2 / item 4: input timeout overrides default 300s", () => {
  test("input timeout:10 → opts.timeout = 10000 (ms)", async () => {
    const ctx = makeCtx();
    await raw({ command: "echo ten", timeout: 10 }, ctx);
    expect(execState.lastOpts.timeout).toBe(10000);
  });

  test("input timeout:1 → opts.timeout = 1000 (ms) — beats 300s default", async () => {
    const ctx = makeCtx();
    await raw({ command: "echo one", timeout: 1 }, ctx);
    expect(execState.lastOpts.timeout).toBe(1000);
  });
});

// ===========================================================================
// Acceptance 5 — configSchema 去 timeout
// ===========================================================================

describe("acceptance-2 / item 5: configSchema has no timeout", () => {
  test("getToolConfigSchema(bashTool) returns undefined or no field with key 'timeout'", () => {
    // bash.ts's buildTool call passes no configSchema at all — so this should
    // be undefined. Even if it were defined (defensive), no field.key may be
    // 'timeout'.
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
    execState.nextResult = { kind: "success", stdout: "REAL_OUTPUT_42", stderr: "" };
    const ctx = makeCtx();
    const r = await raw({ command: "echo REAL_OUTPUT_42" }, ctx);
    expect(r.ok).toBe(true);
    const text = (r as any).data.text;
    expect(text).toContain("REAL_OUTPUT_42");
    expect(text).toMatch(/\[Completed in [\d.]+s\]/);
  });

  test("formatted output (LLM-facing) contains stdout + completion marker", async () => {
    execState.nextResult = { kind: "success", stdout: "FMT_OUTPUT", stderr: "" };
    const ctx = makeCtx();
    const text = await run({ command: "echo FMT_OUTPUT" }, ctx);
    expect(text).toContain("FMT_OUTPUT");
    expect(text).toMatch(/\[Completed in [\d.]+s\]/);
  });

  test("non-zero exit (fail path) → text contains 'Exit code N' + completion", async () => {
    execState.nextResult = { kind: "fail", stdout: "PARTIAL", stderr: "boom", code: 42 };
    const ctx = makeCtx();
    const r = await raw({ command: "exit 42" }, ctx);
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

describe("acceptance-2 / item 7: TaskStart{type:shell} still works", () => {
  const execStart = getToolExecute(taskStartTool)!;
  const fmtStart = getToolFormat(taskStartTool)!;

  test("type:shell → callerCtx.delegateFns.runBackground, returns task_id", async () => {
    let capturedCmd: string | null = null;
    const ctx: any = {
      caller: "internal",
      agentId: "caller",
      workingDir: ".",
      delegateFns: {
        runBackground: (cmd: string) => { capturedCmd = cmd; return "ts-bg-1"; },
        getTaskResult: () => null,
      },
    };
    const text = await fmtStart(await execStart({ type: "shell", command: "npm test" }, ctx));
    expect(text).toMatch(/task_id: ts-bg-1/);
    expect(capturedCmd).toBe("npm test");
    // Must not have invoked our mocked execFile — TaskStart routes through
    // delegateFns.runBackground, not bash.ts's exec path.
    expect(execState.lastCall).toBeNull();
  });
});

// ===========================================================================
// Acceptance 8 — ToolsPage 不渲染 Shell timeout config (静态:configSchema 空)
// ===========================================================================
//
// ToolsPage.tsx (around line 319) renders config fields by iterating
// selectedTool.configSchema with the guard `selectedTool.configSchema?.length > 0`.
// With configSchema undefined/empty, the entire config tab body is skipped and
// "No configurable parameters." is shown. We assert the schema-side invariant
// here; UI render is a mechanical consequence.

describe("acceptance-2 / item 8: ToolsPage will not render Shell timeout (configSchema empty)", () => {
  test("configSchema is empty or undefined → ToolsPage render guard skips it", () => {
    // ToolsPage.tsx:319 guard: `selectedTool.configSchema?.length > 0`.
    const renderableLen = (schema ?? []).length;
    expect(renderableLen).toBe(0);
  });

  test("no configSchema field with key 'timeout' would render", () => {
    // Render guard aside: even if iteration ran, no field has key 'timeout'.
    const keys = (schema ?? []).map((f: any) => f.key);
    expect(keys).not.toContain("timeout");
  });
});

// ===========================================================================
// Extra — timeout still kills (sub-2 不做转后台; sub-3 才改)
// ===========================================================================
//
// Acceptance-2's "不破坏" lens: the foreground timeout path must still kill
// (return "Command timed out") rather than auto-background. bash.ts's catch
// block `if (err.killed)` returns the timeout text. This must NOT have changed
// into a background dispatch (sub-3's scope).

describe("extra: foreground timeout still kills (no auto-background in sub-2)", () => {
  test("killed error → text 'Command timed out after Ns', ok:false, exitCode:-1", async () => {
    execState.nextResult = { kind: "timeout", stdout: "", stderr: "" };
    const ctx = makeCtx({
      // If sub-2 accidentally turned timeout into background, runBackground
      // would fire. Wire it to assert it does NOT.
      runBackground: () => "should-not-fire-bg",
    });
    const r = await raw({ command: "sleep 9999", timeout: 5 }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).data.exitCode).toBe(-1);
    const text = (r as any).data.text;
    expect(text).toMatch(/Command timed out after 5s/);
    expect(text).toContain("sleep 9999");
    // Critical: timeout must NOT have produced a task_id.
    expect(text).not.toMatch(/task_id/);
    // And runBackground must not have been invoked (no auto-bg in sub-2).
    // We can't directly assert call count on the mock, but execFile WAS
    // called (blocking path) — confirming we went through exec, not bg.
    expect(execState.lastCall).not.toBeNull();
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
      // No delegateFns at all — UI dispatcher preview path.
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
        // runBackground intentionally absent.
        getTaskResult: () => null,
      },
    };
    const r = await raw({ command: "x", background: true }, ctx);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/not available/i);
  });

  test("background:true surfaces launch failures synchronously (status:failed)", async () => {
    // If runBackground's spawn fails immediately, the registry marks the task
    // 'failed' and the next getTaskResult reflects it. Bash surfaces that as
    // ok:true (launch returned a task_id) but with a "failed to launch" text.
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
//
// Exercised outside vitest — the verifier report captures build:lib exit code.
// The sentinel below proves the module loads (a TS error would surface at
// build, not at runtime, but importing confirms no runtime wiring issue).

describe("acceptance-2 / item 9: typecheck sentinel", () => {
  test("bashTool + helpers are importable (module loads)", () => {
    expect(typeof bashTool).toBe("object");
    expect(typeof exec).toBe("function");
    expect(typeof fmt).toBe("function");
  });
});
