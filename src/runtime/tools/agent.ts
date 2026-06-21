// Agent 子任务委派工具
//
// # 文件说明书
//
// ## 核心功能
// 定义 Agent 工具，支持阻塞/非阻塞两种模式的子任务委派
//
// ## 输入
// 子任务描述、委派模式（blocking/non_blocking）
//
// ## 输出
// 阻塞模式返回子 Agent 输出，非阻塞模式返回 task_id
//
// ## 定位
// src/runtime/tools/ — 工具层，供 agent-loop 调用
//
// ## 依赖
// zod、tool-factory.ts
//
// ## 维护规则
// 新增委派参数需同步更新 zod schema
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const delegateTool = buildTool({
	name: "Agent",
	description: "Delegate a task to a sub-agent. Supports blocking and non-blocking modes.",
	prompt: "Delegate a task to a sub-agent that runs in an isolated context with its own conversation history.\n\n" +
		"Modes:\n" +
		"- blocking (default): waits for the sub-agent to finish and returns its output. Use for quick tasks.\n" +
		"- non_blocking: returns a task_id immediately. Use Wait or TaskStatus to check progress later.\n\n" +
		"When to delegate:\n" +
		"- Parallel work: dispatch multiple sub-agents for independent tasks\n" +
		"- Complex multi-step searches requiring multiple rounds of grep/glob\n" +
		"- Isolated exploration that should not pollute the main conversation\n\n" +
		"Use model parameter to override the model for the sub-agent.\n" +
		"Use systemPrompt to give the sub-agent specialized instructions.\n\n" +
		"For non-blocking tasks, use Wait to be notified when done, or TaskStatus to poll progress.",
	meta: { category: "agent", isReadOnly: false, isConcurrencySafe: false },
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
		const config = ctx.toolConfig?.Agent ?? {};
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
