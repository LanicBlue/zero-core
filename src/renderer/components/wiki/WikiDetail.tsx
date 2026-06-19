// Wiki 详情组件 (v0.8 P8 升级为全局树右节点正文)
//
// # 文件说明书
//
// ## 核心功能
// 显示选中 Wiki 节点的正文。P8 起:
//   - 正文走 store.expandNode → wiki:readDetail(磁盘懒加载),首次展开
//     自动拉取;之后缓存。
//   - docPointer 跳转原文:对项目子树节点(header/intent/docPointer 指向
//     工作区文件),提供「Open original」按钮,读 workspaceDir 下的相对
//     路径(wiki:readWorkspaceDoc,FS 沙箱在主进程强制)。
//   - 编辑保留 legacy upsert(wiki:updateNode),只对项目子树节点启用。
//
// ## 输入
// - node: WikiNode | null
// - detail: string | undefined(已懒加载;undefined = 未加载/无正文)
// - onExpand / onEdit / onOpenOriginal 回调
//
// ## 输出
// - 渲染的详情面板
//
// ## 定位
// 渲染进程组件,被 WikiPage 使用。
//
// ## 依赖
// - react
// - ../../../shared/types (WikiNode, UpdateWikiNodeInput)
//
// ## 维维护规则
// - WikiNode 展示字段或编辑/展开回调变更时同步本组件
// - docPointer 跳转路径解析变更需同步主进程 wiki:readWorkspaceDoc
//
import React, { useEffect, useState } from "react";
import type { WikiNode } from "../../../shared/types.js";

interface WikiDetailProps {
	node: WikiNode | null;
	/** Lazy-loaded body content (undefined = not loaded or no body). */
	detail: string | undefined;
	onExpand: (nodeId: string) => void;
	onOpenOriginal: (node: WikiNode) => void;
	onEdit: (nodeId: string, data: { summary?: string; detail?: string }) => void;
}

