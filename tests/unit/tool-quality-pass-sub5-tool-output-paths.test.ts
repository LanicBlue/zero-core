// tool-quality-pass sub-5 acceptance test: `[tool-outputs]/` 虚拟前缀通道
//
// # 文件说明书
//
// ## 核心功能
// 独立、对抗式验证 docs/plan/tool-quality-pass/acceptance-5.md 的 10 条:
//   1. 新前缀格式:maybeExternalizeToolResult(>16K) 返指针含 `[tool-outputs]/`(非 `.zero-core/`)。
//   2. **Read 真能读虚拟路径(核心!)**:产出真外部化文件后,fileReadTool 用
//      `[tool-outputs]/<hash>.txt` 读到文件真实内容(证明 Read 真解析了新前缀,
//      不只 externalizer 改了串)。
//   3. 沙箱拒越界:`[tool-outputs]/../../etc/passwd` 等逃逸 → 权限错误,不读外部。
//   4. 不存在文件 → 合理错误(not found),不崩。
//   5. 旧指针兼容:resolvePointerRelPath(`.zero-core/tool-outputs/...`) 仍还原绝对。
//   6. 新指针还原:resolvePointerRelPath(`[tool-outputs]/...`) 还原绝对。
//   7. 不泄露绝对路径:指针串不含 `C:/Users/...` 等。
//   8. typecheck 绿(由 build:lib 验证,本文件仅自身类型正确)。
//   9. 既有 externalize 测试不回归(指针格式断言更新,见 steps-overhaul-sub2-externalize.test.ts:104)。
//   10. 既有 `[skills]/` 通道不回归(由 skill-paths.test.ts 覆盖,本文件加一条对照断言)。
//
// ## 设计
// ZERO_CORE_DIR 已被 vitest.config.ts 在测试启动前 pin 到 per-run temp dir(见其
// 头注释)—— 所以写到 <ZERO_CORE_DIR>/tool-outputs/ 的真外部化文件落 OS temp,
// 永不污染真 ~/.zero-core/。我们从 core/config.ts 直接 import ZERO_CORE_DIR 拿到
// 该 temp 路径,既验纯函数(resolveToolOutputPath / resolvePointerRelPath),也
// 端到端驱动 fileReadTool.execute(走 buildTool wrapper 的 experimental_context
// 路径,镜像 skill-paths.test.ts 的 callExecute 模式)。
//
// ## Acceptance mapping (acceptance-5.md)
//   - "#1 新前缀格式"           → "新前缀格式" describe
//   - "#2 Read 真消费"          → "Read execute:[tool-outputs]/ 通道(核心)" describe
//   - "#3 沙箱拒越界"           → 同上 describe 的越界用例
//   - "#4 不存在文件清晰错误"   → 同上 describe
//   - "#5/#6 旧/新指针兼容"     → "resolvePointerRelPath:双形态兼容" describe
//   - "#7 不泄露绝对路径"       → "新前缀格式" + "Read execute" 多处断言
//   - "#8 typecheck"            → 外部 build:lib
//   - "#9 既有测试不回归"       → 由 steps-overhaul-sub2-externalize.test.ts 改 1 处断言
//   - "#10 [skills]/ 不回归"    → 由 skill-paths.test.ts 既覆盖;本文件加 1 条对照

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZERO_CORE_DIR } from "../../src/core/config.js";
import { fileReadTool } from "../../src/tools/file-read.js";
import {
	tryParseToolOutputPath,
	resolveToolOutputPath,
	isToolOutputVirtualPath,
	TOOL_OUTPUTS_VIRTUAL_PREFIX,
} from "../../src/tools/tool-output-paths.js";
import {
	maybeExternalizeToolResult,
	parseExternalizedPointer,
	resolvePointerRelPath,
	TOOL_RESULT_EXTERNALIZE_THRESHOLD,
} from "../../src/runtime/tool-result-externalizer.js";

// ---------------------------------------------------------------------------
// Helpers (mirror skill-paths.test.ts callExecute pattern)
// ---------------------------------------------------------------------------

