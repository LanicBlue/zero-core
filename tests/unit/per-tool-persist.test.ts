// Step 2B acceptance test: per-tool result immediate persist.
//
// # 文件说明书
//
// ## 核心功能
// Verifies the PostToolUse / PostToolUseFailure hooks registered by
// registerTurnHooks upsert the current step row immediately after each tool
// finishes, BEFORE finish-step (StepEnd) fires — the hard precondition for
// case2 recovery (side effect committed → crash before StepEnd would
// otherwise orphan the tool result).
//
// ## 验收对应
// docs/design/hook-redesign/steps/2B-per-tool-persist/accept.md
//   - A2.case1: tool A PostToolUse → block persisted with result + status=done
//     (no finish-step fired yet).
//   - A2.case2: tool B never finished (no PostToolUse) → no B block in DB.
//   - A2.case3: later StepEnd persists the full step (A+B+usage); A's block is
//     not duplicated (upsert keyed on (session_id, seq) is idempotent).
//   - A3: A done + B incomplete state survives getSteps → rebuildFromSteps
//     without throwing, and A's tool-call has a paired tool-result.
//
// ## 设计
// Drives the real pipeline: temporary CoreDatabase + runMigrations (own temp dir,
// never touches ~/.zero-core/sessions.db), a fresh HookRegistry per case,
// registerTurnHooks(sessionDB, registry), and a real TurnRecorder. The
// AgentLoop is NOT instantiated — instead we replay the exact sequence of
// recorder mutations + hook triggers the loop performs around tool execution.
// This isolates the per-tool-persist seam from the rest of the loop.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { registerTurnHooks } from "../../src/runtime/hooks/turn-hooks.js";
import { TurnRecorder } from "../../src/runtime/turn-recorder.js";
import { AgentSession } from "../../src/runtime/session.js";

let tmpDir: string;
let sessionDB: CoreDatabase;
let sessionId = "test-session-2b";

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-2b-per-tool-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	runMigrations(sessionDB);
	// Note: do NOT call ensureSession here — it is private on CoreDatabase.
	// appendStep/upsertStep call it internally as needed.
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Parse the persisted assistant step content into a block array. */
function readAssistantBlocks(turnGroup: number): any[] {
	const rows = sessionDB.getSteps(sessionId).filter(
		(s) => s.turnGroup === turnGroup && s.role === "assistant",
	);
	// Flatten all assistant rows for the group into one block list, mirroring
	// how rebuildFromSteps processes them. For the single-step scenarios below
	// there is exactly one assistant row.
	const blocks: any[] = [];
	for (const r of rows) {
		try {
			blocks.push(...JSON.parse(r.content ?? "[]"));
		} catch {
			// leave empty
		}
	}
	return blocks;
}

