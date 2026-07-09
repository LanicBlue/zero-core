// 单测:skill-creator 内置脚手架脚本 init-skill.mjs 的核心函数 scaffoldSkill。
//
// # 文件说明书
//
// ## 核心功能
// 直接 import scripts/init-skill.mjs 导出的 `scaffoldSkill` 纯函数(不做 IO),
// 造各种合法/非法的入参喂进去,断言返回的 plan(skillDir / files / dirs)+ 校验错误。
// 不 spawn node(更快、更稳、跨平台无路径坑)。
//
// ## 测试覆盖
//   - valid: 标准 id → 生成 SKILL.md + skillDir
//   - valid + resources → 额外创建 scripts/references/assets 子目录
//   - targetDir 自定义 → skillDir 落在自定义父目录
//   - targetDir 默认 → 落 ~/.zero-core/skills
//   - invalid id: 空 / 含空格 / `.` / `..` / 过长 / 特殊字符 → 抛错
//   - invalid resources: 非法值(如 "docs")→ 抛错
//   - SKILL.md 模板含 frontmatter(name + description TODO)+ body TODO
//   - SKILL.md description 不是空(有 [TODO] 占位,scanner 不会跳过空 description)
//
// ## 定位
// tests/unit/ — vitest。
//

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPT_PATH = resolve(
	__dirname,
	"../../docs/plan/skill-system/bundled-skills/skill-creator/scripts/init-skill.mjs",
);

// 动态 import .mjs(vitest 支持 ESM dynamic import)。
const { scaffoldSkill, isPathSafeId } = await import(SCRIPT_PATH);

