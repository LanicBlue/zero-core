// ---------------------------------------------------------------------------
// Logger — debug mode vs production mode
// ---------------------------------------------------------------------------
//
// Debug mode:  set ZERO_CORE_DEBUG=1 or --debug flag
// Production:  only warn/error level logs
//
// Usage:
//   import { log } from "../core/logger.js";
//   log.agent("Sending prompt:", text);
//   log.debug("loop", "Stream event:", event.type);
// ---------------------------------------------------------------------------

const DEBUG = !!(
	process.env.ZERO_CORE_DEBUG === "1" ||
	process.argv.includes("--debug")
);

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogPayload {
	level: LogLevel;
	module: string;
	message: string;
	args: unknown[];
}

const formatters = new Map<string, (payload: LogPayload) => string>();

let logSink: (payload: LogPayload) => void = (payload) => {
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
