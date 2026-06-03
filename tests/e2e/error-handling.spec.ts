import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ERROR_FIXTURE = resolve(__dirname, "fixtures/error-response.json");

test.describe("Error handling", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.afterEach(async () => {
		await cleanup();
	});

	test("error banner appears when first message fails", async () => {
		const app = await launchApp(ERROR_FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);

		await window.locator(".chat-input-bar textarea").fill("trigger error");
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();

		const banner = window.locator(".error-banner");
		await expect(banner).toBeVisible({ timeout: 20_000 });
	});

	test("error banner can be dismissed by clicking close button", async () => {
		const app = await launchApp(ERROR_FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);

		await window.locator(".chat-input-bar textarea").fill("trigger error");
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();

		const banner = window.locator(".error-banner");
		await expect(banner).toBeVisible({ timeout: 20_000 });

		await banner.locator(".error-banner-close").click();
		await expect(banner).not.toBeVisible();
	});

	test("error banner auto-dismisses after 5 seconds", async () => {
		const app = await launchApp(ERROR_FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);

		await window.locator(".chat-input-bar textarea").fill("trigger error");
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();

		const banner = window.locator(".error-banner");
		await expect(banner).toBeVisible({ timeout: 20_000 });

		await expect(banner).not.toBeVisible({ timeout: 8_000 });
	});
});
