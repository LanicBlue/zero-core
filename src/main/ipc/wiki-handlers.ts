// Project Wiki（项目知识库节点）IPC 处理器。
//
// # 文件说明书
//
// ## 核心功能
// 注册 `wiki:*` 系列 IPC 通道，提供按项目组织的 Wiki 节点 CRUD：
//   - wiki:listByProject 列出某项目下全部节点；
//   - wiki:getNode / wiki:createNode（强制绑定 projectId）/
//     wiki:updateNode（失败时返回 `{error}`）/ wiki:deleteNode。
//
// ## 输入
// - IpcContext：wikiStore
// - 通道参数：projectId、节点 id、节点 input
//
// ## 输出
// - WikiNode 列表 / 单节点 / 写操作结果
// - updateNode 失败统一返回 `{error: message}`
//
// ## 定位
// src/main/ipc 下领域 IPC 处理器；由 ipc 注册入口调用
// registerWikiHandlers(ctx)。是 M4 看板/知识库浏览页面的后端入口。
//
// ## 依赖
// - ./typed-ipc.js、./types.js
// - 间接：ctx.wikiStore（sessionDb 模块）
//
// ## 维护规则
// - 创建节点必须确保 projectId 绑定，避免悬挂节点
// - WikiNode 类型/字段变更需同步 shared 类型与 wikiStore 列定义
// - 写路径上的异常需收敛为 `{error}` 返回，避免渲染层崩溃
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