/**
 * Drive fileReadTool via the buildTool wrapper (experimental_context path),
 * identical to how the real tool is invoked. Returns the formatted text on
 * success, or the failure-message string on ok:false (wrapper throws; we catch).
 *
 * readScope defaults to "workspace" to verify the [tool-outputs]/ channel
 * bypasses the workspace guard (mirrors skill-paths.test.ts).
 */
async function callReadExecute(
	input: any,
	opts: { workingDir?: string; readScope?: "workspace" | "filesystem" } = {},
): Promise<string> {
	const ctx: any = {
		workingDir: opts.workingDir,
		agentId: "test-agent",
		readScope: opts.readScope ?? "workspace",
		emit: () => {},
	};
	try {
		return await fileReadTool.execute(input, { experimental_context: { ctx } });
	} catch (err: any) {
		// wrapper throws Error(formattedText) on ok:false; expose the message
		// so failure assertions can match against the text content uniformly.
		return err?.message ?? String(err);
	}
}

/**
 * Write a file directly under <ZERO_CORE_DIR>/tool-outputs/<filename>.
 * Used to set up an externalized file without going through maybeExternalizeToolResult
 * (for cases that need a known filename / content).
 */
function writeToolOutputFile(filename: string, content: string): string {
	const dir = join(ZERO_CORE_DIR, "tool-outputs");
	mkdirSync(dir, { recursive: true });
	const abs = join(dir, filename);
	writeFileSync(abs, content, "utf8");
	return abs;
}

/** Build a string of approximately N UTF-8 bytes (ASCII repeated). */
function makeBigResult(bytes: number): string {
	return "x".repeat(bytes);
}

/**
 * Strip Read's cat -n line-number prefix (`<N>\t`) from each line, returning
 * the raw payload. Read in full mode returns `<lineNo>\t<line>` per line; for
 * content-comparison assertions we want the line payload, not the formatting.
 */
function stripCatN(s: string): string {
	return s.split("\n").map((l) => l.replace(/^\d+\t/, "")).join("\n");
}

// ===========================================================================
// 纯函数:tryParseToolOutputPath(前缀识别)
// ===========================================================================
describe("tryParseToolOutputPath:前缀识别", () => {
	test("[tool-outputs]/foo.txt → {rest:'foo.txt'}", () => {
		expect(tryParseToolOutputPath("[tool-outputs]/foo.txt")).toEqual({ rest: "foo.txt" });
	});

	test("[tool-outputs]/sub/bar.md → 嵌套保留", () => {
		expect(tryParseToolOutputPath("[tool-outputs]/sub/bar.md")).toEqual({ rest: "sub/bar.md" });
	});

	test("win32 反斜杠形态 [tool-outputs]\\foo.txt", () => {
		expect(tryParseToolOutputPath("[tool-outputs]\\foo.txt")).toEqual({ rest: "foo.txt" });
	});

	test("裸 [tool-outputs]/ → null(无 rel)", () => {
		expect(tryParseToolOutputPath("[tool-outputs]/")).toBeNull();
	});

	test("非 [tool-outputs]/ 前缀 → null(交回原流程)", () => {
		expect(tryParseToolOutputPath("/abs/path/file.md")).toBeNull();
		expect(tryParseToolOutputPath("relative/file.md")).toBeNull();
		expect(tryParseToolOutputPath("[skills]/foo/SKILL.md")).toBeNull(); // 旧通道不误吞
		expect(tryParseToolOutputPath("[tool-outputs]foo.txt")).toBeNull(); // 缺 /
	});

	test("包裹引号被 strip", () => {
		expect(tryParseToolOutputPath('"[tool-outputs]/foo.txt"')).toEqual({ rest: "foo.txt" });
	});
});

// ===========================================================================
// 纯函数:isToolOutputVirtualPath(轻量前缀判定)
// ===========================================================================
describe("isToolOutputVirtualPath:轻量前缀判定", () => {
	test("[tool-outputs]/foo → true", () => {
		expect(isToolOutputVirtualPath("[tool-outputs]/foo.txt")).toBe(true);
	});

	test("非前缀 → false", () => {
		expect(isToolOutputVirtualPath("/abs/path")).toBe(false);
		expect(isToolOutputVirtualPath("[skills]/foo")).toBe(false);
		expect(isToolOutputVirtualPath("")).toBe(false);
		expect(isToolOutputVirtualPath(null as any)).toBe(false);
	});

	test("TOOL_OUTPUTS_VIRTUAL_PREFIX 常量值", () => {
		expect(TOOL_OUTPUTS_VIRTUAL_PREFIX).toBe("[tool-outputs]/");
	});
});

