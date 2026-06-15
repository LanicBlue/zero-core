// E2E 测试：流式输出中切换 session 后切回，验证消息恢复
//
// # 文件说明书
//
// ## 核心功能
// 验证 Agent 正在流式输出时切换到另一个 session、在 B session 发送消息、再通过 sessions 下拉切回原 A session 后，A 的流式内容不丢失；断言 A 的用户气泡、助手气泡及多分块文本「Part one ... Final」均完整存在
//
// ## 输入
// multi-chunk-slow.json fixture（流式输出 Part one. Part two. Part three. Final.）
//
// ## 输出
// Playwright 测试用例：监测 .chat-panel[data-session-id] 切换、.session-item 列表、.message.message-user/assistant 数量与文本
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证 session 切换中的流式输出保持与恢复
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady、selectTestAgent）
//
// ## 维护规则
// fixture 分块文本变更需同步更新「Part one」「Final」断言
// session 切换 UI（btn-new-session / btn-sessions / session-item）变更需更新选择器
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SLOW_FIXTURE = resolve(__dirname, "fixtures/multi-chunk-slow.json");

test.describe("Session streaming restore", () => {
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

	test("switching sessions mid-stream preserves output on return", async () => {
		// 1. Get the current session ID (Session A)
		const sessionAId = await window.locator(".chat-panel").getAttribute("data-session-id");
		expect(sessionAId).toBeTruthy();

		// 2. Send a message but do NOT wait for streaming to complete
		await window.locator(".chat-input-bar textarea").fill("streaming test");
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();

		// Wait for streaming to start
		await window.waitForSelector(".cursor-blink", { timeout: 5_000, state: "attached" });

		// 3. Create a new session (Session B) while Session A is still streaming
		await window.locator("button.btn-new-session").click();
		// Wait for the new session to activate (data-session-id changes)
		await window.waitForFunction(
			(oldId) => document.querySelector(".chat-panel")?.getAttribute("data-session-id") !== oldId,
			sessionAId,
			{ timeout: 5_000 }
		);

		const sessionBId = await window.locator(".chat-panel").getAttribute("data-session-id");
		expect(sessionBId).not.toBe(sessionAId);

		// Send a message in Session B
		await window.locator(".chat-input-bar textarea").fill("session B msg");
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();
		await window.waitForSelector(".cursor-blink", { timeout: 30_000, state: "detached" });

		// 4. Switch back to Session A via the session dropdown
		await window.locator("button.btn-sessions").click();
		// Find the session item that is NOT active (= Session A)
		const sessionItems = window.locator(".session-item");
		await expect(sessionItems).toHaveCount(2);

		// Click the non-active session (Session A)
		const inactiveSession = window.locator(".session-item:not(.active) .session-item-label");
		await inactiveSession.click();

		// Wait for session to switch
		await window.waitForFunction(
			(targetId) => document.querySelector(".chat-panel")?.getAttribute("data-session-id") === targetId,
			sessionAId,
			{ timeout: 5_000 }
		);

		// 5. Verify the original user message from Session A is still there
		const userMessages = window.locator(".message.message-user");
		await expect(userMessages).toHaveCount(1);
		await expect(userMessages).toContainText("streaming test");

		// 6. Verify the assistant response is present
		const assistantMessages = window.locator(".message.message-assistant");
		await expect(assistantMessages).toHaveCount(1);
		// The multi-chunk-slow fixture outputs: "Part one. Part two. Part three. Final."
		await expect(assistantMessages).toContainText("Part one");
		await expect(assistantMessages).toContainText("Final");
	});
});
