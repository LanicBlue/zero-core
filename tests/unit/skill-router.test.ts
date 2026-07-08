// 单元测试:skill-router 写路径护栏 + 本软件 skill CRUD 往返(acceptance-6 用例 7/8/4/5/6)
//
// # 文件说明书
//
// ## 核心功能
// 验证:
//   - isPathSafeId 白名单(拒 `..`、`/`、空格、特殊字符、超长)。
//   - assertWithinAppSkillsRoot 拒 `../` 越界 + 绝对外部路径(关键护栏,acceptance-6 用例 7)。
//   - buildSkillMd + stripFrontmatter 往返保持 frontmatter + body。
//   - 通过 Express + node:http 跑 router:CRUD 往返(create → update → delete)+ 外部来源只读(403)。
//   - 不破坏 ~/.claude / ~/.agents(只读校验,acceptance-6 用例 8)。
//
// ## 路径隔离
// 通过 `process.env.ZERO_CORE_DIR = tmpHome` 让 skill-router 的 `appSkillsRoot()` 与
// mock 后的 scanSkills baseDir 都落在同一 tmpHome 内(既当 ZERO_CORE_DIR 又当 fake home)。
// scannerMod.scanSkills 被 vi.spyOn mock 成基于 tmpHome 的真实扫描,不读真实 home。
//
// ## 定位
// tests/unit/ — 验证 skill-router 写路径 + CRUD。
//
// ## 依赖
// vitest、express、node:http、node:fs、node:os、node:path
//
// ## 维护规则
// 写路径校验逻辑变化时同步更新;CRUD body 格式变化时同步断言。
//

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── scanner homedir 重定向(vitest 不透传 USERPROFILE/HOME 给 os.homedir()) ──
// 让 scanner 的 `~/.zero-core` 解析到 tmpHome,与 router 的 appSkillsRoot()(基于
// ZERO_CORE_DIR = tmpHome/.zero-core)对齐。
let _fakeHome: string | null = null;
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return {
		...actual,
		homedir: () => _fakeHome ?? actual.homedir(),
	};
});

// ─── Helpers ────────────────────────────────────────────────

function listen(app: Express): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer(app);
		server.listen(0, () => {
			const addr = server.address() as { port: number };
			resolve({ server, port: addr.port });
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(resolve));
}

async function req(port: number, method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
	const url = `http://localhost:${port}${path}`;
	const opts: RequestInit = { method };
	if (body !== undefined) {
		opts.headers = { "Content-Type": "application/json" };
		opts.body = JSON.stringify(body);
	}
	const resp = await fetch(url, opts);
	const text = await resp.text();
	try {
		return { status: resp.status, data: JSON.parse(text) };
	} catch {
		return { status: resp.status, data: text };
	}
}

// ─── Setup:动态 import(vi.mock 已 hoist,模块拿到 mock 过的 node:os) ──

let routerMod: typeof import("../../src/server/skill-router.js");
let scannerMod: typeof import("../../src/server/skill-scanner.js");

beforeAll(async () => {
	routerMod = await import("../../src/server/skill-router.js");
	scannerMod = await import("../../src/server/skill-scanner.js");
});

// ─── 1. 纯函数护栏 ───────────────────────────────────────────

describe("acceptance-6 用例 7:写路径护栏(纯函数)", () => {
	test("isPathSafeId 白名单:接受 path-safe,拒特殊字符", () => {
		const { isPathSafeId } = routerMod;
		expect(isPathSafeId("my-skill")).toBe(true);
		expect(isPathSafeId("my_skill.v2")).toBe(true);
		expect(isPathSafeId("ABC123")).toBe(true);
		// 拒
		expect(isPathSafeId("")).toBe(false);
		expect(isPathSafeId(".")).toBe(false);
		expect(isPathSafeId("..")).toBe(false);
		expect(isPathSafeId("a/b")).toBe(false);
		expect(isPathSafeId("a\\b")).toBe(false);
		expect(isPathSafeId("a b")).toBe(false);
		expect(isPathSafeId("a:b")).toBe(false);
		expect(isPathSafeId("a\tb")).toBe(false);
		expect(isPathSafeId("../../../etc/passwd")).toBe(false);
		expect(isPathSafeId("x".repeat(65))).toBe(false);
	});

	test("assertWithinAppSkillsRoot 接受根内,拒越界 + 绝对外部路径", () => {
		const { assertWithinAppSkillsRoot, appSkillsRoot } = routerMod;
		const root = appSkillsRoot();
		expect(() => assertWithinAppSkillsRoot(join(root, "foo"))).not.toThrow();
		expect(() => assertWithinAppSkillsRoot(join(root, "foo", "SKILL.md"))).not.toThrow();
		expect(() => assertWithinAppSkillsRoot(root)).not.toThrow();
		// 拒 `../` 越界
		expect(() => assertWithinAppSkillsRoot(join(root, "..", "escape"))).toThrow();
		expect(() => assertWithinAppSkillsRoot(join(root, "..", "..", "etc", "passwd"))).toThrow();
		// 拒完全外部绝对路径
		expect(() => assertWithinAppSkillsRoot(join(tmpdir(), "elsewhere"))).toThrow();
		expect(() => assertWithinAppSkillsRoot(join(tmpdir(), "fake-home", ".claude", "skills", "x"))).toThrow();
	});
});

