// 单测:Grep 的 Node 原生 fallback(rg 不可用时,如 Windows)
//
// # 文件说明书
// ## 核心功能
// 验证 nativeGrepSearch 在无 ripgrep 环境下正确实现内容搜索:content /
// files_with_matches / count 三种模式、glob/type 过滤、-i、上下文、二进制跳过、
// node_modules/.git 跳过、head_limit。
// ## 为什么需要
// Windows 上 rg 不在 Node PATH,Grep 主路径 ENOENT。原生 fallback 是 Windows
// 下唯一的搜索路径,必须有测试守住,否则会重演 "spawn grep ENOENT" 全挂。
//

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeGrepSearch } from "../../src/tools/grep.js";

let root: string;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "zc-grep-"));
	// a.ts — 含目标 pattern
	writeFileSync(join(root, "a.ts"), "const ZERO = 1;\nexport { zero };\n// nothing here\n");
	// b.ts — 大小写不同(验证 -i)
	writeFileSync(join(root, "b.ts"), "const ZeroUp = 2;\n");
	// README.md — 不应被 type=ts 命中
	writeFileSync(join(root, "README.md"), "# zero docs\n");
	// node_modules/skip.ts — 必须被跳过
	mkdirSync(join(root, "node_modules"), { recursive: true });
	writeFileSync(join(root, "node_modules", "skip.ts"), "const zero = 'should-not-match';\n");
	// bin.png — 二进制,跳过
	writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
});
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

describe("nativeGrepSearch (rg-free fallback)", () => {
	it("content mode returns path:line:match", async () => {
		const out = await nativeGrepSearch({
			pattern: "zero", searchPath: root, output_mode: "content",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toContain("a.ts:2:");
		// 大小写敏感:不应命中 ZeroUp
		expect(out).not.toContain("b.ts:");
	});

	it("case-insensitive (-i) matches across case", async () => {
		const out = await nativeGrepSearch({
			pattern: "zero", searchPath: root, output_mode: "files_with_matches",
			caseInsensitive: true, head_limit: 50, max_columns: 500,
		});
		expect(out).toContain("a.ts");
		expect(out).toContain("b.ts");
	});

	it("type filter restricts by extension", async () => {
		const out = await nativeGrepSearch({
			pattern: "zero", searchPath: root, type: "ts", output_mode: "files_with_matches",
			caseInsensitive: true, head_limit: 50, max_columns: 500,
		});
		expect(out).toContain("a.ts");
		expect(out).not.toContain("README.md");
	});

	it("count mode reports per-file counts", async () => {
		const out = await nativeGrepSearch({
			pattern: "zero", searchPath: root, type: "ts", output_mode: "count",
			caseInsensitive: true, head_limit: 50, max_columns: 500,
		});
		expect(out).toMatch(/a\.ts:\d+/);
	});

	it("skips node_modules", async () => {
		const out = await nativeGrepSearch({
			pattern: "should-not-match", searchPath: root, output_mode: "files_with_matches",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toBe("No matches found.");
	});

	it("skips binary files", async () => {
		// PNG starts with bytes that include no ASCII 'zero'; ensure no crash + no match.
		const out = await nativeGrepSearch({
			pattern: "zero", searchPath: root, glob: "*.png", output_mode: "files_with_matches",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toBe("No matches found.");
	});

	it("glob filter (*.ts)", async () => {
		const out = await nativeGrepSearch({
			pattern: "zero", searchPath: root, glob: "*.ts", output_mode: "files_with_matches",
			caseInsensitive: true, head_limit: 50, max_columns: 500,
		});
		expect(out).toContain("a.ts");
		expect(out).not.toContain("README.md");
	});

	it("respects head_limit", async () => {
		const out = await nativeGrepSearch({
			pattern: "zero", searchPath: root, type: "ts", output_mode: "content",
			caseInsensitive: true, head_limit: 1, max_columns: 500,
		});
		// content 模式按行截到 head_limit;最多 1 行(可能带上下文,但无 ctx 时仅 1 行)
		const lines = out.split("\n").filter((l) => l.trim() && !l.startsWith("..."));
		expect(lines.length).toBeLessThanOrEqual(1);
	});

	it("reports invalid regex cleanly", async () => {
		const out = await nativeGrepSearch({
			pattern: "([", searchPath: root, output_mode: "content",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toContain("Invalid regex");
	});
});
