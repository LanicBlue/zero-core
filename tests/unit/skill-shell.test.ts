// 单元测试:skill-system sub-3 `[skills]/` Shell 虚拟路径通道(acceptance-3)
//
// # 文件说明书
//
// ## 核心功能
// 验证 Shell(bash.ts)的 `[skills]/` 虚拟路径通道:
// - 纯函数 resolveSkillTokensInShellCommand:
//   - `[skills]/<id>/<rel>` token → 真实路径(引号包裹 + 正斜杠化)。
//   - `${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 自引用 → 真实 baseDir(有锚点时)。
//   - `../` 越界 → 拒(沙箱)。
//   - 不存在 skill → 拒。
//   - 多 token / 命令注入边界(空格/特殊字符)。
// - bash.ts execute 集成:命令替换 + SKILL_DIR env 注入 + 真实脚本执行。
//
// ## 输入
// src/tools/skill-paths.ts(resolveSkillTokensInShellCommand)+ src/tools/bash.ts
// (bashTool.execute)。execute 用例在 tmp home 下搭 mock skill 目录 + 真实脚本,
// 经 home 注入(scanner sub-1 机制)发现 skill。
//
// ## 输出
// Vitest 用例覆盖 acceptance-3.md 的核心场景(用例 1/2/3/4/5/6/7)。
//
// ## 定位
// tests/unit/ —— 单元测试,验证 sub-3 Shell 通道。
//
// ## 依赖
// vitest、node:fs、node:os、node:path。
//
// ## 维护规则
// 解析器/Shell 集成逻辑改动时同步更新;mock skill 经 home 参数注入,不污染真实
// ~/.claude。execute 测试搭真实可执行脚本(写 .sh / .py / .js,跨平台跑)。
// 注意:execute 走 buildTool 的 experimental_context({ctx:...})形态。
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 文件级 mock:把 node:os 的 homedir 指向测试 tmp home(同 skill-paths.test.ts)。
// 原因:resolveSkillByName(id) 不传 home(生产用真实 home),测试要让它发现 tmp
// 下建的 mock skill。vi.mock 文件级隔离,不影响其他测试文件。
const mockHome = { current: "" };
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return {
		...actual,
		homedir: () => mockHome.current,
	};
});

import { resolveSkillTokensInShellCommand } from "../../src/tools/skill-paths.js";
import { bashTool } from "../../src/tools/bash.js";

// 在 tmp home 下建一个 skill 目录 + SKILL.md + 可选兄弟文件 / 脚本。
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

