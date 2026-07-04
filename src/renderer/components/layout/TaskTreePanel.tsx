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
import React, { useEffect, useState } from "react";
import { useChatStore } from "../../store/chat-store.js";
import { useTaskStore } from "../../store/task-store.js";
import type { RuntimeTaskInfo } from "../../../shared/types.js";

// Module-level stable empty-array reference: avoids a fresh `[]` (new identity
// each render) that would force downstream memo/selector consumers to re-render
// on every parent render even when nothing changed.
const EMPTY_TASKS: RuntimeTaskInfo[] = [];

const STATUS_ICON: Record<string, string> = {
	running: "●",
	finishing: "◐",
	completed: "✓",
	failed: "✗",
	killed: "⊘",
	interrupted: "⌽",
};

// Compact token count for the list row (1234 → "1.2k", 1250000 → "1.3M").
function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
	return (n / 1_000_000).toFixed(1) + "M";
}

export default function TaskTreePanel() {
	const activeSessionId = useChatStore((s) => s.activeSessionId);
	// Selector subscriptions (N2 render hygiene): subscribe to the active
	// session's slice only, so a refresh of another session's slice doesn't
	// re-render this panel. Action fns are stable across renders (zustand).
	const tasks = useTaskStore((s) => (activeSessionId ? (s.tasksBySession[activeSessionId] ?? EMPTY_TASKS) : EMPTY_TASKS));
	const loading = useTaskStore((s) => (activeSessionId ? !!s.loadingBySession[activeSessionId] : false));
	const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
	const selectTask = useTaskStore((s) => s.selectTask);
	const startWatching = useTaskStore((s) => s.startWatching);
	const stopWatching = useTaskStore((s) => s.stopWatching);

	// Pull-on-display: watch the active session so the runtime:tasks:changed
	// ping drives refreshes; stop on switch-away (disconnect-on-leave).
	useEffect(() => {
		if (!activeSessionId) return;
		startWatching(activeSessionId);
		return () => { stopWatching(activeSessionId); };
	}, [activeSessionId, startWatching, stopWatching]);

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

	// Per-node collapse (fold subtrees). Default = all expanded. Mirrors the
	// WikiTree pattern: a Set of collapsed task ids; the caret toggles and stops
	// propagation so clicking it doesn't also select the task.
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const toggleCollapse = (taskId: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(taskId)) next.delete(taskId);
			else next.add(taskId);
			return next;
		});
	};

	const renderNode = (t: RuntimeTaskInfo): React.ReactNode => {
		const children = byParent.get(t.id) ?? [];
		const hasChildren = children.length > 0;
		const isCollapsed = collapsed.has(t.id);
		return (
			<div key={t.id} className="task-tree-node">
				<button
					type="button"
					className={`task-card${selectedTaskId === t.id ? " task-card-selected" : ""}`}
					onClick={() => onSelect(t)}
					title={t.task}
				>
					<div className="task-card-row">
						<span
							className={`task-caret${hasChildren ? "" : " task-caret-empty"}`}
							onClick={hasChildren ? (e) => { e.stopPropagation(); toggleCollapse(t.id); } : undefined}
						>
							{hasChildren ? (isCollapsed ? "▸" : "▾") : ""}
						</span>
						<span className={`task-status-icon task-status-${t.status}`} title={t.status}>{STATUS_ICON[t.status] ?? "?"}</span>
						<span className="task-card-target">{t.type === "bash" ? "bash" : "subagent"}</span>
						{/* Metadata, not task content (content is in the title tooltip +
							right-pane conversation). turns/tokens/currentTool come straight
							off RuntimeTaskInfo — already pulled by the store, no extra fetch. */}
						<span className="task-card-stat" title="turns">{t.turns}t</span>
						<span className="task-card-stat" title="tokens">{formatTokens(t.tokens)}</span>
						{t.currentTool && <span className="task-card-tool" title={t.currentTool}>{t.currentTool}</span>}
					</div>
				</button>
				{hasChildren && !isCollapsed && (
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
