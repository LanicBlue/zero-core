// E2E 测试：页面切换后消息恢复
//
// # 文件说明书
//
// ## 核心功能
// 验证用户从 Chat 页面导航到其他页面再切回后，对话内容能正确恢复；覆盖 Agent 已完成后切页恢复，以及 Agent 流式输出进行中切到 Settings 等后台流式完成后再切回 Chat 的恢复场景
//
// ## 输入
// simple-response.json（普通响应）与 slow-response.json（带「Starting... still running... done.」分块慢响应）fixture
//
// ## 输出
// Playwright 测试用例：断言切页前后 .message.message-user / .message.message-assistant 数量与文本一致，并等待 .cursor-blink detached
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证 Chat 页面挂载/卸载后的消息持久化与流式后台续跑
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady、selectTestAgent、sendChatMessage）
//
// ## 维护规则
// fixture 文本变更需同步更新「Hello from mock model」「Starting」「done」等断言
// Chat 页面挂载策略（visibility:hidden vs unmount）变更需重新评估后台流式续跑测试
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");
const SLOW_FIXTURE = resolve(__dirname, "fixtures/slow-response.json");

test.describe("Page restore", () => {
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

	test("messages persist after navigating away and back to Chat", async () => {
		await sendChatMessage(window, "hello");

		await expect(window.locator(".message.message-user")).toHaveCount(1);
		await expect(window.locator(".message.message-assistant")).toHaveCount(1);
		await expect(window.locator(".message.message-assistant")).toContainText("Hello from mock model");

		// Navigate away then back
		await window.locator("button[title='Settings']").click();
		await window.waitForSelector(".page-overlay", { timeout: 5000 });
		await window.locator("button[title='Chat']").click();
		await window.waitForSelector(".page-chat.page-active", { timeout: 5000 });

		// Messages should still be there
		await expect(window.locator(".message.message-user")).toHaveCount(1);
		await expect(window.locator(".message.message-user")).toContainText("hello");
		await expect(window.locator(".message.message-assistant")).toHaveCount(1);
		await expect(window.locator(".message.message-assistant")).toContainText("Hello from mock model");
	});
});

test.describe("Page restore — agent running in background", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(SLOW_FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	test("streaming continues in background and messages restore on return", async () => {
		// 1. Send message but do NOT wait for streaming to complete
		await window.locator(".chat-input-bar textarea").fill("hello bg");
		// round-3 review P1-1:统一 getByRole Send(旧 button:not(.btn-abort) 歧义 .btn-attach)。
		await window.getByRole("button", { name: "Send" }).click();

		// Wait for streaming to start (cursor-blink appears)
		await window.waitForSelector(".cursor-blink", { timeout: 5_000, state: "attached" });

		// 2. Navigate away WHILE agent is streaming
		await window.locator("button[title='Settings']").click();
		await window.waitForSelector(".page-overlay", { timeout: 5000 });

		// 3. Wait for streaming to complete in background (cursor-blink detached)
		// The chat panel is still mounted (visibility: hidden) so we can still observe it
		await window.waitForSelector(".cursor-blink", { timeout: 30_000, state: "detached" });

		// 4. Navigate back to Chat
		await window.locator("button[title='Chat']").click();
		await window.waitForSelector(".page-chat.page-active", { timeout: 5000 });

		// 5. Verify messages are fully restored
		const userBubbles = window.locator(".message.message-user");
		const assistantBubbles = window.locator(".message.message-assistant");

		await expect(userBubbles).toHaveCount(1);
		await expect(userBubbles).toContainText("hello bg");
		await expect(assistantBubbles).toHaveCount(1);
		// The slow fixture text: "Starting... still running... done."
		await expect(assistantBubbles).toContainText("Starting");
		await expect(assistantBubbles).toContainText("done");
	});
});
