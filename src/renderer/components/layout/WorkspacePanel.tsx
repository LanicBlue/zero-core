import React, { useState, useEffect, useCallback } from "react";
import { useAgentStore } from "../../store/agent-store.js";

interface FileEntry {
	name: string;
	path: string;
	type: "file" | "dir";
	children?: FileEntry[];
	expanded?: boolean;
}

// Lightweight markdown → HTML
function renderMarkdown(text: string): string {
	let html = text
		// Code blocks (```...```)
		.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
			`<pre class="md-code-block"><code class="lang-${lang}">${esc(code)}</code></pre>`)
		// Inline code
		.replace(/`([^`]+)`/g, "<code class='md-inline-code'>$1</code>")
		// Headers
		.replace(/^### (.+)$/gm, "<h4>$1</h4>")
		.replace(/^## (.+)$/gm, "<h3>$1</h3>")
		.replace(/^# (.+)$/gm, "<h2>$1</h2>")
		// Bold / italic
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		// Links
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href='$2' target='_blank'>$1</a>")
		// Unordered lists
		.replace(/^[*-] (.+)$/gm, "<li>$1</li>")
		// Paragraphs (double newline)
		.replace(/\n{2,}/g, "</p><p>")
		// Single newlines → <br>
		.replace(/\n/g, "<br>");

	// Wrap loose <li> in <ul>
	html = html.replace(/((?:<li>.*?<\/li><br>?)+)/g, "<ul>$1</ul>");
	// Wrap in paragraph
	html = `<p>${html}</p>`;
	// Clean up empty paragraphs
	html = html.replace(/<p>\s*<\/p>/g, "");
	return html;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function WorkspacePanel() {
	const { agents } = useAgentStore();
	// We don't track activeAgentId here — fetch global workspace from config
	const [globalWorkspace, setGlobalWorkspace] = useState("");
	const [tree, setTree] = useState<FileEntry[]>([]);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState<string>("");
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		fetch("/api/config")
			.then((r) => r.json())
			.then((c) => setGlobalWorkspace(c.workspaceDir))
			.catch(() => {});
	}, []);

	const workspaceDir = globalWorkspace;

	const fetchTree = useCallback(async () => {
		try {
			const res = await fetch("/api/files");
			if (res.ok) {
				const data = await res.json();
				setTree(data);
			}
		} catch { /* */ }
	}, []);

	useEffect(() => {
		fetchTree();
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
	const isMarkdown = /\.(md|mdx|markdown)$/i.test(selectedFile ?? "");

	const shortDir = workspaceDir
		? workspaceDir.replace(/^C:\\Users\\[^\\]+/, "~").replace(/\\/g, "/")
		: "";

	return (
		<div className="workspace-panel">
			{/* Top: file tree */}
			<div className="workspace-tree-section">
				<div className="workspace-tree-header">
					<span>{shortDir}</span>
					<button type="button" className="btn-icon" onClick={fetchTree} title="Refresh">{"↻"}</button>
				</div>
				<div className="workspace-tree">
					{tree.length === 0 ? (
						<p className="doc-placeholder">No workspace files.</p>
					) : (
						tree.map((e) => renderEntry(e))
					)}
				</div>
			</div>

			{/* Bottom: doc viewer */}
			{selectedFile && (
				<div className="workspace-doc-viewer">
					<div className="workspace-doc-header">
						<span>{fileName}</span>
						<button type="button" className="btn-icon" onClick={() => setSelectedFile(null)}>{"✕"}</button>
					</div>
					{loading ? (
						<div className="workspace-doc-content"><p>Loading...</p></div>
					) : isMarkdown ? (
						<div
							className="workspace-doc-content md-render"
							dangerouslySetInnerHTML={{ __html: renderMarkdown(fileContent) }}
						/>
					) : (
						<pre className="workspace-doc-content doc-viewer-code">{fileContent}</pre>
					)}
				</div>
			)}
		</div>
	);
}
