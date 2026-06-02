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
