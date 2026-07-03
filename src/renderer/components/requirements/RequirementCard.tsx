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
	/** v0.8 (M4): project name for the card's project tag (decision 7 — kanban grouped by Project). */
	projectName?: string;
	onClick: (req: RequirementRecord) => void;
	/** v0.8 (M4): open the {PM, projectId} discuss session (decision 13/14). */
	onDiscuss?: (req: RequirementRecord) => void;
	/** v0.8 (M4): open the PM coverage-judgement view (decision 34, verify status). */
	onCoverage?: (req: RequirementRecord) => void;
}

// N2 render hygiene: the impl is a named export so unit tests can spy on its
// render count and assert React.memo actually prevents re-renders when props
// are referentially stable. The default export remains the memo-wrapped card.
export function RequirementCardImpl({ requirement, currentStep, projectName, onClick, onDiscuss, onCoverage }: RequirementCardProps) {
	const priorityColor = PRIORITY_COLORS[requirement.priority] || "#9E9E9E";
	const sourceIcon = SOURCE_ICONS[requirement.source] || "\u{1F4CB}";
	const showExecution = (requirement.status === "build" || requirement.status === "verify") && currentStep;
	const canDiscuss = requirement.status === "found" || requirement.status === "discuss";
	const canCoverage = requirement.status === "verify";

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
				{projectName && (
					<>
						<span style={{ opacity: 0.3 }}>|</span>
						<span
							title={requirement.projectId}
							style={{
								background: "rgba(33,150,243,0.15)",
								color: "#64B5F6",
								padding: "0 6px",
								borderRadius: 8,
								fontSize: 10,
							}}
						>
							{projectName}
						</span>
					</>
				)}
			</div>
			{(canDiscuss || canCoverage) && (
				<div style={{ marginTop: 6, display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
					{canDiscuss && (
						<button
							type="button"
							onClick={() => onDiscuss?.(requirement)}
							style={{
								padding: "2px 8px",
								background: "#2196F3", border: "none", borderRadius: 4,
								color: "#fff", fontSize: 11, cursor: "pointer",
							}}
						>
							{"\u{1F4AC}"} Discuss
						</button>
					)}
					{canCoverage && (
						<button
							type="button"
							onClick={() => onCoverage?.(requirement)}
							style={{
								padding: "2px 8px",
								background: "#00BCD4", border: "none", borderRadius: 4,
								color: "#fff", fontSize: 11, cursor: "pointer",
							}}
						>
							{"\u{1F50D}"} Coverage
						</button>
					)}
				</div>
			)}
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
// N2 render hygiene: wrap in React.memo (shallow compare) so a kanban re-render
// triggered by an unrelated card's data change doesn't re-render this card
// unless its own props changed. Callbacks from the parent (onClick/onDiscuss/
// onCoverage) are useCallback-stable, so identity flips only on real changes.
const RequirementCard = React.memo(RequirementCardImpl);
export default RequirementCard;
