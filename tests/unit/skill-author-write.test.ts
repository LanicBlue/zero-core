// 单元测试:skill-system sub-8 `[skills]/` 写通道 + 门禁(acceptance-8)
//
// # 文件说明书
//
// ## 核心功能
// 验证 sub-8 用例:
// - resolveSkillWritePath:新 skill / 已存在 app / 外部只读 / id 护栏 / 越界。
// - stampAuthorFrontmatter:有/无 frontmatter / 已有 author 不覆盖。
// - checkSkillAuthorGate:agentId 缺失 / service 缺失 / record 缺失 / flag false / true。
// - fileWriteTool + fileEditTool execute 的 skill 通道:门禁 + 落盘 + author 标记。
//
// ## 输入
// src/tools/skill-paths.ts(写解析)、src/tools/skill-author-gate.ts(门禁)、
// src/tools/{file-write,file-edit}.ts(execute)、mock agent-service。
//
// ## 输出
// Vitest 用例覆盖 acceptance-8 用例 1/2/4/5/6/7(核心写 + 门禁 + 标记)。
// 用例 3(读不受门禁)在 skill-paths.test.ts 已覆盖(读家族)。用例 8(prompt)见
// system-prompt-author.test.ts。用例 9(toggle 往返)见 E2E。
//
// ## 定位
// tests/unit/ —— 单元测试。
//
// ## 维护规则
// mock os.homedir 指向 tmp(隔离);mock agent-service 的 getAgentService 注入假 record。
//
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 文件级 mock:os.homedir → tmp home(scanner/router 用它解 app 根)。
const mockHome = { current: "" };
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => mockHome.current };
});

// mock agent-service:getAgentService 返可控 fake(含 getAgentRecord)。
// 测试用例通过 mockService.current 切换 record 内容(canAuthorSkills true/false)。
const mockService = {
	current: undefined as
		| { getAgentRecord(id: string): { skillPolicy?: { canAuthorSkills?: boolean } } | undefined }
		| undefined,
};
vi.mock("../../src/server/agent-service.js", () => ({
	getAgentService: () => mockService.current,
}));

import {
	resolveSkillWritePath,
	stampAuthorFrontmatter,
} from "../../src/tools/skill-paths.js";
import { checkSkillAuthorGate } from "../../src/tools/skill-author-gate.js";
import { fileWriteTool } from "../../src/tools/file-write.js";
import { fileEditTool } from "../../src/tools/file-edit.js";

// 在 tmp home 下建一个 skill 目录(app 来源 = ~/.zero-core/skills/<id>)。
function createAppSkill(home: string, id: string, body = "body"): string {
	const dir = join(home, ".zero-core", "skills", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		["---", `name: ${id}`, `description: ${id} skill`, "---", "", body].join("\n"),
		"utf-8",
	);
	return dir;
}
// 在 tmp home 下建一个外部 skill(user 来源 = ~/.claude/skills/<id>)。
function createUserSkill(home: string, id: string, body = "body"): string {
	const dir = join(home, ".claude", "skills", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		["---", `name: ${id}`, `description: ${id} skill`, "---", "", body].join("\n"),
		"utf-8",
	);
	return dir;
}

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "zc-skill-write-"));
	mockHome.current = home;
	mockService.current = undefined;
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	mockService.current = undefined;
});

// ===========================================================================
// resolveSkillWritePath(纯路径解析)
// ===========================================================================
describe("resolveSkillWritePath:路径解析", () => {
	test("非 [skills]/ 前缀 → null(交回原写流程)", () => {
		expect(resolveSkillWritePath("/abs/path/x.md", home)).toBeNull();
		expect(resolveSkillWritePath("relative/x.md", home)).toBeNull();
	});

	test("新 skill 合法 id → 落 appSkillDir,markAuthor=true", () => {
		const r = resolveSkillWritePath("[skills]/my-flow/SKILL.md", home);
		expect(r).not.toBeNull();
		if (r && r.ok) {
			expect(r.realPath).toBe(join(home, ".zero-core", "skills", "my-flow", "SKILL.md"));
			expect(r.markAuthor).toBe(true);
		}
	});

	test("新 skill 含 path-safe 字符(._-)→ 通过", () => {
		const r = resolveSkillWritePath("[skills]/my_flow.v2/SKILL.md", home);
		expect(r && r.ok).toBe(true);
	});

	test("新 skill id 非 path-safe(含空格)→ 拒", () => {
		const r = resolveSkillWritePath("[skills]/my flow/SKILL.md", home);
		expect(r && !r.ok && /Invalid skill id/.test(r.error)).toBe(true);
	});

	test("新 skill id 含 ../ → 拒", () => {
		const r = resolveSkillWritePath("[skills]/../etc/SKILL.md", home);
		expect(r && !r.ok).toBe(true);
	});

	test("新 skill id 含特殊字符(:)→ 拒", () => {
		const r = resolveSkillWritePath("[skills]/a:b/SKILL.md", home);
		expect(r && !r.ok).toBe(true);
	});

	test("新 skill rel 越界(../)→ 拒(沙箱)", () => {
		const r = resolveSkillWritePath("[skills]/newone/../../etc/passwd", home);
		expect(r && !r.ok && /outside skill directory/.test(r.error)).toBe(true);
	});

	test("已存在 app skill → 解析成功,markAuthor=true", () => {
		createAppSkill(home, "existing");
		const r = resolveSkillWritePath("[skills]/existing/SKILL.md", home);
		expect(r && r.ok && r.markAuthor).toBe(true);
		if (r && r.ok) {
			expect(r.realPath).toBe(join(home, ".zero-core", "skills", "existing", "SKILL.md"));
		}
	});

	test("已存在 app skill rel 越界 → 拒(沙箱)", () => {
		createAppSkill(home, "existing");
		const r = resolveSkillWritePath("[skills]/existing/../../etc/passwd", home);
		expect(r && !r.ok && /outside skill directory/.test(r.error)).toBe(true);
	});

	test("已存在外部 skill(user 来源)→ 拒(外部只读)", () => {
		createUserSkill(home, "external");
		const r = resolveSkillWritePath("[skills]/external/SKILL.md", home);
		expect(r && !r.ok && /read-only/.test(r.error)).toBe(true);
	});

	test("glob 通配 id → 拒(跨 skill)", () => {
		const r = resolveSkillWritePath("[skills]/*/SKILL.md", home);
		expect(r && !r.ok && /cross-skill/.test(r.error)).toBe(true);
	});
});

