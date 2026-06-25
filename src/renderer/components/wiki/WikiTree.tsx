// Wiki 树组件 (v0.8 P8 全局树浏览器 · 懒加载渲染)
//
// # 文件说明书
//
// ## 核心功能
// 渲染全局 wiki 记忆树的左树。**逐层懒加载**:从根锚点的直接子节点开始
// 渲染,点展开才请求并渲染下一层(由 store 的 expandNode 拉取)。未展开的
// 子树不请求、不渲染。
//
// ## 输入
// - childrenByNode / childrenLoaded / loadingChildren(store 状态)
// - rootId(当前 scope 根锚点)
// - selectedNodeId / onSelect / onExpand
//
// ## 输出
// - 渲染的树(只含已展开路径的可见行)
//
import React, { useState, useEffect } from "react";
import type { WikiNode } from "../../../shared/types.js";

const NODE_TYPE_ICONS: Record<string, string> = {
	project: "\u{1F4C2}",
	header: "\u{1F4C4}",
	intent: "\u{1F4DD}",
	structure: "\u{1F4C1}",
	memory: "\u{1F9E0}",
};

function iconFor(node: WikiNode): string {
	if (node.id === "wiki-root:global") return "\u{1F310}";
	if (node.id.startsWith("wiki-root:")) return "\u{1F4C2}";
	return NODE_TYPE_ICONS[node.type] || "\u{1F4C4}";
}

interface WikiTreeProps {
	childrenByNode: Record<string, WikiNode[]>;
	childrenLoaded: Record<string, boolean>;
	loadingChildren: Record<string, boolean>;
	rootId: string;
	selectedNodeId: string | null;
	onSelect: (nodeId: string) => void;
	onExpand: (nodeId: string) => void;
}

export default function WikiTree({
	childrenByNode, childrenLoaded, loadingChildren, rootId,
	selectedNodeId, onSelect, onExpand,
}: WikiTreeProps) {
	// Expanded node ids (local UI state). Root is expanded by default once its
	// children have loaded.
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootId]));

	// If the root changes (scope switch) or root children land, auto-expand it.
	useEffect(() => {
		setExpanded(new Set([rootId]));
	}, [rootId]);

	const toggle = (id: string, hasKids: boolean) => {
		if (!hasKids && !childrenLoaded[id]) {
			// Directory not yet loaded → expanding must fetch first.
			onExpand(id);
			setExpanded((prev) => new Set(prev).add(id));
			return;
		}
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const rows: Array<{ node: WikiNode; depth: number }> = [];
	const walk = (parentId: string, depth: number) => {
		const kids = childrenByNode[parentId] ?? [];
		for (const child of kids) {
			rows.push({ node: child, depth });
			if (expanded.has(child.id)) {
				// If expanded but children not yet loaded → show a Loading row
				// (the store fetches them; this re-renders when they arrive).
				if (childrenLoaded[child.id]) {
					walk(child.id, depth + 1);
				} else {
					rows.push({ node: { id: `__loading_${child.id}`, title: "Loading…", type: "header", path: "" } as WikiNode, depth: depth + 1 });
					onExpand(child.id);
				}
			}
		}
	};
	walk(rootId, 0);

	if (rows.length === 0) {
		return (
			<div data-testid="wiki-tree" style={{
				padding: 20, textAlign: "center", fontSize: 12,
				color: "var(--text-tertiary, #555)",
			}}>
				{loadingChildren[rootId] ? "Loading…" : "No wiki nodes in this view."}
			</div>
		);
	}

	return (
		<div data-testid="wiki-tree" style={{ overflowY: "auto", padding: "4px 0" }}>
			{rows.map(({ node, depth }) => {
				const isLoader = node.id.startsWith("__loading_");
				const hasChildrenLoaded = childrenLoaded[node.id];
				const childrenCount = (childrenByNode[node.id]?.length ?? 0);
				// A node can be expanded if it's a container type OR its children
				// have been loaded (even if currently empty — empty dirs collapse).
				const canExpand = node.type === "structure" || node.type === "project" || hasChildrenLoaded || childrenCount > 0;
				const isExpanded = expanded.has(node.id);
				const isSelected = node.id === selectedNodeId;
				return (
					<div
						key={node.id}
						data-testid="wiki-tree-node"
						data-node-id={node.id}
						data-node-type={node.type}
						onClick={() => !isLoader && onSelect(node.id)}
						style={{
							display: "flex", alignItems: "center", gap: 4,
							padding: "3px 8px", paddingLeft: depth * 14 + 8,
							cursor: isLoader ? "default" : "pointer",
							background: isSelected ? "var(--bg-active, #2a2a2e)" : "transparent",
							borderRadius: 4, fontSize: 12,
							color: isSelected ? "var(--text-primary, #e0e0e0)" : isLoader ? "var(--text-tertiary, #666)" : "var(--text-secondary, #888)",
							whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
							fontStyle: isLoader ? "italic" : "normal",
						}}
						onMouseEnter={(e) => { if (!isSelected && !isLoader) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-hover, #252528)"; }}
						onMouseLeave={(e) => { if (!isSelected && !isLoader) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
					>
						{canExpand ? (
							<span
								onClick={(e) => { e.stopPropagation(); toggle(node.id, childrenCount > 0); }}
								style={{ fontSize: 10, width: 12, textAlign: "center", flexShrink: 0, userSelect: "none" }}
							>
								{loadingChildren[node.id] ? "⋯" : isExpanded ? "▾" : "▸"}
							</span>
						) : (
							<span style={{ width: 12, flexShrink: 0 }} />
						)}
						<span style={{ flexShrink: 0 }}>{isLoader ? "" : iconFor(node)}</span>
						<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
							{node.title || node.path}
						</span>
					</div>
				);
			})}
		</div>
	);
}