describe("buildSkillMd + stripFrontmatter 往返(acceptance-6 用例 4)", () => {
	test("简单 frontmatter + body 往返", () => {
		const { buildSkillMd, stripFrontmatter } = routerMod;
		const md = buildSkillMd({
			name: "My Skill",
			description: "A simple skill.",
			body: "# Heading\n\nSome body text.\n",
		});
		expect(md.startsWith("---\n")).toBe(true);
		expect(md).toContain("name: My Skill");
		expect(md).toContain("description: A simple skill.");
		const body = stripFrontmatter(md);
		expect(body).toContain("# Heading");
		expect(body.startsWith("# Heading")).toBe(true);
	});

	test("含特殊字符的 name/description → YAML 双引号包裹,stripFrontmatter 仍正确", () => {
		const { buildSkillMd, stripFrontmatter } = routerMod;
		const md = buildSkillMd({
			name: "Skill: with colon",
			description: 'Has "quotes" and #hash',
			body: "body line",
		});
		expect(md).toContain('name: "Skill: with colon"');
		expect(md).toContain('description: "Has \\"quotes\\" and #hash"');
		expect(stripFrontmatter(md).startsWith("body line")).toBe(true);
	});

	test("scanner.parseSkillFrontmatter 能解析 router 生成的 SKILL.md", () => {
		const { buildSkillMd } = routerMod;
		const md = buildSkillMd({
			name: "Generated",
			description: "from router",
			body: "hello",
		});
		const parsed = scannerMod.parseSkillFrontmatter(md);
		expect(parsed.name).toBe("Generated");
		expect(parsed.description).toBe("from router");
	});
});

// ─── 2. Express router 往返(node:http + fetch) ──────────────

let tmpHome: string;
let server: Server | null = null;

function buildApp(): Express {
	const app = express();
	app.use(express.json());
	app.use("/api/skills", routerMod.createSkillRouter());
	return app;
}

beforeEach(() => {
	tmpHome = mkdtempSync(join(tmpdir(), "zc-skill-router-home-"));
	// router 与 scanner 都用 os.homedir() 解析 app 根;vi.mock 重定向两者到 tmpHome。
	_fakeHome = tmpHome;
});

afterEach(async () => {
	_fakeHome = null;
	if (server) { await close(server); server = null; }
	rmSync(tmpHome, { recursive: true, force: true });
});

// (helper removed — 真实 scanSkills 直接用 homedir 重定向后的环境,不需要 mock。)

function seedAppSkill(home: string, id: string, fm: { name?: string; description: string }, body = "body") {
	const skillDir = join(home, ".zero-core", "skills", id);
	mkdirSync(skillDir, { recursive: true });
	const lines = ["---"];
	if (fm.name !== undefined) lines.push(`name: ${fm.name}`);
	lines.push(`description: ${fm.description}`, "---", "", body);
	writeFileSync(join(skillDir, "SKILL.md"), lines.join("\n"), "utf-8");
}

function seedUserSkill(home: string, sourceRoot: ".claude" | ".agents", id: string, fm: { name?: string; description: string }) {
	const skillDir = join(home, sourceRoot, "skills", id);
	mkdirSync(skillDir, { recursive: true });
	const lines = ["---"];
	if (fm.name !== undefined) lines.push(`name: ${fm.name}`);
	lines.push(`description: ${fm.description}`, "---", "", "user body");
	writeFileSync(join(skillDir, "SKILL.md"), lines.join("\n"), "utf-8");
}

async function start(app: Express): Promise<number> {
	const r = await listen(app);
	server = r.server;
	return r.port;
}

