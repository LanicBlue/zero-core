// deleteStepsFromSeq — cascade rollback (delete user message + all after).
//
// # 文件说明书
//
// ## 核心功能
// 直测 SessionDB.deleteStepsFromSeq:
//   1. 删 seq >= fromSeq,保留 seq < fromSeq(回档到该 user 消息之前)。
//   2. step_count 重算 = 剩余行数;且因恒为尾部删除,剩余 [0..fromSeq-1] 连续,
//      故 step_count = fromSeq = 下一个正确分配的 seq(无中段删除的碰撞风险)。
//   3. tool_executions.turn_seq >= fromSeq 级联删除;NULL turn_seq 的旧行保留。
//   4. compression cursor >= fromSeq → clearSummaries(cursor 回到 null);< fromSeq
//      则摘要/游标保留。
//
// ## 测试策略
// 临时 SessionDB + runMigrations;appendStep 造 3 个 turn(user 的 turn_group ===
// seq),recordToolExecution 造带 turnSeq 的工具记录,saveSummaryAndAdvanceCursor
// 造压缩游标;然后 deleteStepsFromSeq 并断言剩余。
//
// ## 输入
// 临时目录 + 真 SessionDB。
//
// ## 输出
// Vitest 用例。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";

let tmpDir: string;
let db: SessionDB;

const SID = "sess-cascade";
const AGENT = "a1";
const NOW = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-delsteps-"));
	db = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(db);
});

afterEach(() => {
	try { db.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Build 3 turns: (seq=0 u, seq=1 a) (seq=2 u, seq=3 a) (seq=4 u, seq=5 a).
 *  User step's turn_group === its seq (mirrors turn-hooks/turn-recorder). */
function seedThreeTurns(): void {
	db.appendStep(SID, 0, 0, "user", "u0");
	db.appendStep(SID, 1, 0, "assistant", "a0");
	db.appendStep(SID, 2, 2, "user", "u2");
	db.appendStep(SID, 3, 2, "assistant", "a2");
	db.appendStep(SID, 4, 4, "user", "u4");
	db.appendStep(SID, 5, 4, "assistant", "a4");
}

describe("deleteStepsFromSeq — cascade rollback", () => {
	test("deletes seq >= fromSeq, keeps seq < fromSeq", () => {
		seedThreeTurns();
		db.deleteStepsFromSeq(SID, 2);
		const remaining = db.getSteps(SID).map((s) => s.seq);
		expect(remaining).toEqual([0, 1]);
		// User message at seq=2 (the rollback point) is gone, as is everything after.
		const roles = db.getSteps(SID).map((s) => s.role);
		expect(roles).toEqual(["user", "assistant"]);
	});

	test("step_count recomputed to remaining count (= fromSeq for a trailing delete)", () => {
		seedThreeTurns();
		expect(db.getStepCount(SID)).toBe(6);
		db.deleteStepsFromSeq(SID, 2);
		// Remaining [0,1] → step_count = 2 = fromSeq → next allocation (seq 2) is free.
		expect(db.getStepCount(SID)).toBe(2);
	});

	test("deleting the first user message clears the whole session", () => {
		seedThreeTurns();
		db.deleteStepsFromSeq(SID, 0);
		expect(db.getSteps(SID)).toEqual([]);
		expect(db.getStepCount(SID)).toBe(0);
	});

	test("tool_executions with turn_seq >= fromSeq cascade-deleted; NULL turn_seq kept", () => {
		seedThreeTurns();
		db.recordToolExecution({ sessionId: SID, agentId: AGENT, toolName: "t0", success: true, durationMs: 1, turnSeq: 0 });
		db.recordToolExecution({ sessionId: SID, agentId: AGENT, toolName: "t2", success: true, durationMs: 1, turnSeq: 2 });
		db.recordToolExecution({ sessionId: SID, agentId: AGENT, toolName: "t4", success: true, durationMs: 1, turnSeq: 4 });
		db.recordToolExecution({ sessionId: SID, agentId: AGENT, toolName: "tNull", success: true, durationMs: 1 }); // turnSeq undefined
		expect(db.queryToolExecutions({ sessionId: SID }).length).toBe(4);

		db.deleteStepsFromSeq(SID, 2);
		const names = db.queryToolExecutions({ sessionId: SID }).map((r) => r.toolName).sort();
		// turn_seq 2 and 4 gone (>= fromSeq 2); turn_seq 0 and NULL kept.
		expect(names).toEqual(["t0", "tNull"]);
	});
});

describe("deleteStepsFromSeq — compression cursor safety", () => {
	test("cursor >= fromSeq → summaries cleared (cursor back to null)", () => {
		seedThreeTurns();
		// Cursor points at seq 3 (inside the region we're about to delete from 2).
		// compression-archive-simplify sub-5: migrated from saveSummaryAndAdvanceCursor
		// (deleted FIFO-3 path) to replaceSummariesAndAdvanceCursor (2-zone rolling).
		db.replaceSummariesAndAdvanceCursor(SID, { title: "s", sections: {}, createdAt: NOW }, 3);
		expect(db.getCompressionCursor(SID)).toBe(3);

		db.deleteStepsFromSeq(SID, 2);
		expect(db.getCompressionCursor(SID)).toBe(null);
	});

	test("cursor < fromSeq → summaries + cursor preserved (compressed region untouched)", () => {
		seedThreeTurns();
		// Cursor at seq 1; we delete from seq 4 → compressed region [0..1] intact.
		// compression-archive-simplify sub-5: migrated from saveSummaryAndAdvanceCursor
		// (deleted FIFO-3 path) to replaceSummariesAndAdvanceCursor (2-zone rolling).
		db.replaceSummariesAndAdvanceCursor(SID, { title: "s", sections: {}, createdAt: NOW }, 1);
		expect(db.getCompressionCursor(SID)).toBe(1);

		db.deleteStepsFromSeq(SID, 4);
		expect(db.getCompressionCursor(SID)).toBe(1);
	});
});
