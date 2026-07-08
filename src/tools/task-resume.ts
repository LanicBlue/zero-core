// TaskResume 工具 —— 解冻冻结子 (sub-4 / design §2.3, 仅 agent, 非阻塞)
//
// # 文件说明书
//
// ## 核心功能
// 让父决定续跑一个 interrupted(冻结)的子代理 task。非阻塞:立即建子 loop +
// 预填 turn_seq 守卫 + setImmediate 拉起 resume,父拿回控制权。仅 agent —— bash
// task 没有"冻结/续跑"语义(超时自动后台保留的 bash 命令直接看 TaskGet)。
//
// ⚠️ turn_seq 守卫(acceptance case 9 强测):callerCtx.delegateFns.resumeTaskBackground
// 在 loop.resume() 之前预填 setTurnSeq(childSessionId) + markTurnStatePrecreated
// (复用 doRecoverIncompleteSessions 模式),否则 TurnStart 当新 turn 分配 seq →
// turn+1 bug。守卫在 delegator 层做(本工具只是入口,不重复守卫逻辑)。
//
// 取代了原 Subagent/resume 动作(design §4 删/合并)。
//
// ## 输入
// - task_id(interrupted 的 agent task)
//
// ## 输出
// - ToolResult{data:{text}};format(r) = r.data.text
//
// ## 定位
// 中立工具层(src/tools/),被 agent loop / UI dispatcher 调。
//
// ## 维护规则
// - bash task 必须拒绝(acceptance 用例 8)。
// - 守卫逻辑在 SubagentDelegator.resumeTaskBackground,本工具不重复。
// - tool-decoupling sub-4(G1 + 决策 2/3):委派函数经 callerCtx.delegateFns;
//   UI 无 loop 状态 → 返默认/示例;execute 返 ToolResult JSON;format 文本与
//   sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";

interface TaskResumeData {
	text: string;
}

export const taskResumeTool = buildTool({
	name: "TaskResume",
	description: "Resume a frozen interrupted sub-agent task (non-blocking, agent tasks only).",
	prompt:
		"Resume a FROZEN interrupted sub-agent task — the parent's deliberate decision to continue a child that was interrupted by a restart (design §2.3).\n\n" +
		"NON-BLOCKING: returns immediately with `child resumed, task_id:X`. The sub-loop is rebuilt lazily + resumed in the background; the turn_seq is pre-populated so the child CONTINUES its interrupted turn (no turn+1). Watch progress via workbench / TaskGet(running → recent calls); fetch the result via TaskGet(completed).\n\n" +
		"AGENT TASKS ONLY — calling this on a bash task returns an error (shell commands have no resume semantics).\n\n" +
		"When to use:\n" +
		"- After a restart, TaskList/TaskGet shows an `interrupted` sub-agent task you WANT to continue (vs. TaskKill to abandon it).\n" +
		"- You've inspected the interrupted child's progress and decided it should finish.\n\n" +
		"Force-Wait (sub-6) will keep your turn alive while the resumed child runs, so you can collect its result before your turn ends.",
	meta: { category: "task", isReadOnly: false, isConcurrencySafe: false, isDestructive: false, exposable: false },
	inputSchema: z.object({
		task_id: z.string().describe("The interrupted agent task to resume"),
	}),
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<TaskResumeData>> => {
		const fns = callerCtx.delegateFns;
		// G1:UI/external host without a loop → benign preview.
		if (!fns?.getTaskResult) {
			return { ok: true, data: { text: `(preview) Task ${input.task_id} not found (no delegateFns / not in an agent loop).` } };
		}
		const info = fns.getTaskResult(input.task_id);
		if (!info) {
			return { ok: true, data: { text: `Task ${input.task_id} not found.` } };
		}
		// AGENT ONLY.
		if (info.type === "bash") {
			return {
				ok: true,
				data: {
					text: `Error: TaskResume is for sub-agent tasks only. Task ${input.task_id} is a bash task (shell commands have no resume semantics).`,
				},
			};
		}
		// Only interrupted tasks are resumable.
		if (info.status !== "interrupted") {
			return {
				ok: true,
				data: {
					text: `Task ${input.task_id} is not interrupted (status: ${info.status}). TaskResume only applies to frozen interrupted children.`,
				},
			};
		}
		if (!fns.resumeTaskBackground) {
			return { ok: false, error: "Task resume is not available in this context." };
		}
		try {
			fns.resumeTaskBackground(input.task_id);
			return {
				ok: true,
				data: {
					text: `Child resumed, task_id: ${input.task_id} (non-blocking). Watch progress via TaskGet; the child continues its interrupted turn (turn_seq preserved).`,
				},
			};
		} catch (err: any) {
			return { ok: false, error: `Failed to resume task ${input.task_id}: ${err.message}` };
		}
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "TaskResume failed.";
		}
		return (result.data as TaskResumeData)?.text ?? "";
	},
});
