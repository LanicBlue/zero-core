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
