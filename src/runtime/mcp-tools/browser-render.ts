// ---------------------------------------------------------------------------
// Browser-based page rendering for SPA sites.
// Uses Electron BrowserWindow with persist:webfetch session so login cookies
// are automatically available — no manual cookie injection needed.
// ---------------------------------------------------------------------------

import { BrowserWindow, session } from "electron";

export interface RenderResult {
	html: string;
	title: string;
	finalUrl: string;
}

export interface RenderOptions {
	/** Seconds to wait after page load for JS to finish rendering (default: 3) */
	renderDelay?: number;
	/** Total timeout in seconds including page load (default: 30) */
	timeout?: number;
}

export async function renderWithBrowser(
	url: string,
	opts?: RenderOptions,
): Promise<RenderResult> {
	const renderDelay = opts?.renderDelay ?? 3;
	const timeout = opts?.timeout ?? 30;

	const ses = session.fromPartition("persist:webfetch");

	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		show: false,
		webPreferences: {
			partition: "persist:webfetch",
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	try {
		// Load page with timeout
		const loaded = await Promise.race([
			win.loadURL(url),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`Page load timed out after ${timeout}s`)), timeout * 1000),
			),
		]);

		// Wait for JS to render content
		await new Promise((resolve) => setTimeout(resolve, renderDelay * 1000));

		// Extract rendered HTML
		const html = await win.webContents.executeJavaScript(
			"document.documentElement.outerHTML",
		);
		const title = await win.webContents.executeJavaScript("document.title");
		const finalUrl = win.webContents.getURL();

		return { html, title, finalUrl };
	} finally {
		if (!win.isDestroyed()) win.close();
	}
}
