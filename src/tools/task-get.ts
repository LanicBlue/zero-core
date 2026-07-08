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
// - ToolResult{data:{text}} —— text 形态按状态分支(running/interrupted=JSON 文本,
//   completed=JSON 文本含 acknowledge 结果)。format(r) = r.data.text(逐字相同)。
//
// ## 定位
// 中立工具层(src/tools/),被 agent loop / UI dispatcher 调。
//
// ## 维护规则
// - 三状态分支的字段增减须同步 design §4.2 + acceptance-4 用例 4/5/6。
// - getTaskRecentCalls 的 N 默认 3,与 delegateFns 实现一致。
// - tool-decoupling sub-4(G1 per-session 访问器 + 决策 2/3):
//   · 委派/查询函数经 `callerCtx.delegateFns.*`(访问器形态,G1)。
//   · UI/外部 host 无 loop 状态时 → 返默认/示例值(不崩)。
//   · execute 返 ToolResult JSON;format 文本与 sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";

/** Default number of recent tool calls shown for a running task (design §4.2). */
const RECENT_CALLS_N = 3;

interface TaskGetData {
	/** LLM-facing text: per-status branch output (JSON for running/interrupted, plain for completed). */
	text: string;
}

export const taskGetTool = buildTool({
	name: "TaskGet",
	description: "Drill into a single background task by task_id. Returns recent calls (running), status+waited (interrupted), or full result+acknowledge (completed).",
	prompt:
		"Drill into ONE background task by task_id. The view branches by status (the workbench only shows id+status — this is the detail view):\n\n" +
		"- **running**: the last N=3 tool-call records (name + args summary, NO output). Tells you what the sub-agent is doing right now without leaking tool output.\n" +
		"- **interrupted**: registry info + waited time (wall-clock, includes downtime) + the marker \"[interrupted by restart]\". Recent calls are empty (the child is frozen until TaskResume re-attaches its loop).\n" +
		"- **completed/failed/killed**: the FULL result + an `acknowledge` step — consuming the result DROPS the task from the live registry / workbench (the \"Get = take the data\" semantics). One-shot: call TaskGet again after acknowledging returns not-found.\n\n" +
		"Use TaskList for an overview (with optional tree); TaskGet for one task's detail. Prefer Wait over polling TaskGet in a loop — Wait is event-driven.",
	meta: { category: "task", isReadOnly: true, isConcurrencySafe: true, isDestructive: false, exposable: false },
	inputSchema: z.object({
		task_id: z.string().describe("The task ID to drill into"),
	}),
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<TaskGetData>> => {
		const fns = callerCtx.delegateFns;
		// G1:UI/external host without a loop → benign preview (no tasks visible).
		if (!fns?.getTaskResult) {
			return { ok: true, data: { text: "(preview) No tasks — callerCtx has no delegateFns (not running inside an agent loop)." } };
		}
		const info = fns.getTaskResult(input.task_id);
		if (!info) {
			return { ok: true, data: { text: `Task ${input.task_id} not found (it may have been acknowledged and consumed, or never existed).` } };
		}

		const elapsed = info.completedAt
			? Math.round((info.completedAt - info.startedAt) / 1000)
			: Math.round((Date.now() - info.startedAt) / 1000);

		// ── running / finishing: recent tool calls, no output ──────────────
		if (info.status === "running" || info.status === "finishing") {
			const calls = fns.getTaskRecentCalls?.(input.task_id, RECENT_CALLS_N) ?? [];
			const callsBlock = calls.length
				? calls.map((c, i) => `  ${i + 1}. ${c.name}${c.args ? `(${c.args})` : ""}`).join("\n")
				: "  (no tool calls yet)";
			return {
				ok: true,
				data: {
					text: JSON.stringify({
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
					}, null, 2),
				},
			};
		}

		// ── interrupted: registry info + waited + marker ───────────────────
		if (info.status === "interrupted") {
			return {
				ok: true,
				data: {
					text: JSON.stringify({
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
					}, null, 2),
				},
			};
		}

		// ── completed / failed / killed: full result + acknowledge ─────────
		const acknowledged = fns.acknowledgeTask?.(input.task_id) ?? false;
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
		return { ok: true, data: { text: JSON.stringify(out, null, 2) } };
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "TaskGet failed.";
		}
		return (result.data as TaskGetData)?.text ?? "";
	},
});
