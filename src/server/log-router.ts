// 日志查看与运行时日志配置 REST 入口
//
// # 文件说明书
//
// ## 核心功能
// 列出 logs 目录中的日志文件、按级别过滤读取最近的日志行,并提供日志开关/保留天数的读写配置端点;配置写入会即时调用 configureLogging 应用到运行时日志器。
//
// ## 输入
// - GET /files 无参数
// - GET /read query: { filename, level?, lines? }
// - GET /config、PUT /config 请求体为 FileLogConfig { enabled, retentionDays, globalLevel }
// - 注入 sessionDb(从其 KVStore 读写 log_config)
//
// ## 输出
// - /files 返回 LogFileSummary[]
// - /read 返回解析后的 LogEntry[]
// - /config 返回当前 FileLogConfig,PUT 返回 { success: true }
//
// ## 定位
// src/server/ 服务层,挂载于 /api/logs,服务于渲染进程的日志查看面板与设置页日志开关。
//
// ## 依赖
// - express Router、node:fs、node:path
// - ../core/config(ZERO_CORE_DIR)、../core/logger(configureLogging)、../core/file-log-sink 类型
// - ../shared/types(LogEntry、LogFileSummary)
//
// ## 维护规则
// - filename 解析时禁止包含 `..` / `/` / `\`,防止越权读取 logs 目录外的文件。
// - 日志行解析依赖固定正则 LOG_LINE_RE;日志器格式调整需同步更新此正则。
// - 新增运行时可配置项时,需同时更新 FileLogConfig 类型与 configureLogging。
//

import { Router } from "express";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ZERO_CORE_DIR } from "../core/config.js";
import { configureLogging } from "../core/logger.js";
import type { LogEntry, LogFileSummary } from "../shared/types.js";
import type { FileLogConfig } from "../core/file-log-sink.js";

const LOG_DIR = join(ZERO_CORE_DIR, "logs");
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

export function createLogRouter(deps: { sessionDb: any }): Router {
	const router = Router();

	router.get("/files", (_req, res) => {
		try {
			const files = readdirSync(LOG_DIR)
				.filter((f) => f.endsWith(".log"))
				.sort()
				.reverse();
			res.json(files.map((f) => {
				const stat = statSync(join(LOG_DIR, f));
				return { filename: f, size: stat.size, date: f.replace(".log", "") } as LogFileSummary;
			}));
		} catch {
			res.json([]);
		}
	});

	router.get("/read", (req, res) => {
		let filename = req.query.filename as string;
		const level = req.query.level as string | undefined;
		const lines = parseInt(req.query.lines as string) || 200;

		if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
			res.json([]);
			return;
		}
		if (!filename.endsWith(".log")) filename += ".log";

		try {
			const content = readFileSync(join(LOG_DIR, filename), "utf-8");
			let logLines = content.split("\n").filter(Boolean);

			if (level && level !== "all") {
				const levelUpper = level.toUpperCase();
				logLines = logLines.filter((l) => l.includes(`[${levelUpper}]`));
			}

			const count = Math.min(lines, 500);
			res.json(logLines.slice(-count).map(parseLogLine).filter((e): e is LogEntry => e !== null));
		} catch {
			res.json([]);
		}
	});

	router.get("/config", (_req, res) => {
		const kv: import("../core/kv-store-interface.js").IKVStore = deps.sessionDb.getKVStore();
		res.json(kv.getJson<FileLogConfig>("log_config") ?? { enabled: true, retentionDays: 7, globalLevel: "debug" as const });
	});

	router.put("/config", (req, res) => {
		deps.sessionDb.getKVStore().setJson("log_config", req.body);
		configureLogging(req.body);
		res.json({ success: true });
	});

	return router;
}
