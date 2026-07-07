// TaskFinish 工具 —— 优雅收尾 (sub-4 / design §4.1,仅 agent)
//
// # 文件说明书
//
// ## 核心功能
// 让一个 running 的后台 sub-agent task 优雅收尾(advisory):注入控制消息要它
// wrap up,可选 maxTurns 强制在 N 个 agent-loop turn 后停。仅 agent —— 对 bash
// task 报错(命令没有"收尾"语义)。
//
// 取代了原 Subagent/request_finish 动作(design §4 删/合并)。
//
// ## 输入
// - task_id
// - message?(可选自定义控制消息)
// - maxTurns?(可选,>0 时 force-stop after N additional agent-loop turns;省略则纯 advisory)
//
// ## 输出
// 结果字符串
//
// ## 定位
// Runtime 工具(src/runtime/tools/),被 Agent 调用。
//
// ## 维护规则
// - bash task 必须拒绝(acceptance 用例 8 强测)。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";

export const taskFinishTool = buildTool({
	name: "TaskFinish",
	description: "Ask a running sub-agent task to wrap up gracefully (agent tasks only).",
	prompt:
		"Ask a running background SUB-AGENT task to wrap up — gentle, advisory finish.\n\n" +
		"Inputs:\n" +
		"- `task_id`: the running agent task to wrap up.\n" +
		"- `message?`: optional custom control message (default asks for the best summary of completed work + gaps).\n" +
		"- `maxTurns?`: if > 0, FORCE-STOP after that many additional agent-loop turns. Omit for a purely advisory request that never force-stops.\n\n" +
		"AGENT TASKS ONLY — calling this on a bash task returns an error (a shell command has no \"finish\" semantics; use TaskKill to stop it).\n\n" +
		"When to use:\n" +
		"- A background sub-agent has done enough work and should return its result.\n" +
		"- You want a soft landing instead of a hard TaskKill.\n\n" +
		"For a hard immediate stop use TaskKill; for a frozen interrupted child use TaskResume (continue) or TaskKill (abandon).",
	meta: { category: "task", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		task_id: z.string().describe("The running agent task to ask to finish"),
		message: z.string().optional().describe("Optional custom control message asking the sub-agent to wrap up"),
		maxTurns: z.number().optional().describe("Force-stop after this many additional agent-loop turns (omit for purely advisory)"),
	}),
	execute: async (input, ctx) => {
		const info = ctx.getTaskResult?.(input.task_id);
		if (!info) return `Task ${input.task_id} not found.`;
		// AGENT ONLY — bash tasks have no finish semantics.
		if (info.type === "bash") {
			return `Error: TaskFinish is for sub-agent tasks only. Task ${input.task_id} is a bash task — use TaskKill to stop it.`;
		}
		if (!ctx.requestTaskFinish) return "Error: request_finish is not available in this context.";
		const ok = ctx.requestTaskFinish(input.task_id, { message: input.message, maxTurns: input.maxTurns });
		if (!ok) return `Task ${input.task_id} not found or not running (status: ${info.status}).`;
		return input.maxTurns
			? `Finish requested for ${input.task_id}: advisory message sent, will force-stop after ${input.maxTurns} more turn(s).`
			: `Finish requested for ${input.task_id}: advisory message sent (no hard turn budget — use TaskKill to force-stop).`;
	},
});
