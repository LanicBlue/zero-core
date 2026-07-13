// Task action 工具 (execution-entry-redesign sub-4)
//
// # 文件说明书
//
// ## 核心功能
// "Task" 是 execution-entry-redesign 的判别联合 action 工具之一。一个工具 +
// action 字段切换 5 个生命周期操作(get/list/kill/finish/resume),复刻 project-tool
// 结构。原 6 个分散工具(get/list/kill/finish/resume/start 各一)合并到此 ——
// start 的功能被 Subagent delegate(后台 agent)与 Shell background
// (后台 shell)接管,本工具不再保留 start 语义。
//   - get     单 task 钻取,按 running / interrupted / completed 三状态分支
//              (running → 近 N=3 调用记录;interrupted → registry+waited+marker;
//               completed/failed/killed → 完整 result + acknowledge 即出 registry)
//   - list    富列表 + tree,带 max_completed config(中层 zoom)
//   - kill    running/finishing → kill(硬停);interrupted → abandon(关冻结子)
//   - finish  优雅收尾(advisory,可选 maxTurns 强停),仅 agent
//   - resume  解冻冻结子(非阻塞,仅 agent,turn_seq 守卫在 delegator 层)
//
// ## 命名 (design §6)
// 工具按功能命名 → `Task`;6 个旧 PascalCase 名(start/get/list/kill/finish/resume 各一)
// 经 RENAMED_TOOLS(sub-5)映射回 `Task`。本 sub 后旧名暂失效,sub-5 修复。
//
// ## 输入
// - callerCtx.delegateFns.*    (G1 per-session 访问器,loop 注入)
// - callerCtx.toolConfig.Task  (max_completed,从旧 list 工具 key 改名)
//
// ## 输出
// - export const taskTool
// - export const taskActionSchema (sub-5 加进 ACTION_SCHEMAS)
//
// ## 定位
// Runtime 工具,被 agent-loop buildTools 通过 DOMAIN_TOOLS 拉入。
//
// ## 维护规则
// - 三状态分支字段须同步 design + acceptance-4 用例(get/list/kill/finish/resume)。
// - G1 顶部统一 guard:UI/外部 host 无 loop → 返 benign preview;每个 case 仍做
//   per-action delegateFn 方法存在性检查(不同 action 用不同方法)。
// - tool-decoupling(决策 2/3):委派函数经 `callerCtx.delegateFns.*`;
//   execute 返 ToolResult JSON;format 透 data.text 与 sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";
import type { TaskInfo } from "../runtime/types.js";

// ---------------------------------------------------------------------------
// Helpers (从 task-list.ts 内联)
// ---------------------------------------------------------------------------

function formatTask(t: TaskInfo, indent: string = ""): string {
	const elapsed = t.completedAt
		? Math.round((t.completedAt - t.startedAt) / 1000) + "s"
		: Math.round((Date.now() - t.startedAt) / 1000) + "s";
	const statusIcon = { running: "●", finishing: "◐", completed: "✓", failed: "✗", killed: "⊘", interrupted: "⌽" }[t.status as "running" | "finishing" | "completed" | "failed" | "killed" | "interrupted"] ?? "?";
	const typeLabel = t.type === "bash" ? "bash" : "subagent";

	let line = `${indent}${statusIcon} [${t.id}] ${typeLabel}  ${t.status}  step:${t.step}  turns:${t.turns}  tokens:${t.tokens}  ${elapsed}`;
	if (t.currentTool) line += `  tool:${t.currentTool}`;
	line += `\n${indent}    ${t.task}`;
	if (t.error) line += `\n${indent}    error: ${t.error}`;
	return line;
}

/**
 * Build a nested tree view from a flat task list using parentTaskId.
 * Roots = tasks with parentTaskId undefined OR whose parent isn't in the set.
 */
