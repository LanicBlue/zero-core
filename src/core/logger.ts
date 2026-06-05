// ---------------------------------------------------------------------------
// Logger — debug mode vs production mode, console + file dual sink
//
// # 文件说明书
//
// ## 核心功能
// 提供分级日志功能，支持控制台和文件双输出。
//
// ## 输入
// - ZERO_CORE_DEBUG 环境变量
// - configureLogging() 配置
//
// ## 输出
// - log 对象（agent, debug, info, warn, error 方法）
// - 日志文件写入
//
// ## 定位
// 全局日志模块，被整个项目使用。
//
// ## 依赖
// - ./file-log-sink - 文件日志
//
// ## 维护规则
// - 新增日志类别时需更新类型定义
// - 保持日志格式一致
//
// Debug mode:  set ZERO_CORE_DEBUG=1 or --debug flag
// Production:  only warn/error level logs
//
// File sink:   writes to {ZERO_CORE_DIR}/logs/YYYY-MM-DD.log
//              always enabled, configurable via configureLogging()
//
// Usage:
//   import { log } from "../core/logger.js";
//   log.agent("Sending prompt:", text);
//   log.debug("loop", "Stream event:", event.type);
// ---------------------------------------------------------------------------

import { createFileLogSink, type FileLogConfig } from "./file-log-sink.js";

const DEBUG = !!(
	process.env.ZERO_CORE_DEBUG === "1" ||
	process.argv.includes("--debug")
);

type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogPayload {
	level: LogLevel;
	module: string;
	message: string;
	args: unknown[];
}

const formatters = new Map<string, (payload: LogPayload) => string>();

// ─── File sink ──────────────────────────────────────────────────────────

const fileLog = createFileLogSink();

// ─── Console sink ───────────────────────────────────────────────────────

const consoleSink = (payload: LogPayload) => {
	const ts = new Date().toISOString().slice(11, 23);
	const fmt = formatters.get(payload.module);
	const prefix = fmt
		? fmt(payload)
		: `[${ts} ${payload.module}] ${payload.message}`;

	switch (payload.level) {
		case "error":
			console.error(prefix, ...payload.args);
			break;
		case "warn":
			console.warn(prefix, ...payload.args);
			break;
		default:
			console.log(prefix, ...payload.args);
	}
};

// ─── Combined sink ──────────────────────────────────────────────────────

let logSink: (payload: LogPayload) => void = (payload) => {
	consoleSink(payload);
	fileLog.sink(payload);
};

function emit(level: LogLevel, module: string, message: string, args: unknown[]) {
	if (level === "debug" && !DEBUG) return;
	logSink({ level, module, message, args });
}

export const log = {
	// Module-specific shortcuts
	agent: (...args: unknown[]) => emit("info", "agent", String(args[0]), args.slice(1)),
	loop: (...args: unknown[]) => emit("info", "loop", String(args[0]), args.slice(1)),
	ipc: (...args: unknown[]) => emit("info", "ipc", String(args[0]), args.slice(1)),
	db: (...args: unknown[]) => emit("info", "db", String(args[0]), args.slice(1)),
	tool: (...args: unknown[]) => emit("info", "tool", String(args[0]), args.slice(1)),
	mcp: (...args: unknown[]) => emit("info", "mcp", String(args[0]), args.slice(1)),
	provider: (...args: unknown[]) => emit("info", "provider", String(args[0]), args.slice(1)),
	session: (...args: unknown[]) => emit("info", "session", String(args[0]), args.slice(1)),

	// General purpose (only shown in debug mode)
	debug: (module: string, ...args: unknown[]) => emit("debug", module, String(args[0]), args.slice(1)),

	// Always shown
	warn: (module: string, ...args: unknown[]) => emit("warn", module, String(args[0]), args.slice(1)),
	error: (module: string, ...args: unknown[]) => emit("error", module, String(args[0]), args.slice(1)),

	// Query
	isDebug: () => DEBUG,
};

// ─── Runtime configuration ──────────────────────────────────────────────

export function configureLogging(config: FileLogConfig): void {
	fileLog.updateConfig(config);
}
