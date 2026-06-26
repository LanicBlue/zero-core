// E2E: fresh-DB seed (v0.8 P6)
//
// Launches Electron without ZERO_CORE_TEST_FIXTURE so the static test seed does
// not run. This verifies the real fresh-db startup path plants the built-in
// zero agent before sessions are restored.
import { test, expect } from "@playwright/test";
import { launchAppFresh, waitForAppReady } from "./helpers/test-app.js";

test.describe("P6 fresh-DB seed (Electron startup)", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchAppFresh>>["window"];

	test.beforeEach(async () => {
		const app = await launchAppFresh();
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	test("fresh DB startup seeds the zero agent in the chat selector", async () => {
		// waitForAppReady already opened the Chat page and populated the agent
		// selector. launchAppFresh intentionally avoids ZERO_CORE_TEST_FIXTURE,
		// so the only seeded agent should come from seedFreshDbDefaults.
		const options = window.locator(".chat-agent-select option[value]:not([value=''])");
		const count = await options.count();
		expect(count).toBeGreaterThanOrEqual(1);

		const labels: string[] = [];
		for (let i = 0; i < count; i++) {
			labels.push((await options.nth(i).innerText()).trim());
		}
		expect(labels.some((l) => /zero/i.test(l)), `expected 'zero' in selector, got: ${labels.join(", ")}`).toBe(true);
		expect(labels.some((l) => /TestAgent/.test(l)), `fresh launcher should not run test seed, got: ${labels.join(", ")}`).toBe(false);
	});
});
