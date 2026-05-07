import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	root: "src/renderer",
	server: {
		port: 5173,
		proxy: {
			"/api": "http://localhost:3210",
			"/ws": {
				target: "ws://localhost:3210",
				ws: true,
			},
		},
	},
	build: {
		outDir: "../../dist/renderer",
	},
});
