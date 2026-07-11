// steps-overhaul sub-10 (sub-4 Lens B 移交): 防御测 —— 组装 messages 数组中
// system role 仅出现在 zone-1 连续段。
//
// # File 说明书
//
// ## 为什么需要这个防御测
// sub-4 把 summary 改 system role + normalizeMessages 合并连续 system(设计文档
// 「两张表」+ acceptance-4「连续-role 修正」)。这是一个**隐式不变量**:
//   - assembled messages 数组里,system role 只出现在**开头的连续段**(zone 1)。
//   - 一旦出现 user/assistant/tool,后续**不再**出现 system。
//
// 为什么这个不变量 load-bearing:Anthropic provider 对**被 user/assistant 分隔的
// 多个 system block 会 throw**(system 必须是连续的前缀)。如果未来有人在中段
// (zone 2 stub)或 fresh tail 注入了 system 消息,或改了 normalizeMessages 漏了
// 合并,就会破这个不变量 → 生产 Anthropic 调用失败。
//
// 当前不变量**结构上**保证(steps 只产 user/assistant/tool;summary 只在 zone 1;
// normalizeMessages 合并连续 system),但**无自动测抓 future regression**。本测
// 补这个缺口。
//
// ## 覆盖场景
//   - 单 summary → 1 个 system 在开头。
//   - 多 summary(3 FIFO)→ 全合并成 1 个连续 system 段(开头),之后无 system。
//   - 压缩后 fresh tail 含 tool 调用 → tool/assistant/user 都不产 system。
//   - 大量 steps + 多 summary → 仍只有开头连续 system。
//
// ## 不变量守恒(acceptance-4 / design.md「两张表」)
//   - system role 仅出现在 assembled messages 的开头连续段。
//
// ## 约束
// - sessions.db readonly 不变量:每个 DB 在 mkdtempSync 临时目录里。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionDB } from "../../src/server/session-db.js";
import { AgentSession } from "../../src/runtime/session.js";
import type { MessageSummary } from "../../src/server/session-db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantContent(blocks: any[]): string {
	return JSON.stringify(blocks);
}

function insertSession(db: SessionDB, sessionId: string) {
	const rawDb = (db as unknown as { db: import("better-sqlite3").Database }).db;
	const now = new Date().toISOString();
	rawDb.prepare(
		"INSERT INTO sessions (id, agent_id, is_main, title, created_at, updated_at, session_kind) " +
		"VALUES (?, 'sys-agent', 0, ?, ?, ?, 'chat')",
	).run(sessionId, "t-" + sessionId, now, now);
}

/** A summary block in the messages-table shape. */
function summary(title: string, fromSeq: number, toSeq: number): MessageSummary {
	return {
		title,
		sections: { status: `did ${fromSeq}..${toSeq}. 下一步: continue` },
		stepRange: { from: fromSeq, to: toSeq },
		createdAt: new Date().toISOString(),
	};
}

/**
 * Assert the system-role contiguity invariant on an assembled messages list:
 * once a non-system message appears, NO further system message may appear.
 * (Equivalently: all system messages form a single contiguous prefix run.)
 */