// ===========================================================================
// 纯函数:resolveToolOutputPath(解析 + 沙箱)
// ===========================================================================
describe("resolveToolOutputPath:解析 + 沙箱", () => {
	test("[tool-outputs]/foo.txt → 真实路径(join ZERO_CORE_DIR/tool-outputs/foo.txt)", () => {
		const r = resolveToolOutputPath("[tool-outputs]/foo.txt");
		expect(r).not.toBeNull();
		expect(r && r.ok).toBe(true);
		if (r && r.ok) {
			expect(r.realPath).toBe(join(ZERO_CORE_DIR, "tool-outputs", "foo.txt"));
			expect(r.baseDir).toBe(join(ZERO_CORE_DIR, "tool-outputs"));
			// 真实路径在 baseDir 内
			expect(r.realPath.startsWith(r.baseDir)).toBe(true);
		}
	});

	test("[tool-outputs]/sub/../foo.txt → 单段 ../ 回到 baseDir 内 → 通过", () => {
		// 沙箱只挡"resolve 后落在 baseDir 外"的越界;合法子目录回退不挡。
		const r = resolveToolOutputPath("[tool-outputs]/sub/../foo.txt");
		expect(r && r.ok).toBe(true);
		if (r && r.ok) {
			expect(r.realPath).toBe(join(ZERO_CORE_DIR, "tool-outputs", "foo.txt"));
		}
	});

	test("[tool-outputs]/../../etc/passwd → {ok:false}(路径沙箱越界)", () => {
		const r = resolveToolOutputPath("[tool-outputs]/../../etc/passwd");
		expect(r).not.toBeNull();
		expect(r && !r.ok).toBe(true);
		if (r && !r.ok) {
			expect(r.error).toContain("outside tool-outputs directory");
		}
	});

	test("[tool-outputs]/../escape.txt → {ok:false}(单段 ../ 越界)", () => {
		const r = resolveToolOutputPath("[tool-outputs]/../escape.txt");
		expect(r && !r.ok).toBe(true);
		if (r && !r.ok) {
			expect(r.error).toContain("outside tool-outputs directory");
		}
	});

	test("非 [tool-outputs]/ 前缀 → null(交回原流程)", () => {
		expect(resolveToolOutputPath("/abs/path/file.md")).toBeNull();
		expect(resolveToolOutputPath("[skills]/foo/SKILL.md")).toBeNull();
	});
});

// ===========================================================================
// acceptance #1 + #7: 新前缀格式 + 不泄露绝对路径
// ===========================================================================
describe("acceptance #1/#7:maybeExternalizeToolResult 返新前缀 + 不泄露绝对路径", () => {
	test("#1 指针串含 `[tool-outputs]/<hash>.txt`(不再是 `.zero-core/`)", () => {
		const big = makeBigResult(TOOL_RESULT_EXTERNALIZE_THRESHOLD + 1000);
		const pointer = maybeExternalizeToolResult(big);
		expect(pointer, ">16K 返非 null 指针").not.toBeNull();
		expect(typeof pointer).toBe("string");
		// 自描述前缀仍在。
		expect(pointer!.startsWith("[externalized: ")).toBe(true);
		// 关键:含新前缀 `[tool-outputs]/`(不再 `.zero-core/`)。
		expect(pointer, "新前缀").toContain("[tool-outputs]/");
		// 不再含旧前缀(否则 agent 仍会误读为 workspace 相对)。
		expect(pointer, "不含旧前缀").not.toContain(".zero-core/tool-outputs/");
		// .txt 扩展名 + 字节数仍在。
		expect(pointer).toContain(".txt");
		expect(pointer).toContain(`${Buffer.byteLength(big, "utf8")} bytes`);
	});

	test("#1 指针串内 hash 形如 `<sha256-hex>.txt`", () => {
		const big = makeBigResult(TOOL_RESULT_EXTERNALIZE_THRESHOLD + 1);
		const pointer = maybeExternalizeToolResult(big)!;
		const parsed = parseExternalizedPointer(pointer);
		expect(parsed).not.toBeNull();
		// relPath 形如 `[tool-outputs]/<64 hex>.txt`
		expect(parsed!.relPath).toMatch(/^\[tool-outputs\]\/[0-9a-f]{64}\.txt$/);
	});

	test("#7 指针串不含绝对路径(虚拟前缀,home 不泄露)", () => {
		const big = makeBigResult(TOOL_RESULT_EXTERNALIZE_THRESHOLD + 500);
		const pointer = maybeExternalizeToolResult(big)!;
		// 不含 ZERO_CORE_DIR 的任何段(尤其不含 homedir 绝对前缀)。
		expect(pointer).not.toContain(ZERO_CORE_DIR);
		// 不含典型 win32 / posix 绝对路径标志。
		expect(pointer).not.toMatch(/[A-Za-z]:[\\/]/); // C:\ / C:/
		expect(pointer).not.toContain("/Users/");
		expect(pointer).not.toContain("/home/");
	});

	test("≤16K result → null(不外置,与 sub-2 行为一致)", () => {
		const small = makeBigResult(1000);
		expect(maybeExternalizeToolResult(small)).toBeNull();
	});
});

