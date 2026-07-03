// 执行详情面板
//
// # 文件说明书
//
// ## 核心功能
// 展示需求处于 Build/Verify 状态时的执行步骤详情和日志。
//
// ## 输入
// - RequirementRecord
// - TaskStepRecord[]
// - RequirementMessage[]
//
// ## 输出
// - 渲染的执行详情面板
//
// ## 定位
// 渲染进程组件，被 KanbanPage 使用。
//
// ## 依赖
// - react
// - ../../shared/types
//
// ## 维护规则
// - 执行步骤/状态展示字段或 TaskStepStatus 变更时同步本组件
// - 步骤日志结构变更需同步渲染逻辑
//
import React, { useEffect } from "react";
import type { RequirementRecord, TaskStepRecord, RequirementMessage, TaskStepStatus } from "../../../shared/types.js";

const STEP_STATUS_ICONS: Record<TaskStepStatus, string> = {
	pending: "○",
	running: "\u{1F504}",
	completed: "✅",
	failed: "❌",
	skipped: "⊘",
};

const STEP_STATUS_COLORS: Record<TaskStepStatus, string> = {
	pending: "#BDBDBD",
	running: "#2196F3",
	completed: "#4CAF50",
	failed: "#F44336",
	skipped: "#9E9E9E",
};

interface ExecutionDetailPanelProps {
	requirement: RequirementRecord;
	steps: TaskStepRecord[];
	messages: RequirementMessage[];
	onRefresh?: () => void;
}


// N2 render hygiene: extracted step row, wrapped in React.memo so a refresh that
// touches messages (not steps) doesn't re-render every step row. The step prop
// identity only flips when this row's own data changes. The impl is a named
// export (StepRowInner) so unit tests can spy on its render count and assert
// React.memo actually skips re-renders when the step prop identity is stable.
export function StepRowInner({ step }: { step: TaskStepRecord }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "4px 0",
				fontSize: 11,
				color: STEP_STATUS_COLORS[step.status],
			}}
		>
			<span>{STEP_STATUS_ICONS[step.status]}</span>
			<span style={{ textTransform: "capitalize" }}>{step.role}</span>
			<span style={{ color: "var(--text-secondary, #888)" }}>— {step.title}</span>
			{step.status === "running" && (
				<span style={{ color: "#2196F3", fontSize: 10 }}>running</span>
			)}
			{step.completedAt && (
				<span style={{ color: "var(--text-secondary, #888)", fontSize: 10, marginLeft: "auto" }}>
					{new Date(step.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
				</span>
			)}
		</div>
	);
}
const StepRow = React.memo(StepRowInner);
export default function ExecutionDetailPanel({ requirement, steps, messages, onRefresh }: ExecutionDetailPanelProps) {
	// Push-driven (N2): refresh only when a task_steps / requirement_messages
	// change touches THIS requirement. The data:changed payload carries the full
	// record on create/update (with requirementId) — we filter by it. Deletes
	// carry only id (rare; refresh anyway since this req is open).
	useEffect(() => {
		if (!onRefresh) return;
		const api = (window as any).api;
		if (!api?.onDataChanged) return;
		const reqId = requirement.id;
		const unsub = api.onDataChanged((e: { collection?: string; changes?: Array<{ op?: string; record?: { requirementId?: string } }> }) => {
			if (e.collection !== "task_steps" && e.collection !== "requirement_messages") return;
			const hit = (e.changes ?? []).some((c) => {
				if (c.op === "delete") return true; // can't see requirementId on delete; refresh
				return c.record?.requirementId === reqId;
			});
			if (hit) onRefresh();
		});
		return () => { if (typeof unsub === "function") unsub(); };
	}, [requirement.id, onRefresh]);

	const sortedSteps = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
	const recentMessages = [...messages]
		.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
		.slice(0, 10);

	return (
		<div style={{
			padding: 12,
			borderTop: "1px solid var(--border-color, #333)",
			background: "var(--bg-tertiary, #141416)",
		}}>
			{/* Steps */}
			<div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--text-primary, #e0e0e0)" }}>
				{"\u{1F4CB}"} Execution Steps
			</div>
			{sortedSteps.map((step) => (
				<StepRow key={step.id} step={step} />
			))}
			{sortedSteps.length === 0 && (
				<div style={{ fontSize: 11, color: "var(--text-secondary, #888)", padding: "4px 0" }}>
					No steps yet.
				</div>
			)}

			{/* Messages / Log */}
			{recentMessages.length > 0 && (
				<>
					<div style={{ fontSize: 12, fontWeight: 600, margin: "12px 0 8px", color: "var(--text-primary, #e0e0e0)" }}>
						{"\u{1F4CA}"} Log
					</div>
					{recentMessages.map((msg) => (
						<div
							key={msg.id}
							style={{
								fontSize: 11,
								padding: "2px 0",
								color: "var(--text-secondary, #888)",
							}}
						>
							<span style={{ color: "var(--text-tertiary, #666)", marginRight: 6 }}>
								{new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
							</span>
							<span style={{ color: "var(--text-tertiary, #666)" }}>[{msg.sender}]</span> <span>{msg.content}</span>
						</div>
					))}
				</>
			)}
		</div>
	);
}
