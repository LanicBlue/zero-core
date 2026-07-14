// sub-3a acceptance test: 数据模型 3区→2区 + fresh-tail 边界去重 + 去双触发.
//
// # File 说明书
// Verifies docs/plan/compression-archive-simplify/acceptance-3a.md:
//   #1 2-zone LLM view = [summary] + [postCursor verbatim] (no middle stub zone).
//   #2 tool_use / tool_result never split across the (now-defunct) middle boundary.
//   #3 fresh-tail boundary has a SINGLE source — session.ts mirror deleted.
//   #4 prompt_too_long recovery no longer double-fires (inline aggressivePrune
//      removed; method deleted).
//   #5 don't-break: existing compression / assembleLLMView tests still pass.
//   #6 build:lib typecheck.
//
// Each test names the acceptance item it implements. Tests #1/#2 build a real
// AgentSession over a temp SessionDB; #3/#4 are static fs greps over src/.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionDB } from "../../src/server/session-db.js";
import { AgentSession } from "../../src/runtime/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Worktree root. Tests are launched from the worktree root (`npx vitest run …`),
 * so process.cwd() is the worktree. Avoids relying on __dirname which vitest 4
 * may transform.
 */
const REPO_ROOT = process.cwd();

function readSrc(rel: string): string {
	const p = join(REPO_ROOT, rel);
	if (!existsSync(p)) throw new Error(`src file missing: ${p}`);
	return readFileSync(p, "utf8");
}

function assistantContent(blocks: any[]): string {
	return JSON.stringify(blocks);
}

function toolResultParts(msgs: any[]): any[] {
	return msgs
		.filter(m => m.role === "tool")
		.flatMap(m => Array.isArray(m.content) ? m.content : [])
		.filter((p: any) => p.type === "tool-result");
}

function toolResultText(part: any): string {
	const out = part.output;
	if (typeof out === "string") return out;
	if (out?.type === "text" && typeof out.value === "string") return out.value;
	if (out?.type === "json") return JSON.stringify(out.value);
	return out != null ? JSON.stringify(out) : "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sub-3a #3+#4: static source invariants (boundary single source + no double-trigger)", () => {
	test("#3 session.ts no longer has its own computeFreshTailBoundary mirror", () => {
		const session = readSrc("src/runtime/session.ts");
		// The session-side duplicate must be GONE.
		expect(session, "session.computeFreshTailBoundary must be deleted").not.toMatch(/computeFreshTailBoundary/);
		// Its helpers / constants are also dead (per implementer's handoff).
		expect(session, "estimateStepTokens (only caller was the deleted boundary) must be gone").not.toMatch(/estimateStepTokens/);
		expect(session, "FRESH_TAIL_ABSOLUTE_TOKEN_BUDGET constant must be gone").not.toMatch(/FRESH_TAIL_ABSOLUTE_TOKEN_BUDGET/);
		expect(session, "FRESH_TAIL_WINDOW_FRACTION constant must be gone").not.toMatch(/FRESH_TAIL_WINDOW_FRACTION/);
	});

	test("#3 compression-core.computeFreshTailStartSeq survives as the SINGLE source", () => {
		const core = readSrc("src/server/compression-core.ts");
		expect(core, "compression-core must still define computeFreshTailStartSeq").toMatch(/export function computeFreshTailStartSeq/);
		// And it must not delegate to the (now-deleted) session mirror.
		expect(core, "must not reference the deleted session.computeFreshTailBoundary").not.toMatch(/session\.computeFreshTailBoundary/);
	});

	test("#4 aggressivePrune is gone everywhere in src/runtime (method + inline call)", () => {
		const session = readSrc("src/runtime/session.ts");
		const loop = readSrc("src/runtime/agent-loop.ts");
		expect(session, "AgentSession.aggressivePrune method must be deleted").not.toMatch(/aggressivePrune/);
		expect(loop, "agent-loop inline aggressivePrune(0.5) call must be deleted").not.toMatch(/aggressivePrune/);
	});

	test("#4 stub-zone machinery (STUB_SENTINEL / stubToolResultsInPlace / stubToolResults param) gone", () => {
		const session = readSrc("src/runtime/session.ts");
		expect(session, "STUB_SENTINEL must be deleted").not.toMatch(/STUB_SENTINEL/);
		expect(session, "stubToolResultsInPlace must be deleted").not.toMatch(/stubToolResultsInPlace/);
		// The opts stub flag on appendStepsAsMessages is also gone — 2-zone has a
		// single verbatim call site.
		expect(session, "appendStepsAsMessages no longer takes stubToolResults").not.toMatch(/stubToolResults/);
	});

	test("#4 agent-loop STILL has a prompt_too_long retry branch (predicate survived; only the inline prune was deleted)", () => {
		const loop = readSrc("src/runtime/agent-loop.ts");
		// isPromptTooLong predicate + retry on it must survive so the PreLLMCall
		// hook path (compressSession) re-fires.
		expect(loop, "isPromptTooLong predicate survived").toMatch(/isPromptTooLong/);
		expect(loop, "prompt_too_long error class branch survived").toMatch(/prompt_too_long/);
	});
});

