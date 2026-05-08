import React, { useState, useEffect, useCallback, useRef } from "react";

interface FileEntry {
	name: string;
	path: string;
	type: "file" | "dir";
	children?: FileEntry[];
	expanded?: boolean;
}

export { type FileEntry };

export default function FileTreePanel() {
	const [tree, setTree] = useState<FileEntry[]>([]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [globalWorkspace, setGlobalWorkspace] = useState("");
	const expandedRef = useRef<Set<string>>(new Set());
	const lastHashRef = useRef<string>("");

	useEffect(() => {
		fetch("/api/config")
			.then((r) => r.json())
			.then((c) => setGlobalWorkspace(c.workspaceDir))
			.catch(() => {});
	}, []);

	// Merge new tree data with existing expanded state
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

	const fetchTree = useCallback(async () => {
		try {
			const res = await fetch("/api/files");
			if (res.ok) {
				const data = await res.json();
				const hash = JSON.stringify(data);
				if (hash !== lastHashRef.current) {
					lastHashRef.current = hash;
					setTree((prev) => mergeTree(data, prev));
				}
			}
		} catch { /* */ }
	}, []);

	useEffect(() => {
		fetchTree();
		const interval = setInterval(fetchTree, 5000);
		return () => clearInterval(interval);
	}, [fetchTree]);

	const toggleDir = (dirPath: string) => {
		const toggle = (entries: FileEntry[]): FileEntry[] =>
			entries.map((e) => {
				if (e.path === dirPath) {
					const next = !e.expanded;
					// Track expansion state in ref so refreshes preserve it
					if (next) expandedRef.current.add(dirPath);
					else expandedRef.current.delete(dirPath);
					return { ...e, expanded: next };
				}
				if (e.children) return { ...e, children: toggle(e.children) };
				return e;
			});
		setTree(toggle(tree));
	};

	const shortDir = globalWorkspace
		? globalWorkspace.replace(/^C:\\Users\\[^\\]+/, "~").replace(/\\/g, "/")
		: "";

	const handleFileClick = (entry: FileEntry) => {
		if (entry.type === "dir") {
			toggleDir(entry.path);
		} else {
			setSelectedFile(entry.path);
			window.dispatchEvent(new CustomEvent("zero-file-select", { detail: entry.path }));
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
				<button type="button" className="btn-icon" onClick={fetchTree} title="Refresh">{"↻"}</button>
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
