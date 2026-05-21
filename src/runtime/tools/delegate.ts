import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const delegateTool = buildTool({
	name: "delegate",
	description:
		"Delegate a task to a sub-agent. The sub-agent runs independently with its own context and returns the result. Use for breaking complex tasks into smaller parallel steps.",
	meta: { category: "runtime", isReadOnly: false, isConcurrencySafe: false },
	inputSchema: z.object({
		task: z.string().describe("The task description for the sub-agent"),
		model: z.string().optional().describe("Model ID override for the sub-agent"),
		systemPrompt: z.string().optional().describe("Custom system prompt for the sub-agent"),
	}),
	execute: async (input, ctx) => {
		const { task, model, systemPrompt } = input;

		if (!ctx.delegateTask) {
			return "Error: Sub-agent delegation is not available in this context.";
		}

		try {
			const result = await ctx.delegateTask(task, { model, systemPrompt });
			return result || "(sub-agent returned no output)";
		} catch (err: any) {
			return `Sub-agent error: ${err.message}`;
		}
	},
});
