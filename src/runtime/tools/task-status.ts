// 任务状态查询工具
//
// # 文件说明书
//
// ## 核心功能
// 提供任务状态查询能力，显示特定任务的详细状态。
//
// ## 输入
// - 任务 ID
//
// ## 输出
// - 任务详细状态
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
//
// ## 维护规则
// - 保持状态信息准确
// - 处理无效任务引用
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";


function formatTurn(turn: { role: string; content: string | null }, limit: number): string {
	const clip = (s: string) => s.length > limit ? s.slice(0, limit - 3) + "..." : s;

	if (turn.role === "user") return "[user] " + clip(turn.content ?? "");

	try {
		const blocks = JSON.parse(turn.content ?? "[]");
		return blocks.map((b: any) => {
			if (b.type === "text") return clip(b.text);
			if (b.type === "tool_use") return "[tool] " + b.name;
			if (b.type === "tool_result") return "[result] " + clip(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
			if (b.type === "tool") return "[tool] " + b.name + (b.status === "error" ? " (error)" : "");
			return "";
		}).filter(Boolean).join("\n");
	} catch {
		return clip(turn.content ?? "");
	}
}

/** Format a group of steps as a single turn for display. */
function formatStepGroup(steps: Array<{ role: string; content: string | null }>, limit: number): string {
	const userStep = steps.find(s => s.role === "user");
	if (userStep) return formatTurn(userStep, limit);

	// Merge all assistant steps
	const allText: string[] = [];
	for (const step of steps) {
		if (step.role !== "assistant") continue;
		try {
			const blocks = JSON.parse(step.content ?? "[]");
			for (const b of blocks) {
				if (b.type === "text") allText.push(b.text);
				if (b.type === "tool") allText.push("[tool] " + b.name + (b.status === "error" ? " (error)" : ""));
			}
		} catch {
			if (step.content) allText.push(step.content);
		}
	}
	const clip = (s: string) => s.length > limit ? s.slice(0, limit - 3) + "..." : s;
	return allText.map(clip).join("\n");
}

export const taskStatusTool = buildTool({
	name: "TaskStatus",
	description: "Check the status and recent activity of a background task.",
	prompt: "Check the status and output of a background task (Agent non-blocking or Bash background).\n\n" +
		"Returns: task status (running/completed/killed), elapsed time, and recent conversation turns.\n\n" +
		"When to use:\n" +
		"- After Wait wakes you up, check the specific task result\n" +
		"- To monitor progress of a long-running background task\n" +
		"- To retrieve the output of a completed task\n\n" +
		"Prefer Wait over polling TaskStatus in a loop — Wait is event-driven.",
	meta: { category: "task", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	configSchema: [
		{
			key: "recent_turns",
			type: "number",
			label: "Recent Turns (items)",
			default: 6,
			description: "显示的最近 turn 条数",
		},
		{
			key: "turn_length",
			type: "number",
			label: "Turn Length (chars)",
			default: 500,
			description: "每条 turn 的最大字符数",
		},
	],
	inputSchema: z.object({
		task_id: z.string().describe("The task ID to check"),
	}),
	execute: async (input, ctx) => {
		if (!ctx.getTaskResult) {
			return "Error: Task status is not available in this context.";
		}

		const info = ctx.getTaskResult(input.task_id);
		if (!info) return `Task ${input.task_id} not found.`;

		const elapsed = info.completedAt
			? Math.round((info.completedAt - info.startedAt) / 1000) + "s"
			: Math.round((Date.now() - info.startedAt) / 1000) + "s";
		const header = [
			`task_id: ${info.id}`,
			`Status: ${info.status}`,
			`Elapsed: ${elapsed}`,
			`Steps: ${info.step}`,
		];
		if (info.currentTool) header.push(`Current tool: ${info.currentTool}`);

		const db = ctx.db;
		if (!db) return header.join("\n");

		const subAgentId = `${ctx.agentId}:${input.task_id}`;
		const session = db.getMainSession(subAgentId);
		if (!session) return header.join("\n");

		const config = ctx.toolConfig?.TaskStatus ?? {};
		const n = config.recent_turns ?? 6;
		const turnLimit = config.turn_length ?? 500;

		// Use step-level data if available, group by turnGroup
		if (db.hasStepSchema()) {
			const steps = db.getSteps(session.id);
			// Group by turnGroup
			const groups = new Map<number, Array<{ role: string; content: string | null }>>();
			for (const s of steps) {
				let group = groups.get(s.turnGroup);
				if (!group) {
					group = [];
					groups.set(s.turnGroup, group);
				}
				group.push({ role: s.role, content: s.content });
			}
			const groupEntries = [...groups.entries()].slice(-n);
			if (!groupEntries.length) return header.join("\n");
			const activity = groupEntries.map(([, g]) => formatStepGroup(g, turnLimit)).join("\n---\n");
			return header.join("\n") + "\n\n" + activity;
		}

		// Legacy fallback
		const turns = db.getTurns(session.id).slice(-n);
		if (!turns.length) return header.join("\n");
		const activity = turns.map((t: any) => formatTurn({ role: t.role, content: t.content }, turnLimit)).join("\n---\n");
		return header.join("\n") + "\n\n" + activity;
	},
});
