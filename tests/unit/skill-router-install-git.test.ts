// 单元测试:sub-7 git URL 安装 —— auto-detect + 原子性 + 回滚(acceptance-7 用例 1-5)
//
// # 文件说明书
//
// ## 核心功能
// 验证(纯函数 + Express router 往返,不真跑 git):
//   - deriveRepoName:从 https/git@/file:// 提取 repo 名,path-safe 化。
//   - detectSkillsInClone:auto-detect 布局(根 / 子目录 / 无 SKILL.md / 并存 / 子目录名非法跳过)。
//   - validateDetectedSkill:合法 frontmatter 通过 / 缺 name / 缺 description / 无 frontmatter / 文件缺失。
//   - install-git 端点集成:
//     · 单 skill repo(file:// 本地 fixture)→ 装到 ~/.zero-core/skills/<repoName>。
//     · 多 skill repo(子目录各有 SKILL.md)→ 全部装。
//     · 无 SKILL.md → 400「未检测到合法 skill」+ 不落盘。
//     · 重名 → 409 整批拒绝 + 清理临时 clone(不残留)。
//     · 校验失败(缺 frontmatter)→ 400 + 不落盘 + 清理临时。
//
// ## 测试隔离
// 用真实 `git clone`(系统 git)clone 一个**本地** file:// fixture repo(可控、离线、
// 不依赖网络/凭证)。每个 fixture repo 是 beforeEach 新建的 tmp 目录,装到 _fakeHome
// 重定向后的 ~/.zero-core/skills。每个用例后 cleanup tmp fixture + fake home。
//
// ## 定位
// tests/unit/ — 验证 sub-7 git 安装核心逻辑。
//
// ## 依赖
// vitest、express、node:http、node:fs、node:os、node:path、node:child_process(建 fixture)
//

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import {
	mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// ─── scanner homedir 重定向 ──
let _fakeHome: string | null = null;
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => _fakeHome ?? actual.homedir() };
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
	try { return { status: resp.status, data: JSON.parse(text) }; }
	catch { return { status: resp.status, data: text }; }
}

let routerMod: typeof import("../../src/server/skill-router.js");

beforeAll(async () => {
	routerMod = await import("../../src/server/skill-router.js");
});

let tmpHome: string;
let server: Server | null = null;

function buildApp(): Express {
	const app = express();
	app.use(express.json());
	app.use("/api/skills", routerMod.createSkillRouter());
	return app;
}

beforeEach(() => {
	tmpHome = mkdtempSync(join(tmpdir(), "zc-skill-git-home-"));
	_fakeHome = tmpHome;
});

afterEach(async () => {
	_fakeHome = null;
	if (server) { await close(server); server = null; }
	rmSync(tmpHome, { recursive: true, force: true });
	for (const p of _fixtureParents) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
	_fixtureParents.clear();
});

async function start(app: Express): Promise<number> {
	const r = await listen(app);
	server = r.server;
	return r.port;
}

// ─── 1. 纯函数:deriveRepoName ────────────────────────────────

describe("deriveRepoName", () => {
	test("https URL with .git", () => {
		expect(routerMod.deriveRepoName("https://github.com/owner/my-skills.git")).toBe("my-skills");
	});
	test("git@ scp-style", () => {
		expect(routerMod.deriveRepoName("git@github.com:owner/repo.git")).toBe("repo");
	});
	test("file:// absolute", () => {
		expect(routerMod.deriveRepoName("file:///tmp/foo/bar-baz")).toBe("bar-baz");
	});
	test("strips trailing slash before splitting", () => {
		expect(routerMod.deriveRepoName("https://github.com/o/repo.git/")).toBe("repo");
	});
	test("path-safe 化非法字符 → dash", () => {
		expect(routerMod.deriveRepoName("https://x/o/my skill repo.git")).toBe("my-skill-repo");
	});
	test("空 → fallback 'skill'", () => {
		expect(routerMod.deriveRepoName("")).toBe("skill");
		expect(routerMod.deriveRepoName("   ")).toBe("skill");
	});
});

// ─── 2. 纯函数:detectSkillsInClone(auto-detect 布局) ───────

