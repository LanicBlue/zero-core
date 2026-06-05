// 日志查看器组件
//
// # 文件说明书
//
// ## 核心功能
// 实时显示应用日志，支持级别过滤和自动滚动
//
// ## 输入
// preload API 返回的日志数据
//
// ## 输出
// 日志列表 JSX（含级别筛选、自动滚动到底部）
//
// ## 定位
// src/renderer/components/common/ — 通用组件，为用户提供调试日志查看
//
// ## 依赖
// React、preload API
//
// ## 维护规则
// 日志级别变更需同步更新过滤器
//
import React, { useState, useEffect, useCallback, useRef } from "react";

const api = () => (window as any).api;

type LogLevel = "all" | "debug" | "info" | "warn" | "error";
const LEVELS: LogLevel[] = ["all", "debug", "info", "warn", "error"];
const LINE_OPTIONS = [50, 100, 200, 500];

interface LogFileSummary {
	filename: string;
	size: number;
	date: string;
}

interface LogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	module: string;
	message: string;
}

export default function LogViewer() {
	const [files, setFiles] = useState<LogFileSummary[]>([]);
	const [selectedFile, setSelectedFile] = useState<string>("");
	const [entries, setEntries] = useState<LogEntry[]>([]);
	const [level, setLevel] = useState<LogLevel>("all");
	const [lines, setLines] = useState(200);
	const [autoRefresh, setAutoRefresh] = useState(true);
	const bodyRef = useRef<HTMLDivElement>(null);
	const prevScrollTop = useRef(0);

	const today = new Date().toISOString().slice(0, 10) + ".log";

	const loadFiles = useCallback(async () => {
		try {
			const list: LogFileSummary[] = await api().logsListFiles();
			setFiles(list);
			if (!selectedFile && list.length > 0) {
				const latest = list[0].filename;
				setSelectedFile(latest);
			}
		} catch { /* ignore */ }
	}, [selectedFile]);

	const loadEntries = useCallback(async () => {
		if (!selectedFile) return;
		try {
			const data: LogEntry[] = await api().logsRead(selectedFile, {
				lines,
				level: level === "all" ? undefined : level,
			});
			setEntries(data);
		} catch { /* ignore */ }
	}, [selectedFile, lines, level]);

	useEffect(() => {
		loadFiles();
	}, []);

	useEffect(() => {
		loadEntries();
	}, [selectedFile, lines, level]);

	useEffect(() => {
		if (!autoRefresh || selectedFile !== today) return;
		const timer = setInterval(loadEntries, 5000);
		return () => clearInterval(timer);
	}, [autoRefresh, selectedFile, today, loadEntries]);

	const handleFileChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		setSelectedFile(e.target.value);
	};

	const formatTime = (ts: string) => {
		try {
			return new Date(ts).toLocaleTimeString();
		} catch {
			return ts;
		}
	};

	return (
		<>
			<div className="log-panel-header">
				<span>Logs</span>
				<button type="button" style={{ fontSize: 11 }} onClick={loadFiles}>Refresh</button>
			</div>
			<div className="log-toolbar">
				<select value={selectedFile} onChange={handleFileChange} className="log-file-select">
					{files.map((f) => (
						<option key={f.filename} value={f.filename}>
							{f.date} ({(f.size / 1024).toFixed(1)}KB)
						</option>
					))}
				</select>
				<div className="log-filter-group">
					{LEVELS.map((l) => (
						<button
							key={l}
							type="button"
							className={`log-filter-btn ${level === l ? "active" : ""}`}
							onClick={() => setLevel(l)}
						>
							{l === "all" ? "All" : l.charAt(0).toUpperCase() + l.slice(1)}
						</button>
					))}
				</div>
				<select value={lines} onChange={(e) => setLines(Number(e.target.value))} className="log-lines-select">
					{LINE_OPTIONS.map((n) => (
						<option key={n} value={n}>{n} lines</option>
					))}
				</select>
			</div>
			<div className="log-panel-body" ref={bodyRef}>
				{entries.length === 0 && (
					<div style={{ padding: "12px", color: "var(--fg-faint)" }}>No log entries</div>
				)}
				{entries.map((entry, i) => (
					<div key={i} className={`log-entry log-${entry.level}`}>
						<span className="log-time">{formatTime(entry.timestamp)}</span>
						<span className="log-module">[{entry.module}]</span>
						<span className="log-msg">{entry.message}</span>
					</div>
				))}
			</div>
		</>
	);
}
