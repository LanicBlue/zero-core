// PostTurnComplete 钩子:全部完成的 todo 在「当前轮结束时」立即清空
//
// # 文件说明书
//
// ## 核心功能
// registerTodoCleanupHooks 在 PostTurnComplete(每轮 agent loop 结束时触发)检查
// agent 的 todo 列表:若**全部 completed**,则立即清空后端 store 并 emit
// todos_update([]),让前端 UI 隐藏。
//
// ## 为什么在 PostTurnComplete(当前轮结束直接清)
// 早期版本在 PreLLMCall(下一轮开始)清,实测"延迟 clear"体验差——全部完成的
// 待办会一直挂到 agent 再次说话才消失。改为 PostTurnComplete:本轮把最后一条
// todo 标完成、turn 一结束就清,UI 即时收起。
//
// ## 设计
// 清理 LOGIC 在本 hook + todo-write.ts(模块内);agent-loop 只在 PostTurnComplete
// ctx 暴露 emit(通用能力)。前端复用既有 todos_update → setTodos → 隐藏,零改动。
//
// ## 定位
// src/runtime/hooks/ — turn 生命周期钩子,由 hooks/index.ts 统一注册。
//

import { HookRegistry } from "../../core/hook-registry.js";
import { getSessionTodos, clearSessionTodos } from "../tools/todo-write.js";

export function registerTodoCleanupHooks(): void {
	HookRegistry.getInstance().register("PostTurnComplete", async (ctx: any) => {
		// 按 sessionId 隔离:同一 agent 的不同 session 各自清各自的 todo,
		// 避免一个 session 完成清空连累另一个 session 的列表。
		const sessionId = ctx?.sessionId as string | undefined;
		const agentId = ctx?.agentId as string | undefined;
		if (!sessionId) return;
		const todos = getSessionTodos(sessionId);
		if (todos.length === 0) return;
		const allDone = todos.every((t) => t.status === "completed");
		if (!allDone) return;
		// All completed → clear immediately at the end of this turn.
		clearSessionTodos(sessionId);
		// Notify the frontend so the widget hides (reuses the existing
		// todos_update → setTodos(sessionId, []) → TodosList returns null path).
		if (typeof ctx.emit === "function") {
			ctx.emit({ type: "todos_update", agentId, sessionId, todos: [] });
		}
		return;
	});
}