describe("sub-3a #1: 2-zone model — [summary] + [postCursor verbatim]", () => {
	let tmpDir: string;
	let dbPath: string;
	let sessionDB: SessionDB | null = null;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub3a-2zone-"));
		dbPath = join(tmpDir, "sessions.db");
		sessionDB = new SessionDB(dbPath);
	});

	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
	});

	test("a postCursor tool step is rendered VERBATIM — no \"[tool result stubbed …]\" middle zone", () => {
		const sessionId = "twzone";
		// Build a history LARGE enough that under the OLD 3-zone model the oldest
		// assistant steps would land in the middle (stubbed) zone. With the
		// 2-zone change they must now be verbatim. min(32K, 20% of 128K) = 25600
		// tokens; ~9 assistant steps at ~3K tokens each pushes past the budget.
		const big = "x".repeat(12000);
		sessionDB!.appendStep(sessionId, 0, 0, "user", "go");
		for (let i = 1; i <= 10; i++) {
			sessionDB!.appendStep(sessionId, i, 0, "assistant", assistantContent([
				{ type: "tool", name: `Tool${i}`, args: {}, result: `real-${i}-${big.slice(0, 20)}`, status: "done" },
				{ type: "text", text: `step ${i} ${big}` },
			]));
		}

		const sess = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const msgs = sess.getMessages();
		const tr = toolResultParts(msgs);

		// CRITICAL assertion: NOT A SINGLE tool result is a stub. Under the old
		// 3-zone model the oldest steps would have produced
		// "[tool result stubbed (steps-overhaul 阶段2)] tool=…" — those must be GONE.
		const stubbed = tr.filter(p => toolResultText(p).startsWith("[tool result stubbed"));
		expect(stubbed, "middle zone must be gone — zero stubbed tool results").toHaveLength(0);

		// And the OLDEST tool result (which would have been stubbed under 3-zone)
		// is now verbatim — carries the real bytes.
		const oldest = tr[0];
		expect(oldest, "oldest tool result present").toBeDefined();
		expect(toolResultText(oldest)).toContain("real-1-");
	});

	test("empty-steps session yields [] (no zones, no crash)", () => {
		const sessionId = "empty";
		// No steps at all.
		const sess = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		expect(sess.getMessages()).toEqual([]);
	});

	test("no compression cursor (null/0) → whole history verbatim (single zone: fresh tail)", () => {
		// Same as the "small history" existing test but restated for sub-3a: with
		// NO summaries and NO cursor, the postCursor region == the entire step
		// history, and every step renders verbatim.
		const sessionId = "nocursor";
		sessionDB!.appendStep(sessionId, 0, 0, "user", "hi");
		sessionDB!.appendStep(sessionId, 1, 0, "assistant", assistantContent([
			{ type: "tool", name: "Echo", args: { x: 1 }, result: "real bytes", status: "done" },
			{ type: "text", text: "done" },
		]));

		const sess = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const msgs = sess.getMessages();

		const tr = toolResultParts(msgs);
		expect(tr).toHaveLength(1);
		expect(toolResultText(tr[0])).toBe("real bytes");
	});

	test("with summaries + cursor: LLM view = [summary system msg] + [postCursor verbatim]", () => {
		const sessionId = "sumcursor";
		sessionDB!.appendStep(sessionId, 0, 0, "user", "go");
		for (let i = 1; i <= 4; i++) {
			sessionDB!.appendStep(sessionId, i, 0, "assistant", assistantContent([
				{ type: "tool", name: `T${i}`, args: {}, result: `real-${i}`, status: "done" },
				{ type: "text", text: `t${i}` },
			]));
		}
		// Compress steps 1..2 (cursor = 2).
		sessionDB!.saveSummaryAndAdvanceCursor(sessionId, {
			title: "did 1..2",
			sections: { status: "first two" },
			stepRange: { from: 1, to: 2 },
			createdAt: "2026-01-01T00:00:00.000Z",
		}, 2);

		const sess = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const msgs = sess.getMessages();

		// Zone 1: summary as a single system message.
		const summaryMsgs = msgs.filter(m => m.role === "system" && typeof m.content === "string" && (m.content as string).includes("[summary:"));
		expect(summaryMsgs.length).toBe(1);

		// Zone 2 (the only "tail" zone now): steps 3..4 verbatim. Real results.
		const tr = toolResultParts(msgs);
		const results = tr.map(toolResultText);
		expect(results.some(r => r.includes("real-3"))).toBe(true);
		expect(results.some(r => r.includes("real-4"))).toBe(true);
		// Pre-cursor (1..2) results do NOT appear — they're summarized away.
		expect(results.some(r => r.includes("real-1") || r.includes("real-2"))).toBe(false);
		// And nothing is stubbed.
		const stubbed = tr.filter(p => toolResultText(p).startsWith("[tool result stubbed"));
		expect(stubbed).toHaveLength(0);
	});
});

