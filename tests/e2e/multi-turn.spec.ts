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
