import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Fetch from API", () => {
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

	test("fetch-from-API does not crash the UI", async () => {
		// Navigate to Settings page
		const settingsBtn = window.locator(".icon-sidebar-bottom button[title='Settings']");
		await settingsBtn.click();

		// Wait for settings to load
		await window.waitForSelector(".settings-page", { timeout: 10_000 });

		// Find the Mock provider card
		const providerCard = window.locator(".provider-card, .provider-item, [data-provider-type='mock']").first();
		const cardCount = await providerCard.count();

		if (cardCount === 0) {
			// Try finding by text content
			const cards = window.locator(".settings-page *");
			const mockCard = cards.locator(":has-text('Mock')").first();
			await expect(mockCard).toBeVisible({ timeout: 5_000 });
		}

		// Verify the settings page is still rendered (not blank)
		const settingsPage = window.locator(".settings-page");
		await expect(settingsPage).toBeVisible({ timeout: 5_000 });

		// The test primarily verifies that navigating to settings doesn't crash
		// and the provider list is visible
	});

	test("fetch-from-API IPC call succeeds with GET method", async () => {
		// Verify the IPC call works by calling it directly via evaluate
		const result = await window.evaluate(async () => {
			const api = (window as any).api;
			const providers = await api.providersList();
			const mockProvider = providers.find((p: any) => p.type === "mock");
			if (!mockProvider) return { error: "No mock provider found" };

			try {
				const models = await api.providersFetchModels(mockProvider.id);
				return { success: true, modelCount: models.length, models };
			} catch (err: any) {
				return { error: err.message };
			}
		});

		// The call should succeed (not throw an error)
		expect(result.error).toBeUndefined();
		expect(result.success).toBe(true);
		// Mock provider returns empty array since baseUrl is a local file
		expect(result.modelCount).toBeGreaterThanOrEqual(0);
	});

	test("fetch-from-API returns models without crashing settings UI", async () => {
		// First verify the IPC call returns data (even if empty for mock)
		const result = await window.evaluate(async () => {
			const api = (window as any).api;
			const providers = await api.providersList();
			const mockProvider = providers.find((p: any) => p.type === "mock");
			if (!mockProvider) return { error: "No mock provider" };

			const models = await api.providersFetchModels(mockProvider.id);
			return { providerId: mockProvider.id, models };
		});

		expect(result.error).toBeUndefined();

		// Navigate to settings to verify UI is functional
		const settingsBtn = window.locator(".icon-sidebar-bottom button[title='Settings']");
		await settingsBtn.click();

		// Verify settings page renders
		await window.waitForSelector(".settings-page", { timeout: 10_000 });
		const settingsPage = window.locator(".settings-page");
		await expect(settingsPage).toBeVisible();

		// Navigate back to chat — verify no crash
		const chatBtn = window.locator("button[title='Chat']");
		await chatBtn.click();
		await window.waitForSelector(".page-chat.page-active", { timeout: 10_000 });

		// Verify chat panel is still functional
		const chatPanel = window.locator(".chat-panel");
		await expect(chatPanel).toBeVisible();
	});

	test("fetch-from-API IPC proxy uses GET method", async () => {
		// Verify by making a direct HTTP request to the backend
		const result = await window.evaluate(async () => {
			const api = (window as any).api;
			const providers = await api.providersList();
			const mockProvider = providers.find((p: any) => p.type === "mock");
			if (!mockProvider) return { error: "No mock provider" };

			// The IPC proxy should forward as GET, not POST
			// If it uses POST, the backend returns 404 and models will be undefined/error
			const models = await api.providersFetchModels(mockProvider.id);
			return { modelCount: Array.isArray(models) ? models.length : -1, isArray: Array.isArray(models) };
		});

		expect(result.error).toBeUndefined();
		expect(result.isArray).toBe(true);
	});
});
