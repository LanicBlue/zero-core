import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const taskStopTool = buildTool({
	name: "task_stop",
	description:
		"Stop a running background subagent by task_id. The subagent is aborted and its status set to 'killed'.",
	userDescription: "停止运行中的后台任务（子 agent 或 bash 命令）。通过 task_id 指定要停止的子 agent，它会立即被终止。适用于：子 agent 运行出错或不再需要时及时释放资源。",
	meta: { category: "runtime", isReadOnly: false, isConcurrencySafe: false, isDestructive: true },
	inputSchema: z.object({
		task_id: z.string().describe("The task ID of the subagent to stop"),
	}),
	execute: async (input, ctx) => {
		if (!ctx.stopTask) {
			return "Error: Task stop is not available in this context.";
		}

		// Check if task exists
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
