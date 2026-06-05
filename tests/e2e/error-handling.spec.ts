// E2E 测试：错误处理与恢复
//
// # 文件说明书
//
// ## 核心功能
// 验证 LLM 返回错误时渲染进程显示错误横幅、横幅可关闭、横幅自动消失
//
// ## 输入
// error-response.json fixture（包含 error 字段的 mock 响应）
//
// ## 输出
// Playwright 测试用例：error banner appears / can be dismissed / auto-dismisses
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证错误恢复流程
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady、selectTestAgent）
//
// ## 维护规则
// error-banner CSS 类名变更需同步更新选择器
// 自动消失超时（5s）变更需调整测试等待时间
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ERROR_FIXTURE = resolve(__dirname, "fixtures/error-response.json");

test.describe("Error handling", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.afterEach(async () => {
		await cleanup();
	});

	test("error banner appears when first message fails", async () => {
		const app = await launchApp(ERROR_FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);

		await window.locator(".chat-input-bar textarea").fill("trigger error");
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();

		const banner = window.locator(".error-banner");
		await expect(banner).toBeVisible({ timeout: 20_000 });
	});

	test("error banner can be dismissed by clicking close button", async () => {
		const app = await launchApp(ERROR_FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);

		await window.locator(".chat-input-bar textarea").fill("trigger error");
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();

		const banner = window.locator(".error-banner");
		await expect(banner).toBeVisible({ timeout: 20_000 });

		await banner.locator(".error-banner-close").click();
		await expect(banner).not.toBeVisible();
	});

	test("error banner auto-dismisses after 5 seconds", async () => {
		const app = await launchApp(ERROR_FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);

		await window.locator(".chat-input-bar textarea").fill("trigger error");
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();

		const banner = window.locator(".error-banner");
		await expect(banner).toBeVisible({ timeout: 20_000 });

		await expect(banner).not.toBeVisible({ timeout: 8_000 });
	});
});
