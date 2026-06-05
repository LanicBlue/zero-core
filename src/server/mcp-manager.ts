// MCP 服务器管理器
//
// # 文件说明书
//
// ## 核心功能
// 管理 MCP 服务器连接，处理工具发现和调用。
//
// ## 输入
// - McpServerConfig - 服务器配置
//
// ## 输出
// - MCP 工具列表
// - 工具调用结果
//
// ## 定位
// 服务层管理器，被 agent-service 使用。
//
// ## 依赖
// - @modelcontextprotocol/sdk - MCP SDK
// - ../core/tool-registry - 工具注册
//
// ## 维护规则
// - MCP 协议变更时需更新
// - 保持连接状态同步
//
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerConfig } from "../shared/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: unknown;
}

interface ConnectedServer {
	config: McpServerConfig;
	client: Client;
	transport: StdioClientTransport | SSEClientTransport;
	tools: McpToolInfo[];
	connectedAt: number;
}

// ---------------------------------------------------------------------------
// MCP Manager — manages connections to MCP servers
// ---------------------------------------------------------------------------

export class MCPManager {
	private servers = new Map<string, ConnectedServer>();
	private toolCache = new Map<string, { tools: McpToolInfo[]; expires: number }>();
	private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private registry: ToolRegistry;

	constructor(registry: ToolRegistry) {
		this.registry = registry;
	}

	async connect(config: McpServerConfig): Promise<{ tools: McpToolInfo[]; error?: string }> {
		// Disconnect existing if reconnecting
		if (this.servers.has(config.id)) {
			await this.disconnect(config.id);
		}

		try {
			let transport: StdioClientTransport | SSEClientTransport;

			if (config.transport === "stdio") {
				if (!config.command) {
					return { tools: [], error: "stdio transport requires a command" };
				}
				transport = new StdioClientTransport({
					command: config.command,
					args: config.args ?? [],
					env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
				});
			} else {
				// sse or streamable-http
				if (!config.url) {
					return { tools: [], error: `${config.transport} transport requires a URL` };
				}
				transport = new SSEClientTransport(
					new URL(config.url),
					{ requestInit: { headers: config.headers } },
				);
			}

			const client = new Client(
				{ name: "zero-core", version: "1.0.0" },
				{ capabilities: {} },
			);

			await client.connect(transport);

			// List tools
			const toolsResult = await client.listTools();
			const tools: McpToolInfo[] = (toolsResult.tools ?? []).map((t: any) => ({
				name: t.name,
				description: t.description ?? undefined,
				inputSchema: t.inputSchema ?? {},
			}));

			this.servers.set(config.id, {
				config,
				client,
				transport,
				tools,
				connectedAt: Date.now(),
			});

			// Update cache
			this.toolCache.set(config.id, { tools, expires: Date.now() + this.CACHE_TTL });

			// Register MCP tools into ToolRegistry
			for (const t of tools) {
				const qualifiedName = `mcp__${config.name}__${t.name}`;
				this.registry.register({
					name: qualifiedName,
					description: t.description ?? "",
					category: "mcp",
					source: "mcp",
					mcpServerId: config.id,
					mcpServerName: config.name,
					meta: {
						isReadOnly: true,
						isDestructive: false,
						isConcurrencySafe: true,
						requiresConfirmation: false,
					},
				});
			}
			this.registry.notifyChange?.();

			return { tools };
		} catch (err) {
			return { tools: [], error: (err as Error).message };
		}
	}

	async disconnect(serverId: string): Promise<void> {
		const server = this.servers.get(serverId);
		if (!server) return;

		try {
			await server.client.close();
		} catch {
			// ignore close errors
		}

		// Kill stdio transport process if possible
		if (server.transport instanceof StdioClientTransport) {
			try {
				(server.transport as any).close?.();
			} catch (err) { log.warn("mcp", "transport close failed:", (err as Error).message); }
		}

		this.servers.delete(serverId);
		this.toolCache.delete(serverId);

		// Unregister MCP tools from ToolRegistry
		this.registry.unregister("mcp", serverId);
	}

	async disconnectAll(): Promise<void> {
		const ids = [...this.servers.keys()];
		await Promise.all(ids.map((id) => this.disconnect(id)));
	}

	async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<{ result: unknown; error?: string }> {
		const server = this.servers.get(serverId);
		if (!server) {
			return { result: null, error: `MCP server not connected: ${serverId}` };
		}

		try {
			const result = await server.client.callTool({ name: toolName, arguments: args });
			return { result };
		} catch (err) {
			return { result: null, error: (err as Error).message };
		}
	}

	getToolsForAgent(agentId?: string): Map<string, McpToolInfo & { serverId: string; serverName: string }> {
		const result = new Map<string, McpToolInfo & { serverId: string; serverName: string }>();

		for (const [serverId, server] of this.servers) {
			if (!server.config.enabled) continue;
			// Filter by agent if agentIds is configured
			if (server.config.agentIds?.length && agentId && !server.config.agentIds.includes(agentId)) continue;

			for (const tool of server.tools) {
				const qualifiedName = `mcp__${server.config.name}__${tool.name}`;
				result.set(qualifiedName, { ...tool, serverId, serverName: server.config.name });
			}
		}

		return result;
	}

	getConnectedServers(): { id: string; name: string; connected: boolean; toolCount: number; error?: string }[] {
		const result: { id: string; name: string; connected: boolean; toolCount: number; error?: string }[] = [];
		for (const [id, server] of this.servers) {
			result.push({
				id,
				name: server.config.name,
				connected: true,
				toolCount: server.tools.length,
			});
		}
		return result;
	}

	isConnected(serverId: string): boolean {
		return this.servers.has(serverId);
	}

	async testConnection(config: McpServerConfig): Promise<{ tools: McpToolInfo[]; error?: string }> {
		// Test connection without persisting
		const result = await this.connect(config);
		if (result.error) {
			return result;
		}
		// Disconnect after test
		await this.disconnect(config.id);
		return result;
	}

	async reconnectEnabled(configs: McpServerConfig[]): Promise<void> {
		const enabledConfigs = configs.filter((c) => c.enabled);
		await Promise.allSettled(
			enabledConfigs.map((config) => this.connect(config)),
		);
	}
}
