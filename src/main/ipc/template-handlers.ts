// 模板管理 IPC handlers
//
// # 文件说明书
//
// ## 核心功能
// 处理模板的列表查询、获取、创建、更新和删除 IPC 请求
//
// ## 输入
// 模板 ID、模板数据
//
// ## 输出
// 模板列表、模板详情、CRUD 操作结果
//
// ## 定位
// src/main/ipc/ — 主进程 IPC 层，管理 Agent 模板
//
// ## 依赖
// typed-ipc.ts、templateStore
//
// ## 维护规则
// 内置模板不可删除，需在 handler 中保留保护逻辑
//
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

export function registerTemplateHandlers(_ctx: IpcContext): void {
	// Template delete can throw (built-in templates), so all handlers are manual.
	typedHandle("templates:list", "templateStore",
		(ctx) => (ctx.templateStore as any).list(),
	);

	typedHandle("templates:get", "templateStore",
		(ctx, id) => (ctx.templateStore as any).get(id),
	);

	typedHandle("templates:create", "templateStore",
		(ctx, input) => (ctx.templateStore as any).create(input),
	);

	typedHandle("templates:update", "templateStore",
		(ctx, id, input) => {
			try { return (ctx.templateStore as any).update(id, input); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("templates:delete", "templateStore",
		(ctx, id) => {
			try { (ctx.templateStore as any).delete(id); return { success: true as const }; }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("templates:export", "templateStore",
		(ctx, id) => {
			try { return (ctx.templateStore as any).exportTemplate(id); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("templates:import", "templateStore",
		(ctx, json) => {
			try { return (ctx.templateStore as any).importTemplate(json); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);
}
