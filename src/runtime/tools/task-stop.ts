// 任务停止工具
//
// # 文件说明书
//
// ## 核心功能
// 提供后台任务停止能力，允许取消正在运行的任务。
//
// ## 输入
// - 任务 ID
//
// ## 输出
// - 停止结果
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
//
// ## 维护规则
// - 保持停止逻辑正确
// - 处理无效任务引用
//
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
