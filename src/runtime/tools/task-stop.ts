import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const taskStopTool = buildTool({
	name: "TaskStop",
	description: "Stop a running background task by task_id.",
	prompt:
		"Stop a running background subagent by task_id. The subagent is aborted and its status set to 'killed'.",
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
