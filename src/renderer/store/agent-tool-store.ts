// Agent 工具前端状态管理
//
// # 文件说明书
//
// ## 核心功能
// 管理 Agent 自定义工具的前端状态和 IPC 调用
//
// ## 输入
// IPC API 调用结果
//
// ## 输出
// AgentToolState（工具列表、加载状态、CRUD 操作）
//
// ## 定位
// src/renderer/store/ — 渲染进程状态层，为 ToolsPage 提供数据
//
// ## 依赖
// zustand、shared/types.ts、preload API
//
// ## 维护规则
// 工具配置字段变更需同步更新 shared/types.ts
//
import { create } from "zustand";
import type { AgentToolEntry } from "../../shared/types.js";

const api = () => (window as any).api;

interface AgentToolState {
	entries: AgentToolEntry[];
	loading: boolean;
	fetchEntries: () => Promise<void>;
	create: (input: Omit<AgentToolEntry, "id" | "createdAt" | "updatedAt">) => Promise<AgentToolEntry>;
	update: (id: string, input: Partial<AgentToolEntry>) => Promise<AgentToolEntry>;
	remove: (id: string) => Promise<void>;
	getByAgentId: (agentId: string) => Promise<AgentToolEntry | undefined>;
}

export const useAgentToolStore = create<AgentToolState>((set, get) => ({
	entries: [],
	loading: true,

	fetchEntries: async () => {
		try {
			const data = await api().agentToolsList();
			set({ entries: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const created = await api().agentToolsCreate(input);
		set((state) => ({ entries: [...state.entries, created] }));
		return created;
	},

	update: async (id, input) => {
		const updated = await api().agentToolsUpdate(id, input);
		set((state) => ({
			entries: state.entries.map((e) => (e.id === id ? updated : e)),
		}));
		return updated;
	},

	remove: async (id) => {
		await api().agentToolsDelete(id);
		set((state) => ({ entries: state.entries.filter((e) => e.id !== id) }));
	},

	getByAgentId: async (agentId: string) => {
		return api().agentToolsGetByAgent(agentId);
	},
}));

// Auto-fetch on first import
let _fetched = false;
if (!_fetched) {
	_fetched = true;
	useAgentToolStore.getState().fetchEntries();

	// Refresh when tools change
	const unsub = api().onToolsChanged(() => {
		useAgentToolStore.getState().fetchEntries();
	});
}
