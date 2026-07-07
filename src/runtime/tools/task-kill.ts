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
// 结果字符串
//
// ## 定位
// Runtime 工具(src/runtime/tools/),被 Agent 调用。
//
// ## 维护规则
// - kill / abandon 的状态判定须与 TaskInfo.status 联合类型一致(running|finishing|completed|failed|killed|interrupted)。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";

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
	meta: { category: "task", isReadOnly: false, isConcurrencySafe: false, isDestructive: true },
	inputSchema: z.object({
		task_id: z.string().describe("The task ID to discard"),
	}),
	execute: async (input, ctx) => {
		const info = ctx.getTaskResult?.(input.task_id);
		if (!info) return `Task ${input.task_id} not found.`;

		// interrupted → abandon
		if (info.status === "interrupted") {
			if (!ctx.abandonTask) return "Error: Task abandon is not available in this context.";
			const ok = ctx.abandonTask(input.task_id);
			return ok
				? `Task ${input.task_id} (interrupted) abandoned: child turn closed + task dropped from the live registry.`
				: `Task ${input.task_id} could not be abandoned (state changed?).`;
		}

		// running / finishing → kill
		if (info.status === "running" || info.status === "finishing") {
			if (!ctx.stopTask) return "Error: Task kill is not available in this context.";
			const killed = ctx.stopTask(input.task_id);
			return killed
				? `Task ${input.task_id} has been killed (hard stop; cannot be resumed).`
				: `Failed to kill task ${input.task_id}.`;
		}

		// terminal — point at TaskGet to consume
		return `Task ${input.task_id} is already terminal (status: ${info.status}). Use TaskGet to acknowledge and consume its result.`;
	},
});
