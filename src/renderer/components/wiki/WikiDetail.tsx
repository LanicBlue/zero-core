// Wiki 详情组件
//
// # 文件说明书
//
// ## 核心功能
// 显示选中 Wiki 节点的详情，包括摘要、关键函数、依赖等信息。
//
// ## 输入
// - ProjectWikiNode | null
// - onExpand 回调
// - onEdit 回调
//
// ## 输出
// - 渲染的详情面板
//
// ## 定位
// 渲染进程组件，被 WikiPage 使用。
//
// ## 依赖
// - react
// - ../../shared/types
//
// ## 维护规则
// - ProjectWikiNode 展示字段或编辑回调变更时同步本组件
// - 节点类型渲染分支变更需同步 onExpand/onEdit 契约
//
import React, { useState } from "react";
import type { ProjectWikiNode, UpdateWikiNodeInput } from "../../../shared/types.js";

interface WikiDetailProps {
	node: ProjectWikiNode | null;
	onExpand: (nodeId: string) => void;
	onEdit: (nodeId: string, data: UpdateWikiNodeInput) => void;
}

export default function WikiDetail({ node, onExpand, onEdit }: WikiDetailProps) {
	const [editing, setEditing] = useState(false);
	const [editSummary, setEditSummary] = useState("");
	const [editDetail, setEditDetail] = useState("");

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

	const startEdit = () => {
		setEditSummary(node.summary || "");
		setEditDetail(node.detail || "");
		setEditing(true);
	};

	const cancelEdit = () => {
		setEditing(false);
	};

	const saveEdit = () => {
		onEdit(node.id, {
			summary: editSummary,
			detail: editDetail,
		});
		setEditing(false);
	};

	return (
		<div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
			{/* Path / Title */}
			<div style={{
				fontSize: 14,
				fontWeight: 600,
				color: "var(--text-primary, #e0e0e0)",
				marginBottom: 4,
				fontFamily: "monospace",
				wordBreak: "break-all",
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
						style={{
							width: "100%",
							minHeight: 60,
							padding: 8,
							background: "var(--bg-secondary, #1c1c1e)",
							border: "1px solid var(--border-color, #333)",
							borderRadius: 4,
							color: "var(--text-primary, #e0e0e0)",
							fontSize: 12,
							resize: "vertical",
							boxSizing: "border-box",
						}}
					/>
					<label style={{ display: "block", fontSize: 12, color: "var(--text-secondary, #888)", marginBottom: 4, marginTop: 8 }}>
						Detail
					</label>
					<textarea
						value={editDetail}
						onChange={(e) => setEditDetail(e.target.value)}
						style={{
							width: "100%",
							minHeight: 120,
							padding: 8,
							background: "var(--bg-secondary, #1c1c1e)",
							border: "1px solid var(--border-color, #333)",
							borderRadius: 4,
							color: "var(--text-primary, #e0e0e0)",
							fontSize: 12,
							resize: "vertical",
							boxSizing: "border-box",
						}}
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

					{/* Detail */}
					{node.detail ? (
						<div style={{
							fontSize: 12,
							color: "var(--text-primary, #e0e0e0)",
							lineHeight: 1.6,
							whiteSpace: "pre-wrap",
							background: "var(--bg-secondary, #1c1c1e)",
							padding: 12,
							borderRadius: 6,
						}}>
							{node.detail}
						</div>
					) : (
						<button
							type="button"
							onClick={() => onExpand(node.id)}
							style={{
								...btnStyle,
								display: "block",
								margin: "16px auto",
							}}
						>
							Expand Full Content
						</button>
					)}

					{/* Actions */}
					<div style={{ marginTop: 16, display: "flex", gap: 8 }}>
						<button type="button" onClick={startEdit} style={btnStyle}>
							Edit
						</button>
					</div>

					{/* Metadata */}
					<div style={{
						marginTop: 16,
						paddingTop: 12,
						borderTop: "1px solid var(--border-color, #333)",
						fontSize: 11,
						color: "var(--text-tertiary, #555)",
					}}>
						<div>Type: {node.nodeType} | Updated by: {node.lastUpdatedBy}</div>
						<div>Updated: {new Date(node.updatedAt).toLocaleString()}</div>
					</div>
				</>
			)}
		</div>
	);
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
