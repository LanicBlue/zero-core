import type { ExposedAPI } from "../preload/index.js";

declare global {
	interface Window {
		api: ExposedAPI;
	}
}
