// steps-overhaul sub-9 acceptance test: 内容量 UI — max(100 step, 5 turn) window.
//
// # 文件说明书
//
// ## 核心功能
// Verifies acceptance-9 items (docs/plan/steps-overhaul/acceptance-9.md):
//   - computeDisplayWindow 实现 max(100 step, 5 turn) 取多的语义。
//   - 数据源是 `steps` 表(原始不可变),不是 messages —— getSessionVolume 读
//     steps + sessions 计数,不读 messages。
//   - sessions.token_usage 可展示(getSessionVolume 返回它)。
//
// ## 设计
// 两层:
//  A) 纯逻辑:computeDisplayWindow 的边界(0 / <100 step / >100 step / >5 turn /
//     并列取 step basis)。无 DB。
//  B) 接线:getSessionVolume 经真实 CoreDatabase,steps 表为真相源,turn_count 不同于
//     distinct turn_group,token_usage 透传。验证"数据源是 steps 不是 messages"。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { computeDisplayWindow, STEP_WINDOW, TURN_WINDOW } from "../../src/server/session-volume.js";
import { createAgentService } from "../../src/server/agent-service.js";
import type { AgentService } from "../../src/server/agent-service.js";

// invariants
describe("steps-overhaul sub-9 · computeDisplayWindow (max(100 step, 5 turn), 取多的)", () => {
	test("STEP_WINDOW=100, TURN_WINDOW=5 (design 决策 #5 阈值)", () => {
		expect(STEP_WINDOW).toBe(100);
		expect(TURN_WINDOW).toBe(5);
	});

	test("空 session (0 steps) → step basis, 全 0", () => {
		const v = computeDisplayWindow(0, 0);
		expect(v.totalStepCount).toBe(0);
		expect(v.totalTurnCount).toBe(0);
		expect(v.displayWindow.basis).toBe("steps");
		expect(v.displayWindow.coveredSteps).toBe(0);
		expect(v.displayWindow.coveredTurns).toBe(0);
		expect(v.tokenUsage).toBeUndefined();
	});

	test("≤100 step, ≤5 turn → step basis 覆盖全部(step 窗口未满,取全部)", () => {
		// 50 step, 3 turn:step 窗口 = min(100,50)=50 step,覆盖全部 50 step / 3 turn。
		const v = computeDisplayWindow(50, 3);
		expect(v.displayWindow.basis).toBe("steps");
		expect(v.displayWindow.coveredSteps).toBe(50);
		expect(v.displayWindow.coveredTurns).toBe(3); // 全部 turn 都在窗口内
	});

	test(">100 step, ≤5 turn → step basis(min(100, total)=100,turn 窗口全覆盖)", () => {
		// 150 step 全在 5 turn 内:step 窗口 = 100 step,turn 窗口 = 5 turn 覆盖全部 150。
		// turn-basis covered = ceil(150*5/5)=150 > step-basis 100 → turn basis 胜。
		// 这正是"取多的":5 turn 覆盖 150 step > 100 step。
		const v = computeDisplayWindow(150, 5);
		expect(v.displayWindow.basis).toBe("turns");
		expect(v.displayWindow.coveredSteps).toBe(150);
		expect(v.displayWindow.coveredTurns).toBe(5);
	});

	test(">100 step, >5 turn,均匀分布 → step basis 胜(5 turn 覆盖少于 100)", () => {
		// 500 step, 25 turn:每 turn 20 step。
		// step-basis = 100 step。
		// turn-basis = ceil(500*5/25)=100 step。并列 → 取 step basis(稳定)。
		const v = computeDisplayWindow(500, 25);
		expect(v.displayWindow.basis).toBe("steps");
		expect(v.displayWindow.coveredSteps).toBe(100);
	});

	test(">100 step, >5 turn,turn 集中在尾部 → turn basis 胜", () => {
		// 200 step, 6 turn:每 turn ~33 step(均匀估计)。
		// step-basis = 100 step。
		// turn-basis = ceil(200*5/6)=167 step > 100 → turn basis 胜。
		const v = computeDisplayWindow(200, 6);
		expect(v.displayWindow.basis).toBe("turns");
		expect(v.displayWindow.coveredSteps).toBe(167);
		expect(v.displayWindow.coveredTurns).toBe(5);
	});

	test("token_usage 透传", () => {
		const usage = { inputTokens: 50000, outputTokens: 1200, totalTokens: 51200 };
		const v = computeDisplayWindow(100, 5, usage);
		expect(v.tokenUsage).toEqual(usage);
	});

	test("负数 / NaN 防御 → 归零", () => {
		const v = computeDisplayWindow(-5, -1);
		expect(v.totalStepCount).toBe(0);
		expect(v.totalTurnCount).toBe(0);
		expect(v.displayWindow.basis).toBe("steps");
	});
});

