import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const delegateTool = buildTool({
	name: "subagent",
	description:
		"Delegate a task to a sub-agent. The sub-agent runs independently with its own context and returns the result. Use for breaking complex tasks into smaller parallel steps.",
	userDescription: "将任务委托给独立运行的子 agent。子 agent 拥有自己的上下文，适合将复杂任务拆分为并行步骤。",
	meta: { category: "runtime", isReadOnly: false, isConcurrencySafe: false },
	configSchema: [
		{ key: "max_steps", type: "number", label: "最大步数", description: "子 agent 最大执行步数（留空则不限制）" },
		{ key: "timeout", type: "number", label: "超时 (s)", description: "子 agent 执行超时时间（秒，留空则不限制）" },
	],
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
