// 单元测试:skill-scanner 协议对齐(acceptance-1)
//
// # 文件说明书
//
// ## 核心功能
// 验证 skill-scanner 的优先级(personal>app)、identity(=目录名)、display name 兜底、
// 同名 frontmatter 跨目录去重、resolveSkillByName 缺失语义、getSkillRoots 顺序。
//
// ## 输入
// src/server/skill-scanner.ts 导出的 scanSkills/getSkillRoots/getSkillIndex/resolveSkillByName,
// 外加每个用例在 tmp home 下搭建的 mock skill 目录树。
//
// ## 输出
// Vitest 用例覆盖 acceptance-1.md「验证手段」三个核心场景 + 两条补充断言。
//
// ## 定位
// tests/unit/ — 单元测试,验证 skill-scanner 数据层。
//
// ## 依赖
// vitest、node:fs、node:os、node:path、../../src/server/skill-scanner.js
//
// ## 维护规则
// scanner 改优先级方向/identity 字段时,本文件按协议同步更新。
// 测试通过 scanSkills(home) 注入 tmp home,不污染真实 ~/.claude|~/.zero-core|~/.agents。
//
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	scanSkills,
	getSkillRoots,
	getSkillIndex,
	resolveSkillByName,
	parseSkillFrontmatter,
	parseSkillFrontmatterFull,
	type DiscoveredSkill,
} from "../../src/server/skill-scanner.js";

// 在 tmp 下建一个 skill 目录 + SKILL.md。返回该 skill 的绝对目录路径。
function createSkill(
	home: string,
	sourceRoot: ".claude" | ".zero-core" | ".agents",
	dirName: string,
	frontmatter: { name?: string; description: string },
): string {
	const skillDir = join(home, sourceRoot, "skills", dirName);
	mkdirSync(skillDir, { recursive: true });
	const fm: string[] = ["---"];
	if (frontmatter.name !== undefined) fm.push(`name: ${frontmatter.name}`);
	fm.push(`description: ${frontmatter.description}`);
	fm.push("---", "", "body");
	writeFileSync(join(skillDir, "SKILL.md"), fm.join("\n"), "utf-8");
	return skillDir;
}

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "zc-skill-scanner-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("acceptance-1 用例1:同 id 跨 source → personal 胜", () => {
	test("scanSkills 在 .zero-core 与 .claude 下都建 foo → 返回 user(source/路径)", () => {
		const appDir = createSkill(home, ".zero-core", "foo", {
			name: "Foo",
			description: "from app",
		});
		const userDir = createSkill(home, ".claude", "foo", {
			name: "Foo",
			description: "from user",
		});

		const skills = scanSkills(home);
		expect(skills).toHaveLength(1);
		const foo = skills[0] as DiscoveredSkill;
		expect(foo.id).toBe("foo");
		expect(foo.source).toBe("user"); // personal 胜
		expect(foo.baseDir).toBe(userDir);
		expect(foo.baseDir).not.toBe(appDir);
		expect(foo.description).toBe("from user");
	});

	test("getSkillIndex 同 id 跨 source → Map 只剩 user 那条", () => {
		createSkill(home, ".zero-core", "bar", {
			name: "Bar",
			description: "app",
		});
		createSkill(home, ".claude", "bar", {
			name: "Bar",
			description: "user",
		});

		const idx = getSkillIndex(home);
		expect(idx.size).toBe(1);
		expect(idx.get("bar")?.source).toBe("user");
		expect(idx.get("bar")?.description).toBe("user");
	});

	test(".agents/skills 也是 user,且 .claude 与 .agents 都存在时优先级靠后(数组序)胜", () => {
		// 两个 user 源,同 id;数组里 .agents 在 .claude 之后 → .agents 胜。
		createSkill(home, ".claude", "baz", {
			name: "Baz",
			description: "claude",
		});
		const agentsDir = createSkill(home, ".agents", "baz", {
			name: "Baz",
			description: "agents",
		});

		const idx = getSkillIndex(home);
		expect(idx.get("baz")?.baseDir).toBe(agentsDir);
		expect(idx.get("baz")?.description).toBe("agents");
	});
});

