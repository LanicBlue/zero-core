// 项目 IPC 处理器
//
// # 文件说明书
//
// ## 核心功能
// Project 相关的 IPC 处理器，处理 Project CRUD 操作。
//
// ## 输入
// - IPC 通道调用
// - IpcContext - 上下文
//
// ## 输出
// - Project 数据
// - CRUD 操作结果
//
// ## 定位
// IPC 处理器，被 ipc.ts 注册。
//
// ## 依赖
// - ./typed-ipc - 类型化 IPC
// - ../../shared/types - 共享类型
//
import { registerCrud } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { ProjectRecord, CreateProjectInput, UpdateProjectInput } from "../../shared/types.js";

export function registerProjectHandlers(ctx: IpcContext): void {
	registerCrud<ProjectRecord, CreateProjectInput, UpdateProjectInput>({
		channel: "projects",
		store: () => ctx.projectStore as any,
		module: "sessionDb",
	});
}
