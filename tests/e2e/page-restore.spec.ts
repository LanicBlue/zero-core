// E2E 测试：页面切换后消息恢复
//
// 验证用户从 Chat 页面导航到其他页面再切回后，对话内容能正确恢复。
// 包含 Agent 运行中切页和 Agent 完成后切回两种核心场景。

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
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();

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