describe("acceptance-6 用例 5/6/4:本软件 skill CRUD 往返", () => {
	test("POST / → 创建 ~/.zero-core/skills/<id>/SKILL.md → GET / 读到", async () => {
		const port = await start(buildApp());
		const res = await req(port, "POST", "/api/skills", {
			id: "my-app-skill", name: "My App Skill", description: "desc", body: "hello body",
		});
		expect(res.status).toBe(201);
		expect(res.data.id).toBe("my-app-skill");
		expect(res.data.source).toBe("app");
		const md = readFileSync(join(tmpHome, ".zero-core", "skills", "my-app-skill", "SKILL.md"), "utf-8");
		expect(md).toContain("name: My App Skill");
		expect(md).toContain("description: desc");
		expect(md).toContain("hello body");
		const list = await req(port, "GET", "/api/skills");
		expect(list.data.find((s: any) => s.id === "my-app-skill")).toBeTruthy();
	});

	test("PUT /:id → 更新 frontmatter + body;id 不变", async () => {
		seedAppSkill(tmpHome, "edit-me", { name: "Before", description: "old" }, "old body");
		const port = await start(buildApp());
		const res = await req(port, "PUT", "/api/skills/edit-me", {
			name: "After", description: "new desc", body: "new body",
		});
		expect(res.status).toBe(200);
		expect(res.data.name).toBe("After");
		expect(res.data.description).toBe("new desc");
		expect(res.data.id).toBe("edit-me");
		const md = readFileSync(join(tmpHome, ".zero-core", "skills", "edit-me", "SKILL.md"), "utf-8");
		expect(md).toContain("name: After");
		expect(md).toContain("new body");
		expect(md).not.toContain("old body");
	});

	test("DELETE /:id → 删整个目录;再扫不到", async () => {
		seedAppSkill(tmpHome, "delete-me", { name: "Del", description: "x" });
		expect(existsSync(join(tmpHome, ".zero-core", "skills", "delete-me"))).toBe(true);
		const port = await start(buildApp());
		const res = await req(port, "DELETE", "/api/skills/delete-me");
		expect(res.status).toBe(200);
		expect(res.data.success).toBe(true);
		expect(existsSync(join(tmpHome, ".zero-core", "skills", "delete-me"))).toBe(false);
		const list = await req(port, "GET", "/api/skills");
		expect(list.data.find((s: any) => s.id === "delete-me")).toBeFalsy();
	});

	test("GET /:id/body → 返回 body(本软件)", async () => {
		seedAppSkill(tmpHome, "body-test", { name: "BT", description: "d" }, "the body line");
		const port = await start(buildApp());
		const res = await req(port, "GET", "/api/skills/body-test/body");
		expect(res.status).toBe(200);
		expect(res.data.body).toContain("the body line");
		expect(res.data.source).toBe("app");
	});

	test("GET /:id/body 404 for unknown id", async () => {
		const port = await start(buildApp());
		const res = await req(port, "GET", "/api/skills/does-not-exist/body");
		expect(res.status).toBe(404);
	});

	test("POST 重复 id → 409", async () => {
		seedAppSkill(tmpHome, "dup", { name: "Dup", description: "d" });
		const port = await start(buildApp());
		const res = await req(port, "POST", "/api/skills", {
			id: "dup", name: "Dup2", description: "d2", body: "x",
		});
		expect(res.status).toBe(409);
	});

	test("POST 非 path-safe id → 400,不写盘", async () => {
		const port = await start(buildApp());
		const res = await req(port, "POST", "/api/skills", {
			id: "../escape", name: "X", description: "d", body: "b",
		});
		expect(res.status).toBe(400);
		expect(existsSync(join(tmpHome, "..", "escape"))).toBe(false);
	});
});

describe("acceptance-6 用例 8 + 2:外部来源只读(不破坏 ~/.claude / ~/.agents)", () => {
	test("PUT 外部来源(user)→ 403,不写 ~/.claude", async () => {
		seedUserSkill(tmpHome, ".claude", "external-skill", { name: "Ext", description: "ext" });
		const port = await start(buildApp());
		const res = await req(port, "PUT", "/api/skills/external-skill", {
			name: "Hacked", description: "x", body: "pwned",
		});
		expect(res.status).toBe(403);
		const md = readFileSync(join(tmpHome, ".claude", "skills", "external-skill", "SKILL.md"), "utf-8");
		expect(md).toContain("name: Ext");
		expect(md).not.toContain("pwned");
	});

	test("DELETE 外部来源(user)→ 403,目录仍在", async () => {
		seedUserSkill(tmpHome, ".agents", "agent-skill", { name: "Agent", description: "a" });
		const port = await start(buildApp());
		const res = await req(port, "DELETE", "/api/skills/agent-skill");
		expect(res.status).toBe(403);
		expect(existsSync(join(tmpHome, ".agents", "skills", "agent-skill"))).toBe(true);
	});

	test("GET /:id/body 外部来源仍可读(只读展示)", async () => {
		seedUserSkill(tmpHome, ".claude", "read-only-ext", { name: "RO", description: "r" });
		const port = await start(buildApp());
		const res = await req(port, "GET", "/api/skills/read-only-ext/body");
		expect(res.status).toBe(200);
		expect(res.data.source).toBe("user");
		expect(res.data.body).toContain("user body");
	});
});
