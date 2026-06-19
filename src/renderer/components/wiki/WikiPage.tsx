// Wiki 浏览页面 (v0.8 P8 升级为全局树浏览器, RFC §10.9)
//
// # 文件说明书
//
// ## 核心功能
// 全局 wiki 记忆树浏览器。左树(按视角可见域截断)+ 右节点正文(磁盘懒
// 加载)。
//
// 视角(scope)切换可见域:
//   - Global  → 整树(zero 视角,看见 knowledge/projects/memory)。
//   - Project → 该项目子树(项目角色视角,store 层守卫一致)。
//
// 右侧正文走 wiki:readDetail(磁盘);对项目子树 header/intent 节点提供
// docPointer 跳转原文(读 workspaceDir 相对路径,主进程沙箱)。
//
// ## 输入
// - wikiStore(scope/nodes/detail/refresh/expandNode/readWorkspaceDoc/search)
// - projectStore(列出项目供 scope 选择)
// - pageStore(记忆 activeWikiProjectId 旧槽位,P8 复用为 scope 记忆)
//
// ## 输出
// - 渲染的 Wiki 浏览页面
//
// ## 定位
// 渲染进程组件,被 AppLayout 使用。
//
// ## 依赖
// - react
// - ../../store/*
//
// ## 维护规则
// - scope/可见域变更需同步 wiki-store + 此页
// - 新增 wiki action 挂到工具栏或右键菜单
//
import React, { useEffect, useState } from "react";
import { useWikiStore, type WikiViewScope } from "../../store/wiki-store.js";
import { useProjectStore } from "../../store/project-store.js";
import { usePageStore } from "../../store/page-store.js";
import { useNotificationStore } from "../../store/notification-store.js";
import WikiTree from "./WikiTree.js";
import WikiDetail from "./WikiDetail.js";
import type { WikiNode } from "../../../shared/types.js";