describe("acceptance-1 用例5:frontmatter 缺 name → display name=目录名", () => {
	test("SKILL.md 无 name frontmatter → DiscoveredSkill.name === 目录名", () => {
		createSkill(home, ".claude", "no-name-skill", {
			// name 故意省略
			description: "has desc but no name",
		});

		const skills = scanSkills(home);
		expect(skills).toHaveLength(1);
		expect(skills[0]?.id).toBe("no-name-skill");
		expect(skills[0]?.name).toBe("no-name-skill"); // 兜底
	});
});

describe("acceptance-1 用例4:同 frontmatter name、不同目录名 → 两条独立记录", () => {
	test("两个目录 frontmatter name 相同、id(目录名)不同 → size=2,id 各=目录名", () => {
		createSkill(home, ".claude", "dir-a", {
			name: "Shared Name",
			description: "a",
		});
		createSkill(home, ".claude", "dir-b", {
			name: "Shared Name",
			description: "b",
		});

		const idx = getSkillIndex(home);
		expect(idx.size).toBe(2);
		expect(idx.has("dir-a")).toBe(true);
		expect(idx.has("dir-b")).toBe(true);
		// display name 相同但 id 不同 —— id 才是主键
		expect(idx.get("dir-a")?.name).toBe("Shared Name");
		expect(idx.get("dir-b")?.name).toBe("Shared Name");
	});
});

describe("acceptance-1 用例2:getSkillRoots 顺序 + source 标记", () => {
	test("返回 3 条,app 在前(低)、两个 user 在后(高)", () => {
		const roots = getSkillRoots(home);
		expect(roots).toHaveLength(3);
		expect(roots.map((r) => r.source)).toEqual(["app", "user", "user"]);
		// 顺序断言:app/bundled → .claude → .agents
		expect(roots[0]?.dir).toBe(join(home, ".zero-core", "skills"));
		expect(roots[1]?.dir).toBe(join(home, ".claude", "skills"));
		expect(roots[2]?.dir).toBe(join(home, ".agents", "skills"));
	});

	// sub-10 (decision 10): 每个 root 带 display-only origin 字段(给 UI badge 用)。
	// origin 与 dir 一一对应:app root → zero-core;~/.claude/skills → claude;~/.agents/skills → agents。
	test("sub-10: 每个 root 带 origin 字段(zero-core/claude/agents,与 dir 对应)", () => {
		const roots = getSkillRoots(home);
		expect(roots.map((r) => r.origin)).toEqual(["zero-core", "claude", "agents"]);
		// source 与 origin 的对应关系(app↔zero-core;两个 user 分别 claude/agents)。
		expect(roots[0]).toMatchObject({ source: "app", origin: "zero-core" });
		expect(roots[1]).toMatchObject({ source: "user", origin: "claude" });
		expect(roots[2]).toMatchObject({ source: "user", origin: "agents" });
	});
});

// sub-10 (decision 10): DiscoveredSkill.origin 由 scanDir 按 root stamp。
// - ~/.zero-core/skills/<id> → origin "zero-core"
// - ~/.claude/skills/<id>    → origin "claude"
// - ~/.agents/skills/<id>    → origin "agents"
// 同 id 跨 root 时:origin 跟随"胜出"那条(personal>app,与 source 同步覆盖)。
describe("sub-10: DiscoveredSkill.origin 按 root stamp", () => {
	test("三条 root 各放一个不同 id 的 skill → origin 各对应 root", () => {
		createSkill(home, ".zero-core", "alpha", { name: "Alpha", description: "a" });
		createSkill(home, ".claude", "beta", { name: "Beta", description: "b" });
		createSkill(home, ".agents", "gamma", { name: "Gamma", description: "g" });

		const idx = getSkillIndex(home);
		expect(idx.get("alpha")?.origin).toBe("zero-core");
		expect(idx.get("beta")?.origin).toBe("claude");
		expect(idx.get("gamma")?.origin).toBe("agents");
	});

	test("同 id 跨 .zero-core + .claude → user 胜,origin=claude(跟胜者)", () => {
		createSkill(home, ".zero-core", "dup", { name: "Dup", description: "app" });
		createSkill(home, ".claude", "dup", { name: "Dup", description: "user-claude" });

		const skill = scanSkills(home)[0];
		expect(skill?.source).toBe("user");
		expect(skill?.origin).toBe("claude"); // personal 胜 → origin 跟随
		expect(skill?.description).toBe("user-claude");
	});

	test("同 id 跨 .claude + .agents → .agents(数组序靠后)胜,origin=agents", () => {
		createSkill(home, ".claude", "dup2", { name: "Dup2", description: "claude" });
		createSkill(home, ".agents", "dup2", { name: "Dup2", description: "agents" });

		const skill = scanSkills(home)[0];
		expect(skill?.origin).toBe("agents");
		expect(skill?.description).toBe("agents");
	});
});

