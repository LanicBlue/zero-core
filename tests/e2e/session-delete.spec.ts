// E2E 测试：会话删除
//
// # 文件说明书
//
// ## 核心功能
// 验证删除活跃会话后自动切换到新的空会话，删除非活跃会话保留当前会话消息
//
// ## 输入
// simple-response.json fixture（mock provider 响应）
//
// ## 输出
// Playwright 测试用例：deleting active session switches to empty / deleting non-active preserves messages
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证会话删除流程
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady、selectTestAgent、sendChatMessage）
//
// ## 维护规则
// session-item CSS 类名变更需同步更新选择器
// 删除按钮位置变更需更新 session-item-delete 选择器
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Session deletion", () => {
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

	test("deleting the active session switches to a new empty session", async () => {
		// Send a message in session A
		await sendChatMessage(window, "message in A");
		await expect(window.locator(".message.message-user")).toHaveCount(1);

		// Delete the active session
		await window.locator(".btn-sessions").click();
		const items = window.locator(".session-item");
		await expect(items).toHaveCount(1, { timeout: 5_000 });
		await items.first().locator(".session-item-delete").click();

		// A new empty session should be created
		await expect(window.locator(".chat-empty")).toBeVisible({ timeout: 5_000 });
	});

	test("deleting a non-active session preserves active session messages", async () => {
		// Session A: send a message
		await sendChatMessage(window, "message in A");
		await expect(window.locator(".message.message-user")).toHaveCount(1);

		// Create session B
		await window.locator(".btn-new-session").click();
		await expect(window.locator(".chat-empty")).toBeVisible();

		// Send in B
		await sendChatMessage(window, "message in B");
		await expect(window.locator(".message.message-user")).toHaveCount(1);
		await expect(window.locator(".message.message-user")).toContainText("message in B");

		// Open session dropdown and wait for 2 items
		await window.locator(".btn-sessions").click();
		const items = window.locator(".session-item");
		await expect(items).toHaveCount(2, { timeout: 5_000 });

		// Find and delete the non-active session
		const count = await items.count();
		for (let i = 0; i < count; i++) {
			const item = items.nth(i);
			const isActive = await item.evaluate((el) => el.classList.contains("active"));
			if (!isActive) {
				await item.locator(".session-item-delete").click();
				break;
			}
		}

		// Active session B should still have its messages
		await expect(window.locator(".message.message-user")).toHaveCount(1);
		await expect(window.locator(".message.message-user")).toContainText("message in B");
	});
});
