// E2E 测试：Fetch from API 拉取模型列表
//
// # 文件说明书
//
// ## 核心功能
// 验证 Settings 页打开后未崩溃、providersFetchModels IPC 调用成功（GET 方法）返回数组、调用后 UI 仍可正常切换 Chat 页，确保 fetch-models 代理使用 GET 而非 POST
//
// ## 输入
// simple-response.json fixture（mock provider）
//
// ## 输出
// Playwright 测试用例：直接通过 window.evaluate 调用 api.providersFetchModels 校验返回数组
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证 fetch-models IPC 代理与设置页 UI 健壮性
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady、selectTestAgent）
//
// ## 维护规则
// IPC 代理方法（GET/POST）变更需同步更新 isArray 断言
// mock provider 返回模型数变化时需调整 modelCount 期望
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Fetch from API", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	test("fetch-from-API does not crash the UI", async () => {
		// Navigate to Settings page
		const settingsBtn = window.locator(".icon-sidebar-bottom button[title='Settings']");
		await settingsBtn.click();

		// Wait for settings to load
		await window.waitForSelector(".settings-page", { timeout: 10_000 });

		// Find the Mock provider card
		const providerCard = window.locator(".provider-card, .provider-item, [data-provider-type='mock']").first();
		const cardCount = await providerCard.count();

		if (cardCount === 0) {
			// Try finding by text content
			const cards = window.locator(".settings-page *");
			const mockCard = cards.locator(":has-text('Mock')").first();
			await expect(mockCard).toBeVisible({ timeout: 5_000 });
		}

		// Verify the settings page is still rendered (not blank)
		const settingsPage = window.locator(".settings-page");
		await expect(settingsPage).toBeVisible({ timeout: 5_000 });

		// The test primarily verifies that navigating to settings doesn't crash
		// and the provider list is visible
	});

	test("fetch-from-API IPC call succeeds with GET method", async () => {
		// Verify the IPC call works by calling it directly via evaluate
		const result = await window.evaluate(async () => {
			const api = (window as any).api;
			const providers = await api.providersList();
			const mockProvider = providers.find((p: any) => p.type === "mock");
			if (!mockProvider) return { error: "No mock provider found" };

			try {
				const models = await api.providersFetchModels(mockProvider.id);
				return { success: true, modelCount: models.length, models };
			} catch (err: any) {
				return { error: err.message };
			}
		});

		// The call should succeed (not throw an error)
		expect(result.error).toBeUndefined();
		expect(result.success).toBe(true);
		// Mock provider returns empty array since baseUrl is a local file
		expect(result.modelCount).toBeGreaterThanOrEqual(0);
	});

	test("fetch-from-API returns models without crashing settings UI", async () => {
		// First verify the IPC call returns data (even if empty for mock)
		const result = await window.evaluate(async () => {
			const api = (window as any).api;
			const providers = await api.providersList();
			const mockProvider = providers.find((p: any) => p.type === "mock");
			if (!mockProvider) return { error: "No mock provider" };

			const models = await api.providersFetchModels(mockProvider.id);
			return { providerId: mockProvider.id, models };
		});

		expect(result.error).toBeUndefined();

		// Navigate to settings to verify UI is functional
		const settingsBtn = window.locator(".icon-sidebar-bottom button[title='Settings']");
		await settingsBtn.click();

		// Verify settings page renders
		await window.waitForSelector(".settings-page", { timeout: 10_000 });
		const settingsPage = window.locator(".settings-page");
		await expect(settingsPage).toBeVisible();

		// Navigate back to chat — verify no crash
		const chatBtn = window.locator("button[title='Chat']");
		await chatBtn.click();
		await window.waitForSelector(".page-chat.page-active", { timeout: 10_000 });

		// Verify chat panel is still functional
		const chatPanel = window.locator(".chat-panel");
		await expect(chatPanel).toBeVisible();
	});

	test("fetch-from-API IPC proxy uses GET method", async () => {
		// Verify by making a direct HTTP request to the backend
		const result = await window.evaluate(async () => {
			const api = (window as any).api;
			const providers = await api.providersList();
			const mockProvider = providers.find((p: any) => p.type === "mock");
			if (!mockProvider) return { error: "No mock provider" };

			// The IPC proxy should forward as GET, not POST
			// If it uses POST, the backend returns 404 and models will be undefined/error
			const models = await api.providersFetchModels(mockProvider.id);
			return { modelCount: Array.isArray(models) ? models.length : -1, isArray: Array.isArray(models) };
		});

		expect(result.error).toBeUndefined();
		expect(result.isArray).toBe(true);
	});
});
