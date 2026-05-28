import { ipcMain, dialog } from "electron";
import type { IpcContext } from "./types.js";

export function registerDialogHandlers(ctx: IpcContext): void {
	ipcMain.handle("app:ready", () => ctx.modulesReady);

	ipcMain.handle("dialog:openDirectory", async () => {
		const result = await dialog.showOpenDialog(ctx.win, {
			properties: ["openDirectory", "createDirectory"],
			title: "Select Directory",
		});
		if (result.canceled || result.filePaths.length === 0) return undefined;
		return result.filePaths[0];
	});
}
