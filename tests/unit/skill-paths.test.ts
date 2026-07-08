// 单元测试:skill-system sub-2 `[skills]/` 虚拟路径通道(acceptance-2)
//
// # 文件说明书
//
// ## 核心功能
// 验证 `[skills]/` 虚拟路径通道:
// - 解析器(tryParseSkillPath / resolveSkillPath):前缀识别 / 沙箱 / 不存在。
// - 回映射(mapRealToVirtual / remapGrepOutputLines):真实路径 → 虚拟形态,无泄露。
// - 替换(replaceSkillDirVars):${SKILL_DIR} / ${CLAUDE_SKILL_DIR} → [skills]/<id>。
// - Read/Glob/Grep execute 的 skill 通道行为(始终放行 / 结果回映射 / 单 skill 限定)。
//
// ## 输入
// src/tools/skill-paths.ts 的纯函数 + src/tools/{file-read,glob,grep}.ts 的 buildTool 产物。
// 每个 execute 用例在 tmp home 下搭 mock skill 目录,经 home 注入(scanner sub-1 机制)。
//
// ## 输出
// Vitest 用例覆盖 acceptance-2.md 的核心场景(用例 1/3/4/6/7/8/9/10/11/12/13)。
//
// ## 定位
// tests/unit/ —— 单元测试,验证 sub-2 读家族通道。
//
// ## 依赖
// vitest、node:fs、node:os、node:path。
//
// ## 维护规则
// 解析器/回映射逻辑改动时同步更新;mock skill 经 home 参数注入,不污染真实 ~/.claude。
// 注意:execute 调用走 buildTool 的 experimental_context({ctx:...})形态,readScope 从 ctx 桥。
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// 文件级 mock:把 node:os 的 homedir 指向测试 tmp home。
// 原因:execute 代码里 resolveSkillByName(id) 不传 home(生产用真实 home,无此问题),
// 测试要让它发现 tmp 下建的 mock skill,只能改 os.homedir() 返回值。
// vi.mock 文件级隔离,不影响其他测试文件。
const mockHome = { current: "" };
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return {
		...actual,
		homedir: () => mockHome.current,
	};
});
import {
	resolveSkillPath,
	tryParseSkillPath,
	mapRealToVirtual,
	remapGrepOutputLines,
	replaceSkillDirVars,
	isPathInSkillBase,
} from "../../src/tools/skill-paths.js";
import { fileReadTool } from "../../src/tools/file-read.js";
import { globTool } from "../../src/tools/glob.js";
import { grepTool } from "../../src/tools/grep.js";

// 在 tmp home 下建一个 skill 目录 + SKILL.md(经 scanner 的 home 注入发现)。
function createSkill(
	home: string,
	dirName: string,
	body = "body",
	extraFiles: Record<string, string> = {},
): string {
	const skillDir = join(home, ".claude", "skills", dirName);
	mkdirSync(skillDir, { recursive: true });
	const fm = ["---", `name: ${dirName}`, `description: ${dirName} skill`, "---", "", body];
	writeFileSync(join(skillDir, "SKILL.md"), fm.join("\n"), "utf-8");
	for (const [rel, content] of Object.entries(extraFiles)) {
		const target = join(skillDir, rel);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content, "utf-8");
	}
	return skillDir;
}

// buildTool 的 execute 走 experimental_context({ctx}) 形态;readScope 从 ctx 桥。
// 传 readScope="workspace" 验证"skill 通道始终放行(不经 readScope)"。
// 注意:buildTool wrapper 把 ToolResult{ok:false} 翻译成 throw(给 AI SDK tool-error),
// 所以失败路径会 reject。本 helper 捕获后返回 error.message(= format 后文本),
// 让测试用 toContain 断言统一工作。
async function callExecute(
	tool: any,
	input: any,
	opts: { workingDir?: string; readScope?: "workspace" | "filesystem" } = {},
): Promise<any> {
	const ctx: any = {
		workingDir: opts.workingDir,
		agentId: "test-agent",
		readScope: opts.readScope ?? "workspace",
		emit: () => {},
	};
	try {
		return await tool.execute(input, { experimental_context: { ctx } });
	} catch (err: any) {
		return err?.message ?? String(err);
	}
}

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "zc-skill-paths-"));
	mockHome.current = home;
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