// ===========================================================================
// stampAuthorFrontmatter
// ===========================================================================
describe("stampAuthorFrontmatter:author 溯源", () => {
	test("无 frontmatter → 造最小 frontmatter 含 author", () => {
		const out = stampAuthorFrontmatter("body text", "agent-1");
		expect(out).toMatch(/^---\nauthor: agent:agent-1\n---\n\nbody text$/);
	});

	test("有 frontmatter 无 author → 在 frontmatter 内追加 author 行", () => {
		const input = "---\nname: foo\ndescription: d\n---\n\nbody";
		const out = stampAuthorFrontmatter(input, "agent-1");
		expect(out).toMatch(/author: agent:agent-1/);
		expect(out).toMatch(/^---\nname: foo\ndescription: d\nauthor: agent:agent-1\n---\n/);
	});

	test("已有 author 行 → 不覆盖", () => {
		const input = "---\nname: foo\nauthor: agent:other\n---\n\nbody";
		const out = stampAuthorFrontmatter(input, "agent-1");
		expect(out).toContain("author: agent:other");
		expect(out).not.toContain("author: agent:agent-1");
	});
});

// ===========================================================================
// checkSkillAuthorGate(门禁)
// ===========================================================================
describe("checkSkillAuthorGate:写门禁", () => {
	const ctx = (over: any = {}) => ({ caller: "internal", ...over }) as any;

	test("agentId 缺失 → 拒", () => {
		expect(checkSkillAuthorGate(ctx({}))).toMatch(/no agentId/);
	});

	test("service 缺失 → 拒", () => {
		mockService.current = undefined;
		expect(checkSkillAuthorGate(ctx({ agentId: "a1" }))).toMatch(/agent service unavailable/);
	});

	test("agent record 缺失 → 拒", () => {
		mockService.current = { getAgentRecord: () => undefined };
		expect(checkSkillAuthorGate(ctx({ agentId: "a1" }))).toMatch(/not found/);
	});

	test("canAuthorSkills=false → 拒", () => {
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: false } }),
		};
		const err = checkSkillAuthorGate(ctx({ agentId: "a1" }));
		expect(err).toMatch(/canAuthorSkills is false/);
	});

	test("canAuthorSkills 缺失(undefined)→ 拒(默认 false 语义)", () => {
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: {} }),
		};
		expect(checkSkillAuthorGate(ctx({ agentId: "a1" }))).toMatch(/canAuthorSkills is false/);
	});

	test("canAuthorSkills=true → 放行(null)", () => {
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: true } }),
		};
		expect(checkSkillAuthorGate(ctx({ agentId: "a1" }))).toBeNull();
	});
});

// ===========================================================================
// fileWriteTool execute(集成:门禁 + 落盘 + author 标记)
// ===========================================================================
// 注意:buildTool wrapper 把 execute 返的 ToolResult{ok:true} → format → 字符串;
// {ok:false} → throw Error(formatted)。所以 callWrite 返回值统一是字符串:
// 成功 = format 后的成功文本(含 "Created"/"Overwrote"/"Successfully edited");
// 失败 = Error.message(= format 后失败文本)。断言用字符串 contains。
async function callWrite(tool: any, input: any, opts: any = {}): Promise<string> {
	// agentId 显式 undefined(opts.agentId === undefined)时必须透传 undefined,
	// 不能 ?? 默认值(否则测不出"无 agentId 被拒"的语义)。用 in 判断。
	const ctx: any = {
		caller: "internal",
		workingDir: opts.workingDir ?? home,
		agentId: "agentId" in opts ? opts.agentId : "test-agent",
		readScope: "workspace",
		emit: () => {},
	};
	try {
		return await tool.execute(input, { experimental_context: { ctx } });
	} catch (err: any) {
		return err?.message ?? String(err);
	}
}

