import type { BrowserWindow } from "electron";
import { log } from "../core/logger.js";
import { loadCoreModules, getModuleState, setMainWindow } from "./ipc/core.js";
import { setContextGetter } from "./ipc/typed-ipc.js";
import { moduleReadiness } from "./ipc/module-readiness.js";
import { registerDialogHandlers } from "./ipc/dialog-handlers.js";
import { registerConfigHandlers } from "./ipc/config-handlers.js";
import { registerAgentHandlers } from "./ipc/agent-handlers.js";
import { registerAgentToolHandlers } from "./ipc/agent-tool-handlers.js";
import { registerProviderHandlers } from "./ipc/provider-handlers.js";
import { registerToolHandlers } from "./ipc/tool-handlers.js";
import { registerSessionHandlers } from "./ipc/session-handlers.js";
import { registerFileHandlers } from "./ipc/file-handlers.js";
import { registerChatHandlers } from "./ipc/chat-handlers.js";
import { registerTemplateHandlers } from "./ipc/template-handlers.js";
import { registerMcpHandlers } from "./ipc/mcp-handlers.js";
import { registerKbHandlers } from "./ipc/kb-handlers.js";
import { registerLogHandlers } from "./ipc/log-handlers.js";

export function registerIpc(win: BrowserWindow): void {
	setMainWindow(win);

	const ctx = getModuleState();
	setContextGetter(() => ctx);

	registerDialogHandlers(ctx);
	registerConfigHandlers(ctx);
	registerAgentHandlers(ctx);
	registerAgentToolHandlers(ctx);
	registerProviderHandlers(ctx);
	registerToolHandlers(ctx);
	registerSessionHandlers(ctx);
	registerFileHandlers(ctx);
	registerChatHandlers(ctx);
	registerTemplateHandlers(ctx);
	registerMcpHandlers(ctx);
	registerKbHandlers(ctx);
	registerLogHandlers(ctx);

	log.ipc("All handlers registered");

	// Load core modules in background — handlers use whenReady() to await specific modules
	loadCoreModules().then(async () => {
		await moduleReadiness.whenAllReady();
		ctx.modulesReady = true;
		if (win && !win.isDestroyed()) {
			win.webContents.send("app:ready", true);
		}
	});
}
