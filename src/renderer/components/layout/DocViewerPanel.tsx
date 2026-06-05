// 文档查看器面板组件
//
// # 文件说明书
//
// ## 核心功能
// 在侧面板中显示 Markdown 格式的文档内容（CLAUDE.md 等）
//
// ## 输入
// 文档文件路径
//
// ## 输出
// Markdown 渲染的文档内容 JSX
//
// ## 定位
// src/renderer/components/layout/ — 布局组件，为用户提供上下文文档查看
//
// ## 依赖
// React、common/MarkdownRenderer.tsx、preload API
//
// ## 维护规则
// 文档路径解析逻辑变更需确保安全
//
import React, { useState, useEffect, useRef, useCallback } from "react";
import MarkdownRenderer from "../common/MarkdownRenderer.js";

const api = () => (window as any).api;

type FileType = "markdown" | "pdf" | "html" | "text";
type ViewMode = "preview" | "source" | "edit";

function getFileType(path: string | null): FileType {
	if (!path) return "text";
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (["md", "mdx", "markdown"].includes(ext)) return "markdown";
	if (ext === "pdf") return "pdf";
	if (["html", "htm"].includes(ext)) return "html";
	return "text";
}

export default function DocViewerPanel() {
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileRoot, setFileRoot] = useState<string>("");
	const [content, setContent] = useState("");
	const [editContent, setEditContent] = useState("");
	const [loading, setLoading] = useState(false);
	const [resolvedPath, setResolvedPath] = useState<string>("");
	const [viewMode, setViewMode] = useState<ViewMode>("preview");
	const webviewRef = useRef<Electron.WebviewTag | null>(null);

	const loadFile = useCallback(async (path: string, root: string) => {
		const fileType = getFileType(path);
		setViewMode("preview");

		if (fileType === "pdf" || fileType === "html") {
			try {
				const result = await api().filesResolvePath(path, root || undefined);
				if (result.path) {
					setResolvedPath("file:///" + result.path.replace(/\\/g, "/"));
				} else {
					setContent("(unable to resolve file path)");
				}
			} catch {
				setContent("(error resolving path)");
			}
			if (fileType === "html") {
				// Also load content for source/edit views
				try {
					const data = await api().filesContent(path, root || undefined);
					setContent(data.content ?? "(empty file)");
				} catch {
					setContent("(error loading content)");
				}
			}
			setLoading(false);
			return;
		}

		try {
			const data = await api().filesContent(path, root || undefined);
			setContent(data.content ?? "(binary file)");
		} catch {
			setContent("(error)");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		const handler = async (e: Event) => {
			const detail = (e as CustomEvent).detail as { path: string; root: string };
			const path = typeof detail === "string" ? detail : detail.path;
			const root = typeof detail === "string" ? "" : (detail.root || "");
			setSelectedFile(path);
			setFileRoot(root);
			setResolvedPath("");
			setLoading(true);
			await loadFile(path, root);
		};
		window.addEventListener("zero-file-select", handler);
		return () => window.removeEventListener("zero-file-select", handler);
	}, [loadFile]);

	const fileName = selectedFile?.split("/").pop()?.split("\\").pop() ?? "";
	const fileType = getFileType(selectedFile);
	const canEdit = fileType === "markdown" || fileType === "html";

	const handleClose = () => {
		setSelectedFile(null);
		setContent("");
		setResolvedPath("");
		setViewMode("preview");
	};

	const handleSave = async () => {
		if (!selectedFile) return;
		try {
			await api().filesSave(selectedFile, editContent, fileRoot || undefined);
			setContent(editContent);
			setViewMode("preview");
			// Reload webview for HTML
			if (fileType === "html") {
				const result = await api().filesResolvePath(selectedFile, fileRoot || undefined);
				if (result.path) {
					setResolvedPath("");
					setTimeout(() => {
						setResolvedPath("file:///" + result.path.replace(/\\/g, "/"));
					}, 100);
				}
			}
		} catch (err) {
			console.error("Save failed:", err);
		}
	};

	const switchToEdit = () => {
		setEditContent(content);
		setViewMode("edit");
	};

	const switchToSource = () => {
		setViewMode("source");
	};

	const switchToPreview = () => {
		setViewMode("preview");
	};

	return (
		<div className="doc-viewer-panel">
			{selectedFile ? (
				<>
					<div className="doc-viewer-panel-header">
						<span className="doc-viewer-filename" title={selectedFile}>
							{fileName}
						</span>
						<div className="doc-viewer-toolbar">
							{canEdit && viewMode === "preview" && (
								<>
									<button type="button" className="doc-toolbar-btn" onClick={switchToSource}>Source</button>
									<button type="button" className="doc-toolbar-btn" onClick={switchToEdit}>Edit</button>
								</>
							)}
							{canEdit && viewMode === "source" && (
								<>
									<button type="button" className="doc-toolbar-btn" onClick={switchToPreview}>Preview</button>
									<button type="button" className="doc-toolbar-btn" onClick={switchToEdit}>Edit</button>
								</>
							)}
							{canEdit && viewMode === "edit" && (
								<>
									<button type="button" className="doc-toolbar-btn doc-toolbar-save" onClick={handleSave}>Save</button>
									<button type="button" className="doc-toolbar-btn" onClick={switchToPreview}>Cancel</button>
								</>
							)}
							<button type="button" className="btn-icon" onClick={handleClose}>{"✕"}</button>
						</div>
					</div>
					{loading ? (
						<div className="doc-viewer-panel-content"><p>Loading...</p></div>
					) : viewMode === "edit" ? (
						<textarea
							className="doc-viewer-editor"
							value={editContent}
							onChange={(e) => setEditContent(e.target.value)}
							spellCheck={false}
							placeholder="File content..."
							aria-label="Edit file content"
						/>
					) : viewMode === "source" ? (
						<pre className="doc-viewer-panel-content doc-viewer-code">{content}</pre>
					) : fileType === "markdown" ? (
						<div className="doc-viewer-panel-content">
							<MarkdownRenderer content={content} />
						</div>
					) : (fileType === "pdf" || fileType === "html") && resolvedPath ? (
						<webview
							ref={webviewRef}
							className="doc-viewer-webview"
							src={resolvedPath}
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
