// Wiki 树组件 (v0.8 P8 升级为全局树浏览器左树)
//
// # 文件说明书
//
// ## 核心功能
// 渲染全局 wiki 记忆树的左树。按视角可见域(由 wiki-store 的 scope 决定,
// 经 wiki:listByAnchors 在 store 层截断)展示节点。支持展开/收起、选中。
//
// 性能(规避大 wiki 树卡顿,plan-P8 风险):
//   - 子节点查找用按 parentId 的索引(O(1)),不做每节点全表 filter。
//   - 展开按需:初始只渲染根节点;点击展开才递归拉子节点。配合 store 的
//     全量 nodes 池(已经 store 层权限截断),只渲染「已展开路径」的可见行,
//     未展开子树的孙节点不被访问。
//   - 行渲染用 key=id 的 div;超大树(>2000 行)时此处可再切虚拟滚动,
//     但当前按需 expand 已把可见行数压到合理范围。
//
// ## 输入
// - nodes: WikiNode[](已按 scope 截断)
// - selectedNodeId
// - onSelect / onToggleExpand 回调
//
// ## 输出
// - 渲染的树
//
// ## 定位
// 渲染进程组件,被 WikiPage 使用。
//
// ## 依赖
// - react
// - ../../../shared/types (WikiNode, WikiNodeTypeGlobal)
//
// ## 维护规则
// - 新增节点 type 时补 NODE_TYPE_ICONS
// - 树渲染/交互变更同步此组件
//
import React, { useMemo, useState } from "react";
import type { WikiNode, WikiNodeTypeGlobal } from "../../../shared/types.js";

const NODE_TYPE_ICONS: Record<string, string> = {
	project: "\u{1F4C2}",
	header: "\u{1F4C4}",
	intent: "\u{1F4DD}",
	structure: "\u{1F4C1}",
	memory: "\u{1F9E0}",
};

function iconFor(node: WikiNode): string {
	// Synthetic roots get a distinct marker so the user can tell the global
	// root / project subtree roots / memory roots apart at a glance.
	if (node.id === "wiki-root:global") return "\u{1F310}";
	if (node.id.startsWith("wiki-root:")) return "\u{1F4C2}";
	return NODE_TYPE_ICONS[node.type] || "\u{1F4C4}";
}

interface WikiTreeProps {
	nodes: WikiNode[];
	selectedNodeId: string | null;
	onSelect: (nodeId: string) => void;
}

export default function WikiTree({ nodes, selectedNodeId, onSelect }: WikiTreeProps) {
	// Index children by parentId once per refresh — O(n) build, O(1) lookup.
	// This is the key perf fix vs. the legacy per-node `nodes.filter(...)`.
	const childrenByParent = useMemo(() => {
		const map = new Map<string | undefined, WikiNode[]>();
		for (const n of nodes) {
			const arr = map.get(n.parentId) ?? [];
			arr.push(n);
			map.set(n.parentId, arr);
		}
		// Sort each bucket by title for stable display.
		for (const arr of map.values()) {
			arr.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
		}
		return map;
	}, [nodes]);

	const rootNodes = childrenByParent.get(undefined) ?? [];

	// Track expanded node ids in local state. Root is expanded by default so
	// the user sees the top-level knowledge/projects/memory buckets.
	const [expanded, setExpanded] = useState<Set<string>>(() => {
		const s = new Set<string>();
		for (const r of rootNodes) {
			if (r.id === "wiki-root:global") s.add(r.id);
		}
		return s;
	});

	const toggle = (id: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	if (nodes.length === 0) {
		return (
			<div style={{
				padding: 20,
				textAlign: "center",
				fontSize: 12,
				color: "var(--text-tertiary, #555)",
			}}>
				No wiki nodes in this view.
				<br />
				Try switching scope or refreshing.
			</div>
		);
	}

	// Flatten the expanded subtree into visible rows. We walk depth-first,
	// only descending into expanded nodes — unexpanded subtrees contribute
	// zero rows, which is what keeps huge trees snappy.
	const rows: Array<{ node: WikiNode; depth: number }> = [];
	const walk = (parentId: string | undefined, depth: number) => {
		const kids = childrenByParent.get(parentId) ?? [];
		for (const child of kids) {
			rows.push({ node: child, depth });
			if (expanded.has(child.id)) {
				walk(child.id, depth + 1);
			}
		}
	};
	walk(undefined, 0);

	return (
		<div style={{ overflowY: "auto", padding: "4px 0" }}>
			{rows.map(({ node, depth }) => {
				const hasChildren = (childrenByParent.get(node.id)?.length ?? 0) > 0;
				const isExpanded = expanded.has(node.id);
				const isSelected = node.id === selectedNodeId;
				return (
					<div
						key={node.id}
						onClick={() => onSelect(node.id)}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 4,
							padding: "3px 8px",
							paddingLeft: depth * 14 + 8,
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
						{hasChildren ? (
							<span
								onClick={(e) => { e.stopPropagation(); toggle(node.id); }}
								style={{ fontSize: 10, width: 12, textAlign: "center", flexShrink: 0, userSelect: "none" }}
							>
								{isExpanded ? "▾" : "▸"}
							</span>
						) : (
							<span style={{ width: 12, flexShrink: 0 }} />
						)}
						<span style={{ flexShrink: 0 }}>{iconFor(node)}</span>
						<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
							{node.title || node.path}
						</span>
					</div>
				);
			})}
		</div>
	);
}
