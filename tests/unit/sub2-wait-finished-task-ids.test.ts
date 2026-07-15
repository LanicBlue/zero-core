// sub-2 (Wait #7 until-optional + #8 finishedTaskIds): adversarial unit tests.
//
// Independent verification of docs/plan/tool-quality-pass/acceptance-2.md.
// Written by the sub-2 verifier — does NOT trust the implementer's claims.
// Each block names the acceptance case it encodes (1-12).
//
// Two layers exercised:
//   - TaskRegistry.suspendUntilWake — the finishedTaskIds collection core
//     (pure registry, no DB, no model, no IPC). Deterministic + fast.
//   - waitTool.__execute — the LLM-facing text + structured data shape,
//     driven through a real TaskRegistry via a stub callerCtx.delegateFns.
//
// Plus direct zod inputSchema.parse for the #7 boundary cases.

import { describe, test, expect, beforeEach } from "vitest";
import { TaskRegistry } from "../../src/runtime/task-registry.js";
import { waitTool } from "../../src/tools/wait.js";

// ==========================================================================
// #7 until optional + timeout bounds (inputSchema layer)
// ==========================================================================
describe("sub-2 #7 inputSchema — until optional + timeout min/max bounds", () => {
	// AI SDK exposes the zod schema directly on the tool object.
	const schema = (waitTool as any).inputSchema
		?? (waitTool as any).inputJSONSchema
		?? (waitTool as any).jsonSchema;

	test("#7.1 timeout-only is accepted by zod (until omitted) — schema bug fixed", () => {
		expect(() => schema.parse({ timeout: 2 })).not.toThrow();
	});

	test("#7.2 until-only is accepted (no regression)", () => {
		expect(() => schema.parse({ until: "2026-07-13T10:00:00Z" })).not.toThrow();
	});

	test("#7.3 neither field is accepted by zod (execute handles the immediate-wake path)", () => {
		// Both optional now — zod passes; execute returns immediate wake.
		expect(() => schema.parse({})).not.toThrow();
	});

	test("#7.4a timeout:1 accepted (lower bound inclusive)", () => {
		expect(() => schema.parse({ timeout: 1 })).not.toThrow();
	});

	test("#7.4b timeout:0 rejected (min(1))", () => {
		expect(() => schema.parse({ timeout: 0 })).toThrow();
	});

	test("#7.4c timeout:0.5 rejected (below min(1))", () => {
		expect(() => schema.parse({ timeout: 0.5 })).toThrow();
	});

	test("#7.4d timeout:4000 rejected (max(3600))", () => {
		expect(() => schema.parse({ timeout: 4000 })).toThrow();
	});

	test("#7.4e timeout:3600 accepted (upper bound inclusive)", () => {
		expect(() => schema.parse({ timeout: 3600 })).not.toThrow();
	});
});

