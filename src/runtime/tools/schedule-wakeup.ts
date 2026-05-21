import { z } from "zod";
import { buildTool } from "./tool-factory.js";

// ---------------------------------------------------------------------------
// ScheduleWakeup — schedule a delayed wake-up to resume work
// ---------------------------------------------------------------------------

export const scheduleWakeupTool = buildTool({
	name: "schedule_wakeup",
	description:
		"Schedule a delayed wake-up to resume work after waiting for external state changes " +
		"(CI runs, deployments, remote builds). The agent will be re-invoked with the given prompt after the delay.",
	meta: { category: "interaction", isReadOnly: true },
	inputSchema: z.object({
		delaySeconds: z.number().min(60).max(3600).describe("Seconds until wake-up (60-3600)"),
		reason: z.string().describe("One sentence explaining why the wait is needed"),
		prompt: z.string().describe("The prompt to resume with when the timer fires"),
	}),
	execute: async ({ delaySeconds, reason, prompt }, ctx) => {
		ctx.emit({
			type: "schedule_wakeup",
			agentId: ctx.agentId,
			delaySeconds,
			reason,
			prompt,
		} as any);

		const minutes = Math.round(delaySeconds / 60 * 10) / 10;
		return `Scheduled wake-up in ${minutes} minutes (${delaySeconds}s). Reason: ${reason}. You will be resumed automatically.`;
	},
});
