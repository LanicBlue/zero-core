// TaskTree panel (chat middle pane, 3rd section).
//
// Lists delegated tasks spawned by the active chat session (parent_session_id
// = activeSessionId), pull-on-display + slow poll for live progress. Clicking
// a task dispatches zero-task-select → the right DocViewerPanel renders the
// task content + runtime status.
//
// "task" here is a runtime delegated execution instance — NOT project "work"
// (which is a project-level config definition, shown in ProjectPage).
//
import React, { useEffect } from "react";
import { useChatStore } from "../../store/chat-store.js";
import { useTaskStore } from "../../store/task-store.js";
import type { DelegatedTaskRecord } from "../../../shared/types.js";

const STATUS_ICON: Record<string, string> = {
	running: "●",
	finishing: "◐",
	completed: "✓",
	failed: "✗",
	killed: "⊘",
	interrupted: "⌽",
};

export default function TaskTreePanel() {
	const activeSessionId = useChatStore((s) => s.activeSessionId);
	const { tasksBySession, loadingBySession, selectedTaskId, selectTask, startPolling, stopPolling } = useTaskStore();

	// Pull-on-display: poll while this session is the active one; stop on switch-away.
	useEffect(() => {
		if (!activeSessionId) return;
		startPolling(activeSessionId);
		return () => { stopPolling(activeSessionId); };
	}, [activeSessionId, startPolling, stopPolling]);

	const tasks = activeSessionId ? (tasksBySession[activeSessionId] ?? []) : [];
	const loading = activeSessionId ? loadingBySession[activeSessionId] : false;

	const onSelect = (t: DelegatedTaskRecord) => {
		selectTask(t.id);
		window.dispatchEvent(new CustomEvent("zero-task-select", { detail: { task: t } }));
	};

	return (
		<div className="task-tree-panel">
			<div className="task-tree-header">
				<span>TASKS · 委派任务</span>
				{loading && <span className="task-tree-loading">…</span>}
			</div>
			<div className="task-tree-body">
				{!activeSessionId ? (
					<div className="doc-placeholder">No session selected.</div>
				) : tasks.length === 0 ? (
					<div className="doc-placeholder">本会话暂无委派任务。</div>
				) : tasks.map((t) => (
					<button
						key={t.id}
						type="button"
						className={`task-card${selectedTaskId === t.id ? " task-card-selected" : ""}`}
						onClick={() => onSelect(t)}
						title={t.task}
					>
						<div className="task-card-row">
							<span className={`task-status-icon task-status-${t.status}`}>{STATUS_ICON[t.status] ?? "?"}</span>
							<span className="task-card-target">{t.targetAgentId}</span>
							<span className="task-card-status">{t.status}</span>
						</div>
						<div className="task-card-task">{t.task.length > 60 ? t.task.slice(0, 60) + "…" : t.task}</div>
						<div className="task-card-meta">
							<span>turns:{t.turns}</span>
							<span>tokens:{t.tokens}</span>
							{t.currentTool && <span>tool:{t.currentTool}</span>}
						</div>
					</button>
				))}
			</div>
		</div>
	);
}
