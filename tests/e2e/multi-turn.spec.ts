// E2E 测试：多轮对话
//
// # 文件说明书
//
// ## 核心功能
// 验证连续发送三条消息后渲染进程正确显示三对用户/助手气泡且顺序正确
//
// ## 输入
// multi-turn-response.json fixture（mock provider 多轮响应）
//
// ## 输出
// Playwright 测试用例：three consecutive messages produce three user and three assistant bubbles
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证多轮对话流程
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady、selectTestAgent、sendChatMessage）
//
// ## 维护规则
// fixture 内容变更需同步更新断言中的期望气泡数量
// 消息顺序断言依赖 DOM 顺序，布局变更需检查 nth 选择器
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/multi-turn-response.json");

test.describe("Multi-turn chat", () => {
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

	test("three consecutive messages produce three user and three assistant bubbles", async () => {
		await sendChatMessage(window, "first");
		await expect(window.locator(".message.message-user")).toHaveCount(1);
		await expect(window.locator(".message.message-assistant")).toHaveCount(1);

		await sendChatMessage(window, "second");
		await expect(window.locator(".message.message-user")).toHaveCount(2);
		await expect(window.locator(".message.message-assistant")).toHaveCount(2);

		await sendChatMessage(window, "third");
		await expect(window.locator(".message.message-user")).toHaveCount(3);
		await expect(window.locator(".message.message-assistant")).toHaveCount(3);

		// Verify order: user/assistant pairs appear in sequence
		const allMessages = window.locator(".message");
		await expect(allMessages.nth(0)).toHaveClass(/message-user/);
		await expect(allMessages.nth(1)).toHaveClass(/message-assistant/);
		await expect(allMessages.nth(2)).toHaveClass(/message-user/);
		await expect(allMessages.nth(3)).toHaveClass(/message-assistant/);
		await expect(allMessages.nth(4)).toHaveClass(/message-user/);
		await expect(allMessages.nth(5)).toHaveClass(/message-assistant/);
	});
});
