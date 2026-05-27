import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import { getSessionDB } from "../db-access.js";

function formatTurn(turn: { role: string; content: string | null }, limit: number): string {
	const clip = (s: string) => s.length > limit ? s.slice(0, limit - 3) + "..." : s;

	if (turn.role === "user") return "[user] " + clip(turn.content ?? "");

	try {
		const blocks = JSON.parse(turn.content ?? "[]");
		return blocks.map((b: any) => {
			if (b.type === "text") return clip(b.text);
			if (b.type === "tool_use") return "[tool] " + b.name;
			if (b.type === "tool_result") return "[result] " + clip(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
			return "";
		}).filter(Boolean).join("\n");
	} catch {
		return clip(turn.content ?? "");
	}
}

export const taskStatusTool = buildTool({
	name: "task_status",
	description:
		"Check the status of a background task. Shows status header and the most recent turns from the session.",
	userDescription: "查询后台任务的状态和最近执行记录。",
	meta: { category: "task", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	configSchema: [
		{
			key: "recent_turns",
			type: "number",
			label: "Recent Turns",
			default: 6,
			description: "显示的最近 turn 条数",
		},
		{
			key: "turn_length",
			type: "number",
			label: "Turn Length",
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

		const db = getSessionDB();
		if (!db) return header.join("\n");

		const subAgentId = `${ctx.agentId}:${input.task_id}`;
		const session = db.getMainSession(subAgentId);
		if (!session) return header.join("\n");

		const config = ctx.toolConfig?.task_status ?? {};
		const n = config.recent_turns ?? 6;
		const turnLimit = config.turn_length ?? 500;
		const turns = db.getTurns(session.id).slice(-n);
		if (!turns.length) return header.join("\n");

		const activity = turns.map((t: any) => formatTurn({ role: t.role, content: t.content }, turnLimit)).join("\n---\n");
		return header.join("\n") + "\n\n" + activity;
	},
});