describe("sub-3a #2: tool_use / tool_result stay paired in the 2-zone output", () => {
	let tmpDir: string;
	let dbPath: string;
	let sessionDB: SessionDB | null = null;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub3a-pair-"));
		dbPath = join(tmpDir, "sessions.db");
		sessionDB = new SessionDB(dbPath);
	});

	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
	});

	test("every tool-call has a matching tool-result id (no orphaning across the 2-zone path)", () => {
		const sessionId = "pairs";
		const big = "z".repeat(12000);
		sessionDB!.appendStep(sessionId, 0, 0, "user", "go");
		for (let i = 1; i <= 10; i++) {
			sessionDB!.appendStep(sessionId, i, 0, "assistant", assistantContent([
				{ type: "tool", name: `T${i}`, args: {}, result: `real-${i}`, status: "done" },
				{ type: "text", text: `s${i} ${big}` },
			]));
		}

		const sess = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const msgs = sess.getMessages();

		const callIds = new Set<string>();
		for (const m of msgs) {
			if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const p of m.content as any[]) {
				if (p?.type === "tool-call" && p.toolCallId) callIds.add(p.toolCallId);
			}
		}
		const resultIds = new Set<string>();
		for (const m of msgs) {
			if (m.role !== "tool" || !Array.isArray(m.content)) continue;
			for (const p of m.content as any[]) {
				if (p?.type === "tool-result" && p.toolCallId) resultIds.add(p.toolCallId);
			}
		}
		for (const id of callIds) expect(resultIds.has(id), `tool-call ${id} has a paired result`).toBe(true);
		for (const id of resultIds) expect(callIds.has(id), `tool-result ${id} has a paired call`).toBe(true);
	});
});
