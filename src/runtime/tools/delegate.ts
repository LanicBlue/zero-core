import { tool } from "ai";
import { z } from "zod";

export const delegateTool = tool({
	description:
		"Delegate a task to a sub-agent. The sub-agent runs independently with its own context and returns the result. Use for breaking complex tasks into smaller parallel steps.",
	inputSchema: z.object({
		task: z.string().describe("The task description for the sub-agent"),
		model: z.string().optional().describe("Model ID override for the sub-agent"),
		systemPrompt: z.string().optional().describe("Custom system prompt for the sub-agent"),
	}),
	execute: async (input, options) => {
		const { task, model, systemPrompt } = input;
		const ctx = options.experimental_context as {
			delegateTask?: (task: string, options?: { model?: string; systemPrompt?: string }) => Promise<string>;
		} | undefined;

		if (!ctx?.delegateTask) {
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
