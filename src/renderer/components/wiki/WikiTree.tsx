// Wiki 树组件
//
// # 文件说明书
//
// ## 核心功能
// 递归渲染 Wiki 节点层级树，支持展开/收起和选中。
//
// ## 输入
// - ProjectWikiNode[]
// - selectedNodeId
// - onSelect 回调
//
// ## 输出
// - 渲染的树结构
//
// ## 定位
// 渲染进程组件，被 WikiPage 使用。
//
// ## 依赖
// - react
// - ../../shared/types
//
// ## 维护规则
// - 树结构渲染或展开/选中交互变更时同步本组件
// - WikiNodeType 新增分支需补充图标与默认展开策略
//
import React, { useState, useMemo } from "react";
import type { ProjectWikiNode, WikiNodeType } from "../../../shared/types.js";

const NODE_ICONS: Record<WikiNodeType, string> = {
	directory: "\u{1F4C1}",
	file: "\u{1F4C4}",
	function: "⚙️",
	class: "\u{1F4E6}",
	section: "\u{1F4DD}",
};

interface WikiTreeProps {
	nodes: ProjectWikiNode[];
	selectedNodeId: string | null;
	onSelect: (nodeId: string) => void;
}

interface TreeNodeProps {
	node: ProjectWikiNode;
	children: ProjectWikiNode[];
	allNodes: ProjectWikiNode[];
	selectedNodeId: string | null;
	onSelect: (nodeId: string) => void;
	depth: number;
}

function TreeNode({ node, children, allNodes, selectedNodeId, onSelect, depth }: TreeNodeProps) {
	const [expanded, setExpanded] = useState(depth < 1);
	const hasChildren = children.length > 0;
	const isSelected = node.id === selectedNodeId;
	const icon = NODE_ICONS[node.nodeType] || "\u{1F4C4}";

	return (
		<div>
			<div
				onClick={() => onSelect(node.id)}
				style={{
					display: "flex",
					alignItems: "center",
					gap: 4,
					padding: "3px 8px",
					paddingLeft: depth * 16 + 8,
					cursor: "pointer",
					background: isSelected ? "var(--bg-active, #2a2a2e)" : "transparent",
					borderRadius: 4,
					fontSize: 12,
					color: isSelected ? "var(--text-primary, #e0e0e0)" : "var(--text-secondary, #888)",
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis",
				}}
				onMouseEnter={(e) => {
					if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-hover, #252528)";
				}}
				onMouseLeave={(e) => {
					if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "transparent";
				}}
			>
				{hasChildren && (
					<span
						onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
						style={{ fontSize: 10, width: 12, textAlign: "center", flexShrink: 0 }}
					>
						{expanded ? "▾" : "▸"}
					</span>
				)}
				{!hasChildren && <span style={{ width: 12, flexShrink: 0 }} />}
				<span style={{ flexShrink: 0 }}>{icon}</span>
				<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
					{node.title}
				</span>
			</div>
			{expanded && hasChildren && children.map((child) => (
				<TreeNode
					key={child.id}
					node={child}
					children={allNodes.filter((n) => n.parentId === child.id)}
					allNodes={allNodes}
					selectedNodeId={selectedNodeId}
					onSelect={onSelect}
					depth={depth + 1}
				/>
			))}
		</div>
	);
}

export default function WikiTree({ nodes, selectedNodeId, onSelect }: WikiTreeProps) {
	// Find root nodes (no parentId)
	const rootNodes = useMemo(() => nodes.filter((n) => !n.parentId), [nodes]);

	if (nodes.length === 0) {
		return (
			<div style={{
				padding: 20,
				textAlign: "center",
				fontSize: 12,
				color: "var(--text-tertiary, #555)",
			}}>
				No wiki nodes yet.
				<br />
				Trigger project analysis first.
			</div>
		);
	}

	return (
		<div style={{ overflowY: "auto", padding: "4px 0" }}>
			{rootNodes.map((node) => (
				<TreeNode
					key={node.id}
					node={node}
					children={nodes.filter((n) => n.parentId === node.id)}
					allNodes={nodes}
					selectedNodeId={selectedNodeId}
					onSelect={onSelect}
					depth={0}
				/>
			))}
		</div>
	);
}
