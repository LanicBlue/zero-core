// 通知 Toast 组件
//
// # 文件说明书
//
// ## 核心功能
// 显示工作流通知的 Toast 弹窗，固定在右上角。
//
// ## 输入
// - notification-store 中的通知列表
//
// ## 输出
// - 固定位置的 Toast 容器
//
// ## 定位
// src/renderer/components/common/ — 通用组件，被 AppLayout 使用。
//
// ## 依赖
// - React
// - notification-store
//
// ## 维护规则
// - 样式变更需与暗色主题一致
// - info 通知由 store 层自动消失
//
import React from "react";
import { useNotificationStore } from "../../store/notification-store.js";

const priorityStyles: Record<string, React.CSSProperties> = {
	critical: {
		borderLeft: "4px solid #e53e3e",
		backgroundColor: "rgba(229, 62, 62, 0.15)",
	},
	warning: {
		borderLeft: "4px solid #dd6b20",
		backgroundColor: "rgba(221, 107, 32, 0.15)",
	},
	info: {
		borderLeft: "4px solid #3182ce",
		backgroundColor: "var(--bg-tertiary)",
	},
};

const containerStyle: React.CSSProperties = {
	position: "fixed",
	top: 12,
	right: 12,
	zIndex: 1000,
	display: "flex",
	flexDirection: "column",
	gap: 8,
	maxWidth: 380,
	pointerEvents: "none",
};

const toastBaseStyle: React.CSSProperties = {
	padding: "10px 14px",
	borderRadius: 6,
	display: "flex",
	flexDirection: "column",
	gap: 4,
	pointerEvents: "auto",
	boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
};

const titleStyle: React.CSSProperties = {
	fontSize: 13,
	fontWeight: 600,
	color: "var(--text-primary)",
};

const messageStyle: React.CSSProperties = {
	fontSize: 12,
	color: "var(--text-secondary)",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
	maxWidth: 320,
};

const actionsStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	marginTop: 2,
};

const dismissBtnStyle: React.CSSProperties = {
	background: "none",
	border: "none",
	color: "var(--text-secondary)",
	cursor: "pointer",
	fontSize: 16,
	lineHeight: 1,
	padding: "0 2px",
	marginLeft: "auto",
};

const viewLinkStyle: React.CSSProperties = {
	fontSize: 12,
	color: "#3182ce",
	textDecoration: "none",
	cursor: "pointer",
};

export default function NotificationToast() {
	const { notifications, dismissNotification } = useNotificationStore();

	if (notifications.length === 0) return null;

	return (
		<div style={containerStyle}>
			{notifications.map((n) => (
				<div
					key={n.id}
					style={{
						...toastBaseStyle,
						...priorityStyles[n.priority] ?? priorityStyles.info,
					}}
				>
					<div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
						<div style={{ flex: 1, minWidth: 0 }}>
							<div style={titleStyle}>{n.title}</div>
							{n.message && <div style={messageStyle}>{n.message}</div>}
						</div>
						<button
							type="button"
							style={dismissBtnStyle}
							onClick={() => dismissNotification(n.id)}
							aria-label="Dismiss"
						>
							x
						</button>
					</div>
					{n.actionUrl && (
						<div style={actionsStyle}>
							<a
								href={n.actionUrl}
								style={viewLinkStyle}
								target="_blank"
								rel="noopener noreferrer"
							>
								View
							</a>
						</div>
					)}
				</div>
			))}
		</div>
	);
}
