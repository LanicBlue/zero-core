// E2E 测试:Skills 页面入口 + 双栏 + 本软件 skill CRUD(acceptance-6 用例 10–15)
//
// # 文件说明书
//
// ## 核心功能
// 1. 入口与基础渲染(原有用例):侧边栏 Skills 按钮位置、点击进页、Refresh 按钮。
// 2. 双栏 + 分组(用例 10):左列表按来源分组、"本软件 skills" 置顶、外部其下;
//    选中左项 → 右详情显示 name/description/body。
// 3. 外部只读(用例 11):外部来源 skill 选中后,详情区无编辑/删除按钮。
// 4. 本软件可编辑 + 往返(用例 12):编辑 display name/description/body → 保存 → 重扫读到新内容。
// 5. 新建(用例 13):新建(id path-safe + name + desc + body)→ 列表出现该项;再次进页仍在。
// 6. 删除(用例 14):删除(确认)→ 列表移除;再次进页不在。
// 7. id 不可改(用例 15):编辑模式下无 id 输入字段(仅改 display name + description + body)。
//
// ## 测试隔离与 cleanup
// scanner 读 os.homedir() —— Electron 主进程的 homedir() 是真实用户 home(E2E 不重定向)。
// 故本软件 skill CRUD 写到真实 `~/.zero-core/skills/<test-id>/`。**每个用例都 cleanup**:
// afterEach 删除本测试创建的所有 `<test-id>` 目录,绝不污染用户环境。
// 不动 ~/.claude / ~/.agents(外部来源只读,本测试不写)。
//
// ## 非确定性处理
// 真实 ~/.claude/skills、~/.agents/skills 内容不可控 —— 用例按 seeded skill 的 id 定位,
// 不断言全局条数。外部只读用例:种一个 user 来源 fixture 到 ~/.claude/skills/<test-ext-id>/,
// 测完 cleanup。
//
// ## 定位
// tests/e2e/ — Playwright Electron E2E。
//
// ## 依赖
// @playwright/test、./helpers/test-app、node:fs、node:path、node:os
//

import { test, expect } from "@playwright/test";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
	mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, mkdtempSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { launchApp, waitForAppReady } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

// 真实 ~/.zero-core/skills 和 ~/.claude/skills —— scanner 读这两个目录。
const APP_SKILLS_DIR = join(homedir(), ".zero-core", "skills");
const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");

// 测试用 id 前缀 —— cleanup 时按此前缀扫并删,避免遗漏。
const TEST_ID_PREFIX = "zc-e2e-sub6-";

/** 创建一个本软件 skill fixture。 */
function seedAppSkill(id: string, opts: { name?: string; description: string; body?: string }) {
	const dir = join(APP_SKILLS_DIR, id);
	mkdirSync(dir, { recursive: true });
	const lines = ["---"];
	if (opts.name !== undefined) lines.push(`name: ${opts.name}`);
	lines.push(`description: ${opts.description}`);
	lines.push("---", "", opts.body ?? "default body");
	writeFileSync(join(dir, "SKILL.md"), lines.join("\n"), "utf-8");
	return dir;
}

/** 创建一个外部来源(user)skill fixture 到 ~/.claude/skills/<id>/。 */
function seedUserSkill(id: string, opts: { name?: string; description: string }) {
	const dir = join(CLAUDE_SKILLS_DIR, id);
	mkdirSync(dir, { recursive: true });
	const lines = ["---"];
	if (opts.name !== undefined) lines.push(`name: ${opts.name}`);
	lines.push(`description: ${opts.description}`);
	lines.push("---", "", "external body");
	writeFileSync(join(dir, "SKILL.md"), lines.join("\n"), "utf-8");
	return dir;
}

/** 清理本测试种下的所有 fixture(按 TEST_ID_PREFIX 前缀扫两个目录)。 */
function cleanupTestSkills() {
	for (const dir of [APP_SKILLS_DIR, CLAUDE_SKILLS_DIR]) {
		if (!existsSync(dir)) continue;
		let entries: string[] = [];
		try { entries = readdirSync(dir); } catch { continue; }
		for (const name of entries) {
			if (name.startsWith(TEST_ID_PREFIX)) {
				try { rmSync(join(dir, name), { recursive: true, force: true }); } catch {}
			}
		}
	}
}

async function gotoSkillsPage(window: import("@playwright/test").Page) {
	const skillsBtn = window.locator(".icon-sidebar-top button[title='Skills']");
	await skillsBtn.click();
	await window.waitForSelector(".skills-page", { timeout: 10_000 });
}

