// Cron 状态管理 (v0.8 M1;P4 §9.3 加 cron_runs 历史拉取)
//
// # 文件说明书
//
// ## 核心功能
// CronRecord 相关的 Zustand 状态管理：列表拉取 + create/update/delete/trigger
// + cron_runs 历史拉取 (P4 §9.3, 调度台卡片展开 history 用)。
//
// ## 输入
// - IPC 调用（crons:list / crons:create / crons:update / crons:delete /
//   crons:trigger / crons:listRuns）
//
// ## 输出
// - cron 列表 + CRUD 方法 + runsByCron (cronId → CronRunRecord[])
//
// ## 定位
// 渲染进程状态管理，被 CronDashboard (P4 调度台) 使用。
//
// ## 依赖
// - zustand
// - ../../shared/types
// - ./notification-store
//

import { create } from "zustand";
import type {
	CronRecord,
	CronRunRecord,
	CreateCronInput,
	UpdateCronInput,
} from "../../shared/types.js";
import { useNotificationStore } from "./notification-store.js";
import { subscribeListDataChange } from "./data-sync.js";

const api = () => (window as any).api;

interface CronListFilter {
	agentId?: string;
	projectId?: string;
	enabled?: boolean;
}

interface CronState {
	crons: CronRecord[];
	loading: boolean;
	/** v0.8 (P4 §9.3): per-cron audit log, keyed by cronId. Newest-first. */
	runsByCron: Record<string, CronRunRecord[]>;
	fetchCrons: (filter?: CronListFilter) => Promise<void>;
	fetchRuns: (cronId: string, limit?: number) => Promise<void>;
	createCron: (input: CreateCronInput) => Promise<CronRecord | undefined>;
	updateCron: (id: string, input: UpdateCronInput) => Promise<CronRecord | undefined>;
	removeCron: (id: string) => Promise<void>;
	triggerCron: (id: string) => Promise<void>;
}

export const useCronStore = create<CronState>((set) => ({
	crons: [],
	loading: false,
	runsByCron: {},

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

	fetchRuns: async (cronId, limit?) => {
		try {
			const rows = await api().cronsListRuns(cronId, limit);
			set((s) => ({ runsByCron: { ...s.runsByCron, [cronId]: rows ?? [] } }));
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to fetch cron runs");
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

// v0.8: incrementally sync crons when mutated from the backend (e.g. the Cron
// tool). Single create/update → fetch one + patch; delete → remove; burst →
// full refetch.
subscribeListDataChange("crons", {
	fetchOne: (id) => api().cronsGet(id),
	patch: (id, record) => useCronStore.setState((s) => {
		const others = s.crons.filter((c) => c.id !== id);
		return record ? { crons: [...others, record as CronRecord] } : { crons: others };
	}),
	refetchAll: () => { useCronStore.getState().fetchCrons(); },
});
