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
	name: "todo_write",
	description:
		"Update the task list to track progress on multi-step work. " +
		"Mark tasks in_progress BEFORE starting them and completed IMMEDIATELY after finishing. " +
		"Only one task should be in_progress at a time.",
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
