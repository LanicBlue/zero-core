// Delegated-task detail view (right pane, shown when a task is selected).
//
// # 文件说明书
//
// ## 核心功能
// 选中中间栏 task 树的一个委派任务时,右栏切到本视图:上栏 = 任务详情
// (id/状态/turns/tokens/工具/结果/错误),下栏 = 该委派 session 的对话,用
// 与主聊天一致的 MessageRow 渲染(只读)。上下栏可拖拽调高(复用
// .middle-splitter,镜像 MiddlePanel 的 weights 模式)。
//
// ## 数据来源
// - 详情:api().delegatedTasksGet(taskId) → DelegatedTaskRecord(含 sessionId)。
// - 对话:api().sessionsGetInit(record.sessionId).messages —— 委派 session 的
//   turns 已落盘(Phase A 持久化),跨重启可读。
//
// ## 定位
// src/renderer/components/layout/ — 被 DocViewerPanel 在 task 模式下嵌入。
//
import React, { useEffect, useRef, useState } from "react";
import MessageRow from "../chat/MessageRow.js";
import type { ChatMessage } from "../../store/chat-store.js";
import type { DelegatedTaskRecord } from "../../../shared/types.js";

const api = () => (window as any).api;

const MIN_WEIGHT = 0.2;

interface Props {
	taskId: string;
}

export default function TaskDetailView({ taskId }: Props) {
	const [record, setRecord] = useState<DelegatedTaskRecord | undefined>(undefined);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [detailWeight, setDetailWeight] = useState(1);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setRecord(undefined);
		setMessages([]);
		(async () => {
			try {
				const rec = (await api().delegatedTasksGet(taskId)) as DelegatedTaskRecord | undefined;
				if (cancelled) return;
				setRecord(rec);
				if (rec?.sessionId) {
					const init = await api().sessionsGetInit(rec.sessionId);
					if (cancelled) return;
					setMessages((init?.messages ?? []) as ChatMessage[]);
				}
			} catch {
				/* leave empty */
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => { cancelled = true; };
	}, [taskId]);

	// Row-resize between the detail pane (top) and conversation pane (bottom).
	const startDrag = (e: React.MouseEvent) => {
		e.preventDefault();
		const startY = e.clientY;
		const panelH = containerRef.current?.clientHeight ?? 1;
		const startWeight = detailWeight;
		const onMove = (ev: MouseEvent) => {
			const dy = ev.clientY - startY;
			// weight-space delta (total weight = 2 → scale by 2/panelH)
			let nw = startWeight + (dy * 2) / panelH;
			if (nw < MIN_WEIGHT) nw = MIN_WEIGHT;
			if (nw > 2 - MIN_WEIGHT) nw = 2 - MIN_WEIGHT;
			setDetailWeight(nw);
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		document.body.style.cursor = "row-resize";
	};

	const avatarLetter = record?.targetAgentId?.[0]?.toUpperCase() ?? "Z";

	return (
		<div className="task-detail-view" ref={containerRef}>
			<div className="task-detail-pane" style={{ flex: `${detailWeight} 1 0` }}>
				{loading ? (
					<div className="doc-placeholder">Loading…</div>
				) : !record ? (
					<div className="doc-placeholder">No persisted record for this task (live-only / bash background task).</div>
				) : (
					<dl className="task-detail-grid">
						<div><dt>Status</dt><dd className={`task-status-${record.status}`}>{record.status}</dd></div>
						<div><dt>Target</dt><dd>{record.targetAgentId}</dd></div>
						<div><dt>Turns</dt><dd>{record.turns}</dd></div>
						<div><dt>Tokens</dt><dd>{record.tokens}</dd></div>
						{record.currentTool && <div><dt>Tool</dt><dd>{record.currentTool}</dd></div>}
						<div className="task-detail-task"><dt>Task</dt><dd>{record.task}</dd></div>
						{record.error && <div className="task-detail-error"><dt>Error</dt><dd>{record.error}</dd></div>}
						{record.result && <div className="task-detail-result"><dt>Result</dt><dd>{record.result}</dd></div>}
					</dl>
				)}
			</div>
			<div className="middle-splitter" onMouseDown={startDrag} />
			<div className="task-detail-conversation" style={{ flex: `${2 - detailWeight} 1 0` }}>
				<div className="task-detail-conversation-header">Conversation</div>
				<div className="task-detail-messages">
					{messages.length === 0 ? (
						<div className="doc-placeholder">{loading ? "…" : "No conversation recorded."}</div>
					) : (
						messages.map((m) => <MessageRow key={m.id} message={m} avatarLetter={avatarLetter} />)
					)}
				</div>
			</div>
		</div>
	);
}
