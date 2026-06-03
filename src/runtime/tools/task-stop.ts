import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const taskStopTool = buildTool({
	name: "TaskStop",
	description: "Stop a running background task by task_id.",
	prompt: "Stop a running background task (Agent or Bash) by task_id.\n\n" +
		"The task is immediately aborted. Stopped tasks cannot be resumed.\n\n" +
		"When to use:\n" +
		"- A background task is taking too long or producing unwanted results\n" +
		"- The user asks to cancel an ongoing operation\n" +
		"- You dispatched a task that is no longer relevant",
	meta: { category: "task", isReadOnly: false, isConcurrencySafe: false, isDestructive: true },
	inputSchema: z.object({
		task_id: z.string().describe("The task ID of the subagent to stop"),
	}),
	execute: async (input, ctx) => {
		if (!ctx.stopTask) {
			return "Error: Task stop is not available in this context.";
		}

		const info = ctx.getTaskResult?.(input.task_id);
		if (!info) {
			return `Task ${input.task_id} not found.`;
		}
		if (info.status !== "running") {
			return `Task ${input.task_id} is not running (status: ${info.status}).`;
		}

		const killed = ctx.stopTask(input.task_id);
		if (killed) {
			return `Task ${input.task_id} has been stopped.`;
		}
		return `Failed to stop task ${input.task_id}.`;
	},
});
