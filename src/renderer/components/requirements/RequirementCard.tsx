// 需求卡片组件
//
// # 文件说明书
//
// ## 核心功能
// 看板中显示的单个需求卡片，展示优先级、来源、时间和执行状态。
//
// ## 输入
// - RequirementRecord
// - 可选的当前步骤
// - 点击回调
//
// ## 输出
// - 渲染的卡片
//
// ## 定位
// 渲染进程组件，被 KanbanPage 使用。
//
// ## 依赖
// - react
// - ../../shared/types
//
// ## 维护规则
// - RequirementRecord 字段、状态或优先级/来源图标映射变更时同步本组件
// - 卡片交互（点击/选中态）变更需同步 KanbanPage 回调约定
//
import React from "react";
import type { RequirementRecord, RequirementPriority, TaskStepRecord, RequirementStatus } from "../../../shared/types.js";

const PRIORITY_COLORS: Record<RequirementPriority, string> = {
	critical: "#F44336",
	high: "#FF9800",
	normal: "#2196F3",
	low: "#9E9E9E",
};

const SOURCE_ICONS: Record<string, string> = {
	analyst: "\u{1F916}",
	user: "\u{1F464}",
};

const STEP_STATUS_ICONS: Record<string, string> = {
	pending: "○",
	running: "\u{1F504}",
	completed: "✅",
	failed: "❌",
	skipped: "⊘",
};

function timeAgo(dateStr: string): string {
	const now = Date.now();
	const then = new Date(dateStr).getTime();
	const diff = now - then;
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

interface RequirementCardProps {
	requirement: RequirementRecord;
	currentStep?: TaskStepRecord;
	onClick: (req: RequirementRecord) => void;
}

export default function RequirementCard({ requirement, currentStep, onClick }: RequirementCardProps) {
	const priorityColor = PRIORITY_COLORS[requirement.priority] || "#9E9E9E";
	const sourceIcon = SOURCE_ICONS[requirement.source] || "\u{1F4CB}";
	const showExecution = (requirement.status === "build" || requirement.status === "verify") && currentStep;

	return (
		<div
			className="requirement-card"
			onClick={() => onClick(requirement)}
			style={{
				background: "var(--bg-secondary, #1c1c1e)",
				border: "1px solid var(--border-color, #333)",
				borderLeft: `3px solid ${priorityColor}`,
				borderRadius: 6,
				padding: "10px 12px",
				cursor: "pointer",
				marginBottom: 8,
				transition: "background 0.15s",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
				<span
					style={{
						width: 8, height: 8, borderRadius: "50%",
						background: priorityColor, flexShrink: 0,
					}}
				/>
				<span style={{
					fontSize: 13,
					fontWeight: 600,
					color: "var(--text-primary, #e0e0e0)",
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
				}}>
					{requirement.title}
				</span>
			</div>
			<div style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				fontSize: 11,
				color: "var(--text-secondary, #888)",
			}}>
				<span>{sourceIcon}</span>
				<span>{requirement.source}</span>
				<span style={{ opacity: 0.3 }}>|</span>
				<span>{timeAgo(requirement.updatedAt)}</span>
			</div>
			{showExecution && (
				<div style={{
					marginTop: 6,
					paddingTop: 6,
					borderTop: "1px solid var(--border-color, #333)",
					fontSize: 11,
					color: "var(--text-secondary, #888)",
					display: "flex",
					alignItems: "center",
					gap: 4,
				}}>
					<span>{STEP_STATUS_ICONS[currentStep.status] || "○"}</span>
					<span>Step {currentStep.stepOrder}: {currentStep.role}</span>
					{currentStep.status === "running" && (
						<span style={{ color: "#2196F3" }}> running</span>
					)}
				</div>
			)}
		</div>
	);
}