// ===========================================================================
// 纯函数:tryParseSkillPath(前缀识别)
// ===========================================================================
describe("tryParseSkillPath:前缀识别", () => {
	test("[skills]/foo/SKILL.md → {skillId:'foo', rel:'SKILL.md'}", () => {
		expect(tryParseSkillPath("[skills]/foo/SKILL.md")).toEqual({
			skillId: "foo",
			rel: "SKILL.md",
		});
	});

	test("[skills]/foo → rel 为空(skill 根)", () => {
		expect(tryParseSkillPath("[skills]/foo")).toEqual({ skillId: "foo", rel: "" });
	});

	test("win32 反斜杠形态 [skills]\\foo\\bar.md", () => {
		expect(tryParseSkillPath("[skills]\\foo\\bar.md")).toEqual({
			skillId: "foo",
			rel: "bar.md",
		});
	});

	test("裸 [skills]/ → null(不指名 skill)", () => {
		expect(tryParseSkillPath("[skills]/")).toBeNull();
	});

	test("非 skill 前缀 → null", () => {
		expect(tryParseSkillPath("/abs/path/file.md")).toBeNull();
		expect(tryParseSkillPath("relative/file.md")).toBeNull();
		expect(tryParseSkillPath("[skills]foo/SKILL.md")).toBeNull(); // 缺 /
	});

	test("包裹引号被 strip", () => {
		expect(tryParseSkillPath('"[skills]/foo/SKILL.md"')).toEqual({
			skillId: "foo",
			rel: "SKILL.md",
		});
	});
});

// ===========================================================================
// 纯函数:resolveSkillPath(解析 + 沙箱)
// ===========================================================================
describe("resolveSkillPath:解析 + 沙箱 + 不存在", () => {
	test("存在 skill → 真实路径(在 baseDir 内)", () => {
		const dir = createSkill(home, "foo");
		const r = resolveSkillPath("[skills]/foo/SKILL.md", home);
		expect(r).toEqual({
			ok: true,
			realPath: join(dir, "SKILL.md"),
			skillId: "foo",
			baseDir: dir,
		});
	});

	test("不存在 skill → {ok:false, error 含 'skill not found'}", () => {
		const r = resolveSkillPath("[skills]/ghost/SKILL.md", home);
		expect(r).toEqual({ ok: false, error: expect.stringContaining("skill not found") });
	});

	test("../越界 → {ok:false}(路径沙箱)", () => {
		createSkill(home, "foo");
		const r = resolveSkillPath("[skills]/foo/../../etc/passwd", home);
		expect(r).toEqual({ ok: false, error: expect.stringContaining("outside skill directory") });
	});

	test("单段 ../ 回到 baseDir 内 → 通过(沙箱只挡越界)", () => {
		createSkill(home, "foo");
		// [skills]/foo/sub/../SKILL.md → resolve 后 = foo/SKILL.md,在 base 内 → 通过。
		// 沙箱只挡"resolve 后落在 baseDir 外"的越界,不挡合法的子目录回退。
		const r = resolveSkillPath("[skills]/foo/sub/../SKILL.md", home);
		expect(r && "ok" in r && r.ok).toBe(true);
	});

	test("非 [skills]/ 前缀 → null(交回原流程)", () => {
		const r = resolveSkillPath("/abs/path", home);
		expect(r).toBeNull();
	});
});

