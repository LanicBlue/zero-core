// Temp vitest config for the 2A spike. Lets vitest discover tests/spike/**.
// Not the project config; deleted with the spike if it gets cleaned up.
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/spike/**/*.test.ts"],
		environment: "node",
		pool: "forks",
	},
});
