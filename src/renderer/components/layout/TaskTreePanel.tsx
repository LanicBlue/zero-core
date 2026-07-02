// TaskTree panel (chat middle pane, 3rd section).
//
// Lists the LIVE in-memory tasks dispatched by the active chat session — the
// SAME source the agent's TaskList reads (runtimeTasks:bySession), so the UI
// and the agent agree on count/status and bash background tasks are visible.
// Tasks carry parentTaskId, so we render a real delegation tree (sub-agent of
// sub-agent), indented by depth. Clicking a task dispatches zero-task-select
// → the right DocViewerPanel renders the task content + runtime status.
//
// "task" here is a runtime delegated execution instance — NOT project "work"
// (which is a project-level config definition, shown in ProjectPage).
//
import React, { useEffect } from "react";
import { useChatStore } from "../../store/chat-store.js";
import { useTaskStore } from "../../store/task-store.js";
import type { RuntimeTaskInfo } from "../../../shared/types.js";

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

	// Rebuild the delegation tree from the flat list (parentTaskId links).
	// Roots = tasks with no parentTaskId; children grouped by parent.
	const byParent = new Map<string, RuntimeTaskInfo[]>();
	for (const t of tasks) {
		const key = t.parentTaskId ?? "__root__";
		const arr = byParent.get(key);
		if (arr) arr.push(t);
		else byParent.set(key, [t]);
	}

	const onSelect = (t: RuntimeTaskInfo) => {
		selectTask(t.id);
		window.dispatchEvent(new CustomEvent("zero-task-select", { detail: { task: t } }));
	};

	const renderNode = (t: RuntimeTaskInfo): React.ReactNode => {
		const children = byParent.get(t.id) ?? [];
		return (
			<div key={t.id} className="task-tree-node">
				<button
					type="button"
					className={`task-card${selectedTaskId === t.id ? " task-card-selected" : ""}`}
					onClick={() => onSelect(t)}
					title={t.task}
				>
					<div className="task-card-row">
						<span className={`task-status-icon task-status-${t.status}`}>{STATUS_ICON[t.status] ?? "?"}</span>
						<span className="task-card-target">{t.type === "bash" ? "bash" : "subagent"}</span>
						<span className="task-card-status">{t.status}</span>
					</div>
					<div className="task-card-task">{t.task.length > 60 ? t.task.slice(0, 60) + "…" : t.task}</div>
					<div className="task-card-meta">
						<span>turns:{t.turns}</span>
						<span>tokens:{t.tokens}</span>
						{t.currentTool && <span>tool:{t.currentTool}</span>}
					</div>
				</button>
				{children.length > 0 && (
					<div className="task-tree-children">
						{children.map((c) => renderNode(c))}
					</div>
				)}
			</div>
		);
	};

	const roots = byParent.get("__root__") ?? [];

	return (
		<div className="task-tree-panel">
			<div className="task-tree-body">
				{loading && tasks.length === 0 ? (
					<div className="doc-placeholder">…</div>
				) : !activeSessionId ? (
					<div className="doc-placeholder">No session selected.</div>
				) : tasks.length === 0 ? (
					<div className="doc-placeholder">本会话暂无委派任务。</div>
				) : roots.map((t) => renderNode(t))}
			</div>
		</div>
	);
}
