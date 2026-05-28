import { ipcMain } from "electron";
import type { IpcContext } from "./types.js";
import { refreshAgentTools } from "./core.js";

export function registerAgentHandlers(ctx: IpcContext): void {
	ipcMain.handle("agents:list", () => ctx.modulesReady ? ctx.agentStore.list() : []);
	ipcMain.handle("agents:get", (_e, id: string) => ctx.modulesReady ? ctx.agentStore.get(id) : undefined);
	ipcMain.handle("agents:create", (_e, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		const result = ctx.agentStore.create(input as any);
		refreshAgentTools();
		return result;
	});
	ipcMain.handle("agents:update", (_e, id: string, input: unknown) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try {
			const result = ctx.agentStore.update(id, input as any);
			refreshAgentTools();
			return result;
		} catch (e) { return { error: (e as Error).message }; }
	});
	ipcMain.handle("agents:delete", (_e, id: string) => {
		if (ctx.modulesReady) {
			ctx.agentStore.delete(id);
			refreshAgentTools();
		}
		return { success: true };
	});
}
