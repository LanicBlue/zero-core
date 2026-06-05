// GitHub 模板导入弹窗组件
//
// # 文件说明书
//
// ## 核心功能
// 从 GitHub 仓库预览和导入 Agent 模板的弹窗组件
//
// ## 输入
// GitHub 仓库 URL
//
// ## 输出
// 导入的模板数据
//
// ## 定位
// src/renderer/components/agents/ — Agent 页面组件，支持远程模板导入
//
// ## 依赖
// React
//
// ## 维护规则
// GitHub API 限流需在 UI 中给出友好提示
//
import React, { useState, useEffect, useRef } from "react";

const DEFAULT_URL = "https://github.com/msitarzewski/agency-agents";

interface PreviewItem {
	name: string;
	description: string;
	icon: string;
	tag: string;
	path: string;
	exists: boolean;
}

interface Props {
	onClose: () => void;
	onPreview: (url: string, subdir?: string) => Promise<{ items: PreviewItem[]; sourceUrl: string; error?: string }>;
	onImport: (url: string, selectedPaths: string[]) => Promise<{ imported: number; updated: number; total: number; error?: string }>;
	onProgress: (cb: (p: { current: number; total: number }) => void) => () => void;
	onPreviewProgress?: (cb: (p: { current: number; total: number }) => void) => () => void;
}

