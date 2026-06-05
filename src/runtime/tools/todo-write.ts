// Todo 任务管理工具
//
// # 文件说明书
//
// ## 核心功能
// 提供任务列表管理能力，跟踪当前会话的任务进度。
//
// ## 输入
// - 任务列表
//
// ## 输出
// - 更新后的任务列表
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
//
// ## 维护规则
// - 保持任务状态准确
// - 处理并发更新
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";

// ---------------------------------------------------------------------------
// TodoWrite — per-agent task list management
// ---------------------------------------------------------------------------

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
}

// Per-agent in-memory todo store
const agentTodos = new Map<string, TodoItem[]>();

export function getAgentTodos(agentId: string): TodoItem[] {
	return agentTodos.get(agentId) ?? [];
}

export function clearAgentTodos(agentId: string): void {
	agentTodos.delete(agentId);
}

export const todoWriteTool = buildTool({
	name: "TodoWrite",
	description: "Update the task list to track progress on multi-step work.",
	prompt:
		"Create and update a task list for tracking progress on multi-step work.\n\nWhen to update todos:\n- Starting a complex task with 3+ distinct steps\n- After completing a step — mark it done immediately\n- When discovering new work during implementation\n\nTask format: each item has content (imperative, e.g. 'Fix auth bug') and status (pending/in_progress/completed).\nKeep exactly one task in_progress at a time. Complete current tasks before starting new ones.",
	meta: { category: "interaction", isReadOnly: false, isConcurrencySafe: false },
	inputSchema: z.object({
		todos: z.array(z.object({
			content: z.string().min(1).describe("Task description (imperative form, e.g. 'Run tests')"),
			status: z.enum(["pending", "in_progress", "completed"]).describe("Current status"),
			activeForm: z.string().min(1).describe("Present continuous form (e.g. 'Running tests')"),
		})).describe("Complete task list — replaces the previous list entirely"),
	}),
	execute: async ({ todos }, ctx) => {
		agentTodos.set(ctx.agentId, todos);

		ctx.emit({
			type: "todos_update",
			agentId: ctx.agentId,
			todos,
		} as any);

		const completed = todos.filter((t: TodoItem) => t.status === "completed").length;
		const inProgress = todos.filter((t: TodoItem) => t.status === "in_progress").length;
		return `Task list updated: ${completed}/${todos.length} completed, ${inProgress} in progress.`;
	},
});
