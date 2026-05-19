import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			lib: {
				entry: resolve("src/main/index.ts"),
				formats: ["cjs"],
				fileName: () => "index.js",
			},
			rollupOptions: {
				external: ["electron"],
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			lib: {
				entry: resolve("src/preload/index.ts"),
				formats: ["cjs"],
				fileName: () => "index.js",
			},
		},
	},
	renderer: {
		plugins: [react()],
		resolve: {
			alias: {
				"@renderer": resolve("src/renderer"),
			},
		},
	},
});