export default function GithubImportModal({ onClose, onPreview, onImport, onProgress, onPreviewProgress }: Props) {
	const [url, setUrl] = useState(DEFAULT_URL);
	const [subdir, setSubdir] = useState("");
	const [phase, setPhase] = useState<"input" | "loading" | "select" | "importing" | "done">("input");
	const [items, setItems] = useState<PreviewItem[]>([]);
	const [sourceUrl, setSourceUrl] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState("");
	const [progress, setProgress] = useState({ current: 0, total: 0 });
	const [fetchProgress, setFetchProgress] = useState({ current: 0, total: 0 });
	const [result, setResult] = useState<{ imported: number; updated: number } | null>(null);
	const [error, setError] = useState("");
	const listRef = useRef<HTMLDivElement>(null);

	const unsubRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		return () => { unsubRef.current?.(); };
	}, []);

	const tags = [...new Set(items.map((i) => i.tag))].sort();

	const filtered = filter
		? items.filter((i) => i.tag === filter || i.name.toLowerCase().includes(filter.toLowerCase()))
		: items;

	const existingCount = items.filter((i) => i.exists).length;
	const selectedNewCount = [...selected].filter((p) => !items.find((i) => i.path === p)?.exists).length;
	const selectedUpdateCount = [...selected].filter((p) => items.find((i) => i.path === p)?.exists).length;

	const handlePreview = async () => {
		setPhase("loading");
		setError("");
		setFetchProgress({ current: 0, total: 0 });

		if (onPreviewProgress) {
			unsubRef.current = onPreviewProgress((p) => setFetchProgress(p));
		}

		try {
			const res = await onPreview(url, subdir.trim() || undefined);
			unsubRef.current?.();
			unsubRef.current = null;
			if (res.error) {
				setError(res.error);
				setPhase("input");
				return;
			}
			setItems(res.items);
			setSourceUrl(res.sourceUrl);
			const sel = new Set(res.items.filter((i) => i.exists).map((i) => i.path));
			setSelected(sel);
			setPhase("select");
		} catch (err: any) {
			unsubRef.current?.();
			unsubRef.current = null;
			setError(err.message || "Unknown error");
			setPhase("input");
		}
	};

	const toggleItem = (path: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	const selectAll = () => setSelected(new Set(filtered.map((i) => i.path)));
	const selectNone = () => setSelected(new Set());

	const handleImport = async () => {
		if (selected.size === 0) return;
		setPhase("importing");
		setProgress({ current: 0, total: selected.size });
		setError("");

		unsubRef.current = onProgress((p) => setProgress(p));

		try {
			const res = await onImport(sourceUrl, [...selected]);
			if (res.error) {
				setError(res.error);
				setPhase("select");
				return;
			}
			setResult({ imported: res.imported, updated: res.updated });
			setPhase("done");
		} catch (err: any) {
			setError(err.message || "Import failed");
			setPhase("select");
		} finally {
			unsubRef.current?.();
			unsubRef.current = null;
		}
	};

	return (
		<div className="modal-overlay">
			<div className="modal-content github-modal-wide" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<h3>Sync Templates from GitHub</h3>
					<button type="button" className="btn-ghost btn-sm" onClick={onClose}>X</button>
				</div>

				{(phase === "input" || phase === "loading") && (
					<div className="modal-body">
						<label>GitHub Repository URL
							<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={DEFAULT_URL} disabled={phase === "loading"} />
						</label>
						<label>Sub-directory (optional)
							<input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="e.g. engineering" disabled={phase === "loading"} />
						</label>
						{error && <p className="modal-error">{error}</p>}
						{phase === "loading" && (
							<div className="modal-fetch-progress">
								<p className="modal-info">
									{fetchProgress.total > 0
										? `Fetching templates... ${fetchProgress.current} / ${fetchProgress.total}`
										: "Scanning repository..."}
								</p>
								{fetchProgress.total > 0 && (
									<div className="progress-bar">
										<div className="progress-bar-fill" style={{ width: (fetchProgress.current / fetchProgress.total * 100) + "%" }} />
									</div>
								)}
							</div>
						)}
						<div className="modal-actions">
							<button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
							<button type="button" className="btn-primary" onClick={handlePreview} disabled={phase === "loading" || !url.trim()}>
								{phase === "loading" ? "Fetching..." : "Preview"}
							</button>
						</div>
					</div>
				)}

				{phase === "select" && (
					<div className="modal-body modal-body-tall">
						<p className="modal-info">
							Found {items.length} templates ({existingCount} imported).
							{selectedNewCount > 0 && ` Import ${selectedNewCount} new.`}
							{selectedUpdateCount > 0 && ` Update ${selectedUpdateCount} existing.`}
						</p>
						<div className="github-select-toolbar">
							<input className="template-search" placeholder="Filter by name or category..." value={filter} onChange={(e) => setFilter(e.target.value)} />
							<button type="button" className="btn-ghost btn-sm" onClick={selectAll}>All</button>
							<button type="button" className="btn-ghost btn-sm" onClick={selectNone}>None</button>
						</div>
						<div className="github-select-list" ref={listRef}>
							{filtered.map((item) => (
								<div key={item.path} className="github-select-item" onClick={() => toggleItem(item.path)}>
									<input type="checkbox" checked={selected.has(item.path)} onChange={() => toggleItem(item.path)} onClick={(e) => e.stopPropagation()} className="github-select-check" />
									<span className="github-select-icon">{item.icon || "📄"}</span>
									<div className="github-select-info">
										<span className="github-select-name">{item.name}</span>
										{item.description && <span className="github-select-desc">{item.description}</span>}
									</div>
									<span className="github-select-tag">{item.tag}</span>
									{item.exists && <span className="github-select-badge">imported</span>}
								</div>
							))}
						</div>
						{error && <p className="modal-error">{error}</p>}
						<div className="modal-actions">
							<button type="button" className="btn-ghost" onClick={() => { setPhase("input"); setError(""); }}>Back</button>
							<button type="button" className="btn-primary" onClick={handleImport} disabled={selected.size === 0}>
								{selectedNewCount > 0 && selectedUpdateCount > 0
									? `Import ${selectedNewCount} & Update ${selectedUpdateCount}`
									: selectedUpdateCount > 0
										? `Update ${selectedUpdateCount} template${selectedUpdateCount !== 1 ? "s" : ""}`
										: `Import ${selectedNewCount} template${selectedNewCount !== 1 ? "s" : ""}`}
							</button>
						</div>
					</div>
				)}

				{phase === "importing" && (
					<div className="modal-body">
						<p className="modal-info">Importing templates...</p>
						<div className="progress-bar">
							<div className="progress-bar-fill" style={{ width: progress.total > 0 ? (progress.current / progress.total * 100) + "%" : "0%" }} />
						</div>
						<p className="progress-text">{progress.current} / {progress.total}</p>
					</div>
				)}

				{phase === "done" && (
					<div className="modal-body">
						<p className="modal-info">Import complete!</p>
						{result && <p>Imported: {result.imported}, Updated: {result.updated}</p>}
						<div className="modal-actions">
							<button type="button" className="btn-primary" onClick={onClose}>Done</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
