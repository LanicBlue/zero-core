// 单测:skill-creator 内置格式审查脚本 validate-skill.mjs 的核心函数 validateSkill。
//
// # 文件说明书
//
// ## 核心功能
// 直接 import scripts/validate-skill.mjs 导出的 `validateSkill` 纯函数(不做 IO),
// 造各种 valid / invalid 的 SKILL.md 内容字符串喂进去,断言 problems / warnings。
// 这样不必 spawn node 子进程(更快、更稳、跨平台无路径坑)。
//
// ## 为什么不 spawn
// 脚本 CLI 入口负责 fs IO;核心 logic 抽成纯函数 `validateSkill({ skillMdContent,
// skillMdBytes?, dirName? })` 便于直接测。CLI 路径已手动跑过自检(见 task 报告)。
//
// ## 测试覆盖
//   - valid: 标准 skill 通过(problems 空)
//   - no frontmatter: error
//   - empty frontmatter block(有 --- 但无 key): error
//   - missing name: error
//   - missing description: error
//   - short description: warning only(仍 problems 空)
//   - empty body: error
//   - too large(> 256KB): error
//   - bad id(空格 / `.` / `..` / 过长 / 特殊字符): error
//   - good id 边界(64 字符、含 `.`-`_`): 通过
//   - dirName 省略(SKILL.md 路径入参): 不校验 id
//
// ## 定位
// tests/unit/ — vitest。
//

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPT_PATH = resolve(
	__dirname,
	"../../docs/plan/skill-system/bundled-skills/skill-creator/scripts/validate-skill.mjs",
);

// 动态 import .mjs(vitest 支持 ESM dynamic import)。
const { validateSkill } = await import(SCRIPT_PATH);

// 造一个合法 skill 内容(可被各 case 局部修改)。
function validContent(opts: { name?: string; description?: string; body?: string } = {}): string {
	const name = opts.name ?? "My Skill";
	const desc = opts.description ?? "Does X when the user asks about X-related things.";
	const body = opts.body ?? "# My Skill\n\nBody content here.\n";
	return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;
}

