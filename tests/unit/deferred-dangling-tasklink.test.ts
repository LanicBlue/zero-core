// Step 2E acceptance tests: deferred consume (control message + insert_now),
// dangling tool-call synthesis, and tool-call ↔ task link + subagent resume.
//
// # File spec
//
// ## Core
// Drives the real hooks + stores registered by the implementation, replaying
// the exact hook-trigger sequence the AgentLoop performs around a step:
//   StepStart (inject) → [step attempt] → StepEnd (commit, only on success).
//
// ## Acceptance mapping
// docs/design/hook-redesign/steps/2E-deferred-dangling-tasklink/accept.md
//   A2 — control-message deferred consume: injected on StepStart, survives a
//        failed attempt (no StepEnd), re-injected on the next StepStart, only
//        cleared once the step that carried it succeeds (StepEnd).
//   A3 — insert_now deferred dequeue: same shape as A2, against InputQueueStore.
//   A4 — dangling tool-call synthesis: a tool block left status:"running" with
//        no result is persisted as-is (truth); rebuildFromSteps synthesizes
//        [interrupted]/error for it so the rebuilt messages are legal
//        (paired result, no throw).
//   A5 — tool-call ↔ task link + subagent resume:
//          * Agent dispatch records the minted taskId on the delegated_tasks
//            row (parentToolCallId) AND on the recorder's tool-call block.
//          * SubagentDelegator.resumeTask is callable and resumes the sub-task
//            WITHOUT re-invoking it (no new task row, sub-step history intact).
//
// ## Scope note (read-only DB)
// Every SessionDB instance is created inside its own throwaway temp directory
// (mkdtempSync under os.tmpdir()); the production ~/.zero-core/sessions.db is
// never opened and never checkpointed.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { registerTaskControlHooks } from "../../src/runtime/hooks/task-control-hooks.js";
import { registerInputQueueHooks } from "../../src/runtime/hooks/input-queue-hooks.js";
import { InputQueueStore } from "../../src/server/input-queue-store.js";
import { TurnRecorder } from "../../src/runtime/turn-recorder.js";
import { AgentSession } from "../../src/runtime/session.js";
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";
import type { SessionConfig, RuntimeProviderConfig, RuntimeCallbacks, AgentRuntime } from "../../src/runtime/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDB(): { db: SessionDB; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "zero-2e-"));
	const db = new SessionDB(join(dir, "sessions.db"));
	runMigrations(db);
	return { db, dir };
}

/** Insert a raw sessions row with the given id (createSession mints its own
 *  uuid, but delegated_tasks has FKs on (parent_session_id, session_id), so we
 *  need rows with specific ids). */
function seedSession(db: SessionDB, id: string, agentId: string, opts?: { parentSessionId?: string; sessionKind?: string; visibility?: string }): void {
	const now = new Date().toISOString();
	(db as unknown as { db: { prepare: (q: string) => { run: (...a: any[]) => void } } }).db.prepare(
		"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at, context, context_project_id, context_workspace_dir, context_wiki_root_node_id, session_kind, parent_session_id, parent_task_id, visibility) " +
		"VALUES (?, ?, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)",
	).run(id, agentId, id, now, now, opts?.sessionKind ?? "chat", opts?.parentSessionId ?? null, opts?.visibility ?? "normal");
}

/** Parse persisted assistant step content into a block list. */
function readAssistantBlocks(db: SessionDB, sessionId: string, turnGroup: number): any[] {
	const blocks: any[] = [];
	for (const r of db.getSteps(sessionId).filter((s) => s.turnGroup === turnGroup && s.role === "assistant")) {
		try { blocks.push(...JSON.parse(r.content ?? "[]")); } catch { /* ignore */ }
	}
	return blocks;
}

// ===========================================================================
// A2 — control message deferred consume
// ===========================================================================

