// Wiki 节点树面板(chat 中间栏下半段)
//
// # 文件说明书
//
// ## 核心功能
// 在 chat 中间栏下段渲染 wiki 节点树。**根节点 = 该 (agent, session) 实际注入
// 上下文的锚点**(后端 resolveAnchors 解析,与 AgentLoop 同源),每根标注入入
// 通道:system(进 system prompt)/ context(每轮重算)/ off(只算 scope)。
//   - project session + agent 无显式 anchor → 通常 [PROJECT(system) + MEMORY(context)]
//   - zero / global agent → [GLOBAL(off,整树只算 scope 不注入)]
//   - 任意 free wikiAnchors → 按各自 inject 显示
//
// 点节点 → readDetail 读摘要+正文 → 派发 zero-wiki-select {title, summary,
// content},由右侧 DocViewerPanel 打开(摘要+正文,与文件树点击共用右侧栏)。
//
// 复用 useWikiStore + WikiTree(与 WikiPage 同源)。childrenByNode 按 parentId
// 索引,多根共存无冲突;expandNode 幂等,逐根懒加载直接子节点。
//
// ## 输入
// - chat-store(activeAgentId / activeSessionId / sessionsByAgent)
// - preload wikiResolvedAnchors(agentId, projectId?) → ResolvedAnchorView[]
// - wiki-store(childrenByNode / loaded / loading / expandNode / selectNode ...)
//
// ## 定位
// src/renderer/components/layout/ — 被 MiddlePanel 作为下段嵌入。
//
import React, { useEffect, useState } from "react";
import { useChatStore, selectActiveAgentId } from "../../store/chat-store.js";
import { useWikiStore } from "../../store/wiki-store.js";
import WikiTree from "../wiki/WikiTree.js";
import type { ResolvedAnchorView } from "../../../shared/types.js";

// Per-root collapse state lives at module scope so it survives panel re-renders
// (anchor list refresh) without resetting every time. Roots start expanded.
const collapsedRoots = new Set<string>();

const api = () => (window as any).api;

const INJECT_LABEL: Record<ResolvedAnchorView["inject"], string> = {
	system: "system",
	context: "context",
	off: "scope",
};
const INJECT_TITLE: Record<ResolvedAnchorView["inject"], string> = {
	system: "注入 system prompt(可缓存)",
	context: "每轮注入 context(重算)",
	off: "只算 scope 锚点(不注入 prompt)",
};

export default function WikiTreePanel() {
	const activeAgentId = useChatStore(selectActiveAgentId);
	const activeSessionId = useChatStore((s) => s.activeSessionId);
	const sessionsByAgent = useChatStore((s) => s.sessionsByAgent);

	const session = (sessionsByAgent[activeAgentId ?? ""] ?? []).find((s: { id: string }) => s.id === activeSessionId);
	const projectId = session?.context?.projectId;

	const {
		childrenByNode, childrenLoaded, loadingChildren,
		selectedNodeId, selectNode, expandNode, readDetail, detailByNode, nodeById,
	} = useWikiStore();

	// 实际注入的锚点(与 AgentLoop 同源)。agent/project 变化时重拉。
	const [anchors, setAnchors] = useState<ResolvedAnchorView[]>([]);
	useEffect(() => {
		if (!activeAgentId) { setAnchors([]); return; }
		let cancelled = false;
		api().wikiResolvedAnchors(activeAgentId, projectId)
			.then((a: ResolvedAnchorView[]) => { if (!cancelled) setAnchors(a ?? []); })
			.catch(() => { if (!cancelled) setAnchors([]); });
		return () => { cancelled = true; };
	}, [activeAgentId, projectId]);

	const rootsKey = anchors.map((a) => a.nodeId).join(",");

	// 逐根懒加载直接子节点(expandNode 幂等:已加载/加载中则跳过)。wiki 被
	// 改时 wiki-store 的增量订阅只刷新受影响分支的 childrenByNode,本组件响应
	// 式读取即可更新,无需这里重跑。
	useEffect(() => {
		for (const a of anchors) {
			void expandNode(a.nodeId);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rootsKey, expandNode]);

	// 选中节点 → 读摘要+正文。
	useEffect(() => {
		if (selectedNodeId) void readDetail(selectedNodeId);
	}, [selectedNodeId, readDetail]);

	// 摘要/正文就绪 → 派发到右侧文档栏。
	const body = selectedNodeId ? detailByNode[selectedNodeId] : undefined;
	const summary = selectedNodeId ? nodeById[selectedNodeId]?.summary : undefined;
	useEffect(() => {
		if (!selectedNodeId) return;
		const n = useWikiStore.getState().nodeById[selectedNodeId];
		window.dispatchEvent(new CustomEvent("zero-wiki-select", {
			detail: {
				title: n?.title ?? selectedNodeId,
				summary: n?.summary ?? "",
				content: body ?? "",
			},
		}));
	}, [selectedNodeId, body, summary]);

	// Re-render when a root's collapse state flips (module-scope Set needs a
	// tick to reflect the change).
	const [, setTick] = useState(0);
	const toggleRoot = (nodeId: string) => {
		if (collapsedRoots.has(nodeId)) collapsedRoots.delete(nodeId);
		else collapsedRoots.add(nodeId);
		setTick((t) => t + 1);
	};

	return (
		<div className="wiki-tree-panel">
			<div className="wiki-tree-body">
				{anchors.length === 0 ? (
					<div className="doc-placeholder">{activeAgentId ? "无 wiki 锚点。" : "No agent selected."}</div>
				) : anchors.map((a) => {
					const collapsed = collapsedRoots.has(a.nodeId);
					return (
						<div key={a.nodeId} className="wiki-root-section">
							<button
								type="button"
								className="wiki-root-label"
								onClick={() => toggleRoot(a.nodeId)}
								title={INJECT_TITLE[a.inject]}
							>
								<span className="wiki-root-caret">{collapsed ? "▸" : "▾"}</span>
								<span className="wiki-root-title">{a.title || a.nodeId}</span>
								<span className={`wiki-inject-badge wiki-inject-${a.inject}`}>
									{INJECT_LABEL[a.inject]}
								</span>
							</button>
							{!collapsed && (
								<WikiTree
									childrenByNode={childrenByNode}
									childrenLoaded={childrenLoaded}
									loadingChildren={loadingChildren}
									rootId={a.nodeId}
									selectedNodeId={selectedNodeId}
									onSelect={selectNode}
									onExpand={expandNode}
								/>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
