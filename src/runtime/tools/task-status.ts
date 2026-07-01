// 任务状态查询工具
//
// # 文件说明书
//
// ## 核心功能
// 提供任务状态查询能力，返回**结构化 JSON**(便于模型可靠解析)。
//
// ## 输出形态
// { task_id, status, elapsed_s, steps, current_tool?, result? }
//   - status ∈ running|completed|failed|killed
//   - current_tool 仅 running 时出现
//   - result 仅 completed/failed 时出现(子代理输出 / 错误信息)
//
// ## 设计说明
// 结果来自 TaskRegistry(info.result / info.turns / info.tokens),不再查 messages DB。
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
//
// ## 维护规则
// - TaskInfo 字段变更需同步本输出
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const taskStatusTool = buildTool({
	name: "TaskStatus",
	description: "Check the status and result of a background task. Returns structured JSON.",
	prompt: "Check the status and output of a background task (Agent non-blocking or Bash background).\n\n" +
		"Returns JSON: { task_id, status (running|finishing|completed|failed|killed|interrupted), elapsed_s, steps, turns, tokens, current_tool?, result? }.\n" +
		"- `turns` = agent-loop iterations completed; `tokens` = cumulative input+output tokens. Use both to judge whether a sub-agent has done enough work and should be asked to finish.\n" +
		"- `current_tool` appears only while running/finishing.\n" +
		"- `result` appears on completed/failed (the sub-agent's output or the error text).\n\n" +
		"When to use:\n" +
		"- After Wait wakes you up, check the specific task result\n" +
		"- To monitor progress of a long-running background task\n" +
		"- To retrieve the output of a completed task\n\n" +
		"Prefer Wait over polling TaskStatus in a loop — Wait is event-driven.",
	meta: { category: "task", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	inputSchema: z.object({
		task_id: z.string().describe("The task ID to check"),
	}),
	execute: async (input, ctx) => {
		if (!ctx.getTaskResult) {
			return "Error: Task status is not available in this context.";
		}

		const info = ctx.getTaskResult(input.task_id);
		if (!info) return JSON.stringify({ task_id: input.task_id, status: "not_found" });

		const elapsed = info.completedAt
			? Math.round((info.completedAt - info.startedAt) / 1000)
			: Math.round((Date.now() - info.startedAt) / 1000);

		const out: Record<string, unknown> = {
			task_id: info.id,
			status: info.status,
			elapsed_s: elapsed,
			steps: info.step,
			turns: info.turns,
			tokens: info.tokens,
		};
		if (info.currentTool) out.current_tool = info.currentTool;
		if (info.status === "completed" || info.status === "failed") {
			out.result = info.result ?? "";
		}
		return JSON.stringify(out, null, 2);
	},
});
