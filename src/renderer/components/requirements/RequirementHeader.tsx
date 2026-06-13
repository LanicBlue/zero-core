// 需求上下文头
//
// # 文件说明书
//
// ## 核心功能
// 嵌入聊天窗口顶部的需求信息条，显示标题、状态、优先级和操作按钮。
//
// ## 输入
// - RequirementRecord
// - 状态流转回调
// - 关闭回调
//
// ## 输出
// - 渲染的需求信息条
//
// ## 定位
// 渲染进程组件，被 ChatPanel 使用。
//
// ## 依赖
// - react
// - ../../shared/types
//
import React from "react";
import type { RequirementRecord, RequirementStatus, RequirementPriority } from "../../../shared/types.js";

const STATUS_LABELS: Record<RequirementStatus, string> = {
	found: "💡 Found",
	discuss: "💬 Discuss",
	ready: "✅ Ready",
	plan: "📋 Plan",
	build: "🔨 Build",
	verify: "🔍 Verify",
	closed: "🏁 Closed",
	cancelled: "❌ Cancelled",
};

const PRIORITY_COLORS: Record<RequirementPriority, string> = {
	critical: "#F44336",
	high: "#FF9800",
	normal: "#2196F3",
	low: "#9E9E9E",
};

interface RequirementHeaderProps {
	requirement: RequirementRecord;
	onTransition: (toStatus: RequirementStatus) => void;
	onClose: () => void;
}

export default function RequirementHeader({ requirement, onTransition, onClose }: RequirementHeaderProps) {
	const priorityColor = PRIORITY_COLORS[requirement.priority] || "#9E9E9E";

	return (
		<div style={{
			display: "flex",
			alignItems: "center",
			gap: 12,
			padding: "8px 16px",
			background: "var(--bg-secondary, #1c1c1e)",
			borderBottom: "1px solid var(--border-color, #333)",
			fontSize: 13,
		}}>
			<span style={{ fontSize: 16 }}>{"\u{1F4CB}"}</span>
			<span style={{
				fontWeight: 600,
				color: "var(--text-primary, #e0e0e0)",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			}}>
				{requirement.title}
			</span>
			<span style={{
				padding: "2px 8px",
				borderRadius: 4,
				background: "var(--bg-tertiary, #141416)",
				color: "var(--text-secondary, #888)",
				fontSize: 11,
				whiteSpace: "nowrap",
			}}>
				{STATUS_LABELS[requirement.status] || requirement.status}
			</span>
			<span style={{
				padding: "2px 8px",
				borderRadius: 4,
				background: priorityColor + "22",
				color: priorityColor,
				fontSize: 11,
				fontWeight: 600,
				whiteSpace: "nowrap",
			}}>
				{requirement.priority}
			</span>
			<div style={{ flex: 1 }} />
			{/* Status-specific actions */}
			{requirement.status === "found" && (
				<button
					type="button"
					onClick={() => onTransition("discuss")}
					style={actionBtnStyle}
				>
					Start Discussion
				</button>
			)}
			{requirement.status === "discuss" && (
				<>
					<button
						type="button"
						onClick={() => onTransition("ready")}
						style={{ ...actionBtnStyle, background: "#4CAF50" }}
					>
						Confirm Ready
					</button>
					<button
						type="button"
						onClick={() => onTransition("found")}
						style={actionBtnStyle}
					>
						Back
					</button>
				</>
			)}
			{requirement.status === "ready" && (
				<span style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>
					Waiting for Lead pickup...
				</span>
			)}
			{(requirement.status === "plan" || requirement.status === "build") && (
				<span style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>
					Execution in progress...
				</span>
			)}
			{requirement.status === "verify" && (
				<button
					type="button"
					onClick={() => onTransition("closed")}
					style={{ ...actionBtnStyle, background: "#4CAF50" }}
				>
					Verify Pass
				</button>
			)}
			<button
				type="button"
				onClick={onClose}
				style={{
					...actionBtnStyle,
					background: "transparent",
					border: "1px solid var(--border-color, #333)",
					color: "var(--text-secondary, #888)",
				}}
			>
				← Back
			</button>
		</div>
	);
}

const actionBtnStyle: React.CSSProperties = {
	padding: "4px 12px",
	background: "#2196F3",
	border: "none",
	borderRadius: 4,
	color: "#fff",
	fontSize: 11,
	cursor: "pointer",
	whiteSpace: "nowrap",
};
