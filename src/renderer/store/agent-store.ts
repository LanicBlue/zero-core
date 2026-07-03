// Agent 状态管理
//
// # 文件说明书
//
// ## 核心功能
// Agent 相关的 Zustand 状态管理，包括 Agent 列表和配置。
//
// ## 输入
// - IPC 事件（agents:list 等）
//
// ## 输出
// - Agent 列表
// - CRUD 操作
//
// ## 定位
// 渲染进程状态管理，被 Agent 组件使用。
//
// ## 依赖
// - zustand - 状态管理
// - ../../shared/types - 共享类型
//
// ## 维护规则
// - 新增 Agent 字段时需更新类型
// - 保持与 IPC 接口一致
//
import { create } from "zustand";
import type { AgentRecord } from "../../shared/types.js";
import { subscribeListDataChange } from "./data-sync.js";

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
}

export interface ToolInfo {
	name: string;
	description: string;
	group?: string;
	source?: string;
	mcpServerName?: string;
	prompt?: string;
	configSchema?: any[];
	meta?: {
		isReadOnly: boolean;
		isDestructive: boolean;
		isConcurrencySafe: boolean;
	};
}

const api = () => (window as any).api;

interface AgentState {
	agents: AgentRecord[];
	models: ModelInfo[];
	tools: ToolInfo[];
	loading: boolean;
	fetchAgents: () => Promise<void>;
	fetchModels: () => Promise<void>;
	fetchTools: () => Promise<void>;
	create: (input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">) => Promise<AgentRecord>;
	update: (id: string, input: Partial<AgentRecord>) => Promise<AgentRecord>;
	remove: (id: string) => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
	agents: [],
	models: [],
	tools: [],
	loading: true,

	fetchAgents: async () => {
		try {
			const data = await api().agentsList();
			set({ agents: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	fetchModels: async () => {
		try {
			const data = await api().modelsList();
			set({ models: data });
		} catch {
			set({ models: [] });
		}
	},

	fetchTools: async () => {
		try {
			const data = await api().toolsList();
			set({ tools: data });
		} catch {
			set({ tools: [] });
		}
	},

	create: async (input) => {
		const created = await api().agentsCreate(input);
		set((state) => ({ agents: [...state.agents, created] }));
		return created;
	},

	update: async (id, input) => {
		const updated = await api().agentsUpdate(id, input);
		set((state) => ({ agents: state.agents.map((a) => (a.id === id ? updated : a)) }));
		return updated;
	},

	remove: async (id) => {
		await api().agentsDelete(id);
		set((state) => ({ agents: state.agents.filter((a) => a.id !== id) }));
	},
}));

// Auto-fetch once the backend is ready. Module-import time is too early: the
// main process is still polling /api/ready, so agentsList() rejects and the
// catch swallows it, leaving agents=[] permanently (only running sessions stay
// visible, via the live event path). Gating on app:ready matches AppLayout and
// fires immediately if already ready.
let _fetched = false;
if (!_fetched) {
	_fetched = true;
	api().onAppReady(() => {
		useAgentStore.getState().fetchAgents();
		useAgentStore.getState().fetchModels();
		useAgentStore.getState().fetchTools();
	});

	// Refresh tools when agent tools change (expose/disable)
	const unsub = api().onToolsChanged(() => {
		useAgentStore.getState().fetchTools();
	});

	// v0.8: incrementally sync agents when mutated from the backend (e.g. the
	// AgentRegistry tool). Single create/update → fetch just that record and
	// patch the array; delete → remove; burst → full refetch.
	subscribeListDataChange("agents", {
		patch: (id, record) => {
			const others = useAgentStore.getState().agents.filter((a) => a.id !== id);
			useAgentStore.setState({ agents: record ? [...others, record as AgentRecord] : others });
			return true; // 非过滤列表:新 id 直接 append
		},
		refetchAll: () => { useAgentStore.getState().fetchAgents(); },
	});
}