function formatTree(tasks: TaskInfo[]): string {
	const byParent = new Map<string | undefined, TaskInfo[]>();
	for (const t of tasks) {
		const key = t.parentTaskId;
		if (!byParent.has(key)) byParent.set(key, []);
		byParent.get(key)!.push(t);
	}
	const lines: string[] = [];
	const render = (parentId: string | undefined, depth: number): void => {
		const children = byParent.get(parentId) ?? [];
		for (const t of children) {
			lines.push(formatTask(t, "  ".repeat(depth)));
			render(t.id, depth + 1);
		}
	};
	render(undefined, 0);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Flat action schema — one tool, five actions (NO start)
// ---------------------------------------------------------------------------
// NOTE: deliberately a FLAT z.object (not z.discriminatedUnion). LLM tool-calling
// protocols (OpenAI/GLM/Anthropic function-calling) require the top-level
// parameters schema to be `type: object`; a top-level `oneOf`/discriminated
// union is dropped or mis-parsed by most providers, so the model calls the tool
// with `{}` and zod then rejects it ("Invalid discriminator value"). The action
// enum still validates the discriminator; per-action required fields are checked
// at runtime in execute (task_id for get/kill/finish/resume, etc.).

export const taskActionSchema = z.object({
	action: z.enum(["get", "list", "kill", "finish", "resume"]),
	// get / kill / finish / resume
	task_id: z.string().optional(),
	// list
	filter: z.enum(["all", "running", "completed"]).optional(),
	taskIds: z.array(z.string()).optional(),
	// finish
	message: z.string().optional(),
	maxTurns: z.number().optional(),
});

/** Default number of recent tool calls shown for a running task (design §4.2). */
const RECENT_CALLS_N = 3;

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const taskTool = buildTool({
	name: "Task",
	description:
		"Manage background task lifecycle (drill-in / list / discard / wrap-up / resume). Action-switched tool: get/list/kill/finish/resume.",
	prompt:
		"Manage background tasks via a single action-switched tool. Tasks are dispatched by Subagent delegate (background agent) or Shell background (background shell) — Task is the lifecycle manager.\n\n" +
		"Actions:\n" +
		"- { action:'get', task_id } — drill into ONE task. Branches by status: running → last N=3 tool-call records (name + args, NO output); interrupted → status + waited + the marker \"[interrupted by restart]\"; completed/failed/killed → full result + acknowledge (consuming the result DROPS it from the live registry; one-shot — call get again returns not-found).\n" +
		"- { action:'list', filter?, taskIds? } — rich list (the MIDDLE zoom: workbench = id+status极简, list = this rich list, get = single-task drill-in). filter: 'all' (default) | 'running' | 'completed'. taskIds: optional drill-in filter on a few ids. Renders a tree when nested tasks exist.\n" +
		"- { action:'kill', task_id } — discard. running/finishing → hard-stop (CANNOT be resumed after this); interrupted → abandon the frozen child (mark its turn_state terminal + drop from registry). Terminal tasks (completed/failed/killed) are not killable — consume them via action:'get'.\n" +
		"- { action:'finish', task_id, message?, maxTurns? } — graceful wrap-up (AGENT tasks only; bash returns an error since shell commands have no finish semantics). Advisory; maxTurns>0 force-stops after N more agent-loop turns.\n" +
		"- { action:'resume', task_id } — resume a FROZEN interrupted sub-agent (AGENT only; non-blocking; child continues its interrupted turn, turn_seq preserved). Watch progress via action:'get'.\n\n" +
		"Prefer Wait over polling Task action:'get' in a loop — Wait is event-driven.",
	meta: {
		category: "task",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
		exposable: false,
	},
	configSchema: [
		{
			key: "max_completed",
			type: "number",
			label: "Max Completed (items)",
			default: 5,
			description: "列表中显示的最近已完成任务数量",
		},
	],
	inputSchema: taskActionSchema,
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult> => {
		const fns = callerCtx.delegateFns;

		// G1 (consolidated top-level):UI/external host without a loop → benign
		// preview (no tasks visible). Per-action code below still does its own
		// delegateFn-method presence checks since different actions need different
		// methods (get/getTaskResult, list/listTasks, kill/stopTask|abandonTask,
		// finish/requestTaskFinish, resume/resumeTaskBackground).
		if (!fns) {
			return { ok: true, data: { text: "(preview) No tasks — callerCtx has no delegateFns (not running inside an agent loop)." } };
		}

		switch (input.action) {
			// ── get:单 task 钻取(从 task-get.ts 内联)─────────────────────────
			case "get": {
				if (!fns.getTaskResult) {
					return { ok: true, data: { text: "(preview) No tasks — callerCtx has no delegateFns (not running inside an agent loop)." } };
				}
				if (!input.task_id) {
					return { ok: false, error: "`task_id` required for action:'get'." };
				}
				const info = fns.getTaskResult(input.task_id);
				if (!info) {
					return { ok: true, data: { text: `Task ${input.task_id} not found (it may have been acknowledged and consumed, or never existed).` } };
				}

				const elapsed = info.completedAt
					? Math.round((info.completedAt - info.startedAt) / 1000)
					: Math.round((Date.now() - info.startedAt) / 1000);

				// running / finishing:recent tool calls, no output
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

				// interrupted:registry info + waited + marker
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
								note: "The child is frozen. Call Task action:'resume' (agent only) to continue it, or action:'kill' to abandon.",
								recent_calls: [],
							}, null, 2),
						},
					};
				}

				// completed / failed / killed:full result + acknowledge
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
					out.acknowledge_warning = "Task could not be acknowledged (still running or unknown). Stop it first via action:'kill'.";
				}
				return { ok: true, data: { text: JSON.stringify(out, null, 2) } };
			}

			// ── list:富列表 + tree(从 task-list.ts 内联)──────────────────────
			case "list": {
				if (!fns.listTasks) {
					return { ok: true, data: { text: "(preview) No tasks — callerCtx has no delegateFns (not running inside an agent loop)." } };
				}
				// toolConfig key moved (旧 list 工具)→ Task (sub-4: tool name is `Task`).
				const config = callerCtx.toolConfig?.Task ?? {};
				const maxCompleted = config.max_completed ?? 5;
				const filter = input.filter ?? "all";
				let tasks = fns.listTasks(filter === "all" ? undefined : filter);

				// Optional taskIds drill-in filter.
				if (input.taskIds && input.taskIds.length) {
					const want = new Set(input.taskIds);
					tasks = tasks.filter((t) => want.has(t.id));
				}

				if (!tasks.length) {
					return {
						ok: true,
						data: {
							text: filter === "running" ? "No running tasks." : "No tasks.",
						},
					};
				}

				const running = tasks.filter((t) => t.status === "running" || t.status === "finishing");
				const completed = tasks.filter((t) => t.status !== "running" && t.status !== "finishing");

				const lines: string[] = [];

				if (running.length) {
					lines.push(`Running (${running.length}):`);
					lines.push(...running.map((t) => formatTask(t)));
				}

				if (completed.length) {
					if (lines.length) lines.push("");
					// Most-recently-completed first.
					const sorted = completed.slice().sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt));
					const recent = sorted.slice(0, maxCompleted);
					const remaining = sorted.length - recent.length;
					lines.push(`Completed (showing ${recent.length}${remaining ? ` of ${sorted.length}` : ""}):`);
					lines.push(...recent.map((t) => formatTask(t)));
					if (remaining) lines.push(`  ... and ${remaining} older tasks`);
				}

				lines.push("");
				lines.push(`Total: ${tasks.length} tasks, ${running.length} running`);

				// Tree view (appended when there are nested tasks — parentTaskId present).
				const hasNested = tasks.some((t) => t.parentTaskId);
				if (hasNested) {
					lines.push("");
					lines.push("Tree:");
					lines.push(formatTree(tasks) || "(empty)");
				}

				return { ok: true, data: { text: lines.join("\n") } };
			}

			// ── kill:running→kill / interrupted→abandon(从 task-kill.ts 内联)──
			case "kill": {
				if (!fns.getTaskResult) {
					return { ok: true, data: { text: `(preview) Task ${input.task_id} not found (no delegateFns / not in an agent loop).` } };
				}
				if (!input.task_id) {
					return { ok: false, error: "`task_id` required for action:'kill'." };
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

				// terminal — point at get to consume
				return {
					ok: true,
					data: {
						text: `Task ${input.task_id} is already terminal (status: ${info.status}). Use Task action:'get' to acknowledge and consume its result.`,
					},
				};
			}

			// ── finish:优雅收尾(从 task-finish.ts 内联)────────────────────────
			case "finish": {
				if (!fns.getTaskResult) {
					return { ok: true, data: { text: `(preview) Task ${input.task_id} not found (no delegateFns / not in an agent loop).` } };
				}
				if (!input.task_id) {
					return { ok: false, error: "`task_id` required for action:'finish'." };
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
							text: `Error: Task action:'finish' is for sub-agent tasks only. Task ${input.task_id} is a bash task — use action:'kill' to stop it.`,
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
							: `Finish requested for ${input.task_id}: advisory message sent (no hard turn budget — use action:'kill' to force-stop).`,
					},
				};
			}

			// ── resume:解冻冻结子(从 task-resume.ts 内联)──────────────────────
			case "resume": {
				if (!fns.getTaskResult) {
					return { ok: true, data: { text: `(preview) Task ${input.task_id} not found (no delegateFns / not in an agent loop).` } };
				}
				if (!input.task_id) {
					return { ok: false, error: "`task_id` required for action:'resume'." };
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
							text: `Error: Task action:'resume' is for sub-agent tasks only. Task ${input.task_id} is a bash task (shell commands have no resume semantics).`,
						},
					};
				}
				// Only interrupted tasks are resumable.
				if (info.status !== "interrupted") {
					return {
						ok: true,
						data: {
							text: `Task ${input.task_id} is not interrupted (status: ${info.status}). action:'resume' only applies to frozen interrupted children.`,
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
							text: `Child resumed, task_id: ${input.task_id} (non-blocking). Watch progress via action:'get'; the child continues its interrupted turn (turn_seq preserved).`,
						},
					};
				} catch (err: any) {
					return { ok: false, error: `Failed to resume task ${input.task_id}: ${err.message}` };
				}
			}

			default:
				return { ok: false, error: `Unknown Task action '${input.action}' (expected get/list/kill/finish/resume).` };
		}
	},
	// format(决策 3):透出 data.text(渲染后的 LLM 文本)。
	format: (result: ToolResult): string => {
		return (result.data as any)?.text ?? result.error ?? "Task action failed.";
	},
});