describe("Step 2B · per-tool result immediate persist (accept.md A2/A3)", () => {
	test("A2.case1: PostToolUse for tool A persists A's tool block with result + status=done, before any finish-step", async () => {
		const registry = new HookRegistry();
		registerTurnHooks(sessionDB, registry);

		const recorder = new TurnRecorder();
		const turnGroup = 100;
		const stepBaseSeq = 101; // assistant step seq for this turn group
		const stepOffset = 0;

		// Replay AgentLoop's recorder state at the moment tool A finishes:
		// turn group started, tools A and B both started (status=running),
		// but only A has produced a result.
		recorder.startTurnGroup(turnGroup);
		recorder.addToolStart("toolA", { arg: 1 }, "tc-A");
		recorder.addToolStart("toolB", { arg: 2 }, "tc-B");

		// AgentLoop fires PostToolUse BEFORE its own updateToolResult call, so
		// we hand the result to the hook directly (the hook applies it to the
		// recorder and then persists). No StepEnd yet.
		await registry.trigger("PostToolUse", {
			sessionId,
			toolCallId: "tc-A",
			toolName: "toolA",
			result: "A-output",
			isError: false,
			recorder,
			stepBaseSeq,
			stepOffset,
		});

		// No finish-step has fired: StepEnd must not have run. Confirm by
		// checking that only the immediate-persist row exists and carries no
		// usage (usage is attached only at StepEnd).
		const steps = sessionDB.getSteps(sessionId).filter((s) => s.turnGroup === turnGroup);
		expect(steps.length).toBe(1);
		expect(steps[0].totalTokens).toBe(0);

		const blocks = readAssistantBlocks(turnGroup);
		const toolA = blocks.find((b: any) => b.type === "tool" && b.name === "toolA");
		expect(toolA, "tool A block must be present after PostToolUse").toBeTruthy();
		expect(toolA.status).toBe("done");
		expect(toolA.result).toBe("A-output");
		expect(toolA.toolCallId).toBe("tc-A");
	});

	test("A2.case2: tool B never received PostToolUse → DB holds no completed B block (B remains running)", async () => {
		const registry = new HookRegistry();
		registerTurnHooks(sessionDB, registry);

		const recorder = new TurnRecorder();
		const turnGroup = 200;
		recorder.startTurnGroup(turnGroup);
		recorder.addToolStart("toolA", { arg: 1 }, "tc-A");
		recorder.addToolStart("toolB", { arg: 2 }, "tc-B");

		// Only A finishes; B's PostToolUse never fires (e.g. crash mid-tool).
		await registry.trigger("PostToolUse", {
			sessionId,
			toolCallId: "tc-A",
			toolName: "toolA",
			result: "A-output",
			isError: false,
			recorder,
			stepBaseSeq: 201,
			stepOffset: 0,
		});

		const blocks = readAssistantBlocks(turnGroup);
		// B's block, if present at all, must still be running (no result).
		const toolB = blocks.find((b: any) => b.type === "tool" && b.name === "toolB");
		if (toolB) {
			expect(toolB.status, "B must not have a result (no PostToolUse)").toBe("running");
			expect(toolB.result, "B must not carry a result").toBeUndefined();
		}
		// No tool block named toolB with status=done may exist.
		const doneB = blocks.find((b: any) => b.type === "tool" && b.name === "toolB" && b.status === "done");
		expect(doneB, "no completed toolB block may be persisted").toBeUndefined();
	});

	test("A2.case3: later StepEnd writes the full step (A+B+usage); A's block is not duplicated (upsert idempotent, seq unchanged)", async () => {
		const registry = new HookRegistry();
		registerTurnHooks(sessionDB, registry);

		const recorder = new TurnRecorder();
		const turnGroup = 300;
		const stepBaseSeq = 301;
		recorder.startTurnGroup(turnGroup);
		recorder.addToolStart("toolA", { arg: 1 }, "tc-A");
		recorder.addToolStart("toolB", { arg: 2 }, "tc-B");

		// 1) A finishes → immediate persist.
		await registry.trigger("PostToolUse", {
			sessionId,
			toolCallId: "tc-A",
			toolName: "toolA",
			result: "A-output",
			isError: false,
			recorder,
			stepBaseSeq,
			stepOffset: 0,
		});

		// Capture the row identity right after the immediate persist.
		const rowsAfterTool = sessionDB.getSteps(sessionId).filter((s) => s.turnGroup === turnGroup);
		expect(rowsAfterTool.length).toBe(1);
		const seqAfterTool = rowsAfterTool[0].seq;

		// 2) B finishes → another immediate persist (same seq, upsert).
		await registry.trigger("PostToolUse", {
			sessionId,
			toolCallId: "tc-B",
			toolName: "toolB",
			result: "B-output",
			isError: false,
			recorder,
			stepBaseSeq,
			stepOffset: 0,
		});

		const rowsAfterB = sessionDB.getSteps(sessionId).filter((s) => s.turnGroup === turnGroup);
		expect(rowsAfterB.length, "no new row created by second upsert").toBe(1);
		expect(rowsAfterB[0].seq, "seq must be unchanged (idempotent upsert)").toBe(seqAfterTool);

		// 3) finish-step seals the step (usage attached) and StepEnd rewrites
		// the same row. AgentLoop calls sealAndAdvanceStep then triggers StepEnd.
		recorder.sealAndAdvanceStep({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
		await registry.trigger("StepEnd", {
			sessionId,
			recorder,
			stepBaseSeq,
			stepOffset: 0,
		});

		const rowsFinal = sessionDB.getSteps(sessionId).filter((s) => s.turnGroup === turnGroup);
		// Still a single assistant row for this step — no duplication.
		expect(rowsFinal.length, "StepEnd must upsert the same row, not insert").toBe(1);
		expect(rowsFinal[0].seq, "seq still unchanged after StepEnd").toBe(seqAfterTool);
		expect(rowsFinal[0].totalTokens, "usage attached by StepEnd").toBe(30);
		expect(rowsFinal[0].inputTokens).toBe(10);
		expect(rowsFinal[0].outputTokens).toBe(20);

		// Content check: exactly one A and one B, both done, with results.
		const blocks = readAssistantBlocks(turnGroup);
		const toolABlocks = blocks.filter((b: any) => b.type === "tool" && b.name === "toolA");
		const toolBBlocks = blocks.filter((b: any) => b.type === "tool" && b.name === "toolB");
		expect(toolABlocks.length, "A appears exactly once (no duplication)").toBe(1);
		expect(toolBBlocks.length, "B appears exactly once").toBe(1);
		expect(toolABlocks[0].status).toBe("done");
		expect(toolABlocks[0].result).toBe("A-output");
		expect(toolBBlocks[0].status).toBe("done");
		expect(toolBBlocks[0].result).toBe("B-output");
	});

	test("A3: in A-done / B-incomplete state, getSteps → rebuildFromSteps does not throw and A's tool-call has a paired tool-result", async () => {
		const registry = new HookRegistry();
		registerTurnHooks(sessionDB, registry);

		const recorder = new TurnRecorder();
		const turnGroup = 400;
		const stepBaseSeq = 401;
		recorder.startTurnGroup(turnGroup);
		recorder.addToolStart("toolA", { arg: 1 }, "tc-A");
		recorder.addToolStart("toolB", { arg: 2 }, "tc-B");

		// Seed a user step for the group so rebuild has a user turn to anchor.
		sessionDB.appendStep(sessionId, stepBaseSeq - 1, turnGroup, "user", "do A and B");

		// Only A finishes; B stays running (crash mid-tool, before StepEnd).
		await registry.trigger("PostToolUse", {
			sessionId,
			toolCallId: "tc-A",
			toolName: "toolA",
			result: "A-output",
			isError: false,
			recorder,
			stepBaseSeq,
			stepOffset: 0,
		});

		// Rebuild messages from whatever is on disk right now. Must not throw.
		// The Session constructor itself calls rebuildFromTurns() at build time,
		// so a throw would surface here — strict assertion.
		let messages: any[] = [];
		expect(() => {
			const session = new AgentSession("system", undefined, sessionId, sessionDB);
			messages = session.getMessages();
		}, "rebuildFromSteps must not throw on a done+running tool mix").not.toThrow();

		// A's completed tool block must round-trip as a paired tool-call +
		// tool-result in the rebuilt message stream. (appendStepMessages emits
		// both from the same block when status=done and result is present.)
		const assistantParts = messages
			.filter((m) => m.role === "assistant")
			.flatMap((m) => Array.isArray(m.content) ? m.content : []);
		const toolCalls = assistantParts.filter((p: any) => p.type === "tool-call" && p.toolName === "toolA");
		const toolResultParts = messages
			.filter((m) => m.role === "tool")
			.flatMap((m) => Array.isArray(m.content) ? m.content : [])
			.filter((p: any) => p.type === "tool-result" && p.toolName === "toolA");
		expect(toolCalls.length, "A rebuilt as a tool-call").toBeGreaterThanOrEqual(1);
		expect(toolResultParts.length, "A rebuilt with a paired tool-result").toBeGreaterThanOrEqual(1);
		// The result's toolCallId must match the call's toolCallId (paired).
		expect(toolResultParts[0].toolCallId).toBe(toolCalls[0].toolCallId);
	});
});
