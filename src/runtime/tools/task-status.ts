import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { TaskInfo } from "../types.js";

function formatTaskInfo(info: TaskInfo): string {
	const lines = [`task_id: ${info.id}`, `Status: ${info.status}`, `Steps: ${info.step}`];
	if (info.maxSteps) lines.push(`Max steps: ${info.maxSteps}`);
	if (info.currentTool) lines.push(`Current tool: ${info.currentTool}`);
	if (info.result) {
		const result = info.result.length > 3000 ? info.result.slice(0, 3000) + "\n... (truncated)" : info.result;
		lines.push(`Result: ${result}`);
	}
	if (info.error) lines.push(`Error: ${info.error}`);
	return lines.join("\n");
}

export const taskStatusTool = buildTool({
	name: "task_status",
	description:
		"Check the status and progress of a non-blocking subagent task. Returns current step, running tool, and result when completed.",
	userDescription: "查询后台任务（子 agent 或 bash 命令）的状态和执行进度。显示当前步数、正在使用的工具，以及完成后的结果。支持等待模式（wait=true），阻塞直到任务完成。",
	meta: { category: "runtime", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	inputSchema: z.object({
		task_id: z.string().describe("The task ID returned by agent in non-blocking mode"),
		wait: z.boolean().optional().describe("If true, block until the task completes or fails (max 120s)"),
	}),
	execute: async (input, ctx) => {
		if (!ctx.getTaskResult) {
			return "Error: Task status is not available in this context.";
		}

		if (input.wait) {
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const info = ctx.getTaskResult(input.task_id);
				if (!info) return `Task ${input.task_id} not found.`;
				if (info.status !== "running") {
					return formatTaskInfo(info);
				}
				await new Promise((r) => setTimeout(r, 1000));
			}
			const info = ctx.getTaskResult(input.task_id);
			if (info) return `Task is still running after 120s.\n\n${formatTaskInfo(info)}`;
			return `Task ${input.task_id} not found.`;
		}

		const info = ctx.getTaskResult(input.task_id);
		if (!info) return `Task ${input.task_id} not found.`;
		return formatTaskInfo(info);
	},
});
