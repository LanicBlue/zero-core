import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { LogEntry, LogFileSummary } from "../../shared/types.js";
import type { FileLogConfig } from "../../core/file-log-sink.js";

const LOG_DIR = () => {
	const { ZERO_CORE_DIR } = require("../../core/config.js") as typeof import("../../core/config.js");
	return join(ZERO_CORE_DIR, "logs");
};

const LOG_LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[(DEBUG|INFO |WARN |ERROR)\]\s+\[([^\]]+)\]\s+(.*)$/;

function parseLogLine(line: string): LogEntry | null {
	const m = LOG_LINE_RE.exec(line);
	if (!m) return null;
	return {
		timestamp: m[1],
		level: m[2].trim().toLowerCase() as LogEntry["level"],
		module: m[3].trim(),
		message: m[4],
	};
}

export function registerLogHandlers(ctx: IpcContext): void {
	typedHandle("logs:list-files", [],
		() => {
			try {
				const dir = LOG_DIR();
				const files = readdirSync(dir)
					.filter((f) => f.endsWith(".log"))
					.sort()
					.reverse();
				return files.map((f) => {
					const stat = statSync(join(dir, f));
					return {
						filename: f,
						size: stat.size,
						date: f.replace(".log", ""),
					} as LogFileSummary;
				});
			} catch {
				return [];
			}
		},
	);

	typedHandle("logs:read", [],
		(_ctx, filename, opts) => {
			if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
				return [];
			}
			if (!filename.endsWith(".log")) filename += ".log";

			try {
				const dir = LOG_DIR();
				const content = readFileSync(join(dir, filename), "utf-8");
				let lines = content.split("\n").filter(Boolean);

				if (opts?.level && opts.level !== "all") {
					const levelUpper = opts.level.toUpperCase();
					lines = lines.filter((l) => l.includes(`[${levelUpper}]`));
				}

				const count = Math.min(opts?.lines ?? 200, 500);
				const selected = lines.slice(-count);

				return selected
					.map(parseLogLine)
					.filter((e): e is LogEntry => e !== null);
			} catch {
				return [];
			}
		},
	);

	typedHandle("logs:get-config", "sessionDb",
		async (_ctx) => {
			const kv = _ctx.sessionDb.getKVStore();
			return kv.getJson<FileLogConfig>("log_config") ?? { enabled: true, retentionDays: 7, globalLevel: "debug" as const };
		},
	);

	typedHandle("logs:set-config", "sessionDb",
		async (_ctx, config) => {
			_ctx.sessionDb.getKVStore().setJson("log_config", config);
			const { configureLogging } = require("../../core/logger.js") as typeof import("../../core/logger.js");
			configureLogging(config);
		},
	);
}
