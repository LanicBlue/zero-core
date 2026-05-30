import { ipcMain } from "electron";
import type { IpcContext } from "./types.js";

export function registerToolHandlers(ctx: IpcContext): void {
	ipcMain.handle("tools:list", () => {
		if (!ctx.modulesReady || !ctx.toolRegistry) return [];
		return ctx.toolRegistry.getAll().map((d: any) => ({
			name: d.name,
			description: d.description,
			prompt: d.prompt,
			group: d.category,
			source: d.source,
			mcpServerName: d.mcpServerName,
			configSchema: d.configSchema,
			meta: d.meta,
		}));
	});

	ipcMain.handle("tool-config:get", () => {
		if (!ctx.toolRegistry) return {};
		return ctx.toolRegistry.getToolConfig();
	});

	ipcMain.handle("tool-config:save", (_e, config: Record<string, Record<string, any>>) => {
		if (!ctx.toolRegistry) return;
		ctx.toolRegistry.saveToolConfig(config);
	});
}
