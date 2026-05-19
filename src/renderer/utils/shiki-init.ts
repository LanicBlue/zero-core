import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;
let initPromise: Promise<void> | null = null;

export function initShiki(): Promise<void> {
	if (highlighter) return Promise.resolve();
	if (initPromise) return initPromise;

	initPromise = createHighlighter({
		themes: ["github-dark", "github-light"],
		langs: [
			"typescript", "javascript", "python", "rust", "go", "java",
			"css", "html", "json", "yaml", "bash", "sql",
			"markdown", "diff", "jsx", "tsx",
		],
	}).then((h) => {
		highlighter = h;
	});

	return initPromise;
}

export function getShiki(): Highlighter {
	if (!highlighter) throw new Error("Shiki not initialized");
	return highlighter;
}

export function isShikiReady(): boolean {
	return highlighter !== null;
}