describe("fileWriteTool:[skills]/ 写通道", () => {
	test("有权限写新 skill → 落盘 + author 标记(用例 1+7)", async () => {
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: true } }),
		};
		const res = await callWrite(
			fileWriteTool,
			{
				path: "[skills]/my-flow/SKILL.md",
				content: "---\nname: My Flow\ndescription: a flow\n---\n\nbody",
			},
			{ agentId: "agent-7" },
		);
		expect(res).toMatch(/Created/);
		const written = readFileSync(join(home, ".zero-core", "skills", "my-flow", "SKILL.md"), "utf-8");
		expect(written).toContain("author: agent:agent-7");
		expect(written).toContain("name: My Flow");
	});

	test("无权限写新 skill → 拒 + 不落盘(用例 2)", async () => {
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: false } }),
		};
		const res = await callWrite(
			fileWriteTool,
			{ path: "[skills]/denied/SKILL.md", content: "x" },
			{ agentId: "agent-x" },
		);
		expect(res).toMatch(/canAuthorSkills is false/);
		expect(existsSync(join(home, ".zero-core", "skills", "denied"))).toBe(false);
	});

	test("无 agentId(UI 调用)写 [skills]/ → 拒 + 不落盘", async () => {
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: true } }),
		};
		const res = await callWrite(
			fileWriteTool,
			{ path: "[skills]/noctx/SKILL.md", content: "x" },
			{ agentId: undefined },
		);
		expect(res).toMatch(/no agentId/);
		expect(existsSync(join(home, ".zero-core", "skills", "noctx"))).toBe(false);
	});

	test("有权限写外部已存在 skill → 拒(外部只读,用例 4)", async () => {
		createUserSkill(home, "external");
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: true } }),
		};
		const res = await callWrite(
			fileWriteTool,
			{ path: "[skills]/external/SKILL.md", content: "x", overwrite: true },
			{ agentId: "agent-y" },
		);
		expect(res).toMatch(/read-only/);
	});

	test("id 非 path-safe → 拒(用例 5)", async () => {
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: true } }),
		};
		const res = await callWrite(
			fileWriteTool,
			{ path: "[skills]/bad id/SKILL.md", content: "x" },
			{ agentId: "agent-z" },
		);
		expect(res).toMatch(/Invalid skill id/);
	});

	test("已存在 app skill rel 越界 → 拒(用例 6)", async () => {
		createAppSkill(home, "existing");
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: true } }),
		};
		const res = await callWrite(
			fileWriteTool,
			{ path: "[skills]/existing/../../escape.md", content: "x" },
			{ agentId: "agent-e" },
		);
		expect(res).toMatch(/outside skill directory/);
	});

	test("非 [skills]/ 路径不受门禁影响(workspace 写照旧)", async () => {
		// 无 service + 无 agentId → 但非 skill 路径,走原 workspace 流程。
		mockService.current = undefined;
		const res = await callWrite(
			fileWriteTool,
			{ path: "plain.txt", content: "hello" },
			{ agentId: undefined },
		);
		expect(res).toMatch(/Created/);
		expect(existsSync(join(home, "plain.txt"))).toBe(true);
	});
});

// ===========================================================================
// fileEditTool execute([skills]/ 通道:门禁 + author 标记)
// ===========================================================================
describe("fileEditTool:[skills]/ 写通道", () => {
	test("有权限 Edit 已存在 app SKILL.md → 替换 + 补 author 标记", async () => {
		createAppSkill(home, "e1", "old body line");
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: true } }),
		};
		const res = await callWrite(
			fileEditTool,
			{
				path: "[skills]/e1/SKILL.md",
				oldText: "---\nname: e1\ndescription: e1 skill\n---",
				newText: "---\nname: e1\ndescription: edited",
			},
			{ agentId: "agent-edit" },
		);
		expect(res).toMatch(/Successfully edited/);
		const written = readFileSync(join(home, ".zero-core", "skills", "e1", "SKILL.md"), "utf-8");
		expect(written).toContain("description: edited");
		expect(written).toContain("author: agent:agent-edit");
	});

	test("无权限 Edit → 拒 + 内容不变", async () => {
		createAppSkill(home, "e2", "body");
		mockService.current = {
			getAgentRecord: () => ({ skillPolicy: { canAuthorSkills: false } }),
		};
		const before = readFileSync(join(home, ".zero-core", "skills", "e2", "SKILL.md"), "utf-8");
		const res = await callWrite(
			fileEditTool,
			{ path: "[skills]/e2/SKILL.md", oldText: "body", newText: "changed" },
			{ agentId: "agent-no" },
		);
		expect(res).toMatch(/canAuthorSkills is false/);
		const after = readFileSync(join(home, ".zero-core", "skills", "e2", "SKILL.md"), "utf-8");
		expect(after).toBe(before);
	});
});
