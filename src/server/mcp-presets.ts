// MCP 服务预定义清单与配置构造器,给 MCP 一键导入提供模板
//
// # 文件说明书
//
// ## 核心功能
// 维护一份内置 MCP 服务器预设列表(目前主要是 Z.AI 系列的视觉、Web 搜索、Web Reader、Zread),并提供 buildPresetConfig 把预设与用户填入的环境/凭证合并为可直接入库的 McpServerConfig。
//
// ## 输入
// - 调用方选定 McpPreset
// - envValues: 用户为 envKeys / headersKeys 中占位符(${KEY})填入的真实值
//
// ## 输出
// - 导出 MCP_PRESETS: McpPreset[]
// - buildPresetConfig 返回 Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">,可直接交给 McpStore.create
//
// ## 定位
// src/server/ 服务层,被 mcp-router 用来提供预设列表与一键添加;本身不直接挂载路由。
//
// ## 依赖
// - ../shared/types(McpServerConfig)
//
// ## 维护规则
// - 新增预设时确保 envKeys/headersKeys 中的占位符语法(${KEY})与 buildPresetConfig 的替换逻辑一致。
// - 预设中 command/args 仅对 stdio transport 有效;url/headers 仅对 sse/streamable-http 有效。
// - 不要把任何真实凭证写进预设,只声明需要哪些键。
//

import type { McpServerConfig } from "../shared/types.js";

export interface McpPreset {
	id: string;
	name: string;
	description: string;
	category: string;
	transport: "stdio" | "sse" | "streamable-http";
	command?: string;
	args?: string[];
	envKeys: string[];
	url?: string;
	headersKeys?: string[];
}

export const MCP_PRESETS: McpPreset[] = [
	{
		id: "zai-vision",
		name: "Z.AI Vision",
		description: "Image & video analysis, UI-to-code, OCR, error diagnosis, data visualization",
		category: "Z.AI",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@z_ai/mcp-server"],
		envKeys: ["Z_AI_API_KEY", "Z_AI_MODE=ZHIPU"],
	},
	{
		id: "zai-web-search",
		name: "Z.AI Web Search",
		description: "Web search with titles, URLs, summaries, and site icons",
		category: "Z.AI",
		transport: "streamable-http",
		url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
		headersKeys: ["Authorization=Bearer ${Z_AI_API_KEY}"],
		envKeys: ["Z_AI_API_KEY"],
	},
	{
		id: "zai-web-reader",
		name: "Z.AI Web Reader",
		description: "Fetch and convert web pages to LLM-friendly markdown content",
		category: "Z.AI",
		transport: "streamable-http",
		url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
		headersKeys: ["Authorization=Bearer ${Z_AI_API_KEY}"],
		envKeys: ["Z_AI_API_KEY"],
	},
	{
		id: "zai-zread",
		name: "Z.AI Zread",
		description: "Read GitHub repo structures, files, docs, and issues",
		category: "Z.AI",
		transport: "streamable-http",
		url: "https://open.bigmodel.cn/api/mcp/zread/mcp",
		headersKeys: ["Authorization=Bearer ${Z_AI_API_KEY}"],
		envKeys: ["Z_AI_API_KEY"],
	},
];

export function buildPresetConfig(
	preset: McpPreset,
	envValues: Record<string, string>,
): Omit<McpServerConfig, "id" | "createdAt" | "updatedAt"> {
	const config: any = {
		name: preset.name,
		transport: preset.transport,
		enabled: true,
		sourceApp: `preset-${preset.id}`,
	};

	if (preset.transport === "stdio") {
		config.command = preset.command;
		config.args = preset.args;
		if (preset.envKeys.length > 0) {
			config.env = {} as Record<string, string>;
			for (const keyExpr of preset.envKeys) {
				const eq = keyExpr.indexOf("=");
				if (eq > 0) {
					const k = keyExpr.slice(0, eq);
					const v = keyExpr.slice(eq + 1);
					config.env[k] = v.startsWith("${") && v.endsWith("}")
						? (envValues[v.slice(2, -1)] ?? "")
						: v;
				} else {
					config.env[keyExpr] = envValues[keyExpr] ?? "";
				}
			}
		}
	} else {
		config.url = preset.url;
		if (preset.headersKeys && preset.headersKeys.length > 0) {
			config.headers = {} as Record<string, string>;
			for (const hExpr of preset.headersKeys) {
				const eq = hExpr.indexOf("=");
				if (eq > 0) {
					const k = hExpr.slice(0, eq);
					let v = hExpr.slice(eq + 1);
					const match = v.match(/\$\{(\w+)\}/g);
					if (match) {
						for (const ph of match) {
							const key = ph.slice(2, -1);
							v = v.replace(ph, envValues[key] ?? "");
						}
					}
					config.headers[k] = v;
				}
			}
		}
	}

	return config;
}
