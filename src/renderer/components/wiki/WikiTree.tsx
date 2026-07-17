// Wiki 树组件(wiki-system-redesign plan-06 §4 · canonical path key)
//
// # 文件说明书
//
// ## 核心功能
// 渲染 wiki 浏览器的左树。**逐层懒加载 + 分页**:
//   - 从 root 的首屏直接 children 开始渲染(limit=50)。
//   - 点展开才请求下一层;同层超过 50 个时显示"Load more"按钮(分页 cursor)。
//   - 1,000 同级 child 不一次拉完(acceptance-06 §B.7)。
//
// **canonical path 是公开 key** —— React key 用 path,store state 用 path,
// 不接收内部 DB 整数 ID。
//
// ## 视觉
//   - kind/source/sync 状态图标。
//   - source-bound 节点(项目镜像)显著标识。
//   - archived 节点默认隐藏,showArchived=true 时灰显。
//   - loading/error/empty 各自状态。
//
// ## 输入
//   - rootAddress: scope root 的 logical/canonical address(POST /expand input)。
//   - showArchived: 是否显示归档节点(默认隐藏)。
//
import React, { useState, useEffect } from "react";
import { useWikiStore } from "../../store/wiki-store.js";

const KIND_ICON: Record<string, string> = {
	root: "\u{1F310}",
	namespace: "\u{1F4D1}",
	project: "\u{1F4C2}",
	directory: "\u{1F4C1}",
	source_file: "\u{1F4C4}",
	source_symlink: "\u{1F517}",
	source_submodule: "\u{1F500}",
	knowledge: "\u{1F4DA}",
	memory: "\u{1F9E0}",
	node: "\u{1F4DD}",
};

function kindIcon(kind: string | undefined, archived: boolean | undefined): string {
	if (archived) return "\u{1F5D1}";
	return (kind && KIND_ICON[kind]) || "\u{1F4C4}";
}

interface WikiTreeProps {
	rootAddress: string;
	showArchived: boolean;
}

