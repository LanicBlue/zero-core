// IPC 模块总注册入口
//
// # 文件说明书
//
// ## 核心功能
// 集中注册所有 IPC handler，初始化模块就绪状态，协调主进程与渲染器通信
//
// ## 输入
// BrowserWindow 实例
//
// ## 输出
// 完成所有 IPC handler 的注册和模块初始化
//
// ## 定位
// src/main/ — 主进程入口，IPC 层的总协调者
//
// ## 依赖
// 所有 ipc/ 子模块、core/logger.ts
//
// ## 维护规则
// 新增 IPC handler 模块时需在此文件导入并注册
//
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
import { registerMessageHandlers } from "./ipc/message-handlers.js";
import { registerFileHandlers } from "./ipc/file-handlers.js";
import { registerChatHandlers } from "./ipc/chat-handlers.js";
import { registerTemplateHandlers } from "./ipc/template-handlers.js";
import { registerGithubTemplateHandlers } from "./ipc/github-template-handlers.js";
import { registerMcpHandlers } from "./ipc/mcp-handlers.js";
import { registerKbHandlers } from "./ipc/kb-handlers.js";
import { registerLogHandlers } from "./ipc/log-handlers.js";
import { registerToolExecutionHandlers } from "./ipc/tool-execution-handlers.js";
import { registerProjectHandlers } from "./ipc/project-handlers.js";
import { registerRequirementHandlers } from "./ipc/requirement-handlers.js";
import { registerWikiHandlers } from "./ipc/wiki-handlers.js";
import { registerCronHandlers } from "./ipc/cron-handlers.js";

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
	registerMessageHandlers(ctx);
	registerFileHandlers(ctx);
	registerChatHandlers(ctx);
	registerTemplateHandlers(ctx);
	registerGithubTemplateHandlers(ctx);
	registerMcpHandlers(ctx);
	registerKbHandlers(ctx);
	registerLogHandlers(ctx);
	registerToolExecutionHandlers(ctx);
	registerProjectHandlers(ctx);
	registerRequirementHandlers(ctx);
	registerWikiHandlers(ctx);
	registerCronHandlers(ctx);

	log.ipc("All handlers registered");

	// Load core modules in background — handlers use whenReady() to await specific modules
	loadCoreModules()
		.then(async () => {
			await moduleReadiness.whenAllReady();
			ctx.modulesReady = true;
			if (win && !win.isDestroyed()) {
				win.webContents.send("app:ready", true);
			}
		})
		.catch((err) => {
			log.error("ipc", "Core modules failed:", err.message);
			const failed = moduleReadiness.getFailedModules();
			if (win && !win.isDestroyed()) {
				win.webContents.send("app:ready", false);
				if (failed.length > 0) {
					win.webContents.send("app:module-errors", failed.map(f => ({ name: f.name, error: f.error.message })));
				}
			}
		});
}
