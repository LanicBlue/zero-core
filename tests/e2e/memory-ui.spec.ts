// E2E 测试：Memory 设置与 Knowledge Base Memory 标签页
//
// # 文件说明书
//
// ## 核心功能
// 验证 Settings 中 Memory 导航项存在、点击后展示 Memory & Compression 面板与压缩开关（默认 off）、Save 按钮可见；以及 Knowledge Base 页的 Libraries/Memory 两个标签、默认激活 Libraries、Memory 标签的搜索框、统计区、空状态文案、标签切换后位置不变
//
// ## 输入
// simple-response.json fixture（mock provider，无 memory 节点）
//
// ## 输出
// Playwright 测试用例：检查 .settings-nav-item、.memory-config、.kb-tab-btn、.memory-search-input、.memory-stats、.agents-empty 等元素
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证 Memory 相关 UI 渲染
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady）
//
// ## 维护规则
// Settings 导航结构或 KB 标签命名变更需同步更新选择器与文案断言
// 压缩开关默认值变更需更新 hasOn 断言
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Settings — Memory section", () => {
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

	test("Memory section exists in settings nav", async () => {
		const settingsBtn = window.locator(".icon-sidebar-bottom button[title='Settings']");
		await settingsBtn.click();

		const memoryNav = window.locator(".settings-nav-item", { hasText: "Memory" });
		await expect(memoryNav).toBeVisible();
	});

	test("clicking Memory nav shows Memory & Compression panel", async () => {
		const settingsBtn = window.locator(".icon-sidebar-bottom button[title='Settings']");
		await settingsBtn.click();

		const memoryNav = window.locator(".settings-nav-item", { hasText: "Memory" });
		await memoryNav.click();

		const title = window.locator(".section-title-row h3", { hasText: "Memory & Compression" });
		await expect(title).toBeVisible();
	});

	test("compression toggle is visible and defaults to off", async () => {
		const settingsBtn = window.locator(".icon-sidebar-bottom button[title='Settings']");
		await settingsBtn.click();

		const memoryNav = window.locator(".settings-nav-item", { hasText: "Memory" });
		await memoryNav.click();

		// Wait for the memory config panel to render
		await window.waitForSelector(".memory-config", { timeout: 5000 });

		const toggles = window.locator(".memory-config .toggle-switch");
		await expect(toggles.first()).toBeVisible({ timeout: 5000 });
		const count = await toggles.count();
		expect(count).toBeGreaterThanOrEqual(2);

		// First toggle (compression) should not have "on" class by default
		const firstToggle = toggles.first();
		const hasOn = await firstToggle.evaluate((el) => el.classList.contains("on"));
		expect(hasOn).toBe(false);
	});

	test("Save button is visible", async () => {
		const settingsBtn = window.locator(".icon-sidebar-bottom button[title='Settings']");
		await settingsBtn.click();

		const memoryNav = window.locator(".settings-nav-item", { hasText: "Memory" });
		await memoryNav.click();

		const saveBtn = window.locator(".memory-config .btn-primary", { hasText: "Save" });
		await expect(saveBtn).toBeVisible();
	});
});

test.describe("Knowledge Base — Memory tab", () => {
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

	test("Knowledge Base icon opens KB page", async () => {
		const kbBtn = window.locator(".icon-sidebar-top button[title='Knowledge Base']");
		await kbBtn.click();

		const header = window.locator(".kb-page-header h2");
		await expect(header).toHaveText("Knowledge Base");
	});

	test("Libraries and Memory tabs are visible", async () => {
		const kbBtn = window.locator(".icon-sidebar-top button[title='Knowledge Base']");
		await kbBtn.click();

		const tabs = window.locator(".kb-tab-btn");
		const count = await tabs.count();
		expect(count).toBe(2);

		await expect(tabs.nth(0)).toHaveText("Libraries");
		await expect(tabs.nth(1)).toHaveText("Memory");
	});

	test("Libraries tab is active by default", async () => {
		const kbBtn = window.locator(".icon-sidebar-top button[title='Knowledge Base']");
		await kbBtn.click();

		const librariesTab = window.locator(".kb-tab-btn", { hasText: "Libraries" });
		await expect(librariesTab).toHaveClass(/active/);
	});

	test("clicking Memory tab shows memory page content", async () => {
		const kbBtn = window.locator(".icon-sidebar-top button[title='Knowledge Base']");
		await kbBtn.click();

		const memoryTab = window.locator(".kb-tab-btn", { hasText: "Memory" });
		await memoryTab.click();

		const searchInput = window.locator(".memory-search-input");
		await expect(searchInput).toBeVisible();

		const stats = window.locator(".memory-stats");
		await expect(stats).toBeVisible();
	});

	test("Memory tab shows empty state message when no nodes", async () => {
		const kbBtn = window.locator(".icon-sidebar-top button[title='Knowledge Base']");
		await kbBtn.click();

		const memoryTab = window.locator(".kb-tab-btn", { hasText: "Memory" });
		await memoryTab.click();

		const emptyMsg = window.locator(".memory-page-content .agents-empty");
		await expect(emptyMsg).toBeVisible();
		await expect(emptyMsg).toContainText("No memory nodes yet");
	});

	test("Memory search input accepts text", async () => {
		const kbBtn = window.locator(".icon-sidebar-top button[title='Knowledge Base']");
		await kbBtn.click();

		const memoryTab = window.locator(".kb-tab-btn", { hasText: "Memory" });
		await memoryTab.click();

		const searchInput = window.locator(".memory-search-input");
		await searchInput.fill("test query");
		await expect(searchInput).toHaveValue("test query");
	});

	test("switching between Libraries and Memory tabs preserves tab bar position", async () => {
		const kbBtn = window.locator(".icon-sidebar-top button[title='Knowledge Base']");
		await kbBtn.click();

		const tabsBar = window.locator(".kb-page-tabs");
		const box1 = await tabsBar.boundingBox();

		const memoryTab = window.locator(".kb-tab-btn", { hasText: "Memory" });
		await memoryTab.click();

		const box2 = await tabsBar.boundingBox();
		expect(box2).not.toBeNull();
		if (box1 && box2) {
			expect(box2.y).toBeCloseTo(box1.y, 0);
		}
	});
});
