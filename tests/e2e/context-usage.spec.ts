import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Context usage indicator", () => {
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

	test("context usage indicator appears after sending a message", async () => {
		await sendChatMessage(window, "hello");

		const contextUsage = window.locator(".context-usage");
		await expect(contextUsage).toBeVisible({ timeout: 10_000 });

		const text = window.locator(".context-usage-text");
		await expect(text).toBeVisible();
		const content = await text.textContent();
		expect(content).toMatch(/\d+[KMG]?\s*\/\s*\d+[KMG]?/);

		const bar = window.locator(".context-usage-bar");
		await expect(bar).toBeVisible();

		const fill = window.locator(".context-usage-fill");
		await expect(fill).toBeVisible();
		const width = await fill.evaluate((el) => el.style.width);
		expect(parseFloat(width)).toBeGreaterThanOrEqual(0);
		expect(parseFloat(width)).toBeLessThanOrEqual(100);
	});

	test("context usage text shows 128K window for mock provider", async () => {
		await sendChatMessage(window, "test context");

		const text = window.locator(".context-usage-text");
		await expect(text).toBeVisible({ timeout: 10_000 });
		await expect(text).toContainText("128K");
	});

	test("context usage bar is green when usage is low", async () => {
		await sendChatMessage(window, "short message");

		const fill = window.locator(".context-usage-fill");
		await expect(fill).toBeVisible({ timeout: 10_000 });
		const bg = await fill.evaluate((el) => el.style.background);
		expect(bg).toMatch(/7ee787|success|green/i);
	});

	test("context usage is visible on startup with restored session", async () => {
		// After architecture fix, context info is always shown from runtime
		const contextUsage = window.locator(".context-usage");
		await expect(contextUsage).toBeVisible({ timeout: 5_000 });
	});

	test("context usage persists across multiple messages", async () => {
		await sendChatMessage(window, "first");
		await expect(window.locator(".context-usage")).toBeVisible({ timeout: 10_000 });

		await sendChatMessage(window, "second");
		await expect(window.locator(".context-usage")).toBeVisible({ timeout: 10_000 });

		const text = await window.locator(".context-usage-text").textContent();
		expect(text).toMatch(/\d+[KMG]?\s*\/\s*\d+[KMG]?/);
	});
});
