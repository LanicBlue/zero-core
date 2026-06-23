// 单测:工具块 args 在 session 恢复时的归一(契约:args 必须是 JSON 字符串)
//
// Bug:重启后工具块只剩 result、丢了调用参数。根因是 DB 存的 tool block
// args 是对象,渲染层把 args 当字符串 JSON.parse → 抛错 → 静默丢弃。
// 本测试锁定 normalizeBlockArgsForUi 把对象 args 归一成字符串。
import { describe, it, expect } from "vitest";
import { normalizeBlockArgsForUi } from "../../src/server/agent-service.js";

describe("normalizeBlockArgsForUi — 恢复路径 args 归一", () => {
	it("对象 args → JSON 字符串(模拟 DB 往返后的形态)", () => {
		// 模拟 turn-recorder 存的对象 args 经 JSON.stringify→DB→JSON.parse 后仍是对象
		const dbShape = JSON.parse(JSON.stringify([
			{ type: "tool", name: "Read", toolCallId: "tc1", status: "done",
				args: { file_path: "/a/b.ts", offset: 10 }, result: "file contents" },
		]));
		const out = normalizeBlockArgsForUi(dbShape);
		expect(out[0].args).toBe(JSON.stringify({ file_path: "/a/b.ts", offset: 10 }));
		// 渲染层 JSON.parse(args) 不再抛
		expect(() => JSON.parse(out[0].args)).not.toThrow();
		expect(JSON.parse(out[0].args).file_path).toBe("/a/b.ts");
	});

	it("已经是字符串的 args 不变(实时路径已经 stringify 过)", () => {
		const blocks = [
			{ type: "tool", name: "Shell", status: "done",
				args: '{"command":"ls"}', result: "a\nb" },
		];
		expect(normalizeBlockArgsForUi(blocks)[0].args).toBe('{"command":"ls"}');
	});

	it("嵌套对象 args 也能 stringify", () => {
		const blocks = [
			{ type: "tool", name: "Edit", status: "done",
				args: { old: "a", new: "b", replace_all: false }, result: "ok" },
		];
		const out = normalizeBlockArgsForUi(blocks);
		const parsed = JSON.parse(out[0].args);
		expect(parsed.old).toBe("a");
		expect(parsed.replace_all).toBe(false);
	});

	it("非 tool 块(text/thinking)不动", () => {
		const blocks = [
			{ type: "text", text: "hello" },
			{ type: "thinking", text: "hm" },
		];
		expect(normalizeBlockArgsForUi(blocks)).toEqual(blocks);
	});

	it("没有 args 字段的 tool 块不动", () => {
		const blocks = [{ type: "tool", name: "X", status: "done", result: "r" }];
		expect(normalizeBlockArgsForUi(blocks)).toEqual(blocks);
	});

	it("args 含不可序列化值(循环)时降级为 String() 不崩", () => {
		const circular: any = { a: 1 };
		circular.self = circular;
		const blocks = [{ type: "tool", name: "X", status: "done", args: circular, result: "r" }];
		const out = normalizeBlockArgsForUi(blocks);
		expect(typeof out[0].args).toBe("string");
	});
});