test.describe("Skills page", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		cleanupTestSkills(); // 进入前清一次,防前次崩溃残留
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => {
		await cleanup();
		cleanupTestSkills(); // 退出后再清一次,确保不污染用户环境
	});

	// ─── 原有用例(入口 + 基础渲染)──────────────────────────────

	test("skills icon is visible in sidebar after MCP", async () => {
		const sidebar = window.locator(".icon-sidebar-top");
		await expect(sidebar).toBeVisible();

		const buttons = sidebar.locator("button");
		const count = await buttons.count();

		let mcpIdx = -1;
		let skillsIdx = -1;
		for (let i = 0; i < count; i++) {
			const title = await buttons.nth(i).getAttribute("title");
			if (title === "MCP Servers") mcpIdx = i;
			if (title === "Skills") skillsIdx = i;
		}
		expect(mcpIdx).toBeGreaterThanOrEqual(0);
		expect(skillsIdx).toBeGreaterThanOrEqual(0);
		expect(skillsIdx).toBeGreaterThan(mcpIdx);
	});

	test("clicking Skills icon shows skills page", async () => {
		await gotoSkillsPage(window);
		const header = window.locator(".skills-page h2");
		await expect(header).toHaveText("Skills");
	});

	test("skills page shows refresh button", async () => {
		await gotoSkillsPage(window);
		// sub-7 加了 "Install from git" btn-ghost → header 现在多个 btn-ghost,按文本定位 Refresh。
		const refreshBtn = window.locator(".skills-page-header-actions button", { hasText: "Refresh" });
		await expect(refreshBtn).toBeVisible();
	});

	// ─── 用例 10:双栏 + 分组 ──────────────────────────────────

	test("case 10: two-pane layout with source grouping (app on top)", async () => {
		const appId = `${TEST_ID_PREFIX}app-seed`;
		const userId = `${TEST_ID_PREFIX}user-seed`;
		seedAppSkill(appId, { name: "App Seed", description: "app-seed desc", body: "app body content" });
		seedUserSkill(userId, { name: "User Seed", description: "user-seed desc" });

		await gotoSkillsPage(window);

		// 等列表加载(Refresh 按钮变 enabled)。
		await window.waitForSelector(`.skill-item[data-testid], .skill-item`, { timeout: 10_000 }).catch(() => {});
		// 左栏按 id 找到 seeded skills。
		const appItem = window.locator(`.skill-item`, { hasText: appId });
		const userItem = window.locator(`.skill-item`, { hasText: userId });
		await expect(appItem).toBeVisible({ timeout: 10_000 });
		await expect(userItem).toBeVisible({ timeout: 10_000 });

		// 分组标题:"本软件 skills" 应在 "外部 skills" 之前。
		const titles = window.locator(".skills-group-title");
		const titleCount = await titles.count();
		let appGroupIdx = -1;
		let userGroupIdx = -1;
		for (let i = 0; i < titleCount; i++) {
			const txt = (await titles.nth(i).innerText()).toLowerCase();
			if (txt.includes("本软件") || txt.includes("app")) appGroupIdx = i;
			if (txt.includes("外部") || txt.includes("user")) userGroupIdx = i;
		}
		expect(appGroupIdx).toBeGreaterThanOrEqual(0);
		expect(userGroupIdx).toBeGreaterThanOrEqual(0);
		expect(appGroupIdx).toBeLessThan(userGroupIdx);

		// 选中本软件 skill → 右详情显示 name/description/body。
		await appItem.click();
		const detail = window.locator(".skill-detail");
		await expect(detail).toBeVisible();
		await expect(detail.locator(".skill-detail-name")).toContainText("App Seed");
		await expect(detail.locator(".skill-detail-description")).toContainText("app-seed desc");
		// body 按需取 → 含 seeded 正文。
		await expect(detail.locator(".skill-detail-body")).toContainText("app body content", { timeout: 10_000 });
	});

	// ─── 用例 11:外部来源只读 ─────────────────────────────────

	test("case 11: external (user-source) skill detail has no edit/delete buttons", async () => {
		const userId = `${TEST_ID_PREFIX}ro-ext`;
		seedUserSkill(userId, { name: "RO Ext", description: "read-only external" });

		await gotoSkillsPage(window);
		const userItem = window.locator(`.skill-item`, { hasText: userId });
		await expect(userItem).toBeVisible({ timeout: 10_000 });
		await userItem.click();

		const detail = window.locator(".skill-detail");
		await expect(detail).toBeVisible();
		// 无 Edit / Delete 按钮。
		await expect(detail.locator("button:has-text('Edit')")).toHaveCount(0);
		await expect(detail.locator("button:has-text('Delete')")).toHaveCount(0);
		// 有只读提示。
		await expect(detail.locator(".skill-detail-readonly-hint")).toBeVisible();
	});

	// ─── 用例 12:本软件 skill 可编辑 + 往返 ────────────────────

	test("case 12: edit app skill (name/description/body) → save → rescan reads new content", async () => {
		const appId = `${TEST_ID_PREFIX}edit`;
		seedAppSkill(appId, { name: "Before Edit", description: "old desc", body: "old body line" });

		await gotoSkillsPage(window);
		const appItem = window.locator(`.skill-item`, { hasText: appId });
		await expect(appItem).toBeVisible({ timeout: 10_000 });
		await appItem.click();

		// 进入编辑模式。
		const detail = window.locator(".skill-detail");
		await expect(detail.locator("button:has-text('Edit')")).toBeVisible();
		await detail.locator("button:has-text('Edit')").click();

		// 改 display name + description + body。
		const nameInput = detail.locator("#skill-edit-name");
		const descInput = detail.locator("#skill-edit-desc");
		const bodyInput = detail.locator("#skill-edit-body");
		await expect(nameInput).toBeVisible();
		await nameInput.fill("After Edit");
		await descInput.fill("new desc");
		await bodyInput.fill("new body content");

		// 保存。
		await detail.locator("button:has-text('Save')").click();

		// 重扫后详情显示新内容。
		await expect(detail.locator(".skill-detail-name")).toContainText("After Edit", { timeout: 10_000 });
		await expect(detail.locator(".skill-detail-description")).toContainText("new desc");
		await expect(detail.locator(".skill-detail-body")).toContainText("new body content", { timeout: 10_000 });

		// 磁盘写回正确。
		const md = readFileSync(join(APP_SKILLS_DIR, appId, "SKILL.md"), "utf-8");
		expect(md).toContain("name: After Edit");
		expect(md).toContain("new body content");
		expect(md).not.toContain("old body line");
	});

	// ─── 用例 13:本软件 skill 新建 ────────────────────────────

	test("case 13: create new app skill → list shows it; persists after re-entry", async () => {
		await gotoSkillsPage(window);

		// 点 + New Skill。
		await window.locator(".skills-page-header-actions button:has-text('New Skill')").click();

		const form = window.locator(".skill-detail-creating");
		await expect(form).toBeVisible();
		await form.locator("#skill-create-id").fill(`${TEST_ID_PREFIX}new`);
		await form.locator("#skill-create-name").fill("Newly Created");
		await form.locator("#skill-create-desc").fill("brand new");
		await form.locator("#skill-create-body").fill("fresh body");
		await form.locator("button:has-text('Create')").click();

		// 列表出现。
		const newItem = window.locator(`.skill-item`, { hasText: `${TEST_ID_PREFIX}new` });
		await expect(newItem).toBeVisible({ timeout: 10_000 });

		// 磁盘文件存在。
		expect(existsSync(join(APP_SKILLS_DIR, `${TEST_ID_PREFIX}new`, "SKILL.md"))).toBe(true);

		// 再次进页仍在。
		await window.locator(".icon-sidebar-top button[title='Chat']").click();
		await gotoSkillsPage(window);
		await expect(newItem).toBeVisible({ timeout: 10_000 });
	});

	// ─── 用例 14:本软件 skill 删除 ────────────────────────────

	test("case 14: delete app skill (with confirm) → removed from list + gone on re-entry", async () => {
		const appId = `${TEST_ID_PREFIX}del`;
		seedAppSkill(appId, { name: "To Delete", description: "soon gone" });

		await gotoSkillsPage(window);
		const item = window.locator(`.skill-item`, { hasText: appId });
		await expect(item).toBeVisible({ timeout: 10_000 });
		await item.click();

		// 触发删除 + 确认对话框(confirm() 由 page.on('dialog') 自动接受)。
		window.on("dialog", (d) => d.accept());
		await window.locator(".skill-detail button:has-text('Delete')").click();

		// 列表移除。
		await expect(item).toHaveCount(0, { timeout: 10_000 });

		// 磁盘目录消失。
		expect(existsSync(join(APP_SKILLS_DIR, appId))).toBe(false);

		// 再次进页不在。
		await window.locator(".icon-sidebar-top button[title='Chat']").click();
		await gotoSkillsPage(window);
		await expect(item).toHaveCount(0);
	});

	// ─── 用例 15:id 不可改 ───────────────────────────────────

	test("case 15: edit mode has no id input field (id is directory name, immutable)", async () => {
		const appId = `${TEST_ID_PREFIX}idlock`;
		seedAppSkill(appId, { name: "Id Lock", description: "d" });

		await gotoSkillsPage(window);
		const item = window.locator(`.skill-item`, { hasText: appId });
		await expect(item).toBeVisible({ timeout: 10_000 });
		await item.click();

		const detail = window.locator(".skill-detail");
		await detail.locator("button:has-text('Edit')").click();

		// 编辑模式:无 id 输入框(只有 name/desc/body),meta 区显示 id 只读。
		const editing = window.locator(".skill-detail-editing");
		await expect(editing).toBeVisible();
		await expect(editing.locator("#skill-edit-id")).toHaveCount(0);
		await expect(editing.locator("#skill-create-id")).toHaveCount(0);
		// id 在 meta 区以只读 code 形式出现。
		await expect(editing.locator("code")).toContainText(appId);
	});

	// ─── 用例 9/10/11(sub-7:从 git URL 安装)──────────────────
	//
	// 用本地 file:// fixture repo(可控、离线、不依赖网络/凭证),需系统 git。
	// 无 git 时整组 skip(单元测试 skill-router-install-git.test.ts 已覆盖逻辑)。

	const E2E_GIT_AVAILABLE = (() => {
		try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; }
		catch { return false; }
	})();

	/**
	 * 构造一个本地 git fixture repo 并返回其 file:// URL。
	 * 注意 repoName **不含** TEST_ID_PREFIX —— clone 出的 id 会是 repoName,
	 * 但 cleanupTestSkills 按前缀扫 ~/.zero-core/skills/<prefix>*,所以这里用
	 * TEST_ID_PREFIX 做前缀(repoName 以 prefix 开头,落盘后能被 cleanup 扫到)。
	 */
	function buildFixtureRepoUrl(layout: "single" | "multi" | "none", repoName: string): string {
		// fixture 放在唯一 tmp 父目录(mkdtemp),repo 根 = 父目录/repoName。
		// clone 出的 id = repoName(repo 名 / 子目录名),落盘到 ~/.zero-core/skills/<id>。
		const dir = mkdtempSync(join(homedir(), ".zero-core", `e2e-fixture-`));
		const repoDir = join(dir, repoName);
		mkdirSync(repoDir, { recursive: true });
		if (layout === "single") {
			writeFileSync(join(repoDir, "SKILL.md"), `---\nname: ${repoName} E2E\ndescription: single e2e fixture\n---\nsingle body\n`, "utf-8");
		} else if (layout === "multi") {
			for (const sub of [`${repoName}-a`, `${repoName}-b`]) {
				mkdirSync(join(repoDir, sub), { recursive: true });
				writeFileSync(join(repoDir, sub, "SKILL.md"), `---\nname: ${sub}\ndescription: multi e2e\n---\n${sub} body\n`, "utf-8");
			}
		}
		// "none":不放任何 SKILL.md,但需至少一个文件让 git commit 成功。
		if (layout === "none") {
			writeFileSync(join(repoDir, ".gitkeep"), "", "utf-8");
		}
		execFileSync("git", ["-C", repoDir, "init", "-q"], { stdio: "ignore" });
		execFileSync("git", ["-C", repoDir, "config", "user.email", "e2e@test"], { stdio: "ignore" });
		execFileSync("git", ["-C", repoDir, "config", "user.name", "E2E"], { stdio: "ignore" });
		execFileSync("git", ["-C", repoDir, "config", "commit.gpgsign", "false"], { stdio: "ignore" });
		execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
		execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"], { stdio: "ignore" });
		// 记录 fixture 父目录用于 cleanup(afterEach 用 prefix 扫)。
		_fixtureDirs.add(dir);
		return "file:///" + repoDir.replace(/\\/g, "/").replace(/^\//, "");
	}

	// fixture 父目录集合 —— afterEach 清理(这些在 tmp 但仍要扫,免得堆积)。
	const _fixtureDirs = new Set<string>();

	test.afterEach(async () => {
		// 清理 fixture repos(已在 beforeEach/afterEach cleanupTestSkills 之外)。
		for (const d of _fixtureDirs) {
			try { rmSync(d, { recursive: true, force: true }); } catch {}
		}
		_fixtureDirs.clear();
	});

	(E2E_GIT_AVAILABLE ? test : test.skip)("case 9: install single skill from file:// fixture → list + detail", async () => {
		const repoName = `${TEST_ID_PREFIX}git-single`;
		const url = buildFixtureRepoUrl("single", repoName);

		await gotoSkillsPage(window);

		// 打开「Install from git」弹窗。
		await window.locator(".skills-page-header-actions button:has-text('Install from git')").click();
		await expect(window.locator(".skill-install-modal")).toBeVisible();
		await window.locator("#skill-install-url").fill(url);
		await window.locator(".skill-install-modal button:has-text('Install')").click();

		// 列表出现该 skill。
		const item = window.locator(".skill-item", { hasText: repoName });
		await expect(item).toBeVisible({ timeout: 30_000 });

		// 详情可读。
		await item.click();
		const detail = window.locator(".skill-detail");
		await expect(detail.locator(".skill-detail-body")).toContainText("single body", { timeout: 15_000 });

		// 磁盘落盘 + 保留 .git。
		expect(existsSync(join(APP_SKILLS_DIR, repoName, "SKILL.md"))).toBe(true);
		expect(existsSync(join(APP_SKILLS_DIR, repoName, ".git"))).toBe(true);
	});

	(E2E_GIT_AVAILABLE ? test : test.skip)("case 10: install multi-skill repo from file:// → all sub-skills appear", async () => {
		const repoName = `${TEST_ID_PREFIX}git-multi`;
		const url = buildFixtureRepoUrl("multi", repoName);
		const idA = `${repoName}-a`;
		const idB = `${repoName}-b`;

		await gotoSkillsPage(window);
		await window.locator(".skills-page-header-actions button:has-text('Install from git')").click();
		await window.locator("#skill-install-url").fill(url);
		await window.locator(".skill-install-modal button:has-text('Install')").click();

		// 两个子 skill 都出现。
		await expect(window.locator(".skill-item", { hasText: idA })).toBeVisible({ timeout: 30_000 });
		await expect(window.locator(".skill-item", { hasText: idB })).toBeVisible({ timeout: 10_000 });

		expect(existsSync(join(APP_SKILLS_DIR, idA, "SKILL.md"))).toBe(true);
		expect(existsSync(join(APP_SKILLS_DIR, idB, "SKILL.md"))).toBe(true);
	});

	(E2E_GIT_AVAILABLE ? test : test.skip)("case 11: re-install same URL → rejected (409), list count unchanged", async () => {
		const repoName = `${TEST_ID_PREFIX}git-dup`;
		const url = buildFixtureRepoUrl("single", repoName);

		await gotoSkillsPage(window);

		// 第一次:成功。
		await window.locator(".skills-page-header-actions button:has-text('Install from git')").click();
		await window.locator("#skill-install-url").fill(url);
		await window.locator(".skill-install-modal button:has-text('Install')").click();
		const item = window.locator(".skill-item", { hasText: repoName });
		await expect(item).toBeVisible({ timeout: 30_000 });

		// 第二次:重名 → 拒绝。弹窗显示错误 toast。
		await window.locator(".skills-page-header-actions button:has-text('Install from git')").click();
		await window.locator("#skill-install-url").fill(url);
		await window.locator(".skill-install-modal button:has-text('Install')").click();

		// toast 出现 + 含 already exists / 整批。
		await expect(window.locator(".skills-toast-error")).toBeVisible({ timeout: 15_000 });
		// 列表条数不变(只有第一次装的那一个):repoName 的 skill 只有一个。
		await expect(window.locator(".skill-item", { hasText: repoName })).toHaveCount(1);
	});

	(E2E_GIT_AVAILABLE ? test : test.skip)("case (extra): install repo with no SKILL.md → error toast, no install", async () => {
		const repoName = `${TEST_ID_PREFIX}git-empty`;
		const url = buildFixtureRepoUrl("none", repoName);

		await gotoSkillsPage(window);
		await window.locator(".skills-page-header-actions button:has-text('Install from git')").click();
		await window.locator("#skill-install-url").fill(url);
		await window.locator(".skill-install-modal button:has-text('Install')").click();

		await expect(window.locator(".skills-toast-error")).toBeVisible({ timeout: 15_000 });
		expect(existsSync(join(APP_SKILLS_DIR, repoName))).toBe(false);
	});
});