describe("validateSkill — core logic", () => {
	it("valid skill: no problems, no warnings", () => {
		const r = validateSkill({ skillMdContent: validContent() });
		expect(r.problems).toEqual([]);
		expect(r.warnings).toEqual([]);
	});

	it("no frontmatter → error", () => {
		const r = validateSkill({ skillMdContent: "just a body, no frontmatter at all\n" });
		expect(r.problems.length).toBeGreaterThan(0);
		expect(r.problems.some((p) => p.includes("frontmatter"))).toBe(true);
	});

	it("frontmatter block present but empty (no key: value) → error", () => {
		// 有 --- 包裹但里面无 key:value —— parseFrontmatter 返回 {}。
		const content = "---\n---\n\nbody\n";
		const r = validateSkill({ skillMdContent: content });
		expect(r.problems.some((p) => p.includes("Frontmatter block is empty"))).toBe(true);
	});

	it("missing name → error", () => {
		const r = validateSkill({
			skillMdContent: "---\ndescription: a valid description here\n---\n\nbody\n",
		});
		expect(r.problems.some((p) => p.includes("missing non-empty `name`"))).toBe(true);
	});

	it("empty name (key present but blank value) → error", () => {
		const r = validateSkill({
			skillMdContent: "---\nname:   \ndescription: a valid description here\n---\n\nbody\n",
		});
		expect(r.problems.some((p) => p.includes("missing non-empty `name`"))).toBe(true);
	});

	it("missing description → error (it is the primary trigger)", () => {
		const r = validateSkill({
			skillMdContent: "---\nname: Has Name\n---\n\nbody\n",
		});
		expect(r.problems.some((p) => p.includes("missing non-empty `description`"))).toBe(true);
	});

	it("empty description (key present but blank) → error", () => {
		const r = validateSkill({
			skillMdContent: "---\nname: Has Name\ndescription:   \n---\n\nbody\n",
		});
		expect(r.problems.some((p) => p.includes("missing non-empty `description`"))).toBe(true);
	});

	it("short description (< 10 chars) → warning only, still valid", () => {
		const r = validateSkill({
			skillMdContent: validContent({ description: "short" }), // 5 chars
		});
		expect(r.problems).toEqual([]);
		expect(r.warnings.some((w) => w.includes("very short"))).toBe(true);
	});

	it("description exactly 10 chars → no warning (boundary)", () => {
		const r = validateSkill({
			skillMdContent: validContent({ description: "0123456789" }), // 10 chars
		});
		expect(r.warnings.filter((w) => w.includes("very short"))).toEqual([]);
	});

	it("empty body (whitespace only after frontmatter) → error", () => {
		const r = validateSkill({
			skillMdContent: "---\nname: X\ndescription: long enough description\n---\n\n   \n\t\n",
		});
		expect(r.problems.some((p) => p.includes("body is empty"))).toBe(true);
	});

	it("SKILL.md too large (> 256KB) → error", () => {
		// 不必真造 256KB 字符串 —— 直接传 skillMdBytes 覆盖字节数估算。
		const r = validateSkill({
			skillMdContent: validContent(),
			skillMdBytes: 256_000 + 1,
		});
		expect(r.problems.some((p) => p.includes("too large"))).toBe(true);
	});

	it("SKILL.md exactly 256KB → ok (boundary)", () => {
		const r = validateSkill({
			skillMdContent: validContent(),
			skillMdBytes: 256_000,
		});
		expect(r.problems.filter((p) => p.includes("too large"))).toEqual([]);
	});

	it("description with surrounding quotes — quotes stripped, length check on inner", () => {
		// frontmatter 里 description: "short" —— 去引号后是 short(5 字符)→ warning。
		// 验证 parseFrontmatter 的引号剥离 + 长度判断都基于去引号后的值。
		const content = '---\nname: X\ndescription: "short"\n---\n\nbody\n';
		const r = validateSkill({ skillMdContent: content });
		expect(r.problems).toEqual([]);
		expect(r.warnings.some((w) => w.includes("very short"))).toBe(true);
	});

	// ─── id path-safe ───────────────────────────────────────

	it("dirName omitted (SKILL.md path input) → id check skipped", () => {
		// 不传 dirName:即使一个明显非法的 id 也不会报(因为没机会校验)。
		const r = validateSkill({ skillMdContent: validContent() });
		expect(r.problems.filter((p) => p.includes("path-safe"))).toEqual([]);
	});

	it("dirName = null → id check skipped (explicit skip)", () => {
		const r = validateSkill({ skillMdContent: validContent(), dirName: null });
		expect(r.problems.filter((p) => p.includes("path-safe"))).toEqual([]);
	});

	it("bad id: contains space → error", () => {
		const r = validateSkill({ skillMdContent: validContent(), dirName: "bad id" });
		expect(r.problems.some((p) => p.includes("not path-safe"))).toBe(true);
	});

	it("bad id: '.' → error", () => {
		const r = validateSkill({ skillMdContent: validContent(), dirName: "." });
		expect(r.problems.some((p) => p.includes("not path-safe"))).toBe(true);
	});

	it("bad id: '..' → error", () => {
		const r = validateSkill({ skillMdContent: validContent(), dirName: ".." });
		expect(r.problems.some((p) => p.includes("not path-safe"))).toBe(true);
	});

	it("bad id: path separator → error", () => {
		const r = validateSkill({ skillMdContent: validContent(), dirName: "a/b" });
		expect(r.problems.some((p) => p.includes("not path-safe"))).toBe(true);
	});

	it("bad id: empty → error", () => {
		const r = validateSkill({ skillMdContent: validContent(), dirName: "" });
		expect(r.problems.some((p) => p.includes("not path-safe"))).toBe(true);
	});

	it("bad id: > 64 chars → error", () => {
		const r = validateSkill({ skillMdContent: validContent(), dirName: "a".repeat(65) });
		expect(r.problems.some((p) => p.includes("not path-safe"))).toBe(true);
	});

	it("good id: 64 chars boundary → ok", () => {
		const r = validateSkill({ skillMdContent: validContent(), dirName: "a".repeat(64) });
		expect(r.problems.filter((p) => p.includes("path-safe"))).toEqual([]);
	});

	it("good id: letters, digits, dash, underscore, dot → ok", () => {
		const r = validateSkill({ skillMdContent: validContent(), dirName: "my-skill_1.2" });
		expect(r.problems.filter((p) => p.includes("path-safe"))).toEqual([]);
	});

	// ─── 多问题同时出现 ────────────────────────────────────────

	it("multiple problems at once: each reported independently", () => {
		// 缺 name + 缺 description + 空 body + 非法 id —— 四个问题各报一条。
		const r = validateSkill({
			skillMdContent: "---\ncategory: x\n---\n\n",
			dirName: "bad id",
		});
		// 注意:缺 name + 缺 description 的报错依赖 frontmatter 非空判断。
		// 这里 frontmatter 有 category(非空),故 name/description 缺失会被检出。
		expect(r.problems.some((p) => p.includes("missing non-empty `name`"))).toBe(true);
		expect(r.problems.some((p) => p.includes("missing non-empty `description`"))).toBe(true);
		expect(r.problems.some((p) => p.includes("body is empty"))).toBe(true);
		expect(r.problems.some((p) => p.includes("not path-safe"))).toBe(true);
		expect(r.problems.length).toBe(4);
	});
});
