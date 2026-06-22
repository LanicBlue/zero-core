// PreLLMCall 钩子:全部完成的 todo 在「下一轮」开始时清空
//
// # 文件说明书
//
// ## 核心功能
// registerTodoCleanupHooks 在 PreLLMCall(每轮 LLM 调用开始时触发)检查 agent 的
// todo 列表:若**全部 completed**,则清空后端 store 并 emit todos_update([]),
// 让前端 UI 隐藏。
//
// ## 为什么在 PreLLMCall(下一轮开始)
// 全完成的 todo 在当前轮保持显示(让 agent/用户看到「100%」),到**下一轮**开始时
// 清掉——即用户说的「延迟到下一个循环 clear」。PreLLMCall 正是下一轮的起点。
//
// ## 设计
// 清理 LOGIC 在本 hook + todo-write.ts(模块内);agent-loop 只在 PreLLMCall ctx
// 暴露 emit(通用能力)。前端复用既有 todos_update → setTodos → 隐藏,零改动。
//
// ## 定位
// src/runtime/hooks/ — turn 生命周期钩子,由 hooks/index.ts 统一注册。
//

import { HookRegistry } from "../../core/hook-registry.js";
import { getAgentTodos, clearAgentTodos } from "../tools/todo-write.js";

export function registerTodoCleanupHooks(): void {
	HookRegistry.getInstance().register("PreLLMCall", async (ctx: any) => {
		const agentId = ctx?.agentId as string | undefined;
		if (!agentId) return;
		const todos = getAgentTodos(agentId);
		if (todos.length === 0) return;
		const allDone = todos.every((t) => t.status === "completed");
		if (!allDone) return;
		// All completed → clear at the start of this (next) turn.
		clearAgentTodos(agentId);
		// Notify the frontend so the widget hides (reuses the existing
		// todos_update → setTodos(agentId, []) → TodosList returns null path).
		if (typeof ctx.emit === "function") {
			ctx.emit({ type: "todos_update", agentId, todos: [] });
		}
		return;
	});
}
