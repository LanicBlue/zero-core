import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const waitTool = buildTool({
	name: "Wait",
	description: "Wait for background tasks to complete or a timeout.",
	prompt:
		"Wait for background tasks to complete, or for a timeout. " +
		"Wakes immediately when a background task (subagent or bash) finishes. " +
		"Returns a status summary of all background tasks.",
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
