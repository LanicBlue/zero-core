import { ipcMain } from "electron";
import type { IpcContext } from "./types.js";
import { refreshAgentTools } from "./core.js";

export function registerAgentToolHandlers(ctx: IpcContext): void {
	ipcMain.handle("agent-tools:list", () => ctx.modulesReady ? ctx.agentToolStore.list() : []);
	ipcMain.handle("agent-tools:get", (_e, id: string) => ctx.modulesReady ? ctx.agentToolStore.get(id) : undefined);
	ipcMain.handle("agent-tools:get-by-agent", (_e, agentId: string) => ctx.modulesReady ? ctx.agentToolStore.getByAgentId(agentId) : undefined);
	ipcMain.handle("agent-tools:create", (_e, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		const result = ctx.agentToolStore.create(input as any);
		refreshAgentTools();
		return result;
	});
	ipcMain.handle("agent-tools:update", (_e, id: string, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try {
			const result = ctx.agentToolStore.update(id, input as any);
			refreshAgentTools();
			return result;
		} catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("agent-tools:delete", (_e, id: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		ctx.agentToolStore.delete(id);
		refreshAgentTools();
		return { success: true };
	});
}
