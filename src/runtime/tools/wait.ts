// 等待工具
//
// # 文件说明书
//
// ## 核心功能
// 提供后台任务等待能力，支持事件驱动的任务完成通知。
//
// ## 输入
// - 超时时间
// - 任务 ID（可选）
//
// ## 输出
// - 任务完成状态
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
//
// ## 维护规则
// - 保持事件驱动逻辑正确
// - 处理超时情况
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const waitTool = buildTool({
	name: "Wait",
	description: "Wait for background tasks to complete or a timeout.",
	prompt: "Wait for background tasks (Agent non-blocking, Bash background) to complete, or for a timeout.\n\n" +
		"Wakes immediately when any background task finishes. Returns a status summary of completed tasks.\n\n" +
		"When to use Wait:\n" +
		"- After dispatching one or more non-blocking Agent or background Bash tasks\n" +
		"- When you need to coordinate multiple parallel tasks\n\n" +
		"Parameters:\n" +
		"- timeout: max wait in seconds (1-3600). Wakes when all tasks complete or timeout is reached.\n" +
		"- task_id: wait for a specific task. If omitted, wakes on any background event.\n\n" +
		"Prefer Wait over polling with TaskStatus in a loop. Wait is event-driven and more efficient.",
	meta: { category: "runtime", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	inputSchema: z.object({
		timeout: z.number().min(1).max(3600).describe("Maximum wait time in seconds (1-3600)."),
		task_id: z.string().optional().describe("Wait for a specific task by ID. If omitted, wakes on any background event."),
	}),
	execute: async (input, ctx) => {
		const seconds = Math.max(1, Math.min(input.timeout, 3600));
		const taskId = input.task_id;

		if (ctx.suspendUntilWake) {
			const summary = await ctx.suspendUntilWake(seconds * 1000, taskId);
			return summary;
		}

		// Fallback: simple sleep
		await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
		return `Resumed after ${seconds}s.`;
	},
});