// ==========================================================================
// #8 TaskRegistry.suspendUntilWake — finishedTaskIds collection (core)
// Includes the CRITICAL #6 multi-task race test.
// ==========================================================================
describe("sub-2 #8 TaskRegistry.suspendUntilWake — finishedTaskIds plumbing", () => {
	let reg: TaskRegistry;
	beforeEach(() => { reg = new TaskRegistry(); });

	// #5: single task finishes during wait → finishedTaskIds = [id]
	test("#5 single complete during wait → finishedTaskIds=[id]", async () => {
		reg.create("t1", "bash", "work");
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		reg.complete("t1", "done");
		const res = await p;
		expect(res.reason).toBe("task finished");
		expect(res.finishedTaskIds, "id recorded").toEqual(["t1"]);
	});

	// ─── #6 MULTI-TASK RACE (acceptance #6) ───────────────────────────────
	// ADVERSARIAL: implementer guards push with `if (this.waitResolver)`. The
	// resolver's `finish` callback sets waitResolver=null SYNCHRONOUSLY when
	// the first task resolves it. So a second task terminating in the same
	// tick — after the first complete() returned but before the awaited
	// promise actually resumes — sees waitResolver===null and SKIPS the push.
	//
	// We construct that exact scenario: two running tasks, suspend Wait, then
	// synchronously call complete(t1) + kill(t2) with NO await between, then
	// await the wake result. Acceptance requires BOTH ids listed.
	test("#6 RACE: complete(t1) + kill(t2) same tick → BOTH ids must be listed", async () => {
		reg.create("t1", "bash", "work");
		reg.create("t2", "bash", "work");
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		// The Promise executor runs synchronously inside suspendUntilWake, so
		// waitResolver is set before this await yields. The await is defensive.
		await Promise.resolve();
		// TWO terminal transitions back-to-back, NO await between — this is
		// the race window.
		reg.complete("t1", "done");
		reg.kill("t2");
		const res = await p;
		expect(res.reason).toBe("task finished");
		// Acceptance #6: BOTH ids must appear.
		expect(
			res.finishedTaskIds,
			"RACE: both t1 and t2 must be in finishedTaskIds; if only [t1], the waitResolver guard skipped the second push"
		).toEqual(expect.arrayContaining(["t1", "t2"]));
		expect(res.finishedTaskIds?.length).toBe(2);
	});

	// #6 variant: complete + fail (different terminal paths) same tick
	test("#6 RACE variant: complete(t1) + fail(t2) same tick → BOTH ids", async () => {
		reg.create("t1", "bash", "work");
		reg.create("t2", "bash", "work");
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		reg.complete("t1", "done");
		reg.fail("t2", "boom");
		const res = await p;
		expect(res.reason).toBe("task finished");
		expect(res.finishedTaskIds).toEqual(expect.arrayContaining(["t1", "t2"]));
		expect(res.finishedTaskIds?.length).toBe(2);
	});

	// #6 variant: complete + acknowledge (acknowledge on a pre-terminated task)
	test("#6 RACE variant: complete(t1) + acknowledge(t2) same tick → BOTH ids", async () => {
		reg.create("t1", "bash", "work");
		reg.create("t2", "bash", "work");
		// Pre-complete t2 while NO Wait is active — should NOT be recorded
		// (waitResolver is null at this point; push guard skips).
		reg.complete("t2", "pre-done");
		// Now suspend Wait, then drive two terminal transitions sync.
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		reg.complete("t1", "done");
		reg.acknowledge("t2"); // t2 is already terminal → acknowledge succeeds
		const res = await p;
		expect(res.reason).toBe("task finished");
		expect(res.finishedTaskIds).toEqual(expect.arrayContaining(["t1", "t2"]));
		expect(res.finishedTaskIds?.length).toBe(2);
	});

	// #8: wake → drain → second Wait starts from empty
	test("#8 second Wait finishedTaskIds starts empty (no residual from first)", async () => {
		reg.create("t1", "bash", "work");
		reg.create("t2", "bash", "work");

		// First Wait: complete t1 mid-wait → finishedTaskIds=[t1]
		const until1 = new Date(Date.now() + 5000).toISOString();
		const p1 = reg.suspendUntilWake({ until1 });
		await Promise.resolve();
		reg.complete("t1", "done");
		const res1 = await p1;
		expect(res1.finishedTaskIds).toEqual(["t1"]);

		// BETWEEN waits: complete t2. waitResolver is null → not recorded.
		reg.complete("t2", "between");

		// Second Wait: no tasks complete during it; short timeout wakes it.
		const res2 = await reg.suspendUntilWake({ timeoutSec: 0.05 });
		expect(res2.reason).toBe("timeout");
		// Critical: second wake does NOT carry t1 (drained) nor t2 (between-wait).
		expect(res2.finishedTaskIds ?? []).not.toContain("t1");
		expect(res2.finishedTaskIds ?? []).not.toContain("t2");
		expect(res2.finishedTaskIds ?? []).toHaveLength(0);
	});

	// #9a: timeout wake → finishedTaskIds absent / empty
	test("#9a timeout wake → finishedTaskIds absent or empty", async () => {
		const res = await reg.suspendUntilWake({ timeoutSec: 0.05 });
		expect(res.reason).toBe("timeout");
		expect(res.finishedTaskIds ?? []).toHaveLength(0);
	});

	// #9b: user-input wake → finishedTaskIds absent (only attached for task-finished)
	test("#9b user-input wake → finishedTaskIds absent (user input wins reason)", async () => {
		reg.create("t1", "bash", "work");
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		// Fire user-input AND task-finish in the same tick. user-input has
		// priority (resolver sees it first); reason becomes "user input".
		reg.interruptWaitForUserInput();
		reg.complete("t1", "done");
		const res = await p;
		expect(res.reason).toBe("user input");
		// finishedTaskIds is only attached when reason === "task finished".
		expect(res.finishedTaskIds, "user-input wake must NOT carry finishedTaskIds").toBeUndefined();
	});

	// #10a: kill during wait → recorded
	test("#10a kill during wait → finishedTaskIds=[id]", async () => {
		reg.create("t1", "bash", "work", new AbortController());
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		reg.kill("t1");
		const res = await p;
		expect(res.reason).toBe("task finished");
		expect(res.finishedTaskIds).toEqual(["t1"]);
	});

	// #10b: fail during wait → recorded
	test("#10b fail during wait → finishedTaskIds=[id]", async () => {
		reg.create("t1", "bash", "work");
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		reg.fail("t1", "boom");
		const res = await p;
		expect(res.reason).toBe("task finished");
		expect(res.finishedTaskIds).toEqual(["t1"]);
	});

	// #10c: acknowledge during wait → recorded
	test("#10c acknowledge during wait → finishedTaskIds=[id]", async () => {
		reg.create("t1", "bash", "work");
		// Make t1 terminal first so acknowledge() is willing to drop it.
		reg.complete("t1", "pre-done");
		const until = new Date(Date.now() + 5000).toISOString();
		const p = reg.suspendUntilWake({ until });
		await Promise.resolve();
		reg.acknowledge("t1");
		const res = await p;
		expect(res.reason).toBe("task finished");
		expect(res.finishedTaskIds).toEqual(["t1"]);
	});
});

