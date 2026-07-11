// steps-overhaul sub-3 acceptance test: messages 引用模型 + LLM view 三区组装.
//
// # File说明书
// ## 核心功能
// 独立验证 acceptance-3.md 的核心条目:
//   - messages 表只存 summary 块 + last_compressed_step_seq(不存 step 内容)。
//   - LLM view(session.messages)组装三区:[summary] + [中间区 tool stub]
//     + [fresh tail 逐字+指针],正确。
//   - fresh tail 边界 = min(32K token, 20% 窗口),step 粒度,tool-pair 安全。
//   - fresh tail 中被外置(>16K)的 tool result 渲染指针形态(不解引用全字节)。
//   - 中间区(压缩游标..fresh-tail 边界)tool 结果 stub(阶段2 常驻组装规则)。
//   - 重启恢复:组装 LLM view = messages.summary + steps[压缩游标..
//     last_completed_step_seq];与崩溃前一致(无 mid-turn 漂移)。
//   - cachedTurns(UI 源)从 steps 独立填,与 LLM view 重建分离。
//   - syncTurnsAfterCompression/replaceStepsFromMessages 已删。
//
// ## 不变量守恒(acceptance-3)
//   - 两表不重复存内容(steps 全量指针版;messages 只 summary+游标)。
//   - 无 mid-turn 漂移:messages 只是游标,steps 是 source,组装永远一致。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里;绝不碰生产
//   ~/.zero-core/sessions.db(memory feedback-sessions-db-readonly)。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionDB } from "../../src/server/session-db.js";
import { AgentSession } from "../../src/runtime/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize an assistant step's blocks to the steps.content JSON shape. */
function assistantContent(blocks: any[]): string {
	return JSON.stringify(blocks);
}

/** A pointer-form tool result, as produced by sub-2's externalizer. */
function pointerResult(origBytes: number, summary: string): string {
	return `[externalized: .zero-core/tool-outputs/fakehash.txt (${origBytes} bytes)] ${summary}`;
}

/** Count tool-result parts in a rebuilt messages list. */
function toolResultParts(msgs: any[]): any[] {
	return msgs
		.filter(m => m.role === "tool")
		.flatMap(m => Array.isArray(m.content) ? m.content : [])
		.filter((p: any) => p.type === "tool-result");
}

/** Extract the text value of a tool-result part. */
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

