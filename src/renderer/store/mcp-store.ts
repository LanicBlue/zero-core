// MCP 服务器前端状态管理
//
// # 文件说明书
//
// ## 核心功能
// 管理 MCP 服务器配置的前端状态和 IPC 调用
//
// ## 输入
// IPC API 调用结果
//
// ## 输出
// McpState（服务器列表、加载状态、CRUD 操作）
//
// ## 定位
// src/renderer/store/ — 渲染进程状态层，为 MCP 页面提供数据
//
// ## 依赖
// zustand、shared/types.ts、preload API
//
// ## 维护规则
// MCP 配置字段变更需同步更新 shared/types.ts
//
import { create } from "zustand";
import type { McpServerConfig } from "../../shared/types.js";

const api = () => (window as any).api;

interface McpState {
	servers: McpServerConfig[];
	loading: boolean;
	fetchServers: () => Promise<void>;
	create: (input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">) => Promise<McpServerConfig>;
	update: (id: string, input: Partial<McpServerConfig>) => Promise<McpServerConfig>;
	remove: (id: string) => Promise<void>;
	testConnection: (input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">) => Promise<{ tools: { name: string; description?: string }[]; error?: string }>;
	connect: (id: string) => Promise<{ tools: { name: string; description?: string }[]; error?: string }>;
	disconnect: (id: string) => Promise<void>;
	getStatus: () => Promise<{ id: string; name: string; connected: boolean; toolCount: number }[]>;
}

export const useMcpStore = create<McpState>((set, get) => ({
	servers: [],
	loading: true,

	fetchServers: async () => {
		try {
			const data = await api().mcpList();
			set({ servers: data, loading: false });
		} catch {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const created = await api().mcpCreate(input);
		await get().fetchServers();
		return created;
	},

	update: async (id, input) => {
		const updated = await api().mcpUpdate(id, input);
		await get().fetchServers();
		return updated;
	},

	remove: async (id) => {
		await api().mcpDelete(id);
		set((state) => ({ servers: state.servers.filter((s) => s.id !== id) }));
	},

	testConnection: async (input) => {
		return api().mcpTest(input);
	},

	connect: async (id) => {
		return api().mcpConnect(id);
	},

	disconnect: async (id) => {
		await api().mcpDisconnect(id);
	},

	getStatus: async () => {
		return api().mcpStatus();
	},
}));

let _fetched = false;
if (!_fetched) {
	_fetched = true;
	useMcpStore.getState().fetchServers();
}
