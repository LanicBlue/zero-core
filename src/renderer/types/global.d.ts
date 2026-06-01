import type { WindowApi } from "../../shared/preload-types.js";

declare global {
	interface Window {
		api: WindowApi;
	}
}
