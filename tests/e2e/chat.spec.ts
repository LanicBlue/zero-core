// E2E 测试：基础聊天功能
//
// # 文件说明书
//
// ## 核心功能
// 验证发送单条消息后渲染进程正确显示一条用户气泡和一条助手气泡
//
// ## 输入
// simple-response.json fixture（mock provider 响应）
//
// ## 输出
// Playwright 测试用例：send message produces one user and one assistant bubble
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证核心聊天流程
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady、selectTestAgent、sendChatMessage）
//
// ## 维护规则
// fixture 内容变更需同步更新断言中的期望文本
// 测试需在 mock provider 模式下运行
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Chat smoke", () => {
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

	test("send message produces one user and one assistant bubble", async () => {
		const userText = "hi";
		await sendChatMessage(window, userText);

		// Verify exactly one user bubble containing the typed text
		const userBubbles = window.locator(".message.message-user");
		await expect(userBubbles).toHaveCount(1);
		await expect(userBubbles).toContainText(userText);

		// Verify exactly one assistant bubble containing fixture content
		const assistantBubbles = window.locator(".message.message-assistant");
		await expect(assistantBubbles).toHaveCount(1);
		await expect(assistantBubbles).toContainText("Hello from mock model");
		await expect(assistantBubbles).toContainText("Streaming works.");
	});
});
