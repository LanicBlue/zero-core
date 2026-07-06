// Delegated-task detail view (right pane, shown when a task is selected).
//
// # 文件说明书
//
// ## 核心功能
// 选中中间栏 task 树的一个委派任务时,右栏切到本视图:
//  - 顶部固定 info bar(不可调):agent / status / created / turns / tokens,
//    从 DelegatedTaskRecord 直接读。
//  - 下方对话(用与主聊天一致的 MessageRow 渲染,只读)。
// 中间栏列表是摘要、右栏是详情;对话是委派子 session 的,与主聊天不是同一个,
// 不算重复。
//
// 历史:本视图原是"上 metadata + splitter + 下对话"两栏 → 2026-07 sub-2 简化
// 成"只留对话" → 同期又加回固定 info bar(精简、不可调,区别于旧 splitter 两栏)。
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
import { useAgentStore } from "../../store/agent-store.js";
import type { DelegatedTaskRecord } from "../../../shared/types.js";
import { resolveAgentLabel } from "./task-label.js";

const api = () => (window as any).api;

interface Props {
	taskId: string;
}

// ISO → "2026-07-06 14:03" (local). Falls back to the raw string on parse fail.
function formatTimestamp(iso: string | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Compact token count (1234 → "1.2k").
function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
	return (n / 1_000_000).toFixed(1) + "M";
}

export default function TaskDetailView({ taskId }: Props) {
	const [record, setRecord] = useState<DelegatedTaskRecord | undefined>(undefined);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	// Live session context (model + current context fill), pulled from the
	// delegated session's init payload (same call that loads messages). Empty
	// until the payload resolves or if the session has no loop yet.
	const [sessionCtx, setSessionCtx] = useState<{ model?: { providerName: string; modelId: string }; contextUsed: number; contextWindow: number }>({ contextUsed: 0, contextWindow: 0 });
	const [loading, setLoading] = useState(true);
	// Resolve the delegated agent's NAME from the roster (consistent with the
	// middle-column TaskTree). Falls back to the raw id.
	const agents = useAgentStore((s) => s.agents);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setRecord(undefined);
		setMessages([]);
		setSessionCtx({ contextUsed: 0, contextWindow: 0 });
		(async () => {
			try {
				const rec = (await api().delegatedTasksGet(taskId)) as DelegatedTaskRecord | undefined;
				if (cancelled) return;
				setRecord(rec);
				if (rec?.sessionId) {
					const init = await api().sessionsGetInit(rec.sessionId);
					if (cancelled) return;
					setMessages((init?.messages ?? []) as ChatMessage[]);
					if (init) setSessionCtx({ model: init.model, contextUsed: init.inputTokens ?? 0, contextWindow: init.contextWindow ?? 0 });
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
	// Same resolution as the middle column (named target → its name; synthetic
	// `<parent>:sub` → parent name).
	const agentNameById = new Map<string, string>();
	for (const a of agents) agentNameById.set(a.id, a.name);
	const agentName = record ? resolveAgentLabel(record.targetAgentId, agentNameById) : "—";

	// Fixed info bar (not resizable): agent / status / model / created / turns
	// / tokens (cumulative) / context (current fill). Shown only when a
	// persisted record exists (bash / live-only tasks have no record → keep the
	// existing placeholder body).
	const contextLabel = sessionCtx.contextWindow > 0
		? `${formatTokens(sessionCtx.contextUsed)} / ${formatTokens(sessionCtx.contextWindow)}`
		: "—";
	// Prefer the model PERSISTED at delegation time (accurate for history,
	// including Subagent-tool overrides); fall back to the session's current
	// live model when the row predates the model_id column (legacy) or has none.
	const modelLabel = record?.modelId ?? sessionCtx.model?.modelId ?? "—";
	const modelTitle = record?.modelId
		?? (sessionCtx.model ? `${sessionCtx.model.providerName}/${sessionCtx.model.modelId}` : undefined);
	let info: React.ReactNode = null;
	if (record) {
		info = (
			<div className="task-detail-info">
				<div className="task-detail-info-row">
					<span className="task-detail-info-label">Agent</span>
					<span className="task-detail-info-value">{agentName}</span>
				</div>
				<div className="task-detail-info-row">
					<span className="task-detail-info-label">Status</span>
					<span className={`task-detail-info-value task-status-text task-status-${record.status}`}>{record.status}</span>
				</div>
				<div className="task-detail-info-row">
					<span className="task-detail-info-label">Model</span>
					<span className="task-detail-info-value" title={modelTitle}>{modelLabel}</span>
				</div>
				<div className="task-detail-info-row">
					<span className="task-detail-info-label">Created</span>
					<span className="task-detail-info-value">{formatTimestamp(record.createdAt)}</span>
				</div>
				<div className="task-detail-info-row">
					<span className="task-detail-info-label">Turns</span>
					<span className="task-detail-info-value">{record.turns}</span>
				</div>
				<div className="task-detail-info-row">
					<span className="task-detail-info-label">Tokens</span>
					<span className="task-detail-info-value">{formatTokens(record.tokens)}</span>
				</div>
				<div className="task-detail-info-row">
					<span className="task-detail-info-label">Context</span>
					<span className="task-detail-info-value">{contextLabel}</span>
				</div>
			</div>
		);
	}

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
			{info}
			<div className="task-detail-conversation">
				<div className="task-detail-conversation-header">Conversation</div>
				<div className="task-detail-messages">{body}</div>
			</div>
		</div>
	);
}
