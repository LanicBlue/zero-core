// 需求状态管理
//
// # 文件说明书
//
// ## 核心功能
// 需求相关的 Zustand 状态管理，包括需求列表、过滤、状态流转、消息和步骤。
//
// ## 输入
// - IPC 调用（requirements:list 等）
//
// ## 输出
// - 需求列表
// - 按状态分组
// - CRUD + 状态流转 + 消息 + 步骤
//
// ## 定位
// 渲染进程状态管理，被 KanbanPage 等组件使用。
//
// ## 依赖
// - zustand - 状态管理
// - ../../shared/types - 共享类型
//
// ## 维护规则
// - 新增需求字段时需更新类型
// - 保持与 IPC 接口一致
//
import { create } from "zustand";
import type {
	RequirementRecord,
	RequirementStatus,
	RequirementMessage,
	TaskStepRecord,
	CreateRequirementInput,
} from "../../shared/types.js";
import { useNotificationStore } from "./notification-store.js";
import { subscribeListDataChange } from "./data-sync.js";

const api = () => (window as any).api;

interface RequirementFilter {
	projectId?: string;
	status?: string;
	priority?: string;
}

interface RequirementState {
	requirements: RequirementRecord[];
	stepsByReq: Record<string, TaskStepRecord[]>;
	messagesByReq: Record<string, RequirementMessage[]>;
	filter: RequirementFilter;
	loading: boolean;

	fetchRequirements: (filter?: RequirementFilter) => Promise<void>;
	createRequirement: (input: CreateRequirementInput) => Promise<RequirementRecord>;
	transitionStatus: (id: string, toStatus: RequirementStatus, triggeredBy: string, comment?: string) => Promise<void>;
	fetchSteps: (reqId: string) => Promise<void>;
	fetchMessages: (reqId: string) => Promise<void>;
	sendMessage: (reqId: string, sender: string, content: string, messageType?: string) => Promise<void>;
	setFilter: (filter: RequirementFilter) => void;

	getFilteredRequirements: () => RequirementRecord[];
	getGroupedByStatus: () => Record<RequirementStatus, RequirementRecord[]>;
}

export const useRequirementStore = create<RequirementState>((set, get) => ({
	requirements: [],
	stepsByReq: {},
	messagesByReq: {},
	filter: {},
	loading: false,

	fetchRequirements: async (filter?) => {
		set({ loading: true });
		try {
			const mergedFilter = { ...get().filter, ...filter };
			const data = await api().requirementsList(mergedFilter);
			set({ requirements: data, filter: mergedFilter, loading: false });
		} catch (err: any) {
			set({ loading: false });
			useNotificationStore.getState().addError(err?.message || "Failed to fetch requirements");
		}
	},

	createRequirement: async (input) => {
		try {
			const created = await api().requirementsCreate(input);
			set((state) => ({ requirements: [...state.requirements, created] }));
			return created;
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to create requirement");
			throw err;
		}
	},

	transitionStatus: async (id, toStatus, triggeredBy, comment?) => {
		try {
			const result = await api().requirementsTransition(id, toStatus, triggeredBy, comment);
			if ("error" in result) throw new Error(result.error);
			set((state) => ({
				requirements: state.requirements.map((r) =>
					r.id === id ? result.requirement : r
				),
			}));
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to transition status");
			throw err;
		}
	},

	fetchSteps: async (reqId) => {
		try {
			const steps = await api().requirementsSteps(reqId);
			set((state) => ({
				stepsByReq: { ...state.stepsByReq, [reqId]: steps },
			}));
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to fetch steps");
		}
	},

	fetchMessages: async (reqId) => {
		try {
			const messages = await api().requirementsMessages(reqId);
			set((state) => ({
				messagesByReq: { ...state.messagesByReq, [reqId]: messages },
			}));
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to fetch messages");
		}
	},

	sendMessage: async (reqId, sender, content, messageType?) => {
		try {
			const msg = await api().requirementsAddMessage(reqId, sender, content, messageType);
			set((state) => ({
				messagesByReq: {
					...state.messagesByReq,
					[reqId]: [...(state.messagesByReq[reqId] || []), msg],
				},
			}));
		} catch (err: any) {
			useNotificationStore.getState().addError(err?.message || "Failed to send message");
			throw err;
		}
	},

	setFilter: (filter) => {
		set({ filter });
		get().fetchRequirements(filter);
	},

	getFilteredRequirements: () => {
		const { requirements, filter } = get();
		let filtered = requirements;
		if (filter.projectId) {
			filtered = filtered.filter((r) => r.projectId === filter.projectId);
		}
		if (filter.status) {
			filtered = filtered.filter((r) => r.status === filter.status);
		}
		if (filter.priority) {
			filtered = filtered.filter((r) => r.priority === filter.priority);
		}
		return filtered;
	},

	getGroupedByStatus: () => {
		const filtered = get().getFilteredRequirements();
		const groups: Record<string, RequirementRecord[]> = {
			found: [], discuss: [], ready: [], plan: [],
			build: [], verify: [], closed: [], cancelled: [],
		};
		for (const r of filtered) {
			if (!groups[r.status]) groups[r.status] = [];
			groups[r.status].push(r);
		}
		return groups as Record<RequirementStatus, RequirementRecord[]>;
	},
}));

// v0.8: incrementally sync requirements when mutated from the backend (e.g.
// CreateRequirement / verify tools, status transitions). Single create/update
// → fetch one + patch; delete → remove; burst → full refetch.
subscribeListDataChange("requirements", {
	fetchOne: (id) => api().requirementsGet(id),
	patch: (id, record) => useRequirementStore.setState((s) => {
		const others = s.requirements.filter((r) => r.id !== id);
		return record ? { requirements: [...others, record as RequirementRecord] } : { requirements: others };
	}),
	refetchAll: () => { useRequirementStore.getState().fetchRequirements(); },
});