// ===========================================================================
// 纯函数:mapRealToVirtual(回映射)
// ===========================================================================
describe("mapRealToVirtual:真实路径 → 虚拟形态", () => {
	test("baseDir 内文件 → [skills]/<id>/<rel>", () => {
		const dir = createSkill(home, "foo", "", { "ref.md": "x" });
		const realFile = join(dir, "ref.md");
		expect(mapRealToVirtual(realFile, "foo", dir)).toBe("[skills]/foo/ref.md");
	});

	test("嵌套子路径保留", () => {
		const dir = createSkill(home, "foo", "", { "scripts/x.py": "y" });
		expect(mapRealToVirtual(join(dir, "scripts", "x.py"), "foo", dir)).toBe(
			"[skills]/foo/scripts/x.py",
		);
	});

	test("baseDir 本身 → [skills]/<id>(无尾斜杠)", () => {
		const dir = createSkill(home, "foo");
		expect(mapRealToVirtual(dir, "foo", dir)).toBe("[skills]/foo");
	});

	test("baseDir 外路径 → 原样返回(不映射,保留可观测性)", () => {
		const dir = createSkill(home, "foo");
		const outside = join(home, "other.md");
		expect(mapRealToVirtual(outside, "foo", dir)).toBe(outside);
	});

	test("win32 反斜杠路径 → 正斜杠虚拟形态", () => {
		const dir = createSkill(home, "foo", "", { "a/b.md": "x" });
		const realWithBackslash = join(dir, "a", "b.md").replace(/\//g, "\\");
		// 仅 win32 跑这个断言的强形态(posix 下 join 不产反斜杠,跳过强断言)
		const mapped = mapRealToVirtual(realWithBackslash, "foo", dir);
		expect(mapped).toBe("[skills]/foo/a/b.md");
		expect(mapped).not.toContain("\\");
	});
});

// ===========================================================================
// 纯函数:isPathInSkillBase(沙箱判定)
// ===========================================================================
describe("isPathInSkillBase:沙箱白名单", () => {
	test("baseDir 内 → true", () => {
		const dir = createSkill(home, "foo", "", { "a.md": "x" });
		expect(isPathInSkillBase(join(dir, "a.md"), dir)).toBe(true);
		expect(isPathInSkillBase(dir, dir)).toBe(true);
	});

	test("baseDir 外 → false", () => {
		const dir = createSkill(home, "foo");
		expect(isPathInSkillBase(join(home, "outside.md"), dir)).toBe(false);
		// 前缀同名但非子目录(baseDirX vs baseDir)→ false
		mkdirSync(join(home, ".claude", "skills", "foobar"), { recursive: true });
		expect(isPathInSkillBase(join(home, ".claude", "skills", "foobar"), dir)).toBe(false);
	});
});

// ===========================================================================
// 纯函数:replaceSkillDirVars(${SKILL_DIR} / ${CLAUDE_SKILL_DIR} 替换)
// ===========================================================================
describe("replaceSkillDirVars:自引用变量替换", () => {
	test("${SKILL_DIR} → [skills]/foo", () => {
		expect(replaceSkillDirVars("see ${SKILL_DIR}/ref.md", "foo")).toBe(
			"see [skills]/foo/ref.md",
		);
	});

	test("${CLAUDE_SKILL_DIR} → [skills]/foo(兼容 Claude 生态)", () => {
		expect(replaceSkillDirVars("see ${CLAUDE_SKILL_DIR}/ref.md", "foo")).toBe(
			"see [skills]/foo/ref.md",
		);
	});

	test("两变量同存 → 都替换", () => {
		const out = replaceSkillDirVars(
			"${SKILL_DIR}/a.md and ${CLAUDE_SKILL_DIR}/b.md",
			"foo",
		);
		expect(out).toBe("[skills]/foo/a.md and [skills]/foo/b.md");
	});

	test("无变量 → 原样", () => {
		expect(replaceSkillDirVars("plain text", "foo")).toBe("plain text");
	});

	test("多次出现 → 全替换", () => {
		expect(replaceSkillDirVars("${SKILL_DIR}/a ${SKILL_DIR}/b", "foo")).toBe(
			"[skills]/foo/a [skills]/foo/b",
		);
	});
});

// ===========================================================================
// 纯函数:remapGrepOutputLines(Grep 结果回映射)
// ===========================================================================
describe("remapGrepOutputLines:Grep 结果回映射", () => {
	test("content 单行格式 rel:ln:content → 加虚拟前缀", () => {
		const out = remapGrepOutputLines("ref.md:1:hello\nref.md:5:world", "foo");
		expect(out).toBe("[skills]/foo/ref.md:1:hello\n[skills]/foo/ref.md:5:world");
	});

	test("files_with_matches 整行 rel → 加前缀", () => {
		const out = remapGrepOutputLines("ref.md\nother.md", "foo");
		expect(out).toBe("[skills]/foo/ref.md\n[skills]/foo/other.md");
	});

	test("count 格式 rel:N → 加前缀", () => {
		const out = remapGrepOutputLines("ref.md:3", "foo");
		expect(out).toBe("[skills]/foo/ref.md:3");
	});

	test("context 格式 rel-ln-content → 加前缀(-<digit> 切分)", () => {
		const out = remapGrepOutputLines("ref.md-1-context\nref.md-2-more", "foo");
		expect(out).toBe("[skills]/foo/ref.md-1-context\n[skills]/foo/ref.md-2-more");
	});

	test("rel 含 -(my-skill 风格)context 不误切", () => {
		// nativeGrepSearch context 输出 `rel-ln-content`,rel=my-ref.md → `-1-` 切
		const out = remapGrepOutputLines("my-ref.md-1-ctx", "foo");
		expect(out).toBe("[skills]/foo/my-ref.md-1-ctx");
	});

	test("'No matches found.' 原样", () => {
		expect(remapGrepOutputLines("No matches found.", "foo")).toBe("No matches found.");
	});

	test("空行原样(上下文组间隔)", () => {
		const out = remapGrepOutputLines("ref.md:1:a\n\nref.md:3:b", "foo");
		expect(out).toBe("[skills]/foo/ref.md:1:a\n\n[skills]/foo/ref.md:3:b");
	});

	test("断言无真实 baseDir 泄露(acceptance 关键)", () => {
		const fakeBase = join(home, ".claude", "skills", "foo");
		const out = remapGrepOutputLines("SKILL.md:1:hello", "foo");
		expect(out).not.toContain(fakeBase);
		expect(out).not.toContain(home);
	});
});

// ===========================================================================
// Read execute:skill 通道(用例 1/3/4/6/7)
// ===========================================================================
describe("Read execute:[skills]/ 通道", () => {
	test("Read [skills]/foo/SKILL.md → 返正文(用例1)", async () => {
		createSkill(home, "foo", "this is the body");
		const result = await callExecute(fileReadTool, {
			path: "[skills]/foo/SKILL.md",
		});
		expect(result).toContain("this is the body");
	});

	test("Read 兄弟文件 [skills]/foo/reference.md → 返内容(用例2)", async () => {
		createSkill(home, "foo", "body", { "reference.md": "ref content here" });
		const result = await callExecute(fileReadTool, {
			path: "[skills]/foo/reference.md",
		});
		expect(result).toContain("ref content here");
	});

	test("${SKILL_DIR}/${CLAUDE_SKILL_DIR} 替换(用例3)", async () => {
		const body = "see ${SKILL_DIR}/a.md and ${CLAUDE_SKILL_DIR}/b.md";
		createSkill(home, "foo", body);
		const result = await callExecute(fileReadTool, {
			path: "[skills]/foo/SKILL.md",
		});
		expect(result).toContain("[skills]/foo/a.md");
		expect(result).toContain("[skills]/foo/b.md");
		expect(result).not.toContain("${SKILL_DIR}");
		expect(result).not.toContain("${CLAUDE_SKILL_DIR}");
	});

	test("../越界 → 拒(用例4 路径沙箱)", async () => {
		createSkill(home, "foo");
		// 建一个 baseDir 外的敏感文件验证不被读到
		writeFileSync(join(home, "secret.txt"), "TOPSECRET");
		const result = await callExecute(fileReadTool, {
			path: "[skills]/foo/../../secret.txt",
		});
		expect(result).toContain("outside skill directory");
		expect(result).not.toContain("TOPSECRET");
	});

	test("不存在 skill → skill not found(用例6)", async () => {
		const result = await callExecute(fileReadTool, {
			path: "[skills]/ghost/SKILL.md",
		});
		expect(result).toContain("skill not found");
	});

	test("workspace-scoped + [skills]/ 前缀 → 放行(用例7 不经 readScope)", async () => {
		// home 在 workingDir 外(workspace=tmp 工作目录),真实 skill 路径在工作目录外,
		// 但 [skills]/ 通道应放行。
		const workDir = mkdtempSync(join(tmpdir(), "zc-workdir-"));
		try {
			createSkill(home, "foo", "body in home outside workdir");
			const result = await callExecute(
				fileReadTool,
				{ path: "[skills]/foo/SKILL.md" },
				{ workingDir: workDir, readScope: "workspace" },
			);
			expect(result).toContain("body in home outside workdir");
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	test("真实路径非 [skills]/ 前缀 → readScope 照常(用例5/13 无回归)", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "zc-workdir-"));
		try {
			writeFileSync(join(workDir, "inside.txt"), "inside ws");
			writeFileSync(join(home, "outside.txt"), "outside ws");
			// 工作目录内 → 放行
			const inside = await callExecute(
				fileReadTool,
				{ path: join(workDir, "inside.txt") },
				{ workingDir: workDir, readScope: "workspace" },
			);
			expect(inside).toContain("inside ws");
			// 工作目录外 → 拒(readScope 照常)
			const outside = await callExecute(
				fileReadTool,
				{ path: join(home, "outside.txt") },
				{ workingDir: workDir, readScope: "workspace" },
			);
			expect(outside).toContain("Access denied");
			expect(outside).not.toContain("outside ws");
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// Glob execute:skill 通道(用例 8/10/11/12)
// ===========================================================================
describe("Glob execute:[skills]/ 通道", () => {
	test("Glob [skills]/foo/** → 命中且路径全虚拟(用例8 无泄露)", async () => {
		createSkill(home, "foo", "body", {
			"a.md": "x",
			"scripts/b.py": "y",
			"ref.md": "z",
		});
		const result = await callExecute(globTool, { pattern: "[skills]/foo/**" });
		expect(result).toContain("[skills]/foo/");
		// 关键断言:无真实 home / baseDir 泄露
		expect(result).not.toContain(home);
		expect(result).not.toContain(join(home, ".claude"));
		expect(result).not.toContain(sep + "skills" + sep + "foo" + sep); // baseDir 段不裸露
	});

	test("Glob [skills]/foo/../../etc/** → 空/不越 baseDir(用例10 沙箱)", async () => {
		createSkill(home, "foo", "body");
		writeFileSync(join(home, "etc-leak.txt"), "LEAK");
		const result = await callExecute(globTool, {
			pattern: "[skills]/foo/../../**",
		});
		// 沙箱兜底过滤:baseDir 外结果一律丢
		expect(result).not.toContain("LEAK");
		expect(result).not.toContain("etc-leak");
	});

	test("裸 [skills]/** → 拒(用例11 单 skill 边界)", async () => {
		createSkill(home, "foo");
		const result = await callExecute(globTool, { pattern: "[skills]/**" });
		expect(result).toContain("not supported");
	});

	test("workspace-scoped + [skills]/foo/** → 放行(用例12)", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "zc-workdir-"));
		try {
			createSkill(home, "foo", "body", { "x.md": "y" });
			const result = await callExecute(
				globTool,
				{ pattern: "[skills]/foo/**" },
				{ workingDir: workDir, readScope: "workspace" },
			);
			expect(result).toContain("[skills]/foo/");
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	test("Glob 经 path 参数([skills]/foo/ + pattern=**)", async () => {
		createSkill(home, "foo", "body", { "z.md": "w" });
		const result = await callExecute(globTool, {
			pattern: "**",
			path: "[skills]/foo/",
		});
		expect(result).toContain("[skills]/foo/z.md");
		expect(result).not.toContain(home);
	});
});

// ===========================================================================
// Grep execute:skill 通道(用例 9/10/11/12)
// ===========================================================================
describe("Grep execute:[skills]/ 通道", () => {
	test("Grep <pattern> [skills]/foo/ → 命中 path 全虚拟(用例9 无泄露)", async () => {
		createSkill(home, "foo", "PATTERN_HERE in skillmd", {
			"ref.md": "another PATTERN_HERE line",
		});
		const result = await callExecute(grepTool, {
			pattern: "PATTERN_HERE",
			path: "[skills]/foo/",
			output_mode: "content",
		});
		expect(result).toContain("PATTERN_HERE");
		expect(result).toContain("[skills]/foo/");
		// 关键断言:无真实路径泄露
		expect(result).not.toContain(home);
		expect(result).not.toContain(join(home, ".claude"));
	});

	test("Grep files_with_matches 模式 path 也回映射", async () => {
		createSkill(home, "foo", "PATTERN", { "a.md": "PATTERN", "b.md": "nomatch" });
		const result = await callExecute(grepTool, {
			pattern: "PATTERN",
			path: "[skills]/foo/",
			output_mode: "files_with_matches",
		});
		expect(result).toContain("[skills]/foo/");
		expect(result).not.toContain(home);
	});

	test("Grep 裸 [skills]/ → 拒(用例11)", async () => {
		createSkill(home, "foo", "PATTERN");
		const result = await callExecute(grepTool, {
			pattern: "PATTERN",
			path: "[skills]/",
		});
		expect(result).toContain("not supported");
	});

	test("Grep 不存在 skill → skill not found", async () => {
		const result = await callExecute(grepTool, {
			pattern: "x",
			path: "[skills]/ghost/",
		});
		expect(result).toContain("skill not found");
	});

	test("workspace-scoped + [skills]/foo/ Grep → 放行(用例12)", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "zc-workdir-"));
		try {
			createSkill(home, "foo", "NEEDLE");
			const result = await callExecute(
				grepTool,
				{ pattern: "NEEDLE", path: "[skills]/foo/" },
				{ workingDir: workDir, readScope: "workspace" },
			);
			expect(result).toContain("NEEDLE");
			expect(result).toContain("[skills]/foo/");
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});
});
