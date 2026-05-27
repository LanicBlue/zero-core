import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const delegateTool = buildTool({
	name: "agent",
	description:
		"Delegate a task to a sub-agent. Blocking mode waits for the result; non-blocking mode returns a task_id immediately for later polling via task_status or wait.",
	userDescription: "将任务委托给子 agent。支持阻塞（等待结果）和非阻塞（后台执行）两种模式。非阻塞模式下会立即返回 task_id，可通过 task_status 查询进度，或用 wait 等待完成。",
	meta: { category: "runtime", isReadOnly: false, isConcurrencySafe: false },
	configSchema: [
		{ key: "auto_background", type: "boolean", label: "自动转后台", description: "阻塞超时后自动转为非阻塞后台执行" },
		{ key: "auto_background_timeout", type: "number", label: "超时 (s)", description: "阻塞等待秒数，超时后转后台；设为 0 则立即非阻塞", default: 0 },
	],
	inputSchema: z.object({
		task: z.string().describe("The task description for the sub-agent"),
		model: z.string().optional().describe("Model ID override for the sub-agent"),
		systemPrompt: z.string().optional().describe("Custom system prompt for the sub-agent"),
		mode: z.enum(["blocking", "non_blocking"]).optional().describe("Execution mode: blocking (wait for result) or non_blocking (return task_id immediately)"),
	}),
	execute: async (input, ctx) => {
		const { task, model, systemPrompt, mode: inputMode } = input;
		const config = ctx.toolConfig?.subagent ?? {};
		const autoBg = config.auto_background === true;
		const bgTimeout = Number(config.auto_background_timeout) || 0;

		// Determine effective mode
		let effectiveMode: "blocking" | "non_blocking";
		if (inputMode) {
			effectiveMode = inputMode;
		} else if (!autoBg) {
			effectiveMode = "blocking";
		} else if (bgTimeout === 0) {
			effectiveMode = "non_blocking";
		} else {
			effectiveMode = "blocking"; // will auto-background after timeout
		}

		if (effectiveMode === "non_blocking") {
			if (!ctx.delegateTaskBackground) {
				return "Error: Non-blocking sub-agent is not available in this context.";
			}
			const taskId = ctx.delegateTaskBackground(task, { model, systemPrompt });
			return `Agent dispatched in non-blocking mode.\ntask_id: ${taskId}\nUse task_status to check progress and retrieve the result.`;
		}

		// Blocking mode
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