describe("steps-overhaul sub-3: messages 引用模型 + LLM view 三区组装", () => {
	let tmpDir: string;
	let dbPath: string;
	let sessionDB: SessionDB | null = null;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub3-threezone-"));
		dbPath = join(tmpDir, "sessions.db");
		sessionDB = new SessionDB(dbPath);
	});

	afterEach(() => {
		sessionDB?.close();
		sessionDB = null;
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
	});

	test("messages table schema: summary_json + last_compressed_step_seq, NO step content columns", () => {
		const db = (sessionDB as any).db;
		const cols = (db.pragma("table_info(messages)") as Array<{ name: string }>).map(c => c.name);
		expect(cols).toContain("summary_json");
		expect(cols).toContain("last_compressed_step_seq");
		// The retired columns from the old "LLM view dumped here" schema are GONE.
		expect(cols).not.toContain("msg_json");
		expect(cols).not.toContain("role");
		expect(cols).not.toContain("content");
	});

	test("getSummaries / getCompressionCursor: empty + NULL on a fresh session (no compression writer in sub-3)", () => {
		const sessionId = "fresh";
		sessionDB!.appendStep(sessionId, 0, 0, "user", "hello");
		expect(sessionDB!.getSummaries(sessionId)).toEqual([]);
		expect(sessionDB!.getCompressionCursor(sessionId)).toBeNull();
	});

	test("saveSummaryAndAdvanceCursor writes summary + advances cursor; FIFO cap at 3", () => {
		const sessionId = "cap";
		const mk = (i: number) => ({
			title: `s${i}`,
			sections: { status: `status ${i}` },
			createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
		});
		sessionDB!.saveSummaryAndAdvanceCursor(sessionId, mk(0), 5);
		sessionDB!.saveSummaryAndAdvanceCursor(sessionId, mk(1), 10);
		sessionDB!.saveSummaryAndAdvanceCursor(sessionId, mk(2), 15);
		expect(sessionDB!.getSummaries(sessionId).map(s => s.title)).toEqual(["s0", "s1", "s2"]);
		expect(sessionDB!.getCompressionCursor(sessionId)).toBe(15);

		// 4th summary evicts the oldest (FIFO).
		sessionDB!.saveSummaryAndAdvanceCursor(sessionId, mk(3), 20);
		const titles = sessionDB!.getSummaries(sessionId).map(s => s.title);
		expect(titles).toEqual(["s1", "s2", "s3"]);
		expect(titles).not.toContain("s0");
		expect(sessionDB!.getCompressionCursor(sessionId)).toBe(20);
	});

	test("LLM view with NO summaries + small history: everything is fresh tail, verbatim (no stubs)", () => {
		const sessionId = "small";
		// User + one assistant step with a tool. Tiny → all in fresh tail.
		sessionDB!.appendStep(sessionId, 0, 0, "user", "run the tool");
		sessionDB!.appendStep(sessionId, 1, 0, "assistant", assistantContent([
			{ type: "tool", name: "Echo", args: { x: 1 }, result: "real result bytes", status: "done" },
			{ type: "text", text: "done" },
		]));

		const sess = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const msgs = sess.getMessages();

		// User message present.
		expect(msgs.filter(m => m.role === "user")).toHaveLength(1);
		// Tool result is VERBATIM (fresh tail) — not stubbed.
		const tr = toolResultParts(msgs);
		expect(tr).toHaveLength(1);
		expect(toolResultText(tr[0])).toBe("real result bytes");
	});

	test("middle zone stubs tool results; fresh tail keeps them verbatim (阶段2 常驻组装规则)", () => {
		const sessionId = "zones";
		// Build a history large enough to span both zones: many assistant steps
		// each carrying a tool result, so the fresh-tail budget (min(32K, 20% of
		// 128K) = 25600 tokens) is exceeded and older steps land in the middle.
		// Each step's content is ~12K chars (~3K tokens) → ~9 steps push past the
		// ~25600-token fresh-tail budget, forcing the oldest into the middle zone.
		const big = "x".repeat(12000);
		// user opens turn_group 0.
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

		// At least one tool result is stubbed (middle zone) — the sentinel prefix.
		const stubbed = tr.filter(p => toolResultText(p).startsWith("[tool result stubbed"));
		expect(stubbed.length, "middle zone stubs at least the oldest tool results").toBeGreaterThan(0);

		// The NEWEST tool result is verbatim (fresh tail) — carries the real result.
		const last = tr[tr.length - 1];
		expect(toolResultText(last)).toContain("real-10-");
	});

	test("fresh tail renders pointer-form tool results VERBATIM (no dereference to full bytes)", () => {
		const sessionId = "pointer";
		// A small history so the pointer result stays in the fresh tail (verbatim).
		const pointer = pointerResult(20000, "head of the externalized result");
		sessionDB!.appendStep(sessionId, 0, 0, "user", "use big tool");
		sessionDB!.appendStep(sessionId, 1, 0, "assistant", assistantContent([
			{ type: "tool", name: "BigRead", args: {}, result: pointer, status: "done" },
			{ type: "text", text: "ok" },
		]));

		const sess = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const msgs = sess.getMessages();
		const tr = toolResultParts(msgs);
		expect(tr).toHaveLength(1);
		// The pointer string is rendered AS-IS in fresh tail — NOT dereferenced
		// to the 20000-byte externalized file. The LLM sees the pointer.
		expect(toolResultText(tr[0])).toBe(pointer);
		expect(toolResultText(tr[0])).toContain("[externalized:");
		expect(toolResultText(tr[0])).toContain("20000 bytes");
	});

	test("compression cursor carves middle vs fresh: steps at seq <= cursor are summarized away", () => {
		const sessionId = "cursor";
		// Seed 4 tool-bearing steps.
		sessionDB!.appendStep(sessionId, 0, 0, "user", "go");
		for (let i = 1; i <= 4; i++) {
			sessionDB!.appendStep(sessionId, i, 0, "assistant", assistantContent([
				{ type: "tool", name: `T${i}`, args: {}, result: `real-${i}`, status: "done" },
				{ type: "text", text: `t${i}` },
			]));
		}

		// Write a summary that compresses steps 1..2 (cursor = 2).
		sessionDB!.saveSummaryAndAdvanceCursor(sessionId, {
			title: "compressed 1..2",
			sections: { status: "did 1 and 2" },
			stepRange: { from: 1, to: 2 },
			createdAt: "2026-01-01T00:00:00.000Z",
		}, 2);

		const sess = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const msgs = sess.getMessages();

		// steps-overhaul sub-4: summary now emitted as a SYSTEM message (Lens A 连续-role 修正).
		const summaryMsgs = msgs.filter(m => m.role === "system" && typeof m.content === "string" && (m.content as string).includes("[summary:"));
		expect(summaryMsgs.length).toBe(1);

		// Steps 1 and 2 (seq <= cursor 2) are NOT in zones 2/3 — their tool
		// results don't appear (only steps 3,4 are post-cursor).
		const tr = toolResultParts(msgs);
		const results = tr.map(toolResultText);
		expect(results.some(r => r.includes("real-1") || r.includes("real-2"))).toBe(false);
		expect(results.some(r => r.includes("real-3") || r.includes("real-4"))).toBe(true);
	});

	test("cachedTurns is the FULL step history (UI source), independent of the 3-zone LLM view", () => {
		const sessionId = "cached";
		// Big history so the LLM view stubs the middle zone.
		const big = "y".repeat(12000);
		sessionDB!.appendStep(sessionId, 0, 0, "user", "go");
		for (let i = 1; i <= 8; i++) {
			sessionDB!.appendStep(sessionId, i, 0, "assistant", assistantContent([
				{ type: "tool", name: `T${i}`, args: {}, result: `real-${i}`, status: "done" },
				{ type: "text", text: `t${i} ${big}` },
			]));
		}

		const sess = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const cached = sess.getCachedTurns();
		// cachedTurns = ALL 9 step rows (1 user + 8 assistant), verbatim, no stubs.
		expect(cached.length).toBe(9);
		// Every assistant step's content is intact (not stubbed) in cachedTurns.
		for (let i = 1; i <= 8; i++) {
			const step = cached.find(c => c.seq === i);
			expect(step, `cached turn seq=${i} present`).toBeDefined();
			expect(step!.content).toContain(`real-${i}`);
		}
	});

	test("crash-restart consistency: reassembling from messages.summary + steps[cursor..] yields the SAME LLM view (no mid-turn drift)", () => {
		const sessionId = "restart";
		// 6 steps with tool results; compress 1..3 (cursor=3) with a summary.
		sessionDB!.appendStep(sessionId, 0, 0, "user", "go");
		for (let i = 1; i <= 6; i++) {
			sessionDB!.appendStep(sessionId, i, 0, "assistant", assistantContent([
				{ type: "tool", name: `T${i}`, args: {}, result: `real-${i}`, status: "done" },
				{ type: "text", text: `step ${i}` },
			]));
		}
		sessionDB!.saveSummaryAndAdvanceCursor(sessionId, {
			title: "did 1..3",
			sections: { status: "first three done" },
			stepRange: { from: 1, to: 3 },
			createdAt: "2026-01-01T00:00:00.000Z",
		}, 3);

		// Phase 1: assemble the LLM view as it would be mid-turn.
		const sess1 = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const view1 = sess1.getMessages();

		// Phase 2: simulate a crash + restart — drop the in-memory session and
		// rebuild purely from the persisted messages (summary+cursor) + steps.
		// The LLM view must be byte-identical (no mid-turn drift).
		const sess2 = new AgentSession("sys", 128000, sessionId, sessionDB as any);
		const view2 = sess2.getMessages();

		expect(view2).toEqual(view1);
	});

	test("tool-pair safety: a fresh-tail split never orphans a tool_use from its result", () => {
		// Every assistant step carries its OWN tool_use AND tool_result blocks,
		// so a step-boundary split (which is what computeFreshTailBoundary uses)
		// can never split a pair. Verify by asserting every tool-call in the
		// rebuilt view has a matching tool-result id.
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

		// Collect every tool-call id and every tool-result id; assert the sets match.
		const callIds = new Set<string>();
		for (const m of msgs) {
			if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const p of m.content) {
				if (p?.type === "tool-call" && p.toolCallId) callIds.add(p.toolCallId);
			}
		}
		const resultIds = new Set<string>();
		for (const m of msgs) {
			if (m.role !== "tool" || !Array.isArray(m.content)) continue;
			for (const p of m.content) {
				if (p?.type === "tool-result" && p.toolCallId) resultIds.add(p.toolCallId);
			}
		}
		// Every call has a result (no orphaned tool_use) and vice versa.
		for (const id of callIds) expect(resultIds.has(id), `tool-call ${id} has a paired result`).toBe(true);
		for (const id of resultIds) expect(callIds.has(id), `tool-result ${id} has a paired call`).toBe(true);
	});

	test("replaceStepsFromMessages is DELETED (no longer on SessionDB)", () => {
		// Sub-3 deleted the destructive "rebuild steps from compressed messages"
		// path. The method must be gone.
		expect(typeof (sessionDB as any).replaceStepsFromMessages).toBe("undefined");
	});

	test("messages never duplicates step content: a 5-step session with a summary has steps intact + only the summary in messages", () => {
		const sessionId = "nodup";
		sessionDB!.appendStep(sessionId, 0, 0, "user", "go");
		for (let i = 1; i <= 4; i++) {
			sessionDB!.appendStep(sessionId, i, 0, "assistant", assistantContent([
				{ type: "text", text: `step ${i}` },
			]));
		}
		sessionDB!.saveSummaryAndAdvanceCursor(sessionId, {
			title: "recap",
			sections: { status: "recapped" },
			stepRange: { from: 1, to: 2 },
			createdAt: "2026-01-01T00:00:00.000Z",
		}, 2);

		// steps table has ALL 5 rows (the source of truth, untouched).
		const steps = sessionDB!.getSteps(sessionId);
		expect(steps.length).toBe(5);

		// messages table has ONLY the summary row (no step content duplicated).
		const db = (sessionDB as any).db;
		const msgRows = db.prepare("SELECT summary_json FROM messages WHERE session_id = ?").all(sessionId) as { summary_json: string }[];
		expect(msgRows.length).toBe(1);
		const summary = JSON.parse(msgRows[0].summary_json);
		expect(summary.title).toBe("recap");
		// The summary carries NO step content (only the structured recap fields).
		expect(summary.sections.status).toBe("recapped");
		expect(JSON.stringify(summary)).not.toContain("step 1"); // no step body leaked in
	});
});