describe("detectSkillsInClone (acceptance-7 用例 1/2/3)", () => {
	test("根 SKILL.md → 单 skill,id = repoName", () => {
		const root = mkdtempSync(join(tmpdir(), "clone-single-"));
		writeFileSync(join(root, "SKILL.md"), "---\nname: S\ndescription: d\n---\nbody\n", "utf-8");
		const detected = routerMod.detectSkillsInClone(root, "my-repo");
		expect(detected).toHaveLength(1);
		expect(detected[0].id).toBe("my-repo");
		expect(detected[0].srcDir).toBe(root);
		rmSync(root, { recursive: true, force: true });
	});

	test("子目录各有 SKILL.md → 多 skill,id = 子目录名(不递归)", () => {
		const root = mkdtempSync(join(tmpdir(), "clone-multi-"));
		for (const sub of ["alpha", "beta"]) {
			mkdirSync(join(root, sub), { recursive: true });
			writeFileSync(join(root, sub, "SKILL.md"), `---\nname: ${sub}\ndescription: d\n---\nbody\n`, "utf-8");
		}
		const detected = routerMod.detectSkillsInClone(root, "unused");
		expect(detected.map((d) => d.id).sort()).toEqual(["alpha", "beta"]);
		expect(detected.every((d) => d.srcDir === join(root, d.id))).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	test("根 + 子目录并存 → 都装(根用 repoName,子目录用子目录名)", () => {
		const root = mkdtempSync(join(tmpdir(), "clone-both-"));
		writeFileSync(join(root, "SKILL.md"), "---\nname: Root\ndescription: d\n---\nbody\n", "utf-8");
		mkdirSync(join(root, "child"), { recursive: true });
		writeFileSync(join(root, "child", "SKILL.md"), "---\nname: Child\ndescription: d\n---\nbody\n", "utf-8");
		const detected = routerMod.detectSkillsInClone(root, "repo-root");
		expect(detected.map((d) => d.id).sort()).toEqual(["child", "repo-root"]);
		rmSync(root, { recursive: true, force: true });
	});

	test("无 SKILL.md(根和子目录都没有)→ 空(调用方报错)", () => {
		const root = mkdtempSync(join(tmpdir(), "clone-none-"));
		mkdirSync(join(root, "sub"), { recursive: true }); // 子目录但无 SKILL.md
		const detected = routerMod.detectSkillsInClone(root, "repo");
		expect(detected).toHaveLength(0);
		rmSync(root, { recursive: true, force: true });
	});

	test("子目录名非法(含空格/斜杠)→ 跳过那个子目录(不递归清洗)", () => {
		const root = mkdtempSync(join(tmpdir(), "clone-badname-"));
		mkdirSync(join(root, "good"), { recursive: true });
		writeFileSync(join(root, "good", "SKILL.md"), "---\nname: Good\ndescription: d\n---\nb\n", "utf-8");
		mkdirSync(join(root, "bad name"), { recursive: true });
		writeFileSync(join(root, "bad name", "SKILL.md"), "---\nname: Bad\ndescription: d\n---\nb\n", "utf-8");
		const detected = routerMod.detectSkillsInClone(root, "repo");
		expect(detected.map((d) => d.id).sort()).toEqual(["good"]);
		rmSync(root, { recursive: true, force: true });
	});

	test("深层嵌套目录有 SKILL.md → 不递归,只看一层", () => {
		const root = mkdtempSync(join(tmpdir(), "clone-nested-"));
		mkdirSync(join(root, "l1", "l2"), { recursive: true });
		writeFileSync(join(root, "l1", "l2", "SKILL.md"), "---\nname: Deep\ndescription: d\n---\nb\n", "utf-8");
		const detected = routerMod.detectSkillsInClone(root, "repo");
		expect(detected).toHaveLength(0); // l1 无 SKILL.md,l2 太深
		rmSync(root, { recursive: true, force: true });
	});

	test("忽略 .git / .隐藏目录 / node_modules", () => {
		const root = mkdtempSync(join(tmpdir(), "clone-ignore-"));
		mkdirSync(join(root, ".git"), { recursive: true });
		writeFileSync(join(root, ".git", "SKILL.md"), "---\nname: x\ndescription: d\n---\nb\n", "utf-8");
		mkdirSync(join(root, "node_modules"), { recursive: true });
		writeFileSync(join(root, "node_modules", "SKILL.md"), "---\nname: x\ndescription: d\n---\nb\n", "utf-8");
		const detected = routerMod.detectSkillsInClone(root, "repo");
		expect(detected).toHaveLength(0);
		rmSync(root, { recursive: true, force: true });
	});
});

// ─── 3. 纯函数:validateDetectedSkill ─────────────────────────

describe("validateDetectedSkill", () => {
	test("合法 frontmatter → ok", () => {
		const root = mkdtempSync(join(tmpdir(), "val-ok-"));
		writeFileSync(join(root, "SKILL.md"), "---\nname: S\ndescription: d\n---\nb\n", "utf-8");
		const d: import("../../src/server/skill-router.js").DetectedSkill = { id: "x", srcDir: root };
		const r = routerMod.validateDetectedSkill(d);
		expect(r.ok).toBe(true);
		expect(d.frontmatter?.name).toBe("S");
		expect(d.frontmatter?.description).toBe("d");
		rmSync(root, { recursive: true, force: true });
	});

	test("缺 name → 失败", () => {
		const root = mkdtempSync(join(tmpdir(), "val-noname-"));
		writeFileSync(join(root, "SKILL.md"), "---\ndescription: d\n---\nb\n", "utf-8");
		const d: import("../../src/server/skill-router.js").DetectedSkill = { id: "x", srcDir: root };
		expect(routerMod.validateDetectedSkill(d).ok).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	test("缺 description → 失败", () => {
		const root = mkdtempSync(join(tmpdir(), "val-nodesc-"));
		writeFileSync(join(root, "SKILL.md"), "---\nname: S\n---\nb\n", "utf-8");
		const d: import("../../src/server/skill-router.js").DetectedSkill = { id: "x", srcDir: root };
		expect(routerMod.validateDetectedSkill(d).ok).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	test("无 frontmatter(纯文本)→ 失败", () => {
		const root = mkdtempSync(join(tmpdir(), "val-nofm-"));
		writeFileSync(join(root, "SKILL.md"), "just some text, no frontmatter", "utf-8");
		const d: import("../../src/server/skill-router.js").DetectedSkill = { id: "x", srcDir: root };
		expect(routerMod.validateDetectedSkill(d).ok).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	test("SKILL.md 缺失 → 失败", () => {
		const root = mkdtempSync(join(tmpdir(), "val-missing-"));
		const d: import("../../src/server/skill-router.js").DetectedSkill = { id: "x", srcDir: root };
		expect(routerMod.validateDetectedSkill(d).ok).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});
});

// ─── 4. install-git 端点集成(用真实 git clone 本地 file:// fixture) ──
//
// 这些用例 clone 一个**本地** tmp 里的 fixture repo(可控、离线),用系统 git。
// 若系统无 git,整个 describe 块 skip。

const GIT_AVAILABLE = (() => {
	try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; }
	catch { return false; }
})();

/**
 * 构造一个本地 git fixture repo 并返回其 file:// URL。
 * layout:
 *   - "single":根 SKILL.md(id = repoName)。
 *   - "multi":子目录 alpha/beta 各有 SKILL.md。
 *   - "none":无 SKILL.md。
 *   - "invalid":根 SKILL.md 但缺 description(校验失败)。
 * repoName 决定 clone 出的目录名(= 单 skill 布局的 id)。
 */
function buildFixtureRepo(layout: "single" | "multi" | "none" | "invalid", repoName: string): string {
	// mkdtemp 给唯一父目录;repo 根 = 父/repoName,这样 clone 出的 id = repoName(repo 名)。
	const parent = mkdtempSync(join(tmpdir(), "zc-fixture-"));
	const dir = join(parent, repoName);
	mkdirSync(dir, { recursive: true });
	_fixtureParents.add(parent);
	if (layout === "single") {
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${repoName} Skill\ndescription: single fixture\n---\nsingle body\n`, "utf-8");
	} else if (layout === "multi") {
		for (const sub of ["alpha", "beta"]) {
			mkdirSync(join(dir, sub), { recursive: true });
			writeFileSync(join(dir, sub, "SKILL.md"), `---\nname: ${sub}\ndescription: multi fixture\n---\n${sub} body\n`, "utf-8");
		}
	} else if (layout === "invalid") {
		// 缺 description → validateDetectedSkill 失败
		writeFileSync(join(dir, "SKILL.md"), `---\nname: Bad\n---\nbody\n`, "utf-8");
	}
	// "none":不放任何 SKILL.md,但需至少一个文件让 git commit 成功。
	if (layout === "none") {
		writeFileSync(join(dir, ".gitkeep"), "", "utf-8");
	}
	// 初始化为 git repo(需 commit,否则 git clone 报 "does not appear to be a git repo")。
	execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"], { stdio: "ignore" });
	// Windows 本地路径转 file:// URL:正反斜杠。
	return "file:///" + dir.replace(/\\/g, "/").replace(/^\//, "");
}

const _fixtureParents = new Set<string>();

(GIT_AVAILABLE ? describe : describe.skip)("install-git 端点集成(真实 git clone 本地 fixture)", () => {
	test("用例 1:单 skill repo → 装到 ~/.zero-core/skills/<repoName>", async () => {
		const url = buildFixtureRepo("single", "single-skill");
		const port = await start(buildApp());
		const res = await req(port, "POST", "/api/skills/install-git", { url });
		expect(res.status).toBe(201);
		expect(res.data.installed).toHaveLength(1);
		expect(res.data.installed[0].id).toBe("single-skill");
		expect(res.data.installed[0].source).toBe("app");
		// 磁盘落盘。
		expect(existsSync(join(tmpHome, ".zero-core", "skills", "single-skill", "SKILL.md"))).toBe(true);
	});

	test("用例 2:多 skill repo(子目录)→ 全部装", async () => {
		const url = buildFixtureRepo("multi", "multi-skill");
		const port = await start(buildApp());
		const res = await req(port, "POST", "/api/skills/install-git", { url });
		expect(res.status).toBe(201);
		const ids = res.data.installed.map((s: any) => s.id).sort();
		expect(ids).toEqual(["alpha", "beta"]);
		expect(existsSync(join(tmpHome, ".zero-core", "skills", "alpha", "SKILL.md"))).toBe(true);
		expect(existsSync(join(tmpHome, ".zero-core", "skills", "beta", "SKILL.md"))).toBe(true);
	});

	test("用例 3:无 SKILL.md → 400「未检测到合法 skill」+ 不落盘", async () => {
		const url = buildFixtureRepo("none", "empty-skill");
		const port = await start(buildApp());
		const res = await req(port, "POST", "/api/skills/install-git", { url });
		expect(res.status).toBe(400);
		expect(String(res.data.error)).toMatch(/未检测到合法 skill|no SKILL\.md/i);
		// ~/.zero-core/skills 下不应有 empty-skill(可能连 skills 目录都不存在)。
		expect(existsSync(join(tmpHome, ".zero-core", "skills", "empty-skill"))).toBe(false);
		// tmp clone 父目录(mkdtemp "zc-skill-git-")应被清理:扫 tmpdir 下属本测试进程的残留。
		// (不强断言 tmpdir 全清,只断言 app 根无残留。)
	});

	test("用例 4:重名 → 409 整批拒绝 + 不落盘", async () => {
		const url = buildFixtureRepo("multi", "dup-skill");
		const port = await start(buildApp());
		// 第一次:成功装 alpha + beta。
		const r1 = await req(port, "POST", "/api/skills/install-git", { url });
		expect(r1.status).toBe(201);
		expect(r1.data.installed.map((s: any) => s.id).sort()).toEqual(["alpha", "beta"]);
		// 第二次:alpha/beta 已存在 → 409 整批拒绝。
		const r2 = await req(port, "POST", "/api/skills/install-git", { url });
		expect(r2.status).toBe(409);
		expect(String(r2.data.error)).toMatch(/already exists|整批/);
		// 落盘的仍是第一次的(alpha/beta 目录在);无新 tmp 残留 → 略(已断言 status + message)。
		expect(existsSync(join(tmpHome, ".zero-core", "skills", "alpha", "SKILL.md"))).toBe(true);
	});

	test("用例 5:校验失败(根 SKILL.md 缺 description)→ 400 + 不落盘", async () => {
		const url = buildFixtureRepo("invalid", "bad-skill");
		const port = await start(buildApp());
		const res = await req(port, "POST", "/api/skills/install-git", { url });
		expect(res.status).toBe(400);
		expect(String(res.data.error)).toMatch(/invalid|description/i);
		expect(existsSync(join(tmpHome, ".zero-core", "skills", "bad-skill"))).toBe(false);
	});

	test("用例 6:URL 为空 → 400", async () => {
		const port = await start(buildApp());
		const res = await req(port, "POST", "/api/skills/install-git", { url: "" });
		expect(res.status).toBe(400);
	});

	test("用例 7:保留 .git(为未来 pull)", async () => {
		const url = buildFixtureRepo("single", "keep-git");
		const port = await start(buildApp());
		const res = await req(port, "POST", "/api/skills/install-git", { url });
		expect(res.status).toBe(201);
		expect(existsSync(join(tmpHome, ".zero-core", "skills", "keep-git", ".git"))).toBe(true);
	});
});
