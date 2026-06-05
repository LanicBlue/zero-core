// ---------------------------------------------------------------------------
// Shared constants — single source of truth for magic numbers and default URLs.
//
// # 文件说明书
//
// ## 核心功能
// 定义项目共享常量，包括限制值、默认 URL 和配置值。
//
// ## 输入
// 无 - 常量定义文件。
//
// ## 输出
// - EXEC_MAX_BUFFER_BYTES - 进程缓冲区大小
// - OUTPUT_TRUNCATION_CHARS - 输出截断字符数
// - DEFAULT_URLS - 默认服务 URL
// - DEV_SERVER_URL - 开发服务器 URL
//
// ## 定位
// 全局常量定义，被整个项目引用。
//
// ## 依赖
// 无
//
// ## 维护规则
// - 新增常量时需添加注释说明用途
// - 保持常量命名语义化
//
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
