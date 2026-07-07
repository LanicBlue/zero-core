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
// task_id(成功) / 错误字符串(失败)
//
// ## 定位
// Runtime 工具(src/runtime/tools/),被 Agent 调用。
//
// ## 依赖
// - zod / buildTool
// - ctx.delegateTaskBackground(后台委派)/ ctx.runBackground(后台 shell)
// - ctx.resolveAgent(命名 subagent 解析,复用 Subagent 工具同款白名单语义)
//
// ## 维护规则
// - Subagent 白名单语义(agent → delegateTaskBackground 传 targetAgentId/systemPrompt/
//   toolPolicy)须与 Subagent 工具的 delegate 动作保持一致 —— 改一处同步另一处。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";

/** A subagent entry's effective name = entry.name override, else the target agent's name. */
function entryDisplayName(entry: { agentId: string; name?: string }, target?: { name?: string }): string {
	return entry.name?.trim() || target?.name?.trim() || entry.agentId;
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
	meta: { category: "task", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
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
	execute: async (input, ctx) => {
		const { type } = input;

		if (type === "shell") {
			if (!input.command || !input.command.trim()) return "Error: `command` required for type:'shell'.";
			if (!ctx.runBackground) return "Error: Background shell is not available in this context.";
			const taskId = ctx.runBackground(input.command, input.timeout);
			// Surface synchronous launch failures (bad shell / missing binary)
			// immediately so the model can tell "launch failed" from "running".
			const launched = ctx.getTaskResult?.(taskId);
			if (launched?.status === "failed") {
				return `Background command failed to launch.\ntask_id: ${taskId}\nError: ${launched.result ?? "unknown launch error"}`;
			}
			return `Background shell started.\ntask_id: ${taskId}\nUse TaskGet to drill in (recent calls / completed result).`;
		}

		// type === "agent"
		if (type !== "agent") return `Error: unknown TaskStart type '${type}'`;
		const { task } = input;
		if (!task || !task.trim()) return "Error: `task` required for type:'agent'.";
		if (!ctx.delegateTaskBackground) return "Error: Background sub-agent is not available in this context.";

		// Resolve delegation options. Same white-list semantics as the Subagent
		// tool's `delegate` action: named `subagent` → live-resolve to the target
		// agent's identity; omit → ephemeral (caller identity + inline overrides).
		let delegateOpts: { targetAgentId?: string; systemPrompt?: string; model?: string; toolPolicy?: any } = {};
		if (input.subagent) {
			const caller = ctx.resolveAgent?.(ctx.agentId);
			const entries = caller?.subagents ?? [];
			let matchedAgentId: string | undefined;
			for (const e of entries) {
				if (!e?.agentId) continue;
				const target = ctx.resolveAgent?.(e.agentId);
				if (entryDisplayName(e, target) === input.subagent) {
					matchedAgentId = e.agentId;
					break;
				}
			}
			if (!matchedAgentId) {
				const avail = entries
					.map((e) => entryDisplayName(e, ctx.resolveAgent?.(e.agentId)))
					.filter(Boolean);
				return `Error: no subagent named "${input.subagent}". Available: ${avail.length ? avail.join(", ") : "(none)"}.`;
			}
			const target = ctx.resolveAgent?.(matchedAgentId);
			if (!target) {
				return `Error: subagent "${input.subagent}" (${matchedAgentId}) no longer exists. Remove the stale reference or recreate the agent.`;
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
		const parentToolCallId = ctx.currentToolCallId;
		const taskId = ctx.delegateTaskBackground(task, {
			...delegateOpts,
			parentToolCallId,
			onDispatched: parentToolCallId
				? (id) => ctx.setToolCallTaskId?.(parentToolCallId, id)
				: undefined,
		});
		return `Background sub-agent started.\ntask_id: ${taskId}\nUse TaskGet to drill in (recent calls / completed result), TaskFinish to wrap up, TaskResume to resume a frozen child.`;
	},
});