function assertSystemRoleContiguous(msgs: Array<{ role: string }>, label: string) {
	let seenNonSystem = false;
	for (let i = 0; i < msgs.length; i++) {
		const role = msgs[i].role;
		if (role === "system") {
			expect(seenNonSystem,
				`${label}: system message at index ${i} appears AFTER a non-system message (breaks zone-1 contiguity — Anthropic would reject split system blocks)`)
				.toBe(false);
		} else {
			seenNonSystem = true;
		}
	}
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe("steps-overhaul sub-10 Lens B (sub-4 移交): system role only in zone-1 contiguous run", () => {
	let tmpDir: string;
	let db: SessionDB;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub10-sys-"));
		db = new SessionDB(join(tmpDir, "sessions.db"));
	});

	afterEach(() => {
		db.close();
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
	});

	test("single summary: one system message at the start, then user/assistant (no later system)", () => {
		insertSession(db, "s1");
		db.saveSummaryAndAdvanceCursor("s1", summary("did 0..3", 0, 3), 3);
		// Seed steps AFTER the cursor (these become zone 2/3).
		db.appendStep("s1", 4, 4, "user", "go");
		db.appendStep("s1", 5, 4, "assistant", assistantContent([{ type: "text", text: "ok" }]));
		db.appendStep("s1", 6, 6, "user", "again");
		db.appendStep("s1", 7, 6, "assistant", assistantContent([{ type: "text", text: "done" }]));

		const sess = new AgentSession("sys", 200000, "s1", db as any);
		const view = sess.getMessages();

		// Invariant holds.
		assertSystemRoleContiguous(view as any, "single summary");
		// And the leading run IS system (the summary).
		expect(view[0].role, "zone 1 starts with system").toBe("system");
	});

	test("multiple summaries (3 FIFO): all merge into ONE contiguous system prefix (no split system blocks)", () => {
		insertSession(db, "m1");
		// Three summaries → without normalizeMessages they'd be 3 back-to-back
		// system messages; normalizeMessages merges them into ONE.
		db.saveSummaryAndAdvanceCursor("m1", summary("did 0..1", 0, 1), 1);
		db.saveSummaryAndAdvanceCursor("m1", summary("did 2..3", 2, 3), 3);
		db.saveSummaryAndAdvanceCursor("m1", summary("did 4..5", 4, 5), 5);
		db.appendStep("m1", 6, 6, "user", "go");
		db.appendStep("m1", 7, 6, "assistant", assistantContent([{ type: "text", text: "ok" }]));

		const sess = new AgentSession("sys", 200000, "m1", db as any);
		const view = sess.getMessages();

		assertSystemRoleContiguous(view as any, "3 summaries (merged)");
		// Exactly ONE system message in the final view (the merged summary).
		const systemCount = view.filter(m => m.role === "system").length;
		expect(systemCount, "3 summaries merged into 1 system message").toBe(1);
		expect(view[0].role).toBe("system");
		// After the system message, only user/assistant/tool.
		for (let i = 1; i < view.length; i++) {
			expect(["user", "assistant", "tool"], `index ${i} not system`).toContain(view[i].role);
		}
	});

	test("fresh tail with tool calls: tool/assistant/user never produce system (zone 2/3 system-free)", () => {
		insertSession(db, "t1");
		db.saveSummaryAndAdvanceCursor("t1", summary("did 0..2", 0, 2), 2);
		// Steps after cursor, with tool calls in the fresh tail.
		db.appendStep("t1", 3, 3, "user", "use a tool");
		db.appendStep("t1", 4, 3, "assistant", assistantContent([
			{ type: "tool", name: "Read", args: {}, result: "file contents here", status: "done" },
			{ type: "text", text: "read it" },
		]));
		db.appendStep("t1", 5, 5, "user", "more");
		db.appendStep("t1", 6, 5, "assistant", assistantContent([
			{ type: "tool", name: "Write", args: {}, result: "ok", status: "done" },
		]));

		const sess = new AgentSession("sys", 200000, "t1", db as any);
		const view = sess.getMessages();

		assertSystemRoleContiguous(view as any, "fresh tail with tools");
		// No tool message is ever relabeled system.
		const roles = view.map(m => m.role);
		expect(roles).toContain("tool"); // tools are present
		expect(roles[0]).toBe("system");
	});

	test("large history + many summaries + many steps: invariant still holds (scale)", () => {
		insertSession(db, "big1");
		// 3 summaries (cap), each compressing a range; cursor at the last.
		db.saveSummaryAndAdvanceCursor("big1", summary("s0", 0, 5), 5);
		db.saveSummaryAndAdvanceCursor("big1", summary("s1", 6, 11), 11);
		db.saveSummaryAndAdvanceCursor("big1", summary("s2", 12, 17), 17);
		// Many steps after the cursor (zone 2 + 3).
		const big = "x".repeat(500);
		for (let i = 18; i < 60; i++) {
			const group = i % 2 === 0 ? i : i - 1;
			const role = i % 2 === 0 ? "user" : "assistant";
			db.appendStep("big1", i, group, role,
				role === "user" ? `u${i}` : assistantContent([{ type: "text", text: `a${i} ${big}` }]));
		}

		const sess = new AgentSession("sys", 200000, "big1", db as any);
		const view = sess.getMessages();

		assertSystemRoleContiguous(view as any, "large history");
		// System count is 1 (merged) — never splits.
		expect(view.filter(m => m.role === "system").length).toBe(1);
	});

	test("NO summaries: zero system messages (the invariant trivially holds; defensive)", () => {
		insertSession(db, "none1");
		db.appendStep("none1", 0, 0, "user", "go");
		db.appendStep("none1", 1, 0, "assistant", assistantContent([{ type: "text", text: "ok" }]));

		const sess = new AgentSession("sys", 200000, "none1", db as any);
		const view = sess.getMessages();

		assertSystemRoleContiguous(view as any, "no summaries");
		expect(view.filter(m => m.role === "system").length, "no system without summaries").toBe(0);
	});
});