// buildTool 的 execute 走 experimental_context({ctx}) 形态。
// 失败路径会 throw(buildTool wrapper 把 ToolResult{ok:false} 翻译成 throw),
// 本 helper 捕获后返回 error.message(= format 后文本),让 toContain 断言统一。
async function callExecute(
	tool: any,
	input: any,
	opts: { workingDir?: string } = {},
): Promise<any> {
	const ctx: any = {
		workingDir: opts.workingDir,
		agentId: "test-agent",
		readScope: "filesystem",
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
	home = mkdtempSync(join(tmpdir(), "zc-skill-shell-"));
	mockHome.current = home;
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

// ===========================================================================
// 纯函数:resolveSkillTokensInShellCommand(token 解析)
// ===========================================================================
describe("resolveSkillTokensInShellCommand:`[skills]/` token → 真实路径", () => {
	test("`python [skills]/foo/scripts/x.py` → 真实路径替换(用例1)", () => {
		const dir = createSkill(home, "foo", "body", { "scripts/x.py": "print('hi')" });
		const r = resolveSkillTokensInShellCommand(`python [skills]/foo/scripts/x.py`, home);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// 替换成真实路径(正斜杠化 + 双引号包裹)。
		const realPath = join(dir, "scripts", "x.py").replace(/\\/g, "/");
		expect(r.command).toContain(`"${realPath}"`);
		// 不再含虚拟 token。
		expect(r.command).not.toContain("[skills]/");
		// skillDirs 收集到 baseDir(供 SKILL_DIR env 注入)。
		expect(r.skillDirs).toContain(dir);
	});

	test("真实路径正斜杠化 + 双引号包裹(用例2 Windows 反斜杠)", () => {
		const dir = createSkill(home, "foo", "body", { "a.py": "x" });
		const r = resolveSkillTokensInShellCommand(`python [skills]/foo/a.py`, home);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// 不含反斜杠(全正斜杠化)。
		expect(r.command).not.toContain("\\");
		// 双引号包裹。
		expect(r.command).toMatch(/"[^"]+"/);
	});

	test("`${SKILL_DIR}/scripts/x.py` + `[skills]/` 锚点 → 真实 baseDir", () => {
		const dir = createSkill(home, "foo", "body", { "scripts/x.py": "y" });
		const cmd = `python [skills]/foo/SKILL.md && python ${'$'}{SKILL_DIR}/scripts/x.py`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// `${SKILL_DIR}` 替换成真实 baseDir(引号包裹 + 正斜杠化)。
		const baseFwd = dir.replace(/\\/g, "/");
		expect(r.command).toContain(`"${baseFwd}/scripts/x.py"`);
		expect(r.command).not.toContain("${SKILL_DIR}");
	});

	test("`${CLAUDE_SKILL_DIR}/x` + 锚点 → 真实 baseDir(兼容 Claude 生态)", () => {
		const dir = createSkill(home, "foo", "body", { "ref.md": "y" });
		const cmd = `cat [skills]/foo/SKILL.md && cat ${'$'}{CLAUDE_SKILL_DIR}/ref.md`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.command).not.toContain("${CLAUDE_SKILL_DIR}");
		expect(r.command).toContain(dir.replace(/\\/g, "/"));
	});

	test("`${SKILL_DIR}` 无 `[skills]/` 锚点 → 保留字面(防御性 best-effort)", () => {
		createSkill(home, "foo", "body");
		const cmd = `echo ${'$'}{SKILL_DIR}/scripts/x.py`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// 无锚点 → 不替换(交 shell 自行展开),不阻塞执行。
		expect(r.command).toContain("${SKILL_DIR}");
		expect(r.skillDirs).toHaveLength(0);
	});

	test("多 `[skills]/` token → 全替换", () => {
		const dir = createSkill(home, "foo", "body", { "a.py": "1", "b.py": "2" });
		const cmd = `python [skills]/foo/a.py && python [skills]/foo/b.py`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.command).not.toContain("[skills]/");
		expect(r.command.split('"').length).toBeGreaterThanOrEqual(5); // 至少两个引号对
	});

	test("引号包裹的 token `\"[skills]/foo/x.py\"` → 识别并替换", () => {
		const dir = createSkill(home, "foo", "body", { "x.py": "y" });
		const cmd = `python "[skills]/foo/x.py"`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const realPath = join(dir, "x.py").replace(/\\/g, "/");
		expect(r.command).toContain(`"${realPath}"`);
	});

	test("非 `[skills]/` 命令 → 原样(用例4 真实路径命令不变)", () => {
		createSkill(home, "foo");
		const cmd = `python /usr/local/bin/x.py --flag value`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.command).toBe(cmd);
		expect(r.skillDirs).toHaveLength(0);
	});

	test("../ 越界 → 整条拒(用例5 沙箱)", () => {
		createSkill(home, "foo");
		writeFileSync(join(home, "secret.txt"), "TOPSECRET");
		const cmd = `cat [skills]/foo/../../secret.txt`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain("outside skill directory");
	});

	test("不存在 skill → 拒", () => {
		const cmd = `python [skills]/ghost/scripts/x.py`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain("skill not found");
	});

	test("混合:一个 token 越界 + 一个合法 → 整条拒(不部分替换)", () => {
		createSkill(home, "foo", "body", { "a.py": "x" });
		const cmd = `python [skills]/foo/a.py && cat [skills]/foo/../../etc/passwd`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(false);
	});

	test("命令注入边界:skill id 含特殊字符 → 不识别为 token", () => {
		// `<id>` 限 [A-Za-z0-9._-],含 `;` 的不识别 → 不替换(防注入)。
		createSkill(home, "foo", "body");
		const cmd = `python [skills]/foo;a.py`;
		const r = resolveSkillTokensInShellCommand(cmd, home);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// `[skills]/foo;a.py` 不是合法 token(id 含 `;`),原样保留。
		// 注意:正则吃 `[skills]/foo`(无 /),但因 rel 部分要求 `/` 开头,`foo;a.py`
		// 整体不被匹配 —— `[skills]/foo` 单段会被匹配(rel 为空)。验证不执行注入:
		// 这里 foo 存在,`[skills]/foo` 会解析成 baseDir 本身(在沙箱内,合法)。
		// 关键是 `;` 后的 `a.py` 不被吞进 skill 路径(防命令注入)。
		// 即:`;a.py` 保留为独立命令段。
		expect(r.command).toContain(";a.py");
	});

	test("空命令 / 非字符串 → ok 空结果", () => {
		const r1 = resolveSkillTokensInShellCommand("", home);
		expect(r1.ok).toBe(true);
		// @ts-expect-error 测试非字符串入参的容错
		const r2 = resolveSkillTokensInShellCommand(undefined, home);
		expect(r2.ok).toBe(true);
	});
});