// ===========================================================================
// acceptance #2/#3/#4: Read execute `[tool-outputs]/` 通道(核心!)
// ===========================================================================
describe("acceptance #2/#3/#4:Read execute `[tool-outputs]/` 通道(核心)", () => {
	let tmpWorkDir: string;

	beforeEach(() => {
		// 临时 workspace(用于验证 `[tool-outputs]/` 通道绕过 workspace 守卫)。
		tmpWorkDir = mkdtempSync(join(tmpdir(), "zc-sub5-read-"));
	});

	afterEach(() => {
		try { rmSync(tmpWorkDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
	});

	// ─── #2 CORE:Read 真消费新前缀(端到端:externalize → 解析 → Read 读回)────
	test("#2 [CORE] externalize(>16K) → Read `[tool-outputs]/<hash>.txt` 读回原内容", async () => {
		const originalContent = "BIG_CONTENT_" + "y".repeat(TOOL_RESULT_EXTERNALIZE_THRESHOLD + 2000);
		// 1) 真外部化:经 maybeExternalizeToolResult 写文件 + 产指针串。
		const pointer = maybeExternalizeToolResult(originalContent);
		expect(pointer, "外部化成功").not.toBeNull();
		// 2) 从指针串提取 relPath(`[tool-outputs]/<hash>.txt`)。
		const parsed = parseExternalizedPointer(pointer!);
		expect(parsed, "指针可解析").not.toBeNull();
		const virtualPath = parsed!.relPath;
		expect(virtualPath.startsWith(TOOL_OUTPUTS_VIRTUAL_PREFIX), "relPath 是新虚拟前缀").toBe(true);
		// 3) [核心] Read 工具用虚拟前缀路径读 → 读到真实文件内容(证明 Read 真解析了
		//    新前缀,不只 externalizer 改了串)。Read 在 full 模式下返 cat -n 格式
		//    (`<行号>\t<内容>`),strip 行号后 = 原始内容。
		const readBack = await callReadExecute({ path: virtualPath });
		const payload = stripCatN(readBack);
		// 读到的内容必须就是原始 result 的完整字节(无指针串、无错误信息)。
		expect(payload, "Read 读回 = 原始内容(strip cat -n 后)").toBe(originalContent);
		// 反向断言:不是指针串、不是错误信息。
		expect(readBack.startsWith("[externalized:"), "不是指针串").toBe(false);
		expect(readBack.startsWith("Error:"), "不是错误").toBe(false);
	});

	// ─── #2 CORE(变体):直接写文件 → Read 用虚拟前缀读到 ────────────────────
	test("#2 [CORE-variant] 直接写 tool-outputs 文件 → Read `[tool-outputs]/known.txt` 读到", async () => {
		const known = "DIRECT_WRITE_BODY_LINE_1\nDIRECT_WRITE_BODY_LINE_2\n";
		writeToolOutputFile("known.txt", known);
		const out = await callReadExecute({ path: "[tool-outputs]/known.txt" });
		expect(out).toContain("DIRECT_WRITE_BODY_LINE_1");
		expect(out).toContain("DIRECT_WRITE_BODY_LINE_2");
		// 形态:cat -n 格式(每行带行号 + tab),与 Read 对真实路径的行为一致。
		expect(out).toMatch(/^\s*1\tDIRECT_WRITE_BODY_LINE_1/m);
	});

	// ─── #2 CORE:绕过 workspace 守卫(与 [skills]/ 通道语义一致) ──────────────
	test("#2 [tool-outputs]/ 通道绕过 workspace 守卫(不依赖 readScope)", async () => {
		// workingDir 是个空 tmp 目录;真实文件在 ZERO_CORE_DIR 下(workspace 外)。
		// `[tool-outputs]/` 通道应放行(不依赖 workingDir);真实路径 readScope=workspace
		// 本来会拒的。
		writeToolOutputFile("wsbypass.txt", "WS_BYPASS_OK");
		const out = await callReadExecute(
			{ path: "[tool-outputs]/wsbypass.txt" },
			{ workingDir: tmpWorkDir, readScope: "workspace" },
		);
		expect(out).toContain("WS_BYPASS_OK");
	});

	// ─── #3 沙箱拒越界(双逃逸)──────────────────────────────────────────────
	test("#3 Read `[tool-outputs]/../../etc/passwd` → 拒(权限错误,不读外部)", async () => {
		// 在 ZERO_CORE_DIR 上一级放一个"敏感"文件,验证沙箱挡(`../` 越界 → 拒)。
		// 即便该文件存在,Read 也不能读到。
		writeFileSync(join(ZERO_CORE_DIR, "secret-sentinel.txt"), "TOPSECRET");
		const out = await callReadExecute({
			path: "[tool-outputs]/../secret-sentinel.txt",
		});
		// 错误信息含 "outside tool-outputs directory"。
		expect(out, "拒含 outside tool-outputs").toContain("outside tool-outputs directory");
		// 关键:绝不能读到敏感文件内容。
		expect(out, "不泄露敏感内容").not.toContain("TOPSECRET");
	});

	test("#3 Read `[tool-outputs]/../../etc/passwd`(双 ../)→ 拒", async () => {
		const out = await callReadExecute({
			path: "[tool-outputs]/../../etc/passwd",
		});
		expect(out).toContain("outside tool-outputs directory");
	});

	// ─── #4 不存在文件 → 合理错误(not found),不崩 ────────────────────────────
	test("#4 Read `[tool-outputs]/deadbeef.txt`(不存在)→ File not found 错误,不崩", async () => {
		const out = await callReadExecute({
			path: "[tool-outputs]/deadbeef-not-exists.txt",
		});
		// 返合理错误(not found),不崩、不返空字符串。
		expect(out, "返非空响应").toBeTruthy();
		expect(out, "含 File not found").toContain("not found");
		// 不是崩溃痕迹(无 stack trace / undefined)。
		expect(out).not.toContain("undefined");
		expect(out).not.toContain("Cannot read properties");
	});
});

// ===========================================================================
// acceptance #5/#6: resolvePointerRelPath 双形态兼容(向后兼容核心)
// ===========================================================================
describe("acceptance #5/#6:resolvePointerRelPath 双形态兼容", () => {
	test("#6 新形态 `[tool-outputs]/<hash>.txt` → join(ZERO_CORE_DIR, tool-outputs, <hash>.txt)", () => {
		const rel = "[tool-outputs]/abc123.txt";
		const abs = resolvePointerRelPath(rel);
		expect(abs).toBe(join(ZERO_CORE_DIR, "tool-outputs", "abc123.txt"));
		// 必须是绝对路径(可被 readFileSync 直接消费)。
		expect(abs.startsWith(ZERO_CORE_DIR)).toBe(true);
	});

	test("#6 新形态嵌套 `[tool-outputs]/sub/x.txt` 保留", () => {
		const abs = resolvePointerRelPath("[tool-outputs]/sub/x.txt");
		expect(abs).toBe(join(ZERO_CORE_DIR, "tool-outputs", "sub", "x.txt"));
	});

	test("#5 旧形态 `.zero-core/tool-outputs/<hash>.txt` → 仍还原绝对(向后兼容)", () => {
		// 历史(sub-5 前)指针嵌的是 `<ZERO_CORE_DIR basename>/tool-outputs/<hash>.txt`。
		// resolvePointerRelPath 去掉首段 basename 后拼到 ZERO_CORE_DIR,旧 steps 行不破。
		const oldRel = ".zero-core/tool-outputs/legacyhash.txt";
		const abs = resolvePointerRelPath(oldRel);
		expect(abs).toBe(join(ZERO_CORE_DIR, "tool-outputs", "legacyhash.txt"));
	});

	test("#5 旧形态读真文件 → 内容一致(端到端向后兼容)", () => {
		// 写一个旧式命名的真外部化文件,然后用旧形态指针寻回它。
		writeToolOutputFile("legacy-1.txt", "LEGACY_BODY");
		const oldRel = ".zero-core/tool-outputs/legacy-1.txt";
		const abs = resolvePointerRelPath(oldRel);
		// 用解析出的绝对路径直接读 → 拿到内容(模拟旧 steps 渲染时寻回)。
		const { readFileSync } = require("node:fs");
		expect(readFileSync(abs, "utf8")).toBe("LEGACY_BODY");
	});

	test("#5/#6 双形态解析到同一文件(等价)", () => {
		// 同一 hash 的两种指针形态应解析到同一绝对路径。
		const oldAbs = resolvePointerRelPath(".zero-core/tool-outputs/samehash.txt");
		const newAbs = resolvePointerRelPath("[tool-outputs]/samehash.txt");
		expect(newAbs).toBe(oldAbs);
	});
});

// ===========================================================================
// 端到端:#2 真消费链路全验(externalize → parse → resolve → Read 读回)
// ===========================================================================
describe("acceptance #2 端到端:externalize → parse → resolve → Read 读回", () => {
	test("完整链路:外置文件 + 指针解析 + Read 经虚拟前缀读回 + 字节一致", async () => {
		const content = "FULL_PIPELINE_" + "z".repeat(TOOL_RESULT_EXTERNALIZE_THRESHOLD + 1234);

		// 1) 外置(产文件 + 指针)。
		const pointer = maybeExternalizeToolResult(content)!;
		// 2) 指针解析出 relPath(虚拟前缀)。
		const parsed = parseExternalizedPointer(pointer)!;
		expect(parsed.bytes).toBe(Buffer.byteLength(content, "utf8"));
		// 3) 旧 API(resolvePointerRelPath)也能还原绝对路径(双形态等价)。
		const absViaResolve = resolvePointerRelPath(parsed.relPath);
		expect(absViaResolve.startsWith(ZERO_CORE_DIR)).toBe(true);
		// 4) [核心] Read 用虚拟前缀读回 = 原始字节(strip cat -n 行号后比较)。
		const viaTool = await callReadExecute({ path: parsed.relPath });
		expect(stripCatN(viaTool)).toBe(content);
	});
});

// ===========================================================================
// acceptance #10:既有 `[skills]/` 通道不回归(对照断言,主覆盖在 skill-paths.test.ts)
// ===========================================================================
describe("acceptance #10:`[skills]/` 通道不回归(对照断言)", () => {
	test("非 `[tool-outputs]/` 前缀的解析路径不被新通道误吞(null 交回原流程)", () => {
		// 关键不变量:[skills]/ 和 [tool-outputs]/ 两个通道互不干扰,各自只识别自己。
		expect(resolveToolOutputPath("[skills]/foo/SKILL.md")).toBeNull();
		expect(tryParseToolOutputPath("[skills]/foo/SKILL.md")).toBeNull();
		// 反向:skill 通道的 tryParseSkillPath 也不会误吞 [tool-outputs]/(由
		// skill-paths.test.ts 覆盖,这里只对照 [tool-outputs]/ 侧)。
		expect(isToolOutputVirtualPath("[skills]/foo")).toBe(false);
	});
});