export default function WikiDetail({ node, detail, onExpand, onOpenOriginal, onEdit }: WikiDetailProps) {
	const [editing, setEditing] = useState(false);
	const [editSummary, setEditSummary] = useState("");
	const [editDetail, setEditDetail] = useState("");

	// Auto-expand body when a node is selected (P8: detail is lazy).
	useEffect(() => {
		if (node) onExpand(node.id);
	}, [node?.id]);

	// Editing form syncs to the selected node.
	useEffect(() => {
		if (node) {
			setEditSummary(node.summary ?? "");
			setEditDetail(detail ?? "");
		}
	}, [node?.id, detail]);

	if (!node) {
		return (
			<div style={{
				padding: 40,
				textAlign: "center",
				color: "var(--text-tertiary, #555)",
				fontSize: 13,
			}}>
				Select a node from the tree to view details.
			</div>
		);
	}

	const isProjectLeaf = node.projectId && (node.type === "header" || node.type === "intent");
	const hasOriginalPath = isProjectLeaf && !!docPointerRelPath(node);

	const startEdit = () => {
		setEditSummary(node.summary ?? "");
		setEditDetail(detail ?? "");
		setEditing(true);
	};

	const cancelEdit = () => setEditing(false);

	const saveEdit = () => {
		onEdit(node.id, { summary: editSummary, detail: editDetail });
		setEditing(false);
	};

	const handleOpenOriginal = () => {
		onOpenOriginal(node);
	};

	return (
		<div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
			{/* Title */}
			<div style={{
				fontSize: 14,
				fontWeight: 600,
				color: "var(--text-primary, #e0e0e0)",
				marginBottom: 4,
				fontFamily: "monospace",
				wordBreak: "break-all",
			}}>
				{node.title || node.path}
			</div>
			<div style={{
				fontSize: 11,
				color: "var(--text-tertiary, #555)",
				fontFamily: "monospace",
				marginBottom: 4,
			}}>
				{node.path}
			</div>
			<div style={{
				height: 1,
				background: "var(--border-color, #333)",
				margin: "8px 0 16px",
			}} />

			{editing ? (
				<div>
					<label style={{ display: "block", fontSize: 12, color: "var(--text-secondary, #888)", marginBottom: 4 }}>
						Summary
					</label>
					<textarea
						value={editSummary}
						onChange={(e) => setEditSummary(e.target.value)}
						style={textareaStyle}
						aria-label="Wiki node summary"
						placeholder="Short summary of this node"
					/>
					<label style={{ display: "block", fontSize: 12, color: "var(--text-secondary, #888)", marginBottom: 4, marginTop: 8 }}>
						Detail (body)
					</label>
					<textarea
						value={editDetail}
						onChange={(e) => setEditDetail(e.target.value)}
						style={{ ...textareaStyle, minHeight: 200 }}
						aria-label="Wiki node body detail"
						placeholder="Full body content (markdown)"
					/>
					<div style={{ marginTop: 8, display: "flex", gap: 8 }}>
						<button type="button" onClick={saveEdit} style={btnStyle}>Save</button>
						<button type="button" onClick={cancelEdit} style={{ ...btnStyle, background: "transparent", border: "1px solid var(--border-color, #333)" }}>Cancel</button>
					</div>
				</div>
			) : (
				<>
					{/* Summary */}
					{node.summary && (
						<div style={{
							fontSize: 12,
							color: "var(--text-secondary, #888)",
							lineHeight: 1.6,
							marginBottom: 16,
							whiteSpace: "pre-wrap",
						}}>
							{node.summary}
						</div>
					)}

					{/* Body (lazy-loaded from disk) */}
					{detail ? (
						<div style={{
							fontSize: 12,
							color: "var(--text-primary, #e0e0e0)",
							lineHeight: 1.6,
							whiteSpace: "pre-wrap",
							background: "var(--bg-secondary, #1c1c1e)",
							padding: 12,
							borderRadius: 6,
							maxHeight: 400,
							overflowY: "auto",
						}}>
							{detail}
						</div>
					) : (
						<div style={{
							fontSize: 11,
							color: "var(--text-tertiary, #555)",
							fontStyle: "italic",
							padding: 8,
						}}>
							No body content on disk for this node.
						</div>
					)}

					{/* docPointer jump to original */}
					{hasOriginalPath && (
						<div style={{ marginTop: 16 }}>
							<button
								type="button"
								onClick={handleOpenOriginal}
								style={{ ...btnStyle, background: "#2a7a2a" }}
							>
								{"\u{1F4C2}"} Open original file
							</button>
						</div>
					)}

					{/* Actions — editing only for project subtree nodes (write scope). */}
					<div style={{ marginTop: 16, display: "flex", gap: 8 }}>
						{node.projectId && (
							<button type="button" onClick={startEdit} style={btnStyle}>Edit</button>
						)}
					</div>

					{/* Metadata */}
					<div style={{
						marginTop: 16,
						paddingTop: 12,
						borderTop: "1px solid var(--border-color, #333)",
						fontSize: 11,
						color: "var(--text-tertiary, #555)",
					}}>
						<div>Type: {node.type}{node.projectId ? ` | Project: ${node.projectId}` : ""}{node.lastUpdatedBy ? ` | By: ${node.lastUpdatedBy}` : ""}</div>
						{node.provenance && <div>Provenance: {node.provenance}</div>}
						{node.flags && node.flags.length > 0 && <div>Flags: {node.flags.join(", ")}</div>}
						<div>Updated: {new Date(node.updatedAt).toLocaleString()}</div>
					</div>
				</>
			)}
		</div>
	);
}

/**
 * Extract the workspace-relative path from a header/intent node's path. The
 * wiki path encodes the scope prefix:
 *   "header:src/runtime/agent-loop.ts" → "src/runtime/agent-loop.ts"
 *   "intent:docs/req-foo.md"           → "docs/req-foo.md"
 * Returns undefined when there's no usable relPath (memory / structure /
 * synthetic roots).
 */
function docPointerRelPath(node: WikiNode): string | undefined {
	const p = node.path ?? "";
	const idx = p.indexOf(":");
	if (idx < 0) return undefined;
	const prefix = p.slice(0, idx);
	const rest = p.slice(idx + 1);
	if ((prefix === "header" || prefix === "intent") && rest) return rest;
	return undefined;
}

const btnStyle: React.CSSProperties = {
	padding: "4px 12px",
	background: "#2196F3",
	border: "none",
	borderRadius: 4,
	color: "#fff",
	fontSize: 12,
	cursor: "pointer",
};

const textareaStyle: React.CSSProperties = {
	width: "100%",
	minHeight: 80,
	padding: 8,
	background: "var(--bg-secondary, #1c1c1e)",
	border: "1px solid var(--border-color, #333)",
	borderRadius: 4,
	color: "var(--text-primary, #e0e0e0)",
	fontSize: 12,
	resize: "vertical",
	boxSizing: "border-box",
};
