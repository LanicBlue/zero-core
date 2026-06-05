// 任务列表工具
//
// # 文件说明书
//
// ## 核心功能
// 提供任务列表查询能力，显示所有后台任务的状态。
//
// ## 输入
// - 无参数
//
// ## 输出
// - 任务列表及状态
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - ../types - 类型定义
//
// ## 维护规则
// - 保持任务状态准确
// - 处理无效任务引用
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { TaskInfo } from "../types.js";

function formatTask(t: TaskInfo): string {
	const elapsed = t.completedAt
		? Math.round((t.completedAt - t.startedAt) / 1000) + "s"
		: Math.round((Date.now() - t.startedAt) / 1000) + "s";
	const statusIcon = { running: "●", completed: "✓", failed: "✗", killed: "⊘" }[t.status];
	const typeLabel = t.type === "bash" ? "bash" : "subagent";

	let line = `${statusIcon} [${t.id}] ${typeLabel}  ${t.status}  step:${t.step}  ${elapsed}`;
	if (t.currentTool) line += `  tool:${t.currentTool}`;
	line += `\n    ${t.task}`;
	if (t.error) line += `\n    error: ${t.error}`;
	return line;
}

export const taskListTool = buildTool({
	name: "TaskList",
	description: "List all background tasks with their status and progress.",
	prompt: "List all background tasks dispatched by this agent.\n\n" +
		"Returns: task IDs, status (running/completed/killed), type, and summary.\n\n" +
		"When to use:\n" +
		"- After dispatching multiple parallel tasks to check overall progress\n" +
		"- To find a task_id for use with TaskStatus or Wait\n" +
		"- To review completed task results\n\n" +
		"Use filter parameter to narrow results: running for active, completed for finished.",
	meta: { category: "task", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	configSchema: [
		{
			key: "max_completed",
			type: "number",
			label: "Max Completed (items)",
			default: 5,
			description: "列表中显示的最近已完成任务数量",
		},
	],
	inputSchema: z.object({
		filter: z.enum(["all", "running", "completed"]).optional().describe("Filter by status: all (default), running, or completed"),
	}),
	execute: async (input, ctx) => {
		if (!ctx.listTasks) {
			return "Error: Task listing is not available in this context.";
		}

		const config = ctx.toolConfig?.TaskList ?? {};
		const maxCompleted = config.max_completed ?? 5;
		const filter = input.filter ?? "all";
		const tasks = ctx.listTasks(filter === "all" ? undefined : filter);

		if (!tasks.length) {
			return filter === "running"
				? "No running tasks."
				: "No tasks.";
		}

		const running = tasks.filter((t) => t.status === "running");
		const completed = tasks.filter((t) => t.status !== "running");

		const lines: string[] = [];

		if (running.length) {
			lines.push(`Running (${running.length}):`);
			lines.push(...running.map(formatTask));
		}

		if (completed.length) {
			if (lines.length) lines.push("");
			const recent = completed.reverse().slice(0, maxCompleted);
			const remaining = completed.length - recent.length;
			lines.push(`Completed (showing ${recent.length}${remaining ? ` of ${completed.length}` : ""}):`);
			lines.push(...recent.map(formatTask));
			if (remaining) lines.push(`  ... and ${remaining} older tasks`);
		}

		lines.push("");
		lines.push(`Total: ${tasks.length} tasks, ${running.length} running`);

		return lines.join("\n");
	},
});
