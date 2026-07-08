// TaskStart 工具 —— 显式后台启动入口 (sub-4 / design §4.1)
//
// # 文件说明书
//
// ## 核心功能
// 后台任务统一入口:dispatch 一个 sub-agent 或一条 shell 命令到后台,立即返回
// task_id。这是 design §4.1 里"显式后台唯一入口"的落地 —— Subagent/Shell 本身
// 只 blocking(超时自动后台保留作 safety net),显式后台全走这里。
//
// ## 输入
// - { type:"agent", task, subagent?, model?, systemPrompt? } —— 后台委派子代理
// - { type:"shell", command, timeout? } —— 后台 shell 命令
//
// ## 输出
// - ToolResult{data:{text, taskId?}}(JSON);format(r) = r.data.text
//
// ## 定位
// 中立工具层(src/tools/),被 agent loop / UI dispatcher 调。
//
// ## 依赖
// - zod / buildTool
// - callerCtx.delegateFns(delegateTaskBackground / runBackground / getTaskResult)
// - callerCtx.agentResolvers.resolveAgent(命名 subagent 解析,G4)
//
// ## 维护规则
// - Subagent 白名单语义(agent → delegateTaskBackground 传 targetAgentId/systemPrompt/
//   toolPolicy)须与 Subagent 工具的 delegate 动作保持一致 —— 改一处同步另一处。
// - tool-decoupling sub-4(G1 per-session 访问器 + 决策 2/3):
//   · 身份(agentId)只从 callerCtx 取。
//   · 委派函数经 `callerCtx.delegateFns.*`(访问器形态,G1)。
//   · UI/外部 host 无 loop 状态时 → 返默认/示例值(不崩)。
//   · execute 返 ToolResult JSON;format 文本与 sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";

/** A subagent entry's effective name = entry.name override, else the target agent's name. */
function entryDisplayName(entry: { agentId: string; name?: string }, target?: { name?: string }): string {
	return entry.name?.trim() || target?.name?.trim() || entry.agentId;
}

interface TaskStartData {
	text: string;
	taskId?: string;
}