describe("scaffoldSkill — core logic", () => {
	it("valid id, no resources → SKILL.md + skillDir only", () => {
		const plan = scaffoldSkill({ skillId: "merge-pdfs", targetDir: "/tmp/staging" });
		expect(plan.skillDir).toBe(join("/tmp/staging", "merge-pdfs"));
		expect(plan.dirs).toEqual([join("/tmp/staging", "merge-pdfs")]);
		expect(plan.files).toHaveLength(1);
		expect(plan.files[0].path).toBe(join(plan.skillDir, "SKILL.md"));
	});

	it("valid id + resources → dirs include requested subdirs", () => {
		const plan = scaffoldSkill({
			skillId: "brand-assets",
			targetDir: "/tmp/staging",
			resources: ["scripts", "references", "assets"],
		});
		expect(plan.dirs).toContain(join(plan.skillDir, "scripts"));
		expect(plan.dirs).toContain(join(plan.skillDir, "references"));
		expect(plan.dirs).toContain(join(plan.skillDir, "assets"));
		// skillDir 仍是 dirs[0]。
		expect(plan.dirs[0]).toBe(plan.skillDir);
	});

	it("resources subset → only requested subdirs created", () => {
		const plan = scaffoldSkill({
			skillId: "minimal",
			targetDir: "/tmp/x",
			resources: ["scripts"],
		});
		expect(plan.dirs).toEqual([join("/tmp/x", "minimal"), join("/tmp/x", "minimal", "scripts")]);
	});

	it("targetDir omitted → defaults to ~/.zero-core/skills", () => {
		const plan = scaffoldSkill({ skillId: "default-root" });
		expect(plan.skillDir).toBe(join(homedir(), ".zero-core", "skills", "default-root"));
	});

	it("targetDir empty string → defaults to ~/.zero-core/skills", () => {
		const plan = scaffoldSkill({ skillId: "empty-root", targetDir: "" });
		expect(plan.skillDir).toBe(join(homedir(), ".zero-core", "skills", "empty-root"));
	});

	it("SKILL.md template has frontmatter (name + description TODO) + body TODO", () => {
		const plan = scaffoldSkill({ skillId: "my-skill", targetDir: "/tmp/x" });
		const md = plan.files[0].content;
		expect(md.startsWith("---\n")).toBe(true);
		expect(md).toContain("name: My Skill"); // hyphen→space, title-cased default
		expect(md).toContain("description:");
		expect(md).toContain("[TODO:");
		// body has a TODO too.
		expect(md).toContain("# My Skill");
	});

	it("SKILL.md description placeholder is non-empty (scanner won't skip)", () => {
		// 关键:占位 description 不能是空字符串,否则 scanner 跳过该 skill。
		const plan = scaffoldSkill({ skillId: "x", targetDir: "/tmp/x" });
		const md = plan.files[0].content;
		const descLine = md.split("\n").find((l) => l.startsWith("description:"));
		expect(descLine).toBeDefined();
		const value = descLine!.slice("description:".length).trim();
		expect(value.length).toBeGreaterThan(0);
	});

	it("default display name: hyphen → space, title-cased", () => {
		const plan = scaffoldSkill({ skillId: "address-review-comments", targetDir: "/tmp/x" });
		expect(plan.files[0].content).toContain("name: Address Review Comments");
	});

	// ── invalid id ──────────────────────────────────────────

	it("invalid id: empty → throws", () => {
		expect(() => scaffoldSkill({ skillId: "", targetDir: "/tmp/x" })).toThrow(/Invalid skill id/);
	});

	it("invalid id: contains space → throws", () => {
		expect(() => scaffoldSkill({ skillId: "bad id", targetDir: "/tmp/x" })).toThrow(/Invalid skill id/);
	});

	it("invalid id: '.' → throws", () => {
		expect(() => scaffoldSkill({ skillId: ".", targetDir: "/tmp/x" })).toThrow(/Invalid skill id/);
	});

	it("invalid id: '..' → throws", () => {
		expect(() => scaffoldSkill({ skillId: "..", targetDir: "/tmp/x" })).toThrow(/Invalid skill id/);
	});

	it("invalid id: path separator → throws", () => {
		expect(() => scaffoldSkill({ skillId: "a/b", targetDir: "/tmp/x" })).toThrow(/Invalid skill id/);
	});

	it("invalid id: > 64 chars → throws", () => {
		expect(() => scaffoldSkill({ skillId: "a".repeat(65), targetDir: "/tmp/x" })).toThrow(/Invalid skill id/);
	});

	it("valid id: 64 chars boundary → ok", () => {
		expect(() => scaffoldSkill({ skillId: "a".repeat(64), targetDir: "/tmp/x" })).not.toThrow();
	});

	it("valid id: letters, digits, dash, underscore, dot → ok", () => {
		expect(() => scaffoldSkill({ skillId: "my-skill_1.2", targetDir: "/tmp/x" })).not.toThrow();
	});

	// ── invalid resources ───────────────────────────────────

	it("invalid resource: 'docs' → throws", () => {
		expect(() =>
			scaffoldSkill({ skillId: "x", targetDir: "/tmp/x", resources: ["docs"] }),
		).toThrow(/Invalid resource "docs"/);
	});

	it("resources list with one valid + one invalid → throws", () => {
		expect(() =>
			scaffoldSkill({ skillId: "x", targetDir: "/tmp/x", resources: ["scripts", "examples"] }),
		).toThrow(/Invalid resource "examples"/);
	});

	it("resources empty array → no extra dirs (minimal skill)", () => {
		const plan = scaffoldSkill({ skillId: "x", targetDir: "/tmp/x", resources: [] });
		expect(plan.dirs).toEqual([join("/tmp/x", "x")]);
	});
});

describe("isPathSafeId (exported helper)", () => {
	it("valid id → true", () => {
		expect(isPathSafeId("merge-pdfs")).toBe(true);
	});
	it("'.' / '..' → false", () => {
		expect(isPathSafeId(".")).toBe(false);
		expect(isPathSafeId("..")).toBe(false);
	});
	it("spaces / separators → false", () => {
		expect(isPathSafeId("has space")).toBe(false);
		expect(isPathSafeId("a/b")).toBe(false);
	});
	it("> 64 chars → false", () => {
		expect(isPathSafeId("a".repeat(65))).toBe(false);
	});
});
