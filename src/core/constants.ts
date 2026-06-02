// ---------------------------------------------------------------------------
// Shared constants — single source of truth for magic numbers and default URLs.
// ---------------------------------------------------------------------------

// ── Process / IO limits ────────────────────────────────────────────────────

/** Max stdout/stderr buffer size for child processes (10 MB). */
export const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Truncate tool / shell output longer than this many characters. */
export const OUTPUT_TRUNCATION_CHARS = 50_000;

// ── Default service URLs ───────────────────────────────────────────────────

export const DEFAULT_URLS = {
	/** Ollama local server (https://ollama.com). */
	ollama: "http://localhost:11434",
	/** SearXNG meta-search instance (https://docs.searxng.org). */
	searxng: "http://localhost:8080",
	/** OpenAI API endpoint used as fallback when provider has no baseUrl. */
	openai: "https://api.openai.com/v1",
} as const;

// ── Dev server ─────────────────────────────────────────────────────────────

/** Vite dev server URL — only used in dev mode (NODE_ENV=development). */
export const DEV_SERVER_URL = "http://localhost:5173";