export default function WikiTree({ rootAddress, showArchived }: WikiTreeProps) {
	const childrenByPath = useWikiStore((s) => s.childrenByPath);
	const childrenLoaded = useWikiStore((s) => s.childrenLoaded);
	const loadingChildren = useWikiStore((s) => s.loadingChildren);
	const summaryByPath = useWikiStore((s) => s.summaryByPath);
	const selectedPath = useWikiStore((s) => s.selectedPath);
	const selectPath = useWikiStore((s) => s.selectPath);
	const expandPath = useWikiStore((s) => s.expandPath);
	const loadMoreChildren = useWikiStore((s) => s.loadMoreChildren);

	// Expanded canonical-path set (local UI state). Root auto-expanded on mount.
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootAddress]));

	useEffect(() => {
		setExpanded(new Set([rootAddress]));
	}, [rootAddress]);

	// 首次挂载触发 root expand(store 幂等,已加载则 skip)。
	useEffect(() => {
		void expandPath(rootAddress);
	}, [rootAddress, expandPath]);

	const toggle = (path: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
		// 展开 = 触发首屏 children 拉取(若未加载)。
		if (!childrenLoaded[path] && !loadingChildren[path]) {
			void expandPath(path);
		}
	};

	// 构造可见行列表(walk expanded paths)。
	const rows: Array<{
		path: string;
		depth: number;
		summary: { displayTitle?: string; kind?: string; summary?: string; archived?: boolean };
	}> = [];
	const walk = (parent: string, depth: number) => {
		const page = childrenByPath[parent];
		if (!page) return;
		for (const child of page.items) {
			const summary = summaryByPath[child.path] ?? {
				displayTitle: child.displayTitle,
				kind: child.kind,
				summary: child.summary,
				archived: child.archived,
			};
			// archived 节点默认隐藏(除非 showArchived=true)。
			if (summary.archived && !showArchived) continue;
			rows.push({ path: child.path, depth, summary });
			if (expanded.has(child.path)) {
				if (childrenLoaded[child.path]) {
					walk(child.path, depth + 1);
				} else {
					// 已展开但未加载 → 占位;展开副作用会触发拉取。
					rows.push({
						path: `__loading:${child.path}`,
						depth: depth + 1,
						summary: { displayTitle: "Loading…", kind: "node" },
					});
					if (!loadingChildren[child.path]) void expandPath(child.path);
				}
			}
		}
	};
	walk(rootAddress, 0);

	const rootPage = childrenByPath[rootAddress];
	const rootLoading = loadingChildren[rootAddress];

	if (rows.length === 0) {
		return (
			<div data-testid="wiki-tree" style={{
				padding: 20, textAlign: "center", fontSize: 12,
				color: "var(--text-tertiary, #555)",
			}}>
				{rootLoading ? "Loading…" : "No wiki nodes in this view."}
			</div>
		);
	}

	return (
		<div data-testid="wiki-tree" style={{ overflowY: "auto", padding: "4px 0" }}>
			{rows.map(({ path, depth, summary }) => {
				const isLoadingRow = path.startsWith("__loading:");
				const realPath = isLoadingRow ? path.slice("__loading:".length) : path;
				const isExpanded = expanded.has(realPath);
				const isSelected = selectedPath === realPath;
				const page = childrenByPath[realPath];
				const hasPage = !!page && page.items.length > 0;
				const canExpand = !isLoadingRow && (hasPage || !!childrenLoaded[realPath]);
				return (
					<div
						key={path}
						data-testid="wiki-tree-node"
						data-node-path={realPath}
						data-node-kind={summary.kind}
						onClick={() => !isLoadingRow && selectPath(realPath)}
						style={{
							display: "flex", alignItems: "center", gap: 4,
							padding: "3px 8px", paddingLeft: depth * 14 + 8,
							cursor: isLoadingRow ? "default" : "pointer",
							background: isSelected ? "var(--bg-active, #2a2a2e)" : "transparent",
							borderRadius: 4, fontSize: 12,
							color: isSelected
								? "var(--text-primary, #e0e0e0)"
								: isLoadingRow
									? "var(--text-tertiary, #666)"
									: summary.archived
										? "var(--text-tertiary, #777)"
										: "var(--text-secondary, #888)",
							whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
							fontStyle: isLoadingRow || summary.archived ? "italic" : "normal",
						}}
					>
						{canExpand ? (
							<span
								onClick={(e) => { e.stopPropagation(); toggle(realPath); }}
								style={{ fontSize: 10, width: 12, textAlign: "center", flexShrink: 0, userSelect: "none" }}
							>
								{loadingChildren[realPath] ? "⋯" : isExpanded ? "▾" : "▸"}
							</span>
						) : (
							<span style={{ width: 12, flexShrink: 0 }} />
						)}
						<span style={{ flexShrink: 0 }}>{kindIcon(summary.kind, summary.archived)}</span>
						<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
							{summary.displayTitle || realPath}
						</span>
						{summary.archived && (
							<span style={{ flexShrink: 0, fontSize: 9, color: "var(--text-tertiary, #555)" }}>
								archived
							</span>
						)}
					</div>
				);
			})}
			{/* Load-more 按钮(分页 cursor)。 */}
			{rootPage && rootPage.hasMore && (
				<div style={{ padding: "6px 8px 6px 14px" }}>
					<button
						type="button"
						onClick={() => loadMoreChildren(rootAddress)}
						disabled={!!loadingChildren[rootAddress]}
						style={loadMoreBtnStyle}
					>
						{loadingChildren[rootAddress] ? "Loading…" : "Load more"}
					</button>
				</div>
			)}
		</div>
	);
}

const loadMoreBtnStyle: React.CSSProperties = {
	padding: "3px 10px",
	background: "transparent",
	border: "1px solid var(--border-color, #333)",
	borderRadius: 4,
	color: "var(--text-secondary, #888)",
	fontSize: 11,
	cursor: "pointer",
};
