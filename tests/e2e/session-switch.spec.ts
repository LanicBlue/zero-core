// E2E 测试：会话切换
//
// # 文件说明书
//
// ## 核心功能
// 验证会话 A 到 B 再切回 A 时消息历史完整保留，无重复或丢失
//
// ## 输入
// simple-response.json fixture（mock provider 响应）
//
// ## 输出
// Playwright 测试用例：switching A → B → A preserves history
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证会话切换流程
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady、selectTestAgent、sendChatMessage）
//
// ## 维护规则
// session-item-label CSS 类名变更需同步更新选择器
// 会话列表 DOM 结构变更需更新 active 判断逻辑
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Session switching", () => {
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

	test("switching A → B → A preserves history", async () => {
		// Session A: send a message
		await sendChatMessage(window, "first message");
		await expect(window.locator(".message.message-user")).toHaveCount(1);
		await expect(window.locator(".message.message-assistant")).toHaveCount(1);

		// Create session B
		await window.locator(".btn-new-session").click();
		// New session: messages cleared
		await expect(window.locator(".chat-empty")).toBeVisible();

		// Send in B
		await sendChatMessage(window, "second message");
		await expect(window.locator(".message.message-user")).toHaveCount(1);
		await expect(window.locator(".message.message-assistant")).toHaveCount(1);
		const bAssistantText = await window.locator(".message.message-assistant").first().textContent();

		// Open session dropdown and switch back to A (first non-active session)
		await window.locator(".btn-sessions").click();
		// The active session is rendered first; we want a different one.
		// Clicking any session-item-label that isn't currently active toggles to it.
		const sessionItems = window.locator(".session-item");
		const count = await sessionItems.count();
		expect(count).toBeGreaterThanOrEqual(2);

		// Pick the first non-active session-item's label button
		let switched = false;
		for (let i = 0; i < count; i++) {
			const item = sessionItems.nth(i);
			const isActive = await item.evaluate((el) => el.classList.contains("active"));
			if (!isActive) {
				await item.locator(".session-item-label").click();
				switched = true;
				break;
			}
		}
		expect(switched).toBe(true);

		// Back on A: original user message preserved
		await expect(window.locator(".message.message-user")).toHaveCount(1);
		await expect(window.locator(".message.message-user")).toContainText("first message");
		// And assistant response still present
		await expect(window.locator(".message.message-assistant")).toHaveCount(1);
		// No duplicate bubbles
		const allUser = await window.locator(".message.message-user").count();
		const allAssistant = await window.locator(".message.message-assistant").count();
		expect(allUser).toBe(1);
		expect(allAssistant).toBe(1);

		// Sanity: bAssistantText should also appear (not strictly required for the
		// assertion, but ensures fixture text was actually emitted)
		expect(bAssistantText).toContain("Hello from mock model");
	});
});
