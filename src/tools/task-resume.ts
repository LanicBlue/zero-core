// TaskResume 工具 —— 解冻冻结子 (sub-4 / design §2.3, 仅 agent, 非阻塞)
//
// # 文件说明书
//
// ## 核心功能
// 让父决定续跑一个 interrupted(冻结)的子代理 task。非阻塞:立即建子 loop +
// 预填 turn_seq 守卫 + setImmediate 拉起 resume,父拿回控制权。仅 agent —— bash
// task 没有"冻结/续跑"语义(超时自动后台保留的 bash 命令直接看 TaskGet)。
//
// ⚠️ turn_seq 守卫(acceptance case 9 强测):ctx.resumeTaskBackground 在
// loop.resume() 之前预填 setTurnSeq(childSessionId) + markTurnStatePrecreated
// (复用 doRecoverIncompleteSessions 模式),否则 TurnStart 当新 turn 分配 seq →
// turn+1 bug。守卫在 delegator 层做(本工具只是入口,不重复守卫逻辑)。
//
// 取代了原 Subagent/resume 动作(design §4 删/合并)。
//
// ## 输入
// - task_id(interrupted 的 agent task)
//
// ## 输出
// 结果字符串
//
// ## 定位
// Runtime 工具(src/runtime/tools/),被 Agent 调用。
//
// ## 维护规则
// - bash task 必须拒绝(acceptance 用例 8)。
// - 守卫逻辑在 SubagentDelegator.resumeTaskBackground,本工具不重复。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";

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
	meta: { category: "task", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		task_id: z.string().describe("The interrupted agent task to resume"),
	}),
	execute: async (input, ctx) => {
		const info = ctx.getTaskResult?.(input.task_id);
		if (!info) return `Task ${input.task_id} not found.`;
		// AGENT ONLY.
		if (info.type === "bash") {
			return `Error: TaskResume is for sub-agent tasks only. Task ${input.task_id} is a bash task (shell commands have no resume semantics).`;
		}
		// Only interrupted tasks are resumable.
		if (info.status !== "interrupted") {
			return `Task ${input.task_id} is not interrupted (status: ${info.status}). TaskResume only applies to frozen interrupted children.`;
		}
		if (!ctx.resumeTaskBackground) return "Error: Task resume is not available in this context.";
		try {
			ctx.resumeTaskBackground(input.task_id);
			return `Child resumed, task_id: ${input.task_id} (non-blocking). Watch progress via TaskGet; the child continues its interrupted turn (turn_seq preserved).`;
		} catch (err: any) {
			return `Failed to resume task ${input.task_id}: ${err.message}`;
		}
	},
});
