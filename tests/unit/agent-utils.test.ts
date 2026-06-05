// 单元测试：Agent 工具函数
//
// # 文件说明书
//
// ## 核心功能
// 测试 agent-utils 中的错误分类、瞬态判断、用户友好消息生成和 thinking 标签解析
//
// ## 输入
// src/runtime/agent-utils.js 导出的 classifyError、isTransientError、userFriendlyMessage、parseThinkingTags
//
// ## 输出
// Vitest 测试用例覆盖错误分类映射、瞬态/非瞬态判断、消息本地化和 thinking 标签解析
//
// ## 定位
// tests/unit/ — 单元测试套件，验证 Agent 辅助逻辑
//
// ## 依赖
// vitest、../../src/runtime/agent-utils
//
// ## 维护规则
// 新增错误分类需添加对应测试用例
// 用户友好消息文案变更需更新断言
//
import { describe, test, expect } from "vitest";
import {
	classifyError,
	isTransientError,
	userFriendlyMessage,
	parseThinkingTags,
	MAX_RETRIES,
	BASE_DELAY_MS,
} from "../../src/runtime/agent-utils.js";

describe("agent-utils constants", () => {
	test("MAX_RETRIES and BASE_DELAY_MS are exposed", () => {
		expect(MAX_RETRIES).toBe(3);
		expect(BASE_DELAY_MS).toBe(1000);
	});
});

describe("classifyError", () => {
	test("AbortError → timeout", () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		expect(classifyError(err)).toBe("timeout");
	});

	test("status 429 → rate_limit", () => {
		expect(classifyError({ status: 429, message: "too many" })).toBe("rate_limit");
	});

	test("status 401 → auth", () => {
		expect(classifyError({ status: 401, message: "nope" })).toBe("auth");
	});

	test("status 403 → auth", () => {
		expect(classifyError({ status: 403, message: "nope" })).toBe("auth");
	});

	test("status 500+ → server_error", () => {
		expect(classifyError({ status: 503, message: "oops" })).toBe("server_error");
	});

	test("ECONNREFUSED code → network", () => {
		expect(classifyError({ code: "ECONNREFUSED", message: "x" })).toBe("network");
	});

	test("context window exceeded → prompt_too_long", () => {
		expect(classifyError({ message: "context length too long" })).toBe("prompt_too_long");
	});

	test("unrecognized → unknown", () => {
		expect(classifyError({ message: "weird" })).toBe("unknown");
	});
});

describe("isTransientError", () => {
	test.each(["timeout", "rate_limit", "server_error", "network"] as const)(
		"%s is transient",
		(cls) => {
			expect(isTransientError(cls)).toBe(true);
		},
	);

	test.each(["auth", "prompt_too_long", "unknown"] as const)(
		"%s is NOT transient",
		(cls) => {
			expect(isTransientError(cls)).toBe(false);
		},
	);
});

describe("userFriendlyMessage", () => {
	test("rate_limit returns localized message", () => {
		const msg = userFriendlyMessage("rate_limit", "raw");
		expect(msg).toContain("限流");
	});

	test("auth mentions API Key", () => {
		expect(userFriendlyMessage("auth", "raw")).toContain("API Key");
	});

	test("unknown truncates long raw messages", () => {
		const long = "x".repeat(300);
		const msg = userFriendlyMessage("unknown", long);
		expect(msg.length).toBe(203);
		expect(msg.endsWith("...")).toBe(true);
	});

	test("unknown keeps short raw as-is", () => {
		expect(userFriendlyMessage("unknown", "short")).toBe("short");
	});
});

describe("parseThinkingTags", () => {
	test("empty input returns empty array", () => {
		expect(parseThinkingTags("")).toEqual([]);
	});

	test("plain text without tags returns one text block", () => {
		const r = parseThinkingTags("hello world");
		expect(r).toEqual([{ type: "text", text: "hello world" }]);
	});

	test("single thinking block", () => {
		const r = parseThinkingTags("<thinking>pondering</thinking>");
		expect(r).toEqual([{ type: "thinking", text: "pondering" }]);
	});

	test("thinking then text", () => {
		const r = parseThinkingTags("<thinking>hmm</thinking>afterwards");
		expect(r).toEqual([
			{ type: "thinking", text: "hmm" },
			{ type: "text", text: "afterwards" },
		]);
	});

	test("unclosed thinking tag emits thinking block with remaining content", () => {
		const r = parseThinkingTags("<thinking>stream of");
		expect(r).toEqual([{ type: "thinking", text: "stream of" }]);
	});

	test("multiple thinking + text interleaved", () => {
		const r = parseThinkingTags("a<thinking>x</thinking>b<thinking>y</thinking>c");
		expect(r).toEqual([
			{ type: "text", text: "a" },
			{ type: "thinking", text: "x" },
			{ type: "text", text: "b" },
			{ type: "thinking", text: "y" },
			{ type: "text", text: "c" },
		]);
	});
});
