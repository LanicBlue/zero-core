// Delegated-task detail view (right pane, shown when a task is selected).
//
// # 文件说明书
//
// ## 核心功能
// 选中中间栏 task 树的一个委派任务时,右栏切到本视图,显示该委派 session 的
// 对话(用与主聊天一致的 MessageRow 渲染,只读)。任务 metadata(status/turns/
// tokens/tool)在中间栏列表显示(sub-1),右栏专心对话 —— 中间栏列表是摘要、
// 右栏是详情,且本对话是委派子 session 的,与主聊天不是同一个,不算重复。
//
// 历史:本视图原是"上 metadata + splitter + 下对话"两栏(2026-07 sub-2 简化)。
// metadata 上移中间栏后,右栏只留对话。
//
// ## 数据来源
// - record:api().delegatedTasksGet(taskId) → DelegatedTaskRecord(targetAgentId
//   取 avatar 字母;sessionId 取对话;无 record = live-only / bash 后台任务)。
// - 对话:api().sessionsGetInit(record.sessionId).messages —— 委派 session 的
//   turns 已落盘(Phase A 持久化),跨重启可读。
//
// ## 定位
// src/renderer/components/layout/ — 被 DocViewerPanel 在 task 模式下嵌入。
//
import React, { useEffect, useState } from "react";
import MessageRow from "../chat/MessageRow.js";
import type { ChatMessage } from "../../store/chat-store.js";
import type { DelegatedTaskRecord } from "../../../shared/types.js";

const api = () => (window as any).api;

interface Props {
	taskId: string;
}

export default function TaskDetailView({ taskId }: Props) {
	const [record, setRecord] = useState<DelegatedTaskRecord | undefined>(undefined);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(true);

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

	const avatarLetter = record?.targetAgentId?.[0]?.toUpperCase() ?? "Z";

	let body: React.ReactNode;
	if (loading) {
		body = <div className="doc-placeholder">…</div>;
	} else if (!record) {
		body = <div className="doc-placeholder">No persisted record for this task (live-only / bash background task).</div>;
	} else if (messages.length === 0) {
		body = <div className="doc-placeholder">No conversation recorded.</div>;
	} else {
		body = messages.map((m) => <MessageRow key={m.id} message={m} avatarLetter={avatarLetter} />);
	}

	return (
		<div className="task-detail-view">
			<div className="task-detail-conversation">
				<div className="task-detail-conversation-header">Conversation</div>
				<div className="task-detail-messages">{body}</div>
			</div>
		</div>
	);
}