describe("acceptance-1 用例3:resolveSkillByName 缺失 → undefined", () => {
	test("不存在的 id → undefined", () => {
		expect(resolveSkillByName("does-not-exist", home)).toBeUndefined();
	});

	test("存在的 id → 返回 DiscoveredSkill", () => {
		createSkill(home, ".claude", "exists", {
			name: "Exists",
			description: "d",
		});
		const resolved = resolveSkillByName("exists", home);
		expect(resolved?.id).toBe("exists");
		expect(resolved?.source).toBe("user");
	});
});

describe("acceptance-1 用例6:body 不读 / 不返回", () => {
	test("DiscoveredSkill 无 body 字段;scanner 不读正文", () => {
		createSkill(home, ".claude", "no-body", {
			name: "NoBody",
			description: "d",
		});
		const skill = scanSkills(home)[0];
		expect(skill).toBeDefined();
		// 协议:DiscoveredSkill 结构里不应有 body 字段
		expect(skill).not.toHaveProperty("body");
	});
});

// ─── sub-11: parseSkillFrontmatterFull(全字段,供详情页 Metadata 段) ──────

describe("sub-11: parseSkillFrontmatterFull 返回全部 frontmatter 字段", () => {
	test("含 name/description + 额外字段(category/allowed-tools)→ 全返回", () => {
		const skillDir = join(home, ".claude", "skills", "fm-full");
		mkdirSync(skillDir, { recursive: true });
		const md = [
			"---",
			"name: Full FM",
			"description: triggers when user asks",
			"category: productivity",
			"allowed-tools: Read, Grep, Bash",
			"version: 1.2.3",
			"---",
			"",
			"body line",
		].join("\n");
		writeFileSync(join(skillDir, "SKILL.md"), md, "utf-8");

		const full = parseSkillFrontmatterFull(md);
		expect(full.name).toBe("Full FM");
		expect(full.description).toBe("triggers when user asks");
		expect(full.category).toBe("productivity");
		expect(full["allowed-tools"]).toBe("Read, Grep, Bash");
		expect(full.version).toBe("1.2.3");
	});

	test("frontmatter 内 value 含引号 → 剥首尾配对引号", () => {
		const md = [
			"---",
			'name: "Quoted: name"',
			'description: "Has \\"escaped\\" quotes"',
			"---",
			"",
			"body",
		].join("\n");
		const full = parseSkillFrontmatterFull(md);
		// 双引号包裹 → 剥外层,内层转义不还原(轻量解析,够展示用)。
		expect(full.name).toBe("Quoted: name");
	});

	test("无 frontmatter → 空对象", () => {
		expect(parseSkillFrontmatterFull("just body text")).toEqual({});
	});

	test("缩进行(嵌套/列表项)被跳过 —— 仅顶层标量进入结果", () => {
		const md = [
			"---",
			"name: Nested",
			"description: d",
			"tools:",
			"  - Read",
			"  - Grep",
			"---",
			"",
			"body",
		].join("\n");
		const full = parseSkillFrontmatterFull(md);
		// tools: 行 value 为空字符串(顶层标量),但缩进的列表项 - Read / - Grep 不进入。
		expect(full.name).toBe("Nested");
		expect(full.tools).toBe("");
		// 确认缩进行的 - Read / - Grep 没被当成顶层 key。
		expect(full["- Read"]).toBeUndefined();
	});

	test("parseSkillFrontmatter(旧 API)仍只返回 { name, description } —— 向后兼容", () => {
		const md = [
			"---",
			"name: Compat",
			"description: d",
			"category: extra",
			"---",
			"",
			"body",
		].join("\n");
		const parsed = parseSkillFrontmatter(md);
		expect(parsed).toEqual({ name: "Compat", description: "d" });
		expect((parsed as any).category).toBeUndefined();
	});
});
