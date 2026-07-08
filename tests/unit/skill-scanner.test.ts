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
