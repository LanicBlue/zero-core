// TaskList 工具 —— 富列表 + tree (sub-4 / design §4.3)
//
// # 文件说明书
//
// ## 核心功能
// 后台任务的富列表视图(design §4.3 三级 zoom 的中层)。支持:
//   - `taskIds?` 过滤:只看指定 id(钻取某几个)
//   - `tree` 渲染:按 parentTaskId 建嵌套树文本(sub-agent of sub-agent 链)
// 比工作台的"id+status 极简"富;比 TaskGet 的"单 task 钻取"粗。
//
// 数据源 ctx.listTasks(TaskInfo[],含 parentTaskId)+ 不递归(本层只看自己直接
// task;tree 靠 parentTaskId 字段就地重建)。
//
// ## 输入
// - filter?(all | running | completed)
// - taskIds?(string[],按 id 过滤)
//
// ## 输出
// 富列表文本(可选 tree 缩进)
//
// ## 定位
// Runtime 工具(src/runtime/tools/),被 Agent 调用。
//
// ## 维护规则
// - formatTask 字段须与 TaskInfo 一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { TaskInfo } from "../types.js";

function formatTask(t: TaskInfo, indent: string = ""): string {
	const elapsed = t.completedAt
		? Math.round((t.completedAt - t.startedAt) / 1000) + "s"
		: Math.round((Date.now() - t.startedAt) / 1000) + "s";
	const statusIcon = { running: "●", finishing: "◐", completed: "✓", failed: "✗", killed: "⊘", interrupted: "⌽" }[t.status as "running" | "finishing" | "completed" | "failed" | "killed" | "interrupted"] ?? "?";
	const typeLabel = t.type === "bash" ? "bash" : "subagent";

	let line = `${indent}${statusIcon} [${t.id}] ${typeLabel}  ${t.status}  step:${t.step}  turns:${t.turns}  tokens:${t.tokens}  ${elapsed}`;
	if (t.currentTool) line += `  tool:${t.currentTool}`;
	line += `\n${indent}    ${t.task}`;
	if (t.error) line += `\n${indent}    error: ${t.error}`;
	return line;
}

/** Build a nested tree view from a flat task list using parentTaskId. */
function formatTree(tasks: TaskInfo[]): string {
	// Group children by parent. Roots = tasks with no parentTaskId (or parent not in set).
	const byParent = new Map<string | undefined, TaskInfo[]>();
	for (const t of tasks) {
		const key = t.parentTaskId;
		if (!byParent.has(key)) byParent.set(key, []);
		byParent.get(key)!.push(t);
	}
	const inSet = new Set(tasks.map((t) => t.id));
	const lines: string[] = [];
	const render = (parentId: string | undefined, depth: number): void => {
		const children = byParent.get(parentId) ?? [];
		// Roots = parentTaskId undefined OR parent not in our filtered set.
		if (parentId === undefined) {
			for (const t of children) {
				lines.push(formatTask(t, "  ".repeat(depth)));
				render(t.id, depth + 1);
			}
		} else {
			for (const t of children) {
				lines.push(formatTask(t, "  ".repeat(depth)));
				render(t.id, depth + 1);
			}
		}
	};
	render(undefined, 0);
	// Orphans (parent in set missing) attached under their nearest visible ancestor
	// are handled by the recursion; tasks whose parent is NOT in the set render as
	// roots. (inSet is used implicitly: parents not in set → treated as undefined.)
	void inSet;
	return lines.join("\n");
}

export const taskListTool = buildTool({
	name: "TaskList",
	description: "List background tasks (rich view). Optional taskIds filter + nested tree.",
	prompt: "List background tasks dispatched by this agent — the MIDDLE zoom level (workbench = id+status极简, TaskList = this rich list, TaskGet = single-task drill-in).\n\n" +
		"Inputs:\n" +
		"- `filter?`: 'all' (default) | 'running' | 'completed'.\n" +
		"- `taskIds?`: optional array — only show these task IDs (drill into a few).\n\n" +
		"Returns: task IDs, status (running/finishing/completed/failed/killed/interrupted), type (subagent/bash), step, turns, tokens, elapsed, current tool, and the task summary.\n\n" +
		"When to use:\n" +
		"- After dispatching multiple parallel tasks to check overall progress.\n" +
		"- To find a task_id for use with TaskGet / TaskKill / TaskFinish / TaskResume.\n" +
		"- To review completed task results before acknowledging them via TaskGet.",
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
		taskIds: z.array(z.string()).optional().describe("Only show these task IDs (optional drill-in filter)"),
	}),
	execute: async (input, ctx) => {
		if (!ctx.listTasks) return "Error: Task listing is not available in this context.";

		const config = ctx.toolConfig?.TaskList ?? {};
		const maxCompleted = config.max_completed ?? 5;
		const filter = input.filter ?? "all";
		let tasks = ctx.listTasks(filter === "all" ? undefined : filter);

		// Optional taskIds drill-in filter.
		if (input.taskIds && input.taskIds.length) {
			const want = new Set(input.taskIds);
			tasks = tasks.filter((t) => want.has(t.id));
		}

		if (!tasks.length) {
			return filter === "running"
				? "No running tasks."
				: "No tasks.";
		}

		const running = tasks.filter((t) => t.status === "running" || t.status === "finishing");
		const completed = tasks.filter((t) => t.status !== "running" && t.status !== "finishing");

		const lines: string[] = [];

		if (running.length) {
			lines.push(`Running (${running.length}):`);
			lines.push(...running.map((t) => formatTask(t)));
		}

		if (completed.length) {
			if (lines.length) lines.push("");
			// Most-recently-completed first.
			const sorted = completed.slice().sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt));
			const recent = sorted.slice(0, maxCompleted);
			const remaining = sorted.length - recent.length;
			lines.push(`Completed (showing ${recent.length}${remaining ? ` of ${sorted.length}` : ""}):`);
			lines.push(...recent.map((t) => formatTask(t)));
			if (remaining) lines.push(`  ... and ${remaining} older tasks`);
		}

		lines.push("");
		lines.push(`Total: ${tasks.length} tasks, ${running.length} running`);

		// Tree view (appended when there are nested tasks — parentTaskId present).
		const hasNested = tasks.some((t) => t.parentTaskId);
		if (hasNested) {
			lines.push("");
			lines.push("Tree:");
			lines.push(formatTree(tasks) || "(empty)");
		}

		return lines.join("\n");
	},
});
