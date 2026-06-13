// 通知状态管理
//
// # 文件说明书
//
// ## 核心功能
// 通知相关的 Zustand 状态管理，包括通知列表和自动消失。
//
// ## 输入
// - 工作流事件（requirement_notification, step_failure, verification_failure）
// - IPC 错误
//
// ## 输出
// - 通知列表
// - 添加/移除通知
//
// ## 定位
// 渲染进程状态管理，被 NotificationToast 组件使用。
//
// ## 依赖
// - zustand - 状态管理
//
// ## 维护规则
// - 通知最大保留 10 条
// - info 类型自动 3 秒消失
//
import { create } from "zustand";

export interface Notification {
	id: string;
	type: string;
	priority: "critical" | "warning" | "info";
	title: string;
	message: string;
	actionUrl?: string;
	timestamp: number;
}

interface NotificationState {
	notifications: Notification[];
	addNotification: (n: Omit<Notification, "id" | "timestamp">) => void;
	dismissNotification: (id: string) => void;
	addError: (message: string) => void;
}

let _nextId = 0;

export const useNotificationStore = create<NotificationState>((set) => ({
	notifications: [],

	addNotification: (n) => {
		const id = String(++_nextId);
		const notification: Notification = {
			...n,
			id,
			timestamp: Date.now(),
		};

		set((state) => ({
			notifications: [notification, ...state.notifications].slice(0, 10),
		}));

		// Auto-dismiss info toasts after 3 seconds
		if (n.priority === "info") {
			setTimeout(() => {
				useNotificationStore.getState().dismissNotification(id);
			}, 3000);
		}
	},

	dismissNotification: (id) => {
		set((state) => ({
			notifications: state.notifications.filter((n) => n.id !== id),
		}));
	},

	addError: (message) => {
		useNotificationStore.getState().addNotification({
			type: "error",
			priority: "warning",
			title: "Error",
			message,
		});
	},
}));
