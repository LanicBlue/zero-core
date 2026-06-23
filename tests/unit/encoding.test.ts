import { describe, it, expect } from "vitest";
import iconv from "iconv-lite";
import { decodeShellBuffer, decodeExecBuffers } from "../../src/core/encoding.js";

describe("decodeShellBuffer", () => {
	it("空 Buffer 返回空串", () => {
		expect(decodeShellBuffer(Buffer.alloc(0))).toBe("");
	});

	it("纯 ASCII 直通(合法 UTF-8)", () => {
		expect(decodeShellBuffer(Buffer.from("hello world", "utf8"))).toBe("hello world");
	});

	it("合法 UTF-8(含中文)直通,不走 GBK 回退", () => {
		const text = "中文测试 — émoji 🎉";
		expect(decodeShellBuffer(Buffer.from(text, "utf8"))).toBe(text);
	});

	it("GBK 编码的中文输出回退解码为正确字符串", () => {
		// Windows 原生命令(cmd/wmic)在中文系统默认吐 GBK(CP936)。
		// GBK 的「中文」字节序列不是合法 UTF-8,fatal UTF-8 解码会抛 → 回退 GBK。
		const gbkBuf = iconv.encode("中文测试", "gbk");
		// 确认它确实不是合法 UTF-8(否则测试前提不成立)
		expect(() => new TextDecoder("utf8", { fatal: true }).decode(gbkBuf)).toThrow();
		expect(decodeShellBuffer(gbkBuf)).toBe("中文测试");
	});

	it("GBK 含繁体/标点也能解码", () => {
		const gbkBuf = iconv.encode("連線成功！★", "gbk");
		expect(decodeShellBuffer(gbkBuf)).toBe("連線成功！★");
	});
});

describe("decodeExecBuffers", () => {
	it("Buffer 字段被解码,缺失字段返回空串", () => {
		expect(decodeExecBuffers({})).toEqual({ stdout: "", stderr: "" });
		expect(decodeExecBuffers({ stdout: Buffer.from("ok", "utf8") })).toEqual({
			stdout: "ok",
			stderr: "",
		});
	});

	it("GBK stdout + UTF-8 stderr 混合各自正确解码", () => {
		const r = decodeExecBuffers({
			stdout: iconv.encode("命令输出", "gbk"),
			stderr: Buffer.from("错误", "utf8"),
		});
		expect(r).toEqual({ stdout: "命令输出", stderr: "错误" });
	});
});
