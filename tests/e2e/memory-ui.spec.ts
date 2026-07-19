// E2E 测试：Settings Memory(压缩)面板
//
// # 文件说明书
//
// ## 核心功能
// Verifies Memory & Compression navigation, automatic policy, model selection, and Save.
// 独立的 Knowledge Base 页与 Memory 标签页已随 KB 子系统移除(memory 现以 wiki 子树形式存在)。
//
// ## 输入
// simple-response.json fixture（mock provider）
//
// ## 输出
// Playwright 测试用例：检查 .settings-nav-item、.memory-config、.btn-primary 等元素
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证 Memory 压缩面板渲染
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady）
//
// ## 维护规则
// Settings 导航结构变更需同步更新选择器与文案断言
// Update assertions when the compression policy or model default changes.
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

	test("compression is automatic and model defaults to Same as Agent", async () => {
		const settingsBtn = window.locator(".icon-sidebar-bottom button[title='Settings']");
		await settingsBtn.click();

		const memoryNav = window.locator(".settings-nav-item", { hasText: "Memory" });
		await memoryNav.click();

		await window.waitForSelector(".memory-config", { timeout: 5000 });
		await expect(window.locator(".memory-config")).toContainText("no enable knob");
		await expect(window.locator(".memory-config .toggle-switch")).toHaveCount(0);

		const model = window.getByLabel("Compression Model");
		await expect(model).toHaveValue("");
		await expect(model.locator("option").first()).toHaveText("Same as Agent");
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
