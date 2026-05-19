import React, { useState, useEffect, lazy, Suspense } from "react";
import MarkdownRenderer from "../common/MarkdownRenderer.js";

const api = () => (window as any).api;

export default function DocViewerPanel() {
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileRoot, setFileRoot] = useState<string>("");
	const [content, setContent] = useState("");
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		const handler = async (e: Event) => {
			const detail = (e as CustomEvent).detail as { path: string; root: string };
			const path = typeof detail === "string" ? detail : detail.path;
			const root = typeof detail === "string" ? "" : (detail.root || "");
			setSelectedFile(path);
			setFileRoot(root);
			setLoading(true);
			try {
				const data = await api().filesContent(path, root || undefined);
				setContent(data.content ?? "(binary file)");
			} catch {
				setContent("(error)");
			} finally {
				setLoading(false);
			}
		};
		window.addEventListener("zero-file-select", handler);
		return () => window.removeEventListener("zero-file-select", handler);
	}, []);

	const fileName = selectedFile?.split("/").pop() ?? "";
	const isMarkdown = /\.(md|mdx|markdown)$/i.test(selectedFile ?? "");

	return (
		<div className="doc-viewer-panel">
			{selectedFile ? (
				<>
					<div className="doc-viewer-panel-header">
						<span>{fileName}</span>
						<button type="button" className="btn-icon" onClick={() => setSelectedFile(null)}>{"✕"}</button>
					</div>
					{loading ? (
						<div className="doc-viewer-panel-content"><p>Loading...</p></div>
					) : isMarkdown ? (
						<div className="doc-viewer-panel-content">
							<MarkdownRenderer content={content} />
						</div>
					) : (
						<pre className="doc-viewer-panel-content doc-viewer-code">{content}</pre>
					)}
				</>
			) : (
				<div className="doc-viewer-panel-empty">
					<p>Select a file to view</p>
				</div>
			)}
		</div>
	);
}
