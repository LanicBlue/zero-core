// E2E 测试：Skills 页面入口与渲染
//
// # 文件说明书
//
// ## 核心功能
// 验证 Skills 按钮在侧边栏（MCP Servers 之后）可见、点击后进入 Skills 页（h2 文本「Skills」）且页面包含刷新按钮
//
// ## 输入
// simple-response.json fixture（mock provider）
//
// ## 输出
// Playwright 测试用例：检查 .icon-sidebar-top 中 Skills 按钮位置、.skills-page 与 .btn-ghost 元素
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证 Skills 页面入口与基础渲染
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady）
//
// ## 维护规则
// 侧边栏按钮顺序或 Skills 入口 title 变更需同步更新断言
// Skills 页结构变更需更新 .skills-page / .btn-ghost 选择器
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Skills page", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	test("skills icon is visible in sidebar after MCP", async () => {
		const sidebar = window.locator(".icon-sidebar-top");
		await expect(sidebar).toBeVisible();

		const buttons = sidebar.locator("button");
		const count = await buttons.count();

		// Find the MCP button and verify Skills button comes after it
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
		const skillsBtn = window.locator(".icon-sidebar-top button[title='Skills']");
		await skillsBtn.click();

		const page = window.locator(".skills-page");
		await expect(page).toBeVisible();

		const header = page.locator("h2");
		await expect(header).toHaveText("Skills");
	});

	test("skills page shows refresh button", async () => {
		const skillsBtn = window.locator(".icon-sidebar-top button[title='Skills']");
		await skillsBtn.click();

		const refreshBtn = window.locator(".skills-page .btn-ghost");
		await expect(refreshBtn).toBeVisible();
	});
});
