// 系统对话框 IPC handlers
//
// # 文件说明书
//
// ## 核心功能
// 处理原生对话框（目录选择、文件选择等）和应用就绪状态 IPC 请求
//
// ## 输入
// 对话框选项参数
//
// ## 输出
// 用户选择的路径、应用就绪状态
//
// ## 定位
// src/main/ipc/ — 主进程 IPC 层，桥接 Electron 原生对话框
//
// ## 依赖
// Electron dialog、typed-ipc.ts
//
// ## 维护规则
// 新增原生对话框类型时在此注册
//
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
