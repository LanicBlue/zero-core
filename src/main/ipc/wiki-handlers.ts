// Wiki IPC 处理器
//
// # 文件说明书
//
// ## 核心功能
// Wiki 相关的 IPC 处理器，处理 Wiki 节点 CRUD 操作。
//
// ## 输入
// - IPC 通道调用
// - IpcContext - 上下文
//
// ## 输出
// - Wiki 节点数据
// - CRUD 操作结果
//
// ## 定位
// IPC 处理器，被 ipc.ts 注册。
//
// ## 依赖
// - ./typed-ipc - 类型化 IPC
// - ../../shared/types - 共享类型
//
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

export function registerWikiHandlers(ctx: IpcContext): void {
	// List by project
	typedHandle("wiki:listByProject", "sessionDb", (ctx, projectId) => {
		return ctx.wikiStore.listByProject(projectId);
	});

	// Get node
	typedHandle("wiki:getNode", "sessionDb", (ctx, id) => {
		return ctx.wikiStore.get(id);
	});

	// Create node
	typedHandle("wiki:createNode", "sessionDb", (ctx, projectId, input) => {
		return ctx.wikiStore.create({ ...input, projectId });
	});

	// Update node
	typedHandle("wiki:updateNode", "sessionDb", (ctx, id, input) => {
		try {
			return ctx.wikiStore.update(id, input);
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// Delete node
	typedHandle("wiki:deleteNode", "sessionDb", (ctx, id) => {
		ctx.wikiStore.delete(id);
		return { success: true as const };
	});
}
