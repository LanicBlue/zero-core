// 文件树面板组件
//
// # 文件说明书
//
// ## 核心功能
// 展示项目文件目录树，支持文件浏览和选择
//
// ## 输入
// chat-store 中的工作目录路径
//
// ## 输出
// 可交互的文件目录树 JSX
//
// ## 定位
// src/renderer/components/layout/ — 布局组件，为用户提供文件导航
//
// ## 依赖
// React、store/chat-store.ts、store/agent-store.ts
//
// ## 维护规则
// 大型目录的懒加载需确保性能
//
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useChatStore, selectActiveAgentId } from "../../store/chat-store.js";
import { useAgentStore } from "../../store/agent-store.js";
import { usePageStore } from "../../store/page-store.js";
import type { AgentRecord } from "../../../shared/types.js";

interface FileEntry {
	name: string;
	path: string;
	type: "file" | "dir";
	children?: FileEntry[];
	expanded?: boolean;
}

const api = () => (window as any).api;

export { type FileEntry };

export default function FileTreePanel() {
	const [tree, setTree] = useState<FileEntry[]>([]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [globalWorkspace, setGlobalWorkspace] = useState("");
	const expandedRef = useRef<Set<string>>(new Set());
	const lastHashRef = useRef<string>("");
	const lastRootRef = useRef<string>("");

	const activeAgentId = useChatStore(selectActiveAgentId);
	const activeSessionId = useChatStore((s) => s.activeSessionId);
	const sessionsByAgent = useChatStore((s) => s.sessionsByAgent);
	// N3 (runtime-push-ui-sync): the file system is NOT runtime — no fs watcher,
	// no periodic fetch. Pull-on-display only (mount / root change / manual
	// refresh button). The chat-page overlay keeps this panel mounted while the
	// user is on another top-level page, so fetchTree additionally gates auto
	// pulls by activePage === "chat" (read live via usePageStore.getState()).
	const agents = useAgentStore((s) => s.agents);
	const activeAgent = agents.find((a: AgentRecord) => a.id === activeAgentId) ?? null;
	// project session → 用项目工作区(右侧目录即项目目录,方便观察 agent 操作);
	// general session(无 context.workspaceDir)→ 退到 agent 默认 / 全局 workspace。
	const activeSession = (sessionsByAgent[activeAgentId ?? ""] ?? []).find((s: { id: string }) => s.id === activeSessionId);
	const effectiveRoot = activeSession?.context?.workspaceDir || activeAgent?.workspaceDir || globalWorkspace;

	useEffect(() => {
		api().configGet()
			.then((c: any) => setGlobalWorkspace(c.workspaceDir))
			.catch(() => {});
	}, []);

	// Clear tree when root changes
	useEffect(() => {
		if (effectiveRoot && effectiveRoot !== lastRootRef.current) {
			lastRootRef.current = effectiveRoot;
			lastHashRef.current = "";
			setTree([]);
		}
	}, [effectiveRoot]);

	const mergeTree = (fresh: FileEntry[], prev: FileEntry[]): FileEntry[] => {
		const prevMap = new Map<string, FileEntry>();
		const indexPrev = (entries: FileEntry[]) => {
			for (const e of entries) {
				prevMap.set(e.path, e);
				if (e.children) indexPrev(e.children);
			}
		};
		indexPrev(prev);

		const apply = (entries: FileEntry[]): FileEntry[] =>
			entries.map((e) => {
				if (e.type === "dir") {
					const expanded = prevMap.get(e.path)?.expanded ?? expandedRef.current.has(e.path);
					return {
						...e,
						expanded,
						children: e.children ? apply(e.children) : undefined,
					};
				}
				return e;
			});

		return apply(fresh);
	};

	const fetchTree = useCallback(async (opts?: { force?: boolean }) => {
		// N3: skip automatic pulls when the chat page isn't the active page (the
		// panel stays mounted under the overlay). The manual refresh button passes
		// `force: true` so an explicit user click always fetches regardless of the
		// current page.
		if (!opts?.force && usePageStore.getState().activePage !== "chat") return;
		if (!effectiveRoot) return;
		try {
			const data = await api().filesTree(effectiveRoot);
			const hash = JSON.stringify(data);
			if (hash !== lastHashRef.current) {
				lastHashRef.current = hash;
				setTree((prev) => mergeTree(data, prev));
			}
		} catch { /* */ }
	}, [effectiveRoot]);

	// N3: pull-on-display — fetch ONCE on mount / when the root changes. No
	// periodic polling (no fs watcher, no timer-based polling). Background writes
	// are not reflected until the user clicks "Refresh".
	useEffect(() => {
		fetchTree();
	}, [fetchTree]);

	const toggleDir = (dirPath: string) => {
		const toggle = (entries: FileEntry[]): FileEntry[] =>
			entries.map((e) => {
				if (e.path === dirPath) {
					const next = !e.expanded;
					if (next) expandedRef.current.add(dirPath);
					else expandedRef.current.delete(dirPath);
					return { ...e, expanded: next };
				}
				if (e.children) return { ...e, children: toggle(e.children) };
				return e;
			});
		setTree(toggle(tree));
	};

	const shortDir = effectiveRoot
		? effectiveRoot.replace(/^C:\\Users\\[^\\]+/, "~").replace(/\\/g, "/")
		: "";

	const handleFileClick = (entry: FileEntry) => {
		if (entry.type === "dir") {
			toggleDir(entry.path);
		} else {
			setSelectedFile(entry.path);
			window.dispatchEvent(new CustomEvent("zero-file-select", {
				detail: { path: entry.path, root: effectiveRoot },
			}));
		}
	};

	const renderEntry = (entry: FileEntry, depth: number = 0) => {
		const indentClass = `file-depth-${Math.min(depth, 8)}`;
		return (
			<div key={entry.path}>
				<div
					className={`file-entry ${indentClass} ${selectedFile === entry.path ? "file-active" : ""}`}
					onClick={() => handleFileClick(entry)}
				>
					<span className="file-icon">{entry.type === "dir" ? (entry.expanded ? "▼" : "▶") : "•"}</span>
					<span className="file-name">{entry.name}</span>
				</div>
				{entry.type === "dir" && entry.expanded && entry.children?.map((c) => renderEntry(c, depth + 1))}
			</div>
		);
	};

	return (
		<div className="file-tree-panel">
			<div className="file-tree-header">
				<span>{shortDir}</span>
				<button type="button" className="btn-icon" onClick={() => fetchTree({ force: true })} title="Refresh">{"↻"}</button>
			</div>
			<div className="file-tree-body">
				{tree.length === 0 ? (
					<p className="doc-placeholder">No files.</p>
				) : (
					tree.map((e) => renderEntry(e))
				)}
			</div>
		</div>
	);
}