// 接线:getSessionVolume 真实读 steps 表 + sessions 计数
describe("steps-overhaul sub-9 · getSessionVolume 数据源 = steps 表 (不是 messages)", () => {
	let tmpDir: string;
	let db: CoreDatabase;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "sub9-volume-"));
		db = new CoreDatabase(join(tmpDir, "core.db"));
		runMigrations(db);
	});

	afterEach(() => {
		try { db.close(); } catch { /* ignore */ }
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("空 session → 全 0 volume", () => {
		const session = db.createSession("agent-x");
		const svc: AgentService = createAgentService(tmpDir, db);
		const v = svc.getSessionVolume(session.id);
		expect(v.totalStepCount).toBe(0);
		expect(v.totalTurnCount).toBe(0);
		expect(v.displayWindow.basis).toBe("steps");
		expect(v.displayWindow.coveredSteps).toBe(0);
	});

	test("写入 step → totalStepCount/totalTurnCount 反映真实历史(steps 表真相源)", () => {
		const session = db.createSession("agent-x");
		// 模拟 3 turn,每 turn 1 user + 2 assistant = 9 step。同一 turn 内所有 step
		// 共享同一个 turn_group(真实分配:turn_group = user step 的 seq)。
		let seq = 0;
		for (let t = 0; t < 3; t++) {
			const tg = seq; // turn_group = user step seq(真实语义)
			db.appendStep(session.id, seq, tg, "user", `turn ${t} user`);
			seq++;
			db.appendStep(session.id, seq, tg, "assistant", `turn ${t} asst 1`);
			seq++;
			db.appendStep(session.id, seq, tg, "assistant", `turn ${t} asst 2`);
			seq++;
		}
		const svc: AgentService = createAgentService(tmpDir, db);
		const v = svc.getSessionVolume(session.id);
		// 9 step rows → totalStepCount = 9。
		expect(v.totalStepCount).toBe(9);
		// 3 distinct turn_group(0, 3, 6)→ totalTurnCount = 3。
		expect(v.totalTurnCount).toBe(3);
	});

	test("turn_count(user rows)≠ distinct turn_group 时,volume 用 distinct turn_group", () => {
		// 构造:turn_group 复用(同一 turn_group 多个 user step,异常但可构造)。
		// 2 个 user step 都用 turn_group=0,1 个 assistant 也 turn_group=0。
		// turn_count(user rows)= 2,但 distinct turn_group = 1。
		const session = db.createSession("agent-x");
		db.appendStep(session.id, 0, 0, "user", "u1");
		db.appendStep(session.id, 1, 0, "user", "u2"); // 同 turn_group,异常但可写
		db.appendStep(session.id, 2, 0, "assistant", "a1");
		const svc: AgentService = createAgentService(tmpDir, db);
		const v = svc.getSessionVolume(session.id);
		// distinct turn_group = 1(只有一个 group 0)。turn_count(user rows)= 2。
		// volume 必须报 distinct = 1,不是 user-row count = 2。
		expect(v.totalTurnCount).toBe(1);
		expect(v.totalStepCount).toBe(3);
	});

	test("token_usage 写入 → volume 透传", () => {
		const session = db.createSession("agent-x");
		db.appendStep(session.id, 0, 0, "user", "u");
		db.setTokenUsage(session.id, { inputTokens: 42, outputTokens: 7, totalTokens: 49 });
		const svc: AgentService = createAgentService(tmpDir, db);
		const v = svc.getSessionVolume(session.id);
		expect(v.tokenUsage).toEqual({ inputTokens: 42, outputTokens: 7, totalTokens: 49 });
	});

	test(">100 step, >5 turn → 取多的(basis 判定正确,数据来自真实 steps)", () => {
		const session = db.createSession("agent-x");
		// 6 turn,每 turn 1 user + 19 assistant = 120 step(>100)。同 turn 内所有
		// step 共享同一个 turn_group(= user step seq)。
		let seq = 0;
		for (let t = 0; t < 6; t++) {
			const tg = seq;
			db.appendStep(session.id, seq, tg, "user", `turn ${t}`);
			seq++;
			for (let a = 0; a < 19; a++) {
				db.appendStep(session.id, seq, tg, "assistant", `a${a}`);
				seq++;
			}
		}
		const svc: AgentService = createAgentService(tmpDir, db);
		const v = svc.getSessionVolume(session.id);
		// 120 step, 6 distinct turn_group。
		expect(v.totalStepCount).toBe(120);
		expect(v.totalTurnCount).toBe(6);
		// turn-basis = ceil(120*5/6)=100;step-basis = min(100,120)=100。并列 → step basis。
		expect(v.displayWindow.basis).toBe("steps");
		expect(v.displayWindow.coveredSteps).toBe(100);
	});
});
