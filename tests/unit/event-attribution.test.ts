// 单元测试:终态事件 session 归属(event-attribution)
//
// # 文件说明书
//
// ## 核心功能
// 锁死:agent_end / error 终态事件只按显式 sessionId 清 streaming;无 sessionId
// 时返回 null,绝不回退 activeSessionId —— 否则并发 run 的终态事件会串清用户
// 正在看的 session(Stop 误变 Send)。
//
// ## 输入
// 模拟事件对象 + activeSessionId
//
// ## 输出
// Vitest 用例
//
import { describe, test, expect } from "vitest";
import { terminalTargetSession } from "../../src/renderer/store/event-attribution.js";

describe("terminalTargetSession", () => {
	test("returns the event's explicit sessionId", () => {
		expect(terminalTargetSession({ sessionId: "sess-A" }, "sess-A")).toBe("sess-A");
	});

	test("does NOT fall back to activeSessionId when sessionId is absent", () => {
		// Regression guard: a background run's terminal event lacking sessionId
		// must not clobber the viewed session. Returning null means the caller
		// skips clearing entirely.
		expect(terminalTargetSession({}, "sess-active")).toBeNull();
		expect(terminalTargetSession({ sessionId: undefined }, "sess-active")).toBeNull();
	});

	test("a concurrent session's terminal event targets only that session", () => {
		// User views sess-A; a background run in sess-B ends → must target B,
		// not A.
		expect(terminalTargetSession({ sessionId: "sess-B" }, "sess-A")).toBe("sess-B");
	});

	test("activeSessionId is ignored entirely", () => {
		// Even when sessionId is empty-string, do not use activeSessionId.
		expect(terminalTargetSession({ sessionId: "" }, "sess-active")).toBeNull();
	});
});
