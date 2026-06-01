import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { McpServerConfig, CreateMcpInput, UpdateMcpInput } from "../../shared/types.js";

export function registerMcpHandlers(ctx: IpcContext): void {
	// MCP has custom logic on create/update/delete (auto-connect/disconnect),
	// so we register all handlers manually with typedHandle.

	typedHandle("mcp:list", "mcpStore",
		(_ctx) => (_ctx.mcpStore as any).list(),
	);

	typedHandle("mcp:get", "mcpStore",
		(_ctx, id) => (_ctx.mcpStore as any).get(id),
	);

	typedHandle("mcp:create", ["mcpStore", "mcpManager"],
		async (_ctx, input) => {
			const record = (_ctx.mcpStore as any).create(input) as McpServerConfig;
			if (record.enabled) {
				const result = await (_ctx.mcpManager as any).connect(record);
				return { ...record, connectedTools: result.tools, connectError: result.error };
			}
			return { ...record };
		},
	);

	typedHandle("mcp:update", ["mcpStore", "mcpManager"],
		async (_ctx, id, input) => {
			try {
				const record = (_ctx.mcpStore as any).update(id, input) as McpServerConfig;
				if (record.enabled) {
					await (_ctx.mcpManager as any).connect(record);
				} else {
					await (_ctx.mcpManager as any).disconnect(id);
				}
				return record;
			} catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("mcp:delete", ["mcpStore", "mcpManager"],
		async (_ctx, id) => {
			await (_ctx.mcpManager as any).disconnect(id);
			(_ctx.mcpStore as any).delete(id);
			return { success: true as const };
		},
	);

	typedHandle("mcp:test", "mcpManager",
		(_ctx, input) => (_ctx.mcpManager as any).testConnection(input),
	);

	typedHandle("mcp:tools", ["mcpStore", "mcpManager"],
		async (_ctx, serverId) => {
			const server = (_ctx.mcpStore as any).get(serverId) as McpServerConfig | undefined;
			if (!server) return [];
			if (!(_ctx.mcpManager as any).isConnected(serverId)) {
				const result = await (_ctx.mcpManager as any).connect(server);
				return result.tools;
			}
			return (_ctx.mcpManager as any).getConnectedServers().find((s: any) => s.id === serverId)?.toolCount ?? 0;
		},
	);

	typedHandle("mcp:connect", ["mcpStore", "mcpManager"],
		async (_ctx, id) => {
			const server = (_ctx.mcpStore as any).get(id) as McpServerConfig | undefined;
			if (!server) return { tools: [], error: "Server not found" };
			return (_ctx.mcpManager as any).connect(server);
		},
	);

	typedHandle("mcp:disconnect", "mcpManager",
		async (_ctx, id) => {
			await (_ctx.mcpManager as any).disconnect(id);
			return { success: true as const };
		},
	);

	typedHandle("mcp:status", "mcpManager",
		(_ctx) => (_ctx.mcpManager as any).getConnectedServers(),
	);
}
