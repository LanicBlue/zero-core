// TaskKill 工具 —— 丢弃后台任务 (sub-4 / design §4.1)
//
// # 文件说明书
//
// ## 核心功能
// 丢弃一个后台 task,按状态分动作(design §4.1):
//   - running/finishing → kill(硬停进程/loop;task 不可再 resume)
//   - interrupted       → abandon(标子 turn_state 终态 + 出 registry/workbench)
//
// 这是 TaskStop 的改名 + interrupted 分支扩展。kill 与 abandon 都不可逆。
//
// ## 输入
// - task_id
//
// ## 输出
// - ToolResult{data:{text}};format(r) = r.data.text
//
// ## 定位
// 中立工具层(src/tools/),被 agent loop / UI dispatcher 调。
//
// ## 维护规则
// - kill / abandon 的状态判定须与 TaskInfo.status 联合类型一致
//   (running|finishing|completed|failed|killed|interrupted)。
// - tool-decoupling sub-4(G1 + 决策 2/3):委派函数经 callerCtx.delegateFns;
//   UI 无 loop 状态 → 返默认/示例;execute 返 ToolResult JSON;format 文本与
//   sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";

interface TaskKillData {
	text: string;
}

export const taskKillTool = buildTool({
	name: "TaskKill",
	description: "Discard a background task. running→kill (hard stop), interrupted→abandon (close frozen child + drop).",
	prompt:
		"Discard a background task by task_id. The action branches by status:\n\n" +
		"- **running / finishing**: hard-stop the task immediately (kill the sub-agent loop or shell process). The task CANNOT be resumed after this — use TaskFinish for a graceful wrap instead.\n" +
		"- **interrupted**: ABANDON the frozen child — mark its interrupted turn_state terminal (so it stops resurfacing on restart) and drop it from the live registry / workbench. The child is never run.\n\n" +
		"Terminal tasks (completed/failed/killed) are not killable — consume them via TaskGet (which acknowledges and drops them).\n\n" +
		"When to use:\n" +
		"- A background task is taking too long or producing unwanted results (running).\n" +
		"- The user asks to cancel an ongoing operation (running).\n" +
		"- You've decided NOT to resume a frozen child after a restart (interrupted).",
	meta: { category: "task", isReadOnly: false, isConcurrencySafe: false, isDestructive: true, exposable: false },
	inputSchema: z.object({
		task_id: z.string().describe("The task ID to discard"),
	}),
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<TaskKillData>> => {
		const fns = callerCtx.delegateFns;
		// G1:UI/external host without a loop → benign preview.
		if (!fns?.getTaskResult) {
			return { ok: true, data: { text: `(preview) Task ${input.task_id} not found (no delegateFns / not in an agent loop).` } };
		}
		const info = fns.getTaskResult(input.task_id);
		if (!info) {
			return { ok: true, data: { text: `Task ${input.task_id} not found.` } };
		}

		// interrupted → abandon
		if (info.status === "interrupted") {
			if (!fns.abandonTask) {
				return { ok: false, error: "Task abandon is not available in this context." };
			}
			const ok = fns.abandonTask(input.task_id);
			return {
				ok: true,
				data: {
					text: ok
						? `Task ${input.task_id} (interrupted) abandoned: child turn closed + task dropped from the live registry.`
						: `Task ${input.task_id} could not be abandoned (state changed?).`,
				},
			};
		}

		// running / finishing → kill
		if (info.status === "running" || info.status === "finishing") {
			if (!fns.stopTask) {
				return { ok: false, error: "Task kill is not available in this context." };
			}
			const killed = fns.stopTask(input.task_id);
			return {
				ok: true,
				data: {
					text: killed
						? `Task ${input.task_id} has been killed (hard stop; cannot be resumed).`
						: `Failed to kill task ${input.task_id}.`,
				},
			};
		}

		// terminal — point at TaskGet to consume
		return {
			ok: true,
			data: {
				text: `Task ${input.task_id} is already terminal (status: ${info.status}). Use TaskGet to acknowledge and consume its result.`,
			},
		};
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "TaskKill failed.";
		}
		return (result.data as TaskKillData)?.text ?? "";
	},
});
