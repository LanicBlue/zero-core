// Project（多 agent 工作流的项目实体）IPC 处理器。
//
// # 文件说明书
//
// ## 核心功能
// 注册 `projects:*` 系列 IPC 通道：
//   - 通过 registerCrud 复用通用 CRUD（list/get/create/update/delete），落地到
//     ctx.projectStore。
//
// v0.8 (P4 §8.6): projects:pause / resume / updateInterval 已删除 — 这些是
// project 域 dead 调度通道 (cron 一等公民后, project 不再 own 一个 schedule)。
// 调度面统一走 crons:* (agent-scoped)。
//
// ## 输入
// - IpcContext：projectStore
//
// ## 输出
// - ProjectRecord / CRUD 结果
//
// ## 定位
// src/main/ipc 下的领域 IPC 处理器；由 ipc 注册入口在初始化时调用
// registerProjectHandlers(ctx)。
//
// ## 依赖
// - ./typed-ipc.js：registerCrud
// - ./types.js：IpcContext
// - ../../shared/types.js：ProjectRecord、CreateProjectInput、UpdateProjectInput
//
// ## 维护规则
// - 新增 projects 通道时优先复用 registerCrud，仅在需要副作用时手写 typedHandle
// - 字段变更需同时更新 shared 类型与 projectStore 列定义
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
