import { ipcMain } from "electron";
import type { IpcContext } from "./types.js";

export function registerMcpHandlers(ctx: IpcContext): void {
	ipcMain.handle("mcp:list", () => ctx.modulesReady ? ctx.mcpStore.list() : []);
	ipcMain.handle("mcp:get", (_e, id: string) => ctx.modulesReady ? ctx.mcpStore.get(id) : undefined);
	ipcMain.handle("mcp:create", async (_e, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		const record = ctx.mcpStore.create(input as any);
		if (record.enabled) {
			const result = await ctx.mcpManager.connect(record);
			return { ...record, connectedTools: result.tools, connectError: result.error };
		}
		return record;
	});
	ipcMain.handle("mcp:update", async (_e, id: string, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try {
			const record = ctx.mcpStore.update(id, input as any);
			if (record.enabled) {
				await ctx.mcpManager.connect(record);
			} else {
				await ctx.mcpManager.disconnect(id);
			}
			return record;
		} catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("mcp:delete", async (_e, id: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		await ctx.mcpManager.disconnect(id);
		ctx.mcpStore.delete(id);
		return { success: true };
	});
	ipcMain.handle("mcp:test", async (_e, input: unknown) => {
		if (!ctx.modulesReady) return { tools: [], error: "loading" };
		return ctx.mcpManager.testConnection(input as any);
	});
	ipcMain.handle("mcp:tools", async (_e, serverId: string) => {
		if (!ctx.modulesReady) return [];
		const server = ctx.mcpStore.get(serverId);
		if (!server) return [];
		if (!ctx.mcpManager.isConnected(serverId)) {
			const result = await ctx.mcpManager.connect(server);
			return result.tools;
		}
		return ctx.mcpManager.getConnectedServers().find((s: any) => s.id === serverId)?.toolCount ?? 0;
	});
	ipcMain.handle("mcp:connect", async (_e, id: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		const server = ctx.mcpStore.get(id);
		if (!server) return { tools: [], error: "Server not found" };
		const result = await ctx.mcpManager.connect(server);
		return result;
	});
	ipcMain.handle("mcp:disconnect", async (_e, id: string) => {
		await ctx.mcpManager.disconnect(id);
		return { success: true };
	});
	ipcMain.handle("mcp:status", () => {
		return ctx.mcpManager.getConnectedServers();
	});
}
