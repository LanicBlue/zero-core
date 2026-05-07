import React, { useState, useEffect, useCallback } from "react";

interface FileEntry {
	name: string;
	path: string;
	type: "file" | "dir";
	children?: FileEntry[];
	expanded?: boolean;
}

export default function DocPanel() {
	const [tree, setTree] = useState<FileEntry[]>([]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState<string>("");
	const [loading, setLoading] = useState(false);

	const fetchTree = useCallback(async () => {
		try {
			const res = await fetch("/api/files");
			if (res.ok) {
				const data = await res.json();
				setTree(data);
			}
		} catch {
			// API not available yet
		}
	}, []);

	useEffect(() => {
		fetchTree();
		// Auto-refresh file tree every 5 seconds
		const interval = setInterval(fetchTree, 5000);
		return () => clearInterval(interval);
	}, [fetchTree]);

	const openFile = async (filePath: string) => {
		setSelectedFile(filePath);
		setLoading(true);
		try {
			const res = await fetch(`/api/files/content?path=${encodeURIComponent(filePath)}`);
			if (res.ok) {
				const data = await res.json();
				setFileContent(data.content ?? "(binary file)");
			} else {
				setFileContent("(unable to load file)");
			}
		} catch {
			setFileContent("(error loading file)");
		}
		setLoading(false);
	};

	const toggleDir = (dirPath: string) => {
		const toggle = (entries: FileEntry[]): FileEntry[] =>
			entries.map((e) => {
				if (e.path === dirPath) return { ...e, expanded: !e.expanded };
				if (e.children) return { ...e, children: toggle(e.children) };
				return e;
			});
		setTree(toggle(tree));
	};

	const renderEntry = (entry: FileEntry, depth: number = 0) => {
		const indentClass = `file-depth-${Math.min(depth, 8)}`;
		return (
			<div key={entry.path}>
				<div
					className={`file-entry ${indentClass} ${selectedFile === entry.path ? "file-active" : ""}`}
					onClick={() => entry.type === "dir" ? toggleDir(entry.path) : openFile(entry.path)}
				>
					<span className="file-icon">{entry.type === "dir" ? (entry.expanded ? "▼" : "▶") : "•"}</span>
					<span className="file-name">{entry.name}</span>
				</div>
				{entry.type === "dir" && entry.expanded && entry.children?.map((c) => renderEntry(c, depth + 1))}
			</div>
		);
	};

	const fileName = selectedFile?.split("/").pop() ?? "";

	return (
		<aside className="doc-panel">
			<div className="doc-header">
				<span>Workspace</span>
				<button type="button" className="btn-icon" onClick={fetchTree} title="Refresh">{"↻"}</button>
			</div>

			<div className="doc-tree">
				{tree.length === 0 ? (
					<p className="doc-placeholder">No project loaded.</p>
				) : (
					tree.map((e) => renderEntry(e))
				)}
			</div>

			{selectedFile && (
				<div className="doc-viewer">
					<div className="doc-viewer-header">
						<span>{fileName}</span>
						<button type="button" className="btn-icon" onClick={() => setSelectedFile(null)}>{"✕"}</button>
					</div>
					<pre className="doc-viewer-code">
						{loading ? "Loading..." : fileContent}
					</pre>
				</div>
			)}
		</aside>
	);
}