/**
 * Extract a workspace-relative path from a header/intent node's wiki path.
 * Must stay in sync with WikiDetail.docPointerRelPath.
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

export default function WikiPage() {
	const { nodes, scope, setScope, refresh, selectedNodeId, selectNode, expandNode, detailByNode, readWorkspaceDoc, search, loading } = useWikiStore();
	const { projects, fetchProjects } = useProjectStore();
	const { activeWikiProjectId, setActiveWikiProjectId } = usePageStore();
	const addError = useNotificationStore((s) => s.addError);

	const [query, setQuery] = useState("");
	const [searchHits, setSearchHits] = useState<WikiNode[] | null>(null);
	const [originalDoc, setOriginalDoc] = useState<{ title: string; content: string } | null>(null);

	// Fetch projects on mount (for the scope selector).
	useEffect(() => {
		fetchProjects();
	}, []);

	// Initial tree load (scope defaults to global in the store).
	useEffect(() => {
		void refresh();
	}, []);

	// Restore scope from page-store memory (legacy activeWikiProjectId slot).
	useEffect(() => {
		if (activeWikiProjectId && scope.kind === "global" && projects.some((p) => p.id === activeWikiProjectId)) {
			setScope({ kind: "project", projectId: activeWikiProjectId });
		}
	}, [projects]);

	const selectedNode = nodes.find((n) => n.id === selectedNodeId);
	const selectedDetail = selectedNodeId ? detailByNode[selectedNodeId] : undefined;

	const handleScopeChange = (value: string) => {
		setOriginalDoc(null);
		if (value === "global") {
			setActiveWikiProjectId(null);
			setScope({ kind: "global" });
		} else {
			setActiveWikiProjectId(value);
			setScope({ kind: "project", projectId: value } as WikiViewScope);
		}
	};

	const handleRefresh = () => void refresh();

	const handleOpenOriginal = async (node: WikiNode) => {
		const rel = docPointerRelPath(node);
		if (!rel || !node.projectId) return;
		const res = await readWorkspaceDoc(node.projectId, rel);
		if (res.error) {
			addError(res.error);
			setOriginalDoc(null);
			return;
		}
		setOriginalDoc({ title: rel, content: res.content ?? "" });
	};

	const handleEdit = async (nodeId: string, data: { summary?: string; detail?: string }) => {
		// P8: editing stays via the legacy wiki:updateNode IPC for project
		// subtree nodes. Detail goes through the disk-write path on the server.
		try {
			const result = await (window as any).api.wikiUpdateNode(nodeId, data);
			if (result && typeof result === "object" && "error" in result) {
				addError(result.error);
				return;
			}
			// Refresh to pick up the new summary/title; re-expand body so the
			// edited detail shows.
			await refresh();
			await expandNode(nodeId);
		} catch (err: any) {
			addError(err?.message || "Failed to update wiki node");
		}
	};

	const handleSearch = async () => {
		if (!query.trim()) {
			setSearchHits(null);
			return;
		}
		const hits = await search(query.trim());
		setSearchHits(hits);
	};

	const scopeValue = scope.kind === "global" ? "global" : scope.projectId;

	// When search results are showing, render them as the tree's node set so
	// the user can click into them. Searching across the WHOLE visible domain
	// (store.search uses scopeAnchors).
	const treeNodes = searchHits ?? nodes;

	return (
		<div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-primary, #1a1a1c)" }}>
			{/* Header */}
			<div style={{
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "12px 16px",
				borderBottom: "1px solid var(--border-color, #333)",
			}}>
				<span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
					{"\u{1F4D6}"} Wiki Browser
				</span>
				<div style={{ flex: 1 }} />
				<select
					value={scopeValue}
					onChange={(e) => handleScopeChange(e.target.value)}
					aria-label="Wiki view scope"
					style={selectStyle}
				>
					<option value="global">Global (all)</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>Project: {p.name}</option>
					))}
				</select>
				<input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
					placeholder="Search wiki..."
					aria-label="Search wiki"
					style={{ ...selectStyle, width: 160 }}
				/>
				<button type="button" onClick={handleSearch} style={smallBtnStyle}>Go</button>
				{searchHits && (
					<button type="button" onClick={() => { setSearchHits(null); setQuery(""); }} style={smallBtnStyle}>Clear</button>
				)}
				<button
					type="button"
					onClick={handleRefresh}
					disabled={loading}
					style={smallBtnStyle}
					aria-label="Refresh wiki tree"
				>
					{loading ? "..." : "\u{1F504}"}
				</button>
			</div>
			{searchHits && (
				<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)", padding: "4px 16px", borderBottom: "1px solid var(--border-color, #333)" }}>
					{searchHits.length} match{searchHits.length === 1 ? "" : "es"} for "{query}"
				</div>
			)}

			{/* Body: Tree + Detail */}
			<div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
				{/* Left: Tree */}
				<div style={{
					width: 280,
					minWidth: 220,
					borderRight: "1px solid var(--border-color, #333)",
					overflowY: "auto",
				}}>
					<WikiTree
						nodes={treeNodes}
						selectedNodeId={selectedNodeId}
						onSelect={selectNode}
					/>
				</div>

				{/* Right: Detail (or original-doc viewer) */}
				<div style={{ flex: 1, overflow: "hidden" }}>
					{originalDoc ? (
						<div style={{ padding: 16, height: "100%", display: "flex", flexDirection: "column" }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
								<span style={{ fontSize: 13, fontFamily: "monospace", color: "var(--text-primary, #e0e0e0)", wordBreak: "break-all" }}>
									{"\u{1F4C4}"} {originalDoc.title}
								</span>
								<div style={{ flex: 1 }} />
								<button type="button" onClick={() => setOriginalDoc(null)} style={smallBtnStyle}>Back to node</button>
							</div>
							<pre style={{
								flex: 1,
								margin: 0,
								padding: 12,
								background: "var(--bg-secondary, #1c1c1e)",
								border: "1px solid var(--border-color, #333)",
								borderRadius: 6,
								fontSize: 11,
								color: "var(--text-primary, #e0e0e0)",
								overflow: "auto",
								whiteSpace: "pre-wrap",
							}}>
								{originalDoc.content || "(empty file)"}
							</pre>
						</div>
					) : (
						<WikiDetail
							node={selectedNode ?? null}
							detail={selectedDetail}
							onExpand={expandNode}
							onOpenOriginal={handleOpenOriginal}
							onEdit={handleEdit}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

const selectStyle: React.CSSProperties = {
	padding: "4px 8px",
	background: "var(--bg-secondary, #1c1c1e)",
	border: "1px solid var(--border-color, #333)",
	borderRadius: 4,
	color: "var(--text-primary, #e0e0e0)",
	fontSize: 12,
};

const smallBtnStyle: React.CSSProperties = {
	padding: "4px 10px",
	background: "transparent",
	border: "1px solid var(--border-color, #333)",
	borderRadius: 4,
	color: "var(--text-secondary, #888)",
	fontSize: 12,
	cursor: "pointer",
};
