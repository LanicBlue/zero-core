// TaskGet 工具 —— 单 task 钻取 (sub-4 / design §4.2)
//
// # 文件说明书
//
// ## 核心功能
// 单个后台 task 的钻取视图,按状态分返(design §4.2 三状态分支):
//   - running    → 近 N=3 条工具调用记录(name + args 摘要,不返输出)
//   - interrupted → registry 信息 + waited(now − startedAt,含停机 wall-clock)
//                   + "[interrupted by restart]";近期调用记录为空(子冻结)
//   - completed/failed/killed → 完整 result + acknowledge(消费即从 registry 删)
//
// 这是"单 task 钻取"层;workbench 是"id+status 极简"层,TaskList 是"富列表+tree"层。
// completed 分支的 acknowledge 体现"Get = 取走数据"语义(原 TaskStatus 改名 TaskGet
// 的理由)。
//
// ## 输入
// - task_id
//
// ## 输出
// 按状态的结构化字符串(JSON for running/interrupted,plain text for completed)
//
// ## 定位
// Runtime 工具(src/runtime/tools/),被 Agent 调用。
//
// ## 维护规则
// - 三状态分支的字段增减须同步 design §4.2 + acceptance-4 用例 4/5/6。
// - getTaskRecentCalls 的 N 默认 3,与 ctx 实现一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";

/** Default number of recent tool calls shown for a running task (design §4.2). */
const RECENT_CALLS_N = 3;

export const taskGetTool = buildTool({
	name: "TaskGet",
	description: "Drill into a single background task by task_id. Returns recent calls (running), status+waited (interrupted), or full result+acknowledge (completed).",
	prompt:
		"Drill into ONE background task by task_id. The view branches by status (the workbench only shows id+status — this is the detail view):\n\n" +
		"- **running**: the last N=3 tool-call records (name + args summary, NO output). Tells you what the sub-agent is doing right now without leaking tool output.\n" +
		"- **interrupted**: registry info + waited time (wall-clock, includes downtime) + the marker \"[interrupted by restart]\". Recent calls are empty (the child is frozen until TaskResume re-attaches its loop).\n" +
		"- **completed/failed/killed**: the FULL result + an `acknowledge` step — consuming the result DROPS the task from the live registry / workbench (the \"Get = take the data\" semantics). One-shot: call TaskGet again after acknowledging returns not-found.\n\n" +
		"Use TaskList for an overview (with optional tree); TaskGet for one task's detail. Prefer Wait over polling TaskGet in a loop — Wait is event-driven.",
	meta: { category: "task", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	inputSchema: z.object({
		task_id: z.string().describe("The task ID to drill into"),
	}),
	execute: async (input, ctx) => {
		if (!ctx.getTaskResult) return "Error: Task query is not available in this context.";
		const info = ctx.getTaskResult(input.task_id);
		if (!info) return `Task ${input.task_id} not found (it may have been acknowledged and consumed, or never existed).`;

		const elapsed = info.completedAt
			? Math.round((info.completedAt - info.startedAt) / 1000)
			: Math.round((Date.now() - info.startedAt) / 1000);

		// ── running / finishing: recent tool calls, no output ──────────────
		if (info.status === "running" || info.status === "finishing") {
			const calls = ctx.getTaskRecentCalls?.(input.task_id, RECENT_CALLS_N) ?? [];
			const callsBlock = calls.length
				? calls.map((c, i) => `  ${i + 1}. ${c.name}${c.args ? `(${c.args})` : ""}`).join("\n")
				: "  (no tool calls yet)";
			return JSON.stringify({
				task_id: info.id,
				type: info.type,
				status: info.status,
				elapsed_s: elapsed,
				step: info.step,
				turns: info.turns,
				tokens: info.tokens,
				current_tool: info.currentTool ?? null,
				recent_calls: calls.map((c) => ({ name: c.name, args: c.args })),
				_recent_calls_readable: callsBlock,
			}, null, 2);
		}

		// ── interrupted: registry info + waited + marker ───────────────────
		if (info.status === "interrupted") {
			return JSON.stringify({
				task_id: info.id,
				type: info.type,
				status: "interrupted",
				waited_s: elapsed,
				step: info.step,
				turns: info.turns,
				tokens: info.tokens,
				last_tool: info.currentTool ?? null,
				task: info.task,
				marker: "[interrupted by restart]",
				note: "The child is frozen. Call TaskResume (agent only) to continue it, or TaskKill to abandon.",
				recent_calls: [],
			}, null, 2);
		}

		// ── completed / failed / killed: full result + acknowledge ─────────
		const acknowledged = ctx.acknowledgeTask?.(input.task_id) ?? false;
		const out: Record<string, unknown> = {
			task_id: info.id,
			type: info.type,
			status: info.status,
			elapsed_s: elapsed,
			result: info.result ?? info.error ?? "",
			acknowledged,
		};
		if (!acknowledged) {
			out.acknowledge_warning = "Task could not be acknowledged (still running or unknown). Stop it first via TaskKill.";
		}
		return JSON.stringify(out, null, 2);
	},
});
