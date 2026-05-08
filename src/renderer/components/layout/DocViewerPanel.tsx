import React, { useState, useEffect } from "react";

function renderMarkdown(text: string): string {
	let html = text
		.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
			`<pre class="md-code-block"><code class="lang-${lang}">${esc(code)}</code></pre>`)
		.replace(/`([^`]+)`/g, "<code class='md-inline-code'>$1</code>")
		.replace(/^### (.+)$/gm, "<h4>$1</h4>")
		.replace(/^## (.+)$/gm, "<h3>$1</h3>")
		.replace(/^# (.+)$/gm, "<h2>$1</h2>")
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href='$2' target='_blank'>$1</a>")
		.replace(/^[*-] (.+)$/gm, "<li>$1</li>")
		.replace(/\n{2,}/g, "</p><p>")
		.replace(/\n/g, "<br>");
	html = html.replace(/((?:<li>.*?<\/li><br>?)+)/g, "<ul>$1</ul>");
	html = `<p>${html}</p>`;
	html = html.replace(/<p>\s*<\/p>/g, "");
	return html;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function DocViewerPanel() {
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [content, setContent] = useState("");
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		const handler = (e: Event) => {
			const path = (e as CustomEvent).detail as string;
			setSelectedFile(path);
			setLoading(true);
			fetch(`/api/files/content?path=${encodeURIComponent(path)}`)
				.then((r) => (r.ok ? r.json() : { content: "(unable to load)" }))
				.then((data) => setContent(data.content ?? "(binary file)"))
				.catch(() => setContent("(error)"))
				.finally(() => setLoading(false));
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
						<div
							className="doc-viewer-panel-content md-render"
							dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
						/>
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
