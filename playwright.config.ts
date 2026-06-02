import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 60_000,
	expect: { timeout: 10_000 },
	// Electron app holds state; parallel runs would fight over the same temp dir / window
	fullyParallel: false,
	workers: 1,
	reporter: process.env.CI ? "line" : "list",
	use: {
		actionTimeout: 10_000,
		trace: "retain-on-failure",
	},
});
