// Wiki 节点树面板(chat 中间栏下半段 · wiki-system-redesign plan-06)
//
// # 文件说明书
//
// ## 核心功能
// 在 chat 中间栏下段渲染 wiki 节点树,根节点 = 当前 (agentId, session) 的
// memory 子树根(`memory://<agentId>`),展开浏览该 agent 的 preferences /
// lessons / 任意 memory 子节点。
//
// plan-06 改造:从旧的"resolveAnchors + 多根锚点"模型迁到 canonical path
// + 单根 memory view(锚点注入模型已退役;AgentRecord.wikiAnchors 字段保留
// 到 plan-08,但 runtime 不再读)。
//
// 点节点 → loadDetail 读摘要 + 正文 → 派发 zero-wiki-select {title, summary,
// content},由右侧 DocViewerPanel 打开。
//
// ## 输入
//   - chat-store(activeAgentId / activeSessionId / sessionsByAgent)
//   - wiki-store(canonical path keyed —— scope=agent-memory)
//
import React, { useEffect } from "react";
import { useChatStore, selectActiveAgentId } from "../../store/chat-store.js";
import { useWikiStore } from "../../store/wiki-store.js";
import WikiTree from "../wiki/WikiTree.js";

export default function WikiTreePanel() {
	const activeAgentId = useChatStore(selectActiveAgentId);

	const setScope = useWikiStore((s) => s.setScope);
	const selectedPath = useWikiStore((s) => s.selectedPath);
	const loadDetail = useWikiStore((s) => s.loadDetail);
	const detailByPath = useWikiStore((s) => s.detailByPath);
	const summaryByPath = useWikiStore((s) => s.summaryByPath);

	// 切 agent → 切 wiki scope 到该 agent 的 memory 子树。
	useEffect(() => {
		if (!activeAgentId) return;
		setScope({ kind: "agent-memory", agentId: activeAgentId });
	}, [activeAgentId, setScope]);

	// 选中节点 → 读 detail。
	useEffect(() => {
		if (selectedPath) void loadDetail(selectedPath);
	}, [selectedPath, loadDetail]);

	// 摘要 / 正文就绪 → 派发到右侧文档栏(与 FileTreePanel 共用 DocViewer)。
	const detail = selectedPath ? detailByPath[selectedPath] : undefined;
	const summary = selectedPath ? summaryByPath[selectedPath] : undefined;
	useEffect(() => {
		if (!selectedPath) return;
		const s = summary ?? {};
		const d = useWikiStore.getState().detailByPath[selectedPath];
		window.dispatchEvent(new CustomEvent("zero-wiki-select", {
			detail: {
				title: s.displayTitle ?? selectedPath,
				summary: s.summary ?? "",
				content: d?.content ?? "",
			},
		}));
	}, [selectedPath, detail, summary]);

	if (!activeAgentId) {
		return (
			<div className="wiki-tree-panel">
				<div className="wiki-tree-body">
					<div className="doc-placeholder">No agent selected.</div>
				</div>
			</div>
		);
	}

	return (
		<div className="wiki-tree-panel">
			<div className="wiki-tree-body">
				<WikiTree
					rootAddress={`memory://${activeAgentId}`}
					showArchived={false}
				/>
			</div>
		</div>
	);
}