// ==========================================================================
// waitTool.__execute — LLM-facing text + structured data shape (#5, #7-struct, #9)
// ==========================================================================
describe("sub-2 waitTool.execute — text + structured data finishedTaskIds", () => {
	function makeCallerCtx(reg: TaskRegistry): any {
		return {
			caller: "internal" as const,
			toolCallId: "tc-test",
			delegateFns: {
				suspendUntilWake: (opts: any) => reg.suspendUntilWake(opts),
				beginWait: () => {},
				endWait: () => {},
				setWaitStartedAt: () => {},
			},
		};
	}
	// Raw execute (buildTool wraps it; __execute is the original).
	const execute = (waitTool as any).__execute;

	test("#5 execute: task complete during wait → text has 'finishedTaskIds: [id]', data.finishedTaskIds=[id]", async () => {
		const reg = new TaskRegistry();
		reg.create("t1", "bash", "work");
		const ctx = makeCallerCtx(reg);
		const until = new Date(Date.now() + 5000).toISOString();
		const execP = execute({ until }, ctx);
		await Promise.resolve();
		reg.complete("t1", "done");
		const result = await execP;
		expect(result.ok).toBe(true);
		expect(result.data.text).toContain("woke: task finished");
		expect(result.data.text).toContain("finishedTaskIds: [t1]");
		expect(result.data.finishedTaskIds).toEqual(["t1"]);
		expect(result.data.reason).toBe("task finished");
	});

	test("#7-structured execute: data.finishedTaskIds matches text (two ids)", async () => {
		const reg = new TaskRegistry();
		reg.create("aa", "bash", "work");
		reg.create("bb", "bash", "work");
		const ctx = makeCallerCtx(reg);
		const until = new Date(Date.now() + 5000).toISOString();
		const execP = execute({ until }, ctx);
		await Promise.resolve();
		reg.complete("aa", "done");
		reg.fail("bb", "boom");
		const result = await execP;
		expect(result.ok).toBe(true);
		// data.finishedTaskIds carries both
		expect(result.data.finishedTaskIds).toEqual(expect.arrayContaining(["aa", "bb"]));
		expect(result.data.finishedTaskIds?.length).toBe(2);
		// text contains both ids + the segment marker
		expect(result.data.text).toContain("finishedTaskIds:");
		expect(result.data.text).toContain("aa");
		expect(result.data.text).toContain("bb");
	});

	test("#9 execute: timeout-only wake → text has NO finishedTaskIds segment, data.finishedTaskIds undefined", async () => {
		const reg = new TaskRegistry();
		const ctx = makeCallerCtx(reg);
		// Calling __execute directly bypasses zod, so timeout=0.05 is fine here
		// (the schema's min(1) would reject it on the LLM path — see #7 tests).
		const result = await execute({ timeout: 0.05 }, ctx);
		expect(result.ok).toBe(true);
		expect(result.data.reason).toBe("timeout");
		expect(result.data.text).not.toContain("finishedTaskIds");
		expect(result.data.finishedTaskIds).toBeUndefined();
	});

	test("#3 execute: neither until nor timeout → immediate wake text", async () => {
		const reg = new TaskRegistry();
		const ctx = makeCallerCtx(reg);
		const result = await execute({}, ctx);
		expect(result.ok).toBe(true);
		expect(result.data.text).toMatch(/immediate wake/);
		expect(result.data.reason).toBe("timeout");
	});
});
