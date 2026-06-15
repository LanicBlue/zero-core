// 单元测试：会话上下文压缩引擎
//
// # 文件说明书
//
// ## 核心功能
// 测试 CompressionEngine 的同步逻辑：identifyTurns（按 user 消息切分 turn 边界，处理 tool/连续 user 场景）和 shouldCompress（usage 阈值判断）；不覆盖需 LLM 调用的 L1/L2 压缩
//
// ## 输入
// 构造的 role/content 消息序列与 usage/threshold 数值
//
// ## 输出
// Vitest 测试用例：覆盖空消息、单 turn、多 turn、tool 嵌入、连续 user、阈值边界
//
// ## 定位
// tests/unit/ — 单元测试套件，验证 runtime 压缩引擎的纯函数逻辑
//
// ## 依赖
// vitest、../../src/runtime/compression-engine（CompressionEngine、TurnBoundary）
//
// ## 维护规则
// turn 切分规则变更需同步更新 identifyTurns 期望
// 阈值判定从 > 改为 >= 等边界行为变更需更新 shouldCompress 测试
//
import { describe, test, expect } from "vitest";
import { CompressionEngine, TurnBoundary } from "../../src/runtime/compression-engine.js";

// We only test the synchronous parts (turn identification, shouldCompress)
// The L1/L2 compression requires an LLM call, so those are integration tests.

function makeMessages(roles: Array<"user" | "assistant" | "tool">): any[] {
	return roles.map((role, i) => ({
		role,
		content: role === "tool" ? `[Tool result ${i}]` : `Message ${i} (${role})`,
	}));
}

describe("CompressionEngine", () => {
	// We pass dummy provider/model — only used for LLM calls which we don't test here
	const engine = new CompressionEngine([], "test", "test");

	describe("identifyTurns", () => {
		test("empty messages → no turns", () => {
			expect(engine.identifyTurns([])).toEqual([]);
		});

		test("single user message → one turn", () => {
			const msgs = makeMessages(["user"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([{ start: 0, end: 1 }]);
		});

		test("user + assistant → one turn", () => {
			const msgs = makeMessages(["user", "assistant"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([{ start: 0, end: 2 }]);
		});

		test("two turns with tool calls", () => {
			// Turn 1: user → assistant → tool → assistant
			// Turn 2: user → assistant
			const msgs = makeMessages(["user", "assistant", "tool", "assistant", "user", "assistant"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([
				{ start: 0, end: 4 },
				{ start: 4, end: 6 },
			]);
		});

		test("three turns", () => {
			const msgs = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([
				{ start: 0, end: 2 },
				{ start: 2, end: 4 },
				{ start: 4, end: 6 },
			]);
		});

		test("consecutive user messages → each starts a new turn", () => {
			const msgs = makeMessages(["user", "user", "user"]);
			const turns = engine.identifyTurns(msgs);
			expect(turns).toEqual([
				{ start: 0, end: 1 },
				{ start: 1, end: 2 },
				{ start: 2, end: 3 },
			]);
		});
	});

	describe("shouldCompress", () => {
		test("returns true when usage > threshold", () => {
			expect(engine.shouldCompress(0.8, 0.7)).toBe(true);
		});

		test("returns false when usage <= threshold", () => {
			expect(engine.shouldCompress(0.6, 0.7)).toBe(false);
		});

		test("returns false when usage equals threshold", () => {
			expect(engine.shouldCompress(0.7, 0.7)).toBe(false);
		});
	});
});
