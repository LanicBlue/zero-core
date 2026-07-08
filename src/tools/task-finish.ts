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
// - ToolResult{data:{text}};format(r) = r.data.text
//
// ## 定位
// 中立工具层(src/tools/),被 agent loop / UI dispatcher 调。
//
// ## 维护规则
// - bash task 必须拒绝(acceptance 用例 8 强测)。
// - tool-decoupling sub-4(G1 + 决策 2/3):委派函数经 callerCtx.delegateFns;
//   UI 无 loop 状态 → 返默认/示例;execute 返 ToolResult JSON;format 文本与
//   sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";

interface TaskFinishData {
	text: string;
}

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
	meta: { category: "task", isReadOnly: false, isConcurrencySafe: false, isDestructive: false, exposable: false },
	inputSchema: z.object({
		task_id: z.string().describe("The running agent task to ask to finish"),
		message: z.string().optional().describe("Optional custom control message asking the sub-agent to wrap up"),
		maxTurns: z.number().optional().describe("Force-stop after this many additional agent-loop turns (omit for purely advisory)"),
	}),
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<TaskFinishData>> => {
		const fns = callerCtx.delegateFns;
		// G1:UI/external host without a loop → benign preview.
		if (!fns?.getTaskResult) {
			return { ok: true, data: { text: `(preview) Task ${input.task_id} not found (no delegateFns / not in an agent loop).` } };
		}
		const info = fns.getTaskResult(input.task_id);
		if (!info) {
			return { ok: true, data: { text: `Task ${input.task_id} not found.` } };
		}
		// AGENT ONLY — bash tasks have no finish semantics.
		if (info.type === "bash") {
			return {
				ok: true,
				data: {
					text: `Error: TaskFinish is for sub-agent tasks only. Task ${input.task_id} is a bash task — use TaskKill to stop it.`,
				},
			};
		}
		if (!fns.requestTaskFinish) {
			return { ok: false, error: "request_finish is not available in this context." };
		}
		const ok = fns.requestTaskFinish(input.task_id, { message: input.message, maxTurns: input.maxTurns });
		if (!ok) {
			return {
				ok: true,
				data: { text: `Task ${input.task_id} not found or not running (status: ${info.status}).` },
			};
		}
		return {
			ok: true,
			data: {
				text: input.maxTurns
					? `Finish requested for ${input.task_id}: advisory message sent, will force-stop after ${input.maxTurns} more turn(s).`
					: `Finish requested for ${input.task_id}: advisory message sent (no hard turn budget — use TaskKill to force-stop).`,
			},
		};
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "TaskFinish failed.";
		}
		return (result.data as TaskFinishData)?.text ?? "";
	},
});
