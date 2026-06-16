// Cron 状态管理 (v0.8 M1)
//
// # 文件说明书
//
// ## 核心功能
// CronRecord 相关的 Zustand 状态管理：列表拉取 + create/update/delete/trigger。
//
// ## 输入
// - IPC 调用（crons:list / crons:create / crons:update / crons:delete / crons:trigger）
//
// ## 输出
// - cron 列表 + CRUD 方法
//
// ## 定位
// 渲染进程状态管理，被 CronEditor / CronList 组件使用。
//
// ## 依赖
// - zustand
// - ../../shared/types
// - ./notification-store
//

import { create } from "zustand";
import type { CronRecord, CreateCronInput, UpdateCronInput } from "../../shared/types.js";
import { useNotificationStore } from "./notification-store.js";

const api = () => (window as any).api;

interface CronState {
	crons: CronRecord[];
	loading: boolean;
	fetchCrons: (filter?: { agentId?: string }) => Promise<void>;
	createCron: (input: CreateCronInput) => Promise<CronRecord | undefined>;
	updateCron: (id: string, input: UpdateCronInput) => Promise<CronRecord | undefined>;
	removeCron: (id: string) => Promise<void>;
	triggerCron: (id: string) => Promise<void>;
}

export const useCronStore = create<CronState>((set) => ({
	crons: [],
	loading: false,

	fetchCrons: async (filter?) => {
		set({ loading: true });
		try {
			const data = await api().cronsList(filter);
			set({ crons: data ?? [], loading: false });
		} catch (err: any) {
			set({ loading: false });
			useNotificationStore.getState().addError(err?.message || "Failed to fetch crons");
		}
	},

	createCron: async (input) => {
		try {
			const result = await api().cronsCreate(input);
			if (result && result.error) throw new Error(result.error);
			await useCronStore.getState().fetchCrons();
			return result as CronRecord;
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to create cron");
			return undefined;
		}
	},

	updateCron: async (id, input) => {
		try {
			const result = await api().cronsUpdate(id, input);
			if (result && result.error) throw new Error(result.error);
			await useCronStore.getState().fetchCrons();
			return result as CronRecord;
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to update cron");
			return undefined;
		}
	},

	removeCron: async (id) => {
		try {
			await api().cronsDelete(id);
			await useCronStore.getState().fetchCrons();
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to delete cron");
		}
	},

	triggerCron: async (id) => {
		try {
			const result = await api().cronsTrigger(id);
			if (result && result.error) throw new Error(result.error);
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to trigger cron");
		}
	},
}));
