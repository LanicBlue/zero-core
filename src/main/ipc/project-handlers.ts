// Project（多 agent 工作流的项目实体）IPC 处理器。
//
// # 文件说明书
//
// ## 核心功能
// 注册 `projects:*` 系列 IPC 通道：
//   - 通过 registerCrud 复用通用 CRUD（list/get/create/update/delete），落地到
//     ctx.projectStore；
//   - 额外实现 M5 三项调度控制：
//     projects:updateInterval（更新分析间隔并 rescheduleProject）、
//     projects:pause（置 paused + unscheduleProject）、
//     projects:resume（置 active + scheduleProject）。
//
// ## 输入
// - IpcContext：projectStore、可选 cronManager
// - 通道参数：projectId、interval
//
// ## 输出
// - ProjectRecord / CRUD 结果
// - `{success:true}` 控制结果；失败抛错由 typedHandle 兜底
// - 副作用：cronManager 中的项目排程随之更新
//
// ## 定位
// src/main/ipc 下的领域 IPC 处理器；由 ipc 注册入口在初始化时调用
// registerProjectHandlers(ctx)。
//
// ## 依赖
// - ./typed-ipc.js：registerCrud / typedHandle
// - ./types.js：IpcContext
// - ../../shared/types.js：ProjectRecord、CreateProjectInput、UpdateProjectInput
// - 间接：ctx.projectStore、ctx.cronManager（M5 调度器）
//
// ## 维护规则
// - 新增 projects 通道时优先复用 registerCrud，仅在需要副作用时手写 typedHandle
// - 任何 status / interval 的写入必须与 cronManager 排程同步，避免漂移
// - 字段变更需同时更新 shared 类型与 projectStore 列定义
//
import { registerCrud, typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { ProjectRecord, CreateProjectInput, UpdateProjectInput } from "../../shared/types.js";

export function registerProjectHandlers(ctx: IpcContext): void {
	registerCrud<ProjectRecord, CreateProjectInput, UpdateProjectInput>({
		channel: "projects",
		store: () => ctx.projectStore as any,
		module: "sessionDb",
	});

	// M5: Update analysis interval (v0.8 M0: analysisInterval moved off
	// ProjectRecord; cron becomes first-class in M1. For now, just reschedule.)
	typedHandle("projects:updateInterval", "sessionDb", (ctx, id, interval) => {
		if (ctx.cronManager) {
			ctx.cronManager.rescheduleProject(id, interval);
		}
		return { success: true as const };
	});

	// M5: Pause project analysis (v0.8 M0: status removed from ProjectRecord)
	typedHandle("projects:pause", "sessionDb", (ctx, id) => {
		if (ctx.cronManager) {
			ctx.cronManager.unscheduleProject(id);
		}
		return { success: true as const };
	});

	// M5: Resume project analysis (v0.8 M0: status / analysisInterval removed)
	typedHandle("projects:resume", "sessionDb", (ctx, id) => {
		if (ctx.cronManager) {
			ctx.cronManager.scheduleProject(id, "daily");
		}
		return { success: true as const };
	});
}
