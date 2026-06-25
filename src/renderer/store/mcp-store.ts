// MCP 服务器状态管理 store
//
// # 文件说明书
//
// ## 核心功能
// 基于 Zustand 的 MCP 服务器全局状态：维护服务器列表与 loading 标志，封装 window.api 上的 mcp* 接口（增删改查、连接测试、连接/断开、状态查询、系统扫描、预设列表与一键添加），并在模块加载时自动 fetchServers。
//
// ## 输入
// - window.api.mcpList / mcpCreate / mcpUpdate / mcpDelete / mcpTest / mcpConnect / mcpDisconnect / mcpStatus / mcpScan / mcpPresets / mcpAddPreset
//
// ## 输出
// - useMcpStore hook：servers / loading 及各 action
// - 导出 McpPreset 类型
//
// ## 定位
// 渲染进程状态层，被 components/mcp 下组件消费。
//
// ## 依赖
// - zustand
// - ../../shared/types (McpServerConfig)
// - window.api（preload 暴露的 mcp* 接口）
//
// ## 维护规则
// - 新增 mcp IPC 接口时需要在 McpState 与 store 实现中同步声明。
// - 自动 fetchServers 的副作用只在模块首次加载执行一次，避免重复请求。
//
import { create } from "zustand";
import type { McpServerConfig } from "../../shared/types.js";

const api = () => (window as any).api;

export interface McpPreset {
	id: string;
	name: string;
	description: string;
	category: string;
	transport: "stdio" | "sse" | "streamable-http";
	envKeys: string[];
}

interface McpState {
	servers: McpServerConfig[];
	loading: boolean;
	/** True after the first successful fetch — guards against re-fetching on page re-mount. */
	loaded: boolean;
	fetchServers: () => Promise<void>;
	create: (input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">) => Promise<McpServerConfig>;
	update: (id: string, input: Partial<McpServerConfig>) => Promise<McpServerConfig>;
	remove: (id: string) => Promise<void>;
	testConnection: (input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">) => Promise<{ tools: { name: string; description?: string }[]; error?: string }>;
	connect: (id: string) => Promise<{ tools: { name: string; description?: string }[]; error?: string }>;
	disconnect: (id: string) => Promise<void>;
	getStatus: () => Promise<{ id: string; name: string; connected: boolean; toolCount: number }[]>;
	scan: () => Promise<{ detected: number; added: number }>;
	presets: () => Promise<McpPreset[]>;
	addPreset: (presetId: string, envValues: Record<string, string>) => Promise<McpServerConfig>;
}

export const useMcpStore = create<McpState>((set, get) => ({
	servers: [],
	loading: true,
	loaded: false,

	fetchServers: async () => {
		// Page-driven fetch (McpSettingsPage useEffect). The create/update
		// helpers below call this to refresh AFTER a mutation — those need a
		// forced re-fetch, so they reset `loaded` first (see create/update).
		try {
			const data = await api().mcpList();
			set({ servers: data, loading: false, loaded: true });
		} catch {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const created = await api().mcpCreate(input);
		set({ loaded: false }); await get().fetchServers();
		return created;
	},

	update: async (id, input) => {
		const updated = await api().mcpUpdate(id, input);
		set({ loaded: false }); await get().fetchServers();
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

	scan: async () => {
		return api().mcpScan();
	},

	presets: async () => {
		return api().mcpPresets();
	},

	addPreset: async (presetId, envValues) => {
		const created = await api().mcpAddPreset(presetId, envValues);
		set({ loaded: false }); await get().fetchServers();
		return created;
	},
}));