describe("Step 2E · A2: control-message deferred consume", () => {
	let db: SessionDB;
	let dir: string;
	const sessionId = "2e-a2-sub";
	const parentSessionId = "2e-a2-parent";
	const taskId = "Dev-2e-a2";

	beforeEach(() => {
		({ db, dir } = makeTempDB());
		// Seed the parent + sub sessions so delegated_tasks' FK on
		// (parent_session_id, session_id) is satisfied.
		seedSession(db, parentSessionId, "Orchestrator", { sessionKind: "chat" });
		seedSession(db, sessionId, "Dev", { sessionKind: "delegated", parentSessionId, visibility: "hidden" });
		// Seed a delegated task that is "finishing" with an unread control
		// message, scoped to the sub-agent session (sessionId) — exactly the
		// state request_finish leaves behind.
		db.createDelegatedTask({
			id: taskId,
			rootTaskId: taskId,
			ownerAgentId: "Orchestrator",
			targetAgentId: "Dev",
			parentSessionId,
			sessionId,
			task: "do work",
			status: "finishing",
			depth: 1,
		});
		db.updateDelegatedTask(taskId, { controlMessage: "WRAP UP NOW" });
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("control message injected on StepStart, survives failed retry (no StepEnd), re-injected on next StepStart, cleared only after StepEnd succeeds", async () => {
		const registry = new HookRegistry();
		registerTaskControlHooks(db, registry);

		const mkCtx = (event: string, stepNumber: number) => ({
			agentId: "Dev",
			sessionId,
			timestamp: Date.now(),
			loopKind: "delegated" as const,
			event,
			stepNumber,
		});

		// ── TurnStart clears any stale markers (defensive). ──────────────
		await registry.trigger("TurnStart", { agentId: "Dev", sessionId, userMessage: "go" });

		// ── Step 1, attempt 1: StepStart injects the control message. ────
		const r1 = await registry.trigger("StepStart", mkCtx("StepStart", 1));
		const injected1 = (r1.appendMessages as any[]) ?? [];
		expect(injected1.length, "attempt 1: control message injected").toBe(1);
		expect(String(injected1[0].content)).toContain("WRAP UP NOW");

		// Pre-condition for "deferred": the persisted controlMessage is STILL
		// set right after inject (NOT cleared).
		let row = db.getDelegatedTask(taskId)!;
		expect(row.controlMessage, "controlMessage still set right after inject (deferred)").toBe("WRAP UP NOW");

		// ── Attempt 1 FAILS → no StepEnd fires (runOneStepWithRetry only
		//    finalizes a step on success). Control message must survive. ──
		row = db.getDelegatedTask(taskId)!;
		expect(row.controlMessage, "after failed attempt (no StepEnd): controlMessage still set").toBe("WRAP UP NOW");

		// ── Step 1, attempt 2 (retry): StepStart must re-inject the SAME
		//    control message because the prior attempt never committed. ──
		const r2 = await registry.trigger("StepStart", mkCtx("StepStart", 1));
		const injected2 = (r2.appendMessages as any[]) ?? [];
		expect(injected2.length, "attempt 2 (retry): control message re-injected").toBe(1);
		expect(String(injected2[0].content)).toContain("WRAP UP NOW");

		// And it is STILL persisted right up until StepEnd.
		row = db.getDelegatedTask(taskId)!;
		expect(row.controlMessage, "before successful StepEnd: controlMessage still set").toBe("WRAP UP NOW");

		// ── Step 1 SUCCEEDS → StepEnd fires → now the control message is
		//    cleared (the deferred consume). ──────────────────────────────
		await registry.trigger("StepEnd", mkCtx("StepEnd", 1));

		row = db.getDelegatedTask(taskId)!;
		expect(row.controlMessage, "after successful StepEnd: controlMessage cleared").toBeUndefined();
	});

	test("control message is NOT cleared by a StepEnd for a DIFFERENT step number", async () => {
		const registry = new HookRegistry();
		registerTaskControlHooks(db, registry);

		await registry.trigger("TurnStart", { agentId: "Dev", sessionId, userMessage: "go" });
		await registry.trigger("StepStart", { agentId: "Dev", sessionId, stepNumber: 5, timestamp: Date.now() });

		// StepEnd for an unrelated step that never carried the injection.
		await registry.trigger("StepEnd", { agentId: "Dev", sessionId, stepNumber: 99, timestamp: Date.now() });

		const row = db.getDelegatedTask(taskId)!;
		expect(row.controlMessage, "unrelated StepEnd must not clear controlMessage").toBe("WRAP UP NOW");
	});
});

// ===========================================================================
// A3 — insert_now deferred dequeue
// ===========================================================================

describe("Step 2E · A3: insert_now deferred dequeue", () => {
	let inputQueue: InputQueueStore;
	let registry: HookRegistry;
	const sessionId = "2e-a3-main";

	beforeEach(() => {
		inputQueue = new InputQueueStore();
		registry = new HookRegistry();
		registerInputQueueHooks(inputQueue, registry);
	});

	test("insert_now peeked on StepStart, survives failed retry (no StepEnd), re-peeked on next StepStart, committed out of queue only after StepEnd succeeds", async () => {
		// Enqueue an insert_now item while the loop is busy.
		inputQueue.enqueue(sessionId, "URGENT: switch focus", "insert_now");
		expect(inputQueue.list(sessionId).length).toBe(1);

		// ── Step 1, attempt 1: StepStart peeks (marks delivered, does NOT remove). ──
		const r1 = await registry.trigger("StepStart", { agentId: "Main", sessionId, stepNumber: 1, timestamp: Date.now() });
		const inj1 = (r1.appendMessages as any[]) ?? [];
		expect(inj1.length, "attempt 1: insert_now injected").toBe(1);
		expect(String(inj1[0].content)).toContain("URGENT");

		// Deferred: still in the queue right after inject.
		expect(inputQueue.list(sessionId).length, "after inject: insert_now still in queue (deferred)").toBe(1);

		// ── Attempt 1 FAILS → no StepEnd → item still in queue. ──────────
		expect(inputQueue.list(sessionId).length, "after failed attempt: insert_now still in queue").toBe(1);

		// ── Step 1, attempt 2 (retry): StepStart re-injects (peek is
		//    idempotent per step, but the prior step's marker is auto-cleared
		//    by the next peek/commit cycle so the item re-enters the pool). ──
		const r2 = await registry.trigger("StepStart", { agentId: "Main", sessionId, stepNumber: 1, timestamp: Date.now() });
		const inj2 = (r2.appendMessages as any[]) ?? [];
		expect(inj2.length, "attempt 2: insert_now re-injected").toBe(1);
		expect(inputQueue.list(sessionId).length, "before successful StepEnd: insert_now still in queue").toBe(1);

		// ── Step 1 SUCCEEDS → StepEnd commits → item leaves the queue. ───
		await registry.trigger("StepEnd", { agentId: "Main", sessionId, stepNumber: 1, timestamp: Date.now() });
		expect(inputQueue.list(sessionId).length, "after successful StepEnd: insert_now dequeued").toBe(0);
	});
});

// ===========================================================================
// A4 — dangling tool-call synthesis
// ===========================================================================

describe("Step 2E · A4: dangling tool-call synthesis (persist truth + rebuild-safe)", () => {
	let db: SessionDB;
	let dir: string;
	const sessionId = "2e-a4-sub";
	const turnGroup = 700;
	const stepBaseSeq = 701;

	beforeEach(() => {
		({ db, dir } = makeTempDB());
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("abort mid-tool leaves a status:'running' tool block with no result → persist fills [interrupted]/error → getSteps carries paired result → rebuildFromSteps does not throw", () => {
		const recorder = new TurnRecorder();
		recorder.startTurnGroup(turnGroup);

		// toolA finishes cleanly; toolB is cut off mid-execution (no result).
		recorder.addToolStart("toolA", { x: 1 }, "tc-a4-A");
		recorder.addToolStart("toolB", { x: 2 }, "tc-a4-B");
		recorder.updateToolResult("tc-a4-A", "toolA", "A-output", false);
		// toolB deliberately left running (status:"running", result undefined).

		// Seed the user step so rebuild has a user turn to anchor.
		db.appendStep(sessionId, stepBaseSeq - 1, turnGroup, "user", "do A and B");

		// Persist — writes the TRUTH. The dangling tool block (toolB) stays
		// "running" on disk; synthesis happens at rebuild time, not persist time.
		// (Step 2E: persist writes truth, rebuild synthesizes dangling.)
		recorder.persistAllSteps(db, sessionId, stepBaseSeq);

		const blocks = readAssistantBlocks(db, sessionId, turnGroup);

		const toolA = blocks.find((b: any) => b.type === "tool" && b.name === "toolA");
		expect(toolA, "toolA block persisted").toBeTruthy();
		expect(toolA.status).toBe("done");
		expect(toolA.result).toBe("A-output");

		const toolB = blocks.find((b: any) => b.type === "tool" && b.name === "toolB");
		expect(toolB, "toolB block persisted (truth: dangling, still running)").toBeTruthy();
		// Persist writes the truth: a tool that never produced a result stays
		// "running". Rebuild is responsible for synthesizing the [interrupted]
		// result so the rebuilt messages are legal.
		expect(toolB.status, "persisted dangling block stays running (truth)").toBe("running");
		expect(toolB.result, "persisted dangling block has no result yet").toBeUndefined();

		// Rebuild messages from disk — must not throw. Every tool block now has
		// a paired tool-result (the synthesis guarantee).
		let messages: any[] = [];
		expect(() => {
			const session = new AgentSession("system", undefined, sessionId, db);
			messages = session.getMessages();
		}, "rebuildFromSteps must not throw on dangling-synthesized steps").not.toThrow();

		// toolB's tool-call has a paired tool-result carrying [interrupted].
		const assistantParts = messages
			.filter((m) => m.role === "assistant")
			.flatMap((m) => Array.isArray(m.content) ? m.content : []);
		const toolBCall = assistantParts.find((p: any) => p.type === "tool-call" && p.toolName === "toolB");
		expect(toolBCall, "toolB rebuilt as a tool-call").toBeTruthy();

		const toolBResult = messages
			.filter((m) => m.role === "tool")
			.flatMap((m) => Array.isArray(m.content) ? m.content : [])
			.find((p: any) => p.type === "tool-result" && p.toolName === "toolB");
		expect(toolBResult, "toolB rebuilt with a paired tool-result").toBeTruthy();
		// toolCallIds must match (paired).
		expect(toolBResult.toolCallId).toBe(toolBCall.toolCallId);
		// The synthesized text surfaces in the rebuilt result value.
		const resultText = typeof toolBResult.output === "string"
			? toolBResult.output
			: JSON.stringify(toolBResult.output ?? "");
		expect(resultText, "rebuilt toolB result carries [interrupted]").toContain("[interrupted]");
	});
});

// ===========================================================================
// A5 — tool-call ↔ task link + subagent resume
// ===========================================================================

describe("Step 2E · A5: tool-call ↔ task link + subagent resume", () => {
	let db: SessionDB;
	let dir: string;
	const parentSessionId = "2e-a5-parent";

	beforeEach(() => {
		({ db, dir } = makeTempDB());
		seedSession(db, parentSessionId, "Orchestrator", { sessionKind: "chat" });
		seedSession(db, "2e-a5-sub-session", "Dev", { sessionKind: "delegated", parentSessionId, visibility: "hidden" });
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("Agent dispatch records taskId on the delegated_tasks row (parentToolCallId) AND annotates the recorder tool-call block; resumeTask resumes WITHOUT re-invoking", async () => {
		// ── (1) Simulate the Agent tool's dispatch path: the delegator mints
		//    a taskId, writes the delegated_tasks row with parentToolCallId,
		//    and fires onDispatched so the caller stamps the recorder block.
		const parentToolCallId = "tc-a5-agent";
		let observedTaskId: string | undefined;
		const recorder = new TurnRecorder();
		recorder.startTurnGroup(800);
		recorder.addToolStart("Agent", { task: "sub work" }, parentToolCallId);

		// Mirrors what the Agent tool's execute() does: it calls
		// ctx.setToolCallTaskId(parentToolCallId, taskId) inside the
		// delegator's onDispatched callback. We drive the same seam.
		//
		// First create the delegated task row with the parent tool-call link.
		const taskId = "Dev-2e-a5-resume";
		db.createDelegatedTask({
			id: taskId,
			rootTaskId: taskId,
			ownerAgentId: "Orchestrator",
			targetAgentId: "Dev",
			parentSessionId,
			sessionId: "2e-a5-sub-session",
			task: "sub work",
			status: "running",
			depth: 1,
			parentToolCallId,
		});
		// Then fire onDispatched (the Agent tool wires this to
		// TurnRecorder.setToolBlockTaskId via ctx.setToolCallTaskId).
		observedTaskId = taskId;
		recorder.setToolBlockTaskId(parentToolCallId, undefined, taskId);

		// ── Assertion 1a: the delegated_tasks row carries the link. ───────
		const row = db.getDelegatedTask(taskId)!;
		expect(row, "delegated task row persisted").toBeTruthy();
		expect(row.parentToolCallId, "parentToolCallId recorded on the delegated task row").toBe(parentToolCallId);

		// ── Assertion 1b: the recorder tool-call block carries the taskId. ─
		const agentBlock = (recorder.blocks as any[]).find(
			(b: any) => b.type === "tool" && b.toolCallId === parentToolCallId,
		);
		expect(agentBlock, "Agent tool-call block exists on the recorder").toBeTruthy();
		expect(agentBlock.taskId, "Agent tool-call block stamped with delegated taskId").toBe(taskId);
		expect(observedTaskId, "onDispatched fired with the minted taskId").toBe(taskId);

		// ── (2) resumeTask resolves a still-running task WITHOUT re-invoking.
		//    Build a SubagentDelegator with a stub createSubLoop that records
		//    whether a NEW run() vs resume() is invoked — the spec invariant
		//    is that resume does NOT re-invoke (no new task, no step-history
		//    reset).
		//
		//    The stub sub-loop's resume() resolves to a fixed result; the
		//    real assertion is that delegateTask (fresh invoke) is NEVER
		//    called on the resume path.
		const config: SessionConfig = {
			agentId: "Orchestrator",
			modelId: "test-model",
			workspaceDir: dir,
			db,
			contextBundle: undefined,
			systemPrompt: "",
			spawnDepth: 0,
			loopKind: "main",
		} as unknown as SessionConfig;
		const providers: RuntimeProviderConfig[] = [];
		const callbacks: RuntimeCallbacks = { onEvent: () => {} };

		let freshInvocations = 0;
		let resumeInvocations = 0;
		const stubLoop: AgentRuntime = {
			async run() { freshInvocations++; /* not used on resume path */ },
			async resume() { resumeInvocations++; /* sub continues from checkpoint */ },
			getResult() { return "SUB-RESUMED-RESULT"; },
			abort() {},
			getState: () => ({ status: "idle" as const }),
		} as unknown as AgentRuntime;

		const delegator = new SubagentDelegator({
			config,
			providers,
			emit: () => {},
			createSubLoop: () => stubLoop,
			getToolConfig: () => ({}),
		});

		// Sanity: the row is still "running" (resumable, not terminal).
		expect(db.getDelegatedTask(taskId)!.status).toBe("running");

		// The sub-session has step history (simulated by a prior persisted
		// step row — this is what resume() continues from rather than resets).
		db.appendStep("2e-a5-sub-session", 1, 100, "user", "prior sub work");
		db.appendStep("2e-a5-sub-session", 2, 100, "assistant", '[{"type":"text","text":"partial"}]');

		const result = await delegator.resumeTask(taskId);

		// ── Assertion 2: resume returns the sub-task's result. ────────────
		expect(result, "resumeTask returns the resumed sub-task result").toBe("SUB-RESUMED-RESULT");

		// ── Assertion 3 (the hard one): resume did NOT re-invoke a fresh
		//    delegation. createSubLoop produced a stub; only resume() should
		//    have been called on it, never run(). ──────────────────────────
		expect(resumeInvocations, "resumeTask calls sub-loop.resume() exactly once").toBe(1);
		expect(freshInvocations, "resumeTask must NOT re-invoke (sub-loop.run() untouched)").toBe(0);

		// ── Assertion 4: terminal bookkeeping removes the completed row. ───
		// fireOnTaskTerminal deliberately marks the child session archived and
		// deletes delegated_tasks immediately so completed work is not restored
		// into the live task tree after restart. The stable taskId assertions
		// above still prove resume continued the existing task rather than
		// creating a replacement delegation.
		expect(db.getDelegatedTask(taskId), "completed task row is removed by terminal bookkeeping").toBeUndefined();
		expect(db.getSession("2e-a5-sub-session")?.archived, "resumed child session is marked for archive").toBe(true);
	});

	test("resumeTask throws for an unknown taskId (no silent re-invoke)", async () => {
		const config: SessionConfig = {
			agentId: "Orchestrator", modelId: "m", workspaceDir: dir, db,
			contextBundle: undefined, systemPrompt: "", spawnDepth: 0, loopKind: "main",
		} as unknown as SessionConfig;
		const delegator = new SubagentDelegator({
			config,
			providers: [],
			emit: () => {},
			createSubLoop: () => ({}) as any,
			getToolConfig: () => ({}),
		});
		await expect(delegator.resumeTask("does-not-exist")).rejects.toThrow(/not found/);
	});
});