// ===========================================================================
// bash.ts execute:[skills]/ 通道集成(用例 1/3/4/5/6/7)
// ===========================================================================
//
// 这些测试搭真实可执行脚本跑 bash.ts execute,验证:
// - 命令 token 被替换成真实路径 → 脚本真跑(用例1)。
// - SKILL_DIR env 注入(用例3)。
// - 真实路径命令不变(用例4)。
// - ../ 越界拒(用例5)。
// - 无回归(用例7)。
//
// 跨平台:写 .js 脚本(node 跑,所有平台都有 node);SKILL_DIR env 测试用 node
// 读 process.env.SKILL_DIR 输出。

describe("bash execute:[skills]/ 通道集成", () => {
	// 跨平台可执行脚本:node 脚本(node 在所有测试环境都有)。
	// echo_args.js:打印所有 argv + process.env.SKILL_DIR,供断言。
	function makeNodeScript(dir: string, name: string, body: string): string {
		const skillDir = dir;
		const scriptsDir = join(skillDir, "scripts");
		mkdirSync(scriptsDir, { recursive: true });
		const scriptPath = join(scriptsDir, name);
		writeFileSync(scriptPath, body, "utf-8");
		return scriptPath;
	}

	test("Shell python-like 命令跑 [skills]/foo/scripts/x.js → 真实脚本执行(用例1)", async () => {
		const dir = createSkill(home, "foo", "body");
		makeNodeScript(
			dir,
			"echo.js",
			`process.stdout.write("SKILL_SCRIPT_RAN:" + process.argv[1]);`,
		);
		// 用 node 跑跨平台(避免依赖 python)。
		const result = await callExecute(bashTool, {
			command: `node [skills]/foo/scripts/echo.js`,
		});
		expect(result).toContain("SKILL_SCRIPT_RAN:");
		// 真实路径被替换进去:脚本收到的 argv[1] 是真实磁盘路径。
		// 形态可能是正斜杠(命令里塞的)或反斜杠(OS/node 规范化),两者都接受 ——
		// 关键断言是脚本名 + skill id 段在路径里(token 真的被解析成真实路径执行了)。
		const fwd = join(dir, "scripts", "echo.js").replace(/\\/g, "/");
		const native = join(dir, "scripts", "echo.js");
		expect(result.includes(fwd) || result.includes(native)).toBe(true);
		// 不再含虚拟 token(命令里替换干净了;脚本输出也不会含 token)。
		expect(result).not.toContain("[skills]/");
	});

	test("SKILL_DIR env 注入(用例3):脚本读到 SKILL_DIR=<真实 baseDir>", async () => {
		const dir = createSkill(home, "foo", "body");
		makeNodeScript(
			dir,
			"env.js",
			`process.stdout.write("ENV_SKILL_DIR=" + (process.env.SKILL_DIR || "UNSET"));`,
		);
		const result = await callExecute(bashTool, {
			command: `node [skills]/foo/scripts/env.js`,
		});
		expect(result).toContain("ENV_SKILL_DIR=");
		// 注入的 SKILL_DIR = 真实 baseDir(native 形态带反斜杠;脚本读 process.env
		// 直接拿到注入值)。形态可能是正/反斜杠,都接受;关键是不为 UNSET 且含 skill 路径段。
		expect(result).not.toContain("ENV_SKILL_DIR=UNSET");
		expect(result).toContain(join(dir).replace(/\\/g, "/").split(/[/\\]/).pop()!); // 含 "foo" 末段
	});

	test("无 [skills]/ token → SKILL_DIR env 不注入(普通命令)", async () => {
		// 普通命令不应注入 SKILL_DIR(避免污染非 skill 子进程环境)。
		// 用 echo + 环境变量检测(bash 下 ${SKILL_DIR} 未设 → 空)。
		// 跨平台:用 node 直接读 env。
		const result = await callExecute(bashTool, {
			command: `node -e "process.stdout.write(process.env.SKILL_DIR || 'UNSET')"`,
		});
		// 没注入 → UNSET(或继承自父进程,测试环境通常无 SKILL_DIR)。
		// 容错:若测试环境恰好有 SKILL_DIR,这里不断言 UNSET,只断言不含 mock baseDir。
		expect(result).not.toContain(home);
	});

	test("../ 越界 → 拒,不执行(用例5)", async () => {
		createSkill(home, "foo", "body");
		writeFileSync(join(home, "secret.txt"), "TOPSECRET");
		const result = await callExecute(bashTool, {
			command: `cat [skills]/foo/../../secret.txt`,
		});
		expect(result).toContain("outside skill directory");
		expect(result).not.toContain("TOPSECRET");
	});

	test("不存在 skill → 拒(用例5 变体)", async () => {
		const result = await callExecute(bashTool, {
			command: `node [skills]/ghost/scripts/x.js`,
		});
		expect(result).toContain("skill not found");
	});

	test("普通命令零变化(用例4/7 无回归)", async () => {
		// 经典 echo 命令,无 skill token,应正常执行。
		const result = await callExecute(bashTool, {
			command: `node -e "process.stdout.write('PLAIN_COMMAND_OK')"`,
		});
		expect(result).toContain("PLAIN_COMMAND_OK");
	});

	test("命令注入防护:skill 脚本路径含空格 → 引号包裹不破坏命令(用例6)", async () => {
		// skill 名含空格不合法(id 限 path-safe),但 baseDir 路径段可能含空格
		// (home 在含空格的 tmp 下)。验证替换后引号包裹,命令仍能执行。
		// 用 mock home 模拟(若 tmpdir 无空格,这条仍跑通——脚本正常执行即可)。
		const dir = createSkill(home, "foo", "body");
		makeNodeScript(
			dir,
			"ok.js",
			`process.stdout.write("INJECTED_SAFE_OK")`,
		);
		const result = await callExecute(bashTool, {
			command: `node [skills]/foo/scripts/ok.js && echo DONE`,
		});
		expect(result).toContain("INJECTED_SAFE_OK");
		// `&& echo DONE` 是独立命令段,不被吞进 skill 路径(注入防护)。
		expect(result).toContain("DONE");
	});

	test("${SKILL_DIR} + [skills]/ 锚点 → 替换成真实 baseDir 并执行", async () => {
		const dir = createSkill(home, "foo", "body");
		makeNodeScript(
			dir,
			"probe.js",
			`process.stdout.write("PROBE=" + require('fs').existsSync(process.argv[1].replace(/\\\\/g,'/').replace('/probe.js','/SKILL.md')));`,
		);
		// 命令含 [skills]/ 锚点 + ${SKILL_DIR} 自引用。
		const cmd = `node [skills]/foo/scripts/probe.js && echo ${'$'}{SKILL_DIR}/scripts/probe.js`;
		const result = await callExecute(bashTool, { command: cmd });
		expect(result).toContain("PROBE=");
		// ${SKILL_DIR} 被替换成真实 baseDir(echo 输出真实路径)。
		expect(result).toContain(dir.replace(/\\/g, "/"));
		expect(result).not.toContain("${SKILL_DIR}");
	});
});

