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
// - 按 sessionId 隔离(同一 agent 的不同 project session 各自独立 todo 列表,
//   避免"Tasks 在一个 agent 内跨 session 串显")
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";

// ---------------------------------------------------------------------------
// TodoWrite — per-session task list management
// ---------------------------------------------------------------------------

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
}

// Per-session in-memory todo store. Keyed by sessionId(同一 agent 的 General /
// 各 project session 互不干扰)。ctx 没有 sessionId 时退化为 agentId,保证旧路径
// 不崩。
const sessionTodos = new Map<string, TodoItem[]>();

function todoKey(sessionId: string | undefined, agentId: string | undefined): string {
	return sessionId ?? agentId ?? "_default";
}

export function getSessionTodos(sessionId: string): TodoItem[] {
	return sessionTodos.get(sessionId) ?? [];
}

export function clearSessionTodos(sessionId: string): void {
	sessionTodos.delete(sessionId);
}

/**
 * Render the session's current todo list as a context block (null if empty).
 * Called by agent-loop each turn so the agent SEES its todo state (not just
 * writes blindly). Rendering lives here (the todo module); agent-loop only
 * wires the result into buildContextMessage — keeps tool/loop concerns separate.
 */
export function renderTodosContext(sessionId: string | undefined, agentId?: string): string | null {
	const todos = sessionTodos.get(todoKey(sessionId, agentId));
	if (!todos || todos.length === 0) return null;
	const lines = todos.map((t) => {
		const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
		return `- ${mark} ${t.content}`;
	});
	const completed = todos.filter((t) => t.status === "completed").length;
	return `${completed}/${todos.length} done\n` + lines.join("\n");
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
		const key = todoKey(ctx.sessionId, ctx.agentId);
		sessionTodos.set(key, todos);

		ctx.emit({
			type: "todos_update",
			agentId: ctx.agentId,
			sessionId: ctx.sessionId,
			todos,
		} as any);

		// Return the FULL list (not just a summary) so the agent sees the actual
		// items + statuses it just committed. Previously returned only "X/Y done",
		// which told the agent nothing about the contents.
		const rendered = renderTodosContext(ctx.sessionId, ctx.agentId) ?? "(empty list)";
		const inProgress = todos.filter((t: TodoItem) => t.status === "in_progress").length;
		return `Task list updated (${inProgress} in progress).\n${rendered}`;
	},
});
