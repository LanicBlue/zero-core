// Wiki 浏览页面
//
// # 文件说明书
//
// ## 核心功能
// Wiki 浏览器主页面，左右分栏布局：左侧树 + 右侧详情。
//
// ## 输入
// - wikiStore (Zustand)
// - projectStore (Zustand)
// - pageStore (Zustand)
//
// ## 输出
// - 渲染的 Wiki 浏览页面
//
// ## 定位
// 渲染进程组件，被 AppLayout 使用。
//
// ## 依赖
// - react
// - ../../store/*
//
// ## 维护规则
// - 分栏布局或 store 订阅变更时同步本组件
// - 新增 wiki 操作需挂接 WikiTree/WikiDetail 并在 store 暴露方法
//
import React, { useEffect, useState } from "react";
import { useWikiStore } from "../../store/wiki-store.js";
import { useProjectStore } from "../../store/project-store.js";
import { usePageStore } from "../../store/page-store.js";
import WikiTree from "./WikiTree.js";
import WikiDetail from "./WikiDetail.js";

export default function WikiPage() {
	const { fetchWikiTree, selectedNodeId, selectNode, expandNode, updateNode, getSelectedNode, getNodesForProject, loading } = useWikiStore();
	const { projects, fetchProjects } = useProjectStore();
	const { activeWikiProjectId, setActiveWikiProjectId } = usePageStore();

	const [localProjectId, setLocalProjectId] = useState<string>(activeWikiProjectId || "");

	// Fetch projects on mount
	useEffect(() => {
		fetchProjects();
	}, []);

	// Auto-select first project if none selected
	useEffect(() => {
		if (!localProjectId && projects.length > 0) {
			const firstId = projects[0].id;
			setLocalProjectId(firstId);
			setActiveWikiProjectId(firstId);
		}
	}, [projects, localProjectId]);

	// Fetch wiki tree when project changes
	useEffect(() => {
		if (localProjectId) {
			fetchWikiTree(localProjectId);
		}
	}, [localProjectId]);

	const nodes = getNodesForProject(localProjectId);
	const selectedNode = getSelectedNode();

	const handleProjectChange = (projectId: string) => {
		setLocalProjectId(projectId);
		setActiveWikiProjectId(projectId);
		selectNode(null);
	};

	const handleRefresh = () => {
		if (localProjectId) {
			fetchWikiTree(localProjectId);
		}
	};

	const handleExpand = async (nodeId: string) => {
		await expandNode(nodeId);
	};

	const handleEdit = async (nodeId: string, data: any) => {
		await updateNode(nodeId, data);
		if (localProjectId) {
			fetchWikiTree(localProjectId);
		}
	};

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
					{"\u{1F4D6}"} Project Wiki
				</span>
				<div style={{ flex: 1 }} />
				<select
					value={localProjectId}
					onChange={(e) => handleProjectChange(e.target.value)}
					style={{
						padding: "4px 8px",
						background: "var(--bg-secondary, #1c1c1e)",
						border: "1px solid var(--border-color, #333)",
						borderRadius: 4,
						color: "var(--text-primary, #e0e0e0)",
						fontSize: 12,
					}}
				>
					<option value="">-- Select Project --</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>{p.name}</option>
					))}
				</select>
				<button
					type="button"
					onClick={handleRefresh}
					disabled={loading || !localProjectId}
					style={{
						padding: "4px 10px",
						background: "transparent",
						border: "1px solid var(--border-color, #333)",
						borderRadius: 4,
						color: "var(--text-secondary, #888)",
						fontSize: 12,
						cursor: "pointer",
					}}
				>
					{loading ? "..." : "\u{1F504}"}
				</button>
			</div>

			{/* Body: Tree + Detail */}
			<div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
				{/* Left: Tree */}
				<div style={{
					width: 250,
					minWidth: 200,
					borderRight: "1px solid var(--border-color, #333)",
					overflowY: "auto",
				}}>
					<WikiTree
						nodes={nodes}
						selectedNodeId={selectedNodeId}
						onSelect={selectNode}
					/>
				</div>

				{/* Right: Detail */}
				<div style={{ flex: 1, overflow: "hidden" }}>
					<WikiDetail
						node={selectedNode || null}
						onExpand={handleExpand}
						onEdit={handleEdit}
					/>
				</div>
			</div>
		</div>
	);
}