export const taskStartTool = buildTool({
	name: "TaskStart",
	description: "Start a background task (sub-agent or shell command) and return its task_id immediately.",
	prompt:
		"Start a background task — the single explicit entry point for non-blocking work (sub-agent OR shell).\n\n" +
		"Inputs:\n" +
		"- { type:'agent', task, subagent?, model?, systemPrompt? } — dispatch a sub-agent in the background.\n" +
		"    · Omit `subagent`: an ephemeral sub-agent that inherits YOUR identity (or the inline `model`/`systemPrompt` overrides).\n" +
		"    · `subagent` (a name from the `Subagent list` action): hand off to a registered role agent running with ITS OWN identity.\n" +
		"- { type:'shell', command, timeout? } — run a shell command in the background.\n\n" +
		"Returns `task_id: <id>` immediately. The task runs in the background; use `TaskGet` to drill in (running → recent calls, completed → full result + acknowledge, interrupted → status), `TaskList` for an overview, `TaskKill` to discard, `TaskFinish`/`TaskResume` (agent only) to gracefully wrap / resume a frozen child.\n\n" +
		"When to use:\n" +
		"- Long-running or independent sub-tasks you want running while you keep working (instead of blocking via `Subagent delegate`).\n" +
		"- Long-running shell commands (downloads, installs, watches).\n\n" +
		"Prefer blocking `Subagent delegate` / `Shell` when you need the result inline; reach for TaskStart when parallelism or long runtime justifies background dispatch.",
	meta: { category: "task", isReadOnly: false, isConcurrencySafe: false, isDestructive: false, exposable: false },
	inputSchema: z.object({
		type: z.enum(["agent", "shell"]).describe("Background task type: agent (sub-agent delegation) or shell (background command)"),
		// agent fields
		task: z.string().optional().describe("(type:'agent') The task description to delegate"),
		subagent: z.string().optional().describe("(type:'agent') Name of a registered subagent (from `Subagent list`). Omit for ephemeral delegation."),
		model: z.string().optional().describe("(type:'agent') Model ID override (ephemeral delegation only)"),
		systemPrompt: z.string().optional().describe("(type:'agent') Custom system prompt override (ephemeral delegation only)"),
		// shell fields
		command: z.string().optional().describe("(type:'shell') The shell command to run in the background"),
		timeout: z.number().optional().describe("(type:'shell') Optional timeout in seconds"),
	}),
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<TaskStartData>> => {
		const { type } = input;
		const fns = callerCtx.delegateFns;

		// G1:when the host has no loop (UI dispatcher preview), there are no
		// delegate fns. Return a benign default so the UI can render the tool
		// preview without crashing — the model never sees this state in real runs.
		if (!fns) {
			return {
				ok: true,
				data: {
					text: "(preview) TaskStart is unavailable outside an agent loop — callerCtx has no delegateFns.",
				},
			};
		}

		if (type === "shell") {
			if (!input.command || !input.command.trim()) {
				return { ok: false, error: "`command` required for type:'shell'." };
			}
			if (!fns.runBackground) {
				return { ok: false, error: "Background shell is not available in this context." };
			}
			const taskId = fns.runBackground(input.command, input.timeout);
			// Surface synchronous launch failures (bad shell / missing binary)
			// immediately so the model can tell "launch failed" from "running".
			const launched = fns.getTaskResult?.(taskId);
			if (launched?.status === "failed") {
				return {
					ok: true,
					data: {
						text: `Background command failed to launch.\ntask_id: ${taskId}\nError: ${launched.result ?? "unknown launch error"}`,
						taskId,
					},
				};
			}
			return {
				ok: true,
				data: {
					text: `Background shell started.\ntask_id: ${taskId}\nUse TaskGet to drill in (recent calls / completed result).`,
					taskId,
				},
			};
		}

		// type === "agent"
		if (type !== "agent") {
			return { ok: false, error: `unknown TaskStart type '${type}'` };
		}
		const { task } = input;
		if (!task || !task.trim()) {
			return { ok: false, error: "`task` required for type:'agent'." };
		}
		if (!fns.delegateTaskBackground) {
			return { ok: false, error: "Background sub-agent is not available in this context." };
		}

		// Resolve delegation options. Same white-list semantics as the Subagent
		// tool's `delegate` action: named `subagent` → live-resolve to the target
		// agent's identity; omit → ephemeral (caller identity + inline overrides).
		// LIVE agent resolution goes through callerCtx.agentResolvers (G4:per-agent
		// config解 via callerCtx.agentId). Falls back to undefined resolvers in
		// UI/external hosts (returns an error listing available names as empty).
		const resolvers = callerCtx.agentResolvers;
		const resolveAgent = resolvers?.resolveAgent;
		let delegateOpts: { targetAgentId?: string; systemPrompt?: string; model?: string; toolPolicy?: any } = {};
		if (input.subagent) {
			const caller = resolveAgent?.(callerCtx.agentId ?? "");
			const entries = caller?.subagents ?? [];
			let matchedAgentId: string | undefined;
			for (const e of entries) {
				if (!e?.agentId) continue;
				const target = resolveAgent?.(e.agentId);
				if (entryDisplayName(e, target) === input.subagent) {
					matchedAgentId = e.agentId;
					break;
				}
			}
			if (!matchedAgentId) {
				const avail = entries
					.map((e) => entryDisplayName(e, resolveAgent?.(e.agentId)))
					.filter(Boolean);
				return { ok: false, error: `no subagent named "${input.subagent}". Available: ${avail.length ? avail.join(", ") : "(none)"}.` };
			}
			const target = resolveAgent?.(matchedAgentId);
			if (!target) {
				return { ok: false, error: `subagent "${input.subagent}" (${matchedAgentId}) no longer exists. Remove the stale reference or recreate the agent.` };
			}
			delegateOpts = {
				targetAgentId: matchedAgentId,
				systemPrompt: target.systemPrompt,
				model: target.model,
				toolPolicy: target.toolPolicy,
			};
		} else {
			delegateOpts = { model: input.model, systemPrompt: input.systemPrompt };
		}

		// Step 2E: same tool-call ↔ task link as the Subagent tool. Stamp the
		// parent tool-call id + annotate the recorder block with the minted
		// taskId so a future dangling-tool-call scanner can re-attach.
		const parentToolCallId = callerCtx.toolCallId;
		const taskId = fns.delegateTaskBackground(task, {
			...delegateOpts,
			parentToolCallId,
			onDispatched: parentToolCallId && fns.setToolCallTaskId
				? (id: string) => fns.setToolCallTaskId!(parentToolCallId, id)
				: undefined,
		});
		return {
			ok: true,
			data: {
				text: `Background sub-agent started.\ntask_id: ${taskId}\nUse TaskGet to drill in (recent calls / completed result), TaskFinish to wrap up, TaskResume to resume a frozen child.`,
				taskId,
			},
		};
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return `Error: ${result.error ?? "TaskStart failed."}`;
		}
		return (result.data as TaskStartData)?.text ?? "";
	},
});