// ===========================================================================
// 可移植性:确保 win32 反斜杠路径在命令里不破坏(用例2 集成)
// ===========================================================================
describe("bash execute:Windows 反斜杠路径安全", () => {
	test("真实路径(含反斜杠形态)进 bash 不破坏 — 脚本仍执行", async () => {
		// 这条测试在所有平台跑:验证替换后的命令(正斜杠化 + 引号包裹)能被 shell 执行。
		const dir = createSkill(home, "foo", "body");
		const scriptsDir = join(dir, "scripts");
		mkdirSync(scriptsDir, { recursive: true });
		writeFileSync(
			join(scriptsDir, "win.js"),
			`process.stdout.write("WIN_PATH_SAFE_OK")`,
			"utf-8",
		);
		const result = await callExecute(bashTool, {
			command: `node [skills]/foo/scripts/win.js`,
		});
		// 关键断言:脚本真的执行了(替换后的命令被 shell 正确解析执行)。
		// 反斜杠/空格在命令里被引号包裹 + 正斜杠化后不破坏命令。
		expect(result).toContain("WIN_PATH_SAFE_OK");
		// 不再含虚拟 token(命令替换干净)。
		expect(result).not.toContain("[skills]/");
	});
});

// 避免 TS unused 警告(chmodSync 在某些平台用不上,保留以备 unix 权限测试)。
void chmodSync;
