import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ZERO_CORE_DIR } from "./config.js";

// ---------------------------------------------------------------------------
// File log sink — writes structured log lines to daily log files
// Format: <ISO timestamp> [<LEVEL>] [<module>] <message> <args>
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface FileLogConfig {
	enabled: boolean;
	retentionDays: number;
	globalLevel: LogLevel;
}

interface LogPayload {
	level: LogLevel;
	module: string;
	message: string;
	args: unknown[];
}

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const LEVEL_PAD: Record<LogLevel, string> = {
	debug: "DEBUG",
	info: "INFO ",
	warn: "WARN ",
	error: "ERROR",
};

const DEFAULT_CONFIG: FileLogConfig = {
	enabled: true,
	retentionDays: 7,
	globalLevel: "debug",
};

export function createFileLogSink(initialConfig?: Partial<FileLogConfig>): {
	sink: (payload: LogPayload) => void;
	updateConfig: (config: FileLogConfig) => void;
} {
	let config: FileLogConfig = { ...DEFAULT_CONFIG, ...initialConfig };
	let currentDate = "";
	let logDir: string | undefined;

	function getLogDir(): string {
		if (!logDir) {
			logDir = join(ZERO_CORE_DIR, "logs");
			if (!existsSync(logDir)) {
				mkdirSync(logDir, { recursive: true });
			}
		}
		return logDir;
	}

	function formatLine(payload: LogPayload): string {
		const ts = new Date().toISOString();
		const level = LEVEL_PAD[payload.level];
		const mod = payload.module.padEnd(7);
		const msg = payload.args.length > 0
			? `${payload.message} ${payload.args.map(String).join(" ")}`
			: payload.message;
		return `${ts} [${level}] [${mod}] ${msg}\n`;
	}

	function rotateIfNeeded(today: string): void {
		if (today === currentDate) return;
		currentDate = today;

		const dir = getLogDir();
		try {
			const files = readdirSync(dir).filter((f) => f.endsWith(".log"));
			const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
			for (const f of files) {
				const stat = statSync(join(dir, f));
				if (stat.mtimeMs < cutoff) {
					try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	}

	function sink(payload: LogPayload): void {
		if (!config.enabled) return;
		if (LEVEL_ORDER[payload.level] < LEVEL_ORDER[config.globalLevel]) return;

		const today = new Date().toISOString().slice(0, 10);
		rotateIfNeeded(today);

		const filePath = join(getLogDir(), `${today}.log`);
		const line = formatLine(payload);

		try {
			appendFileSync(filePath, line, "utf8");
		} catch { /* silently fail — file logging is best-effort */ }
	}

	function updateConfig(newConfig: FileLogConfig): void {
		config = newConfig;
	}

	return { sink, updateConfig };
}
