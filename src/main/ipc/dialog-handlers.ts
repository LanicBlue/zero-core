import { dialog } from "electron";
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

export function registerDialogHandlers(ctx: IpcContext): void {
	typedHandle("app:ready", [],
		() => ctx.modulesReady,
	);

	typedHandle("dialog:openDirectory", [],
		async () => {
			const result = await dialog.showOpenDialog(ctx.win, {
				properties: ["openDirectory", "createDirectory"],
				title: "Select Directory",
			});
			if (result.canceled || result.filePaths.length === 0) return undefined;
			return result.filePaths[0];
		},
	);
}
