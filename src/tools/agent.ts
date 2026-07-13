// Agent 委派工具 (execution-entry-redesign sub-1 — delegate 默认后台化)
//
// # 文件说明书
//
// ## 核心功能
// 单一 `Subagent` 工具,两个 action:
//   - list     列出 caller 当前可委派的 subagent(现查 agentStore,自发现,
//              不靠 system prompt 注入)。
//   - delegate 委派任务(默认后台,立即返 task_id)。传 `subagent`(name)→ 用那个
//              已注册 agent 的身份(systemPrompt/model/toolPolicy,现查)跑;不传 →
//              临时委派(继承 caller 身份,或 inline model/systemPrompt 覆盖)。
//
// sub-1 (execution-entry-redesign) 改动:delegate 从 blocking(delegateTask 等
// 结果)改成默认后台(直接调 delegateTaskBackground,立即返 task_id)。去 blocking
// 模式 + 去 auto_background config(行为固化)。delegateTask 本身保持 blocking 不变
// —— Orchestrate 的 task 节点仍走它(经 fns.delegateTask),本工具不再经它。
//
// 单工具名 `Subagent` 恒定合法;subagent 是参数值;身份/列表现查 agentStore,
// 改配置不用重启 loop。
//
// ## 白名单语义
// delegate 带 subagent 时只能委派给 caller 自己 subagents 列表里的 agent
// (运行时现查)。匹配不到 name → 报错并列出可用名;目标 agentId 查不到 →
// 报错(不静默回落 caller)。
//
// ## 输入
// - callerCtx.agentResolvers.resolveAgent(LIVE 解 caller + 目标身份)
// - callerCtx.delegateFns.delegateTaskBackground(后台委派,立即返 task_id)
//
// ## 输出
// - ToolResult{data:{text, taskId?}};format(r) = r.data.text
//
// ## 维护规则
// - tool-decoupling sub-4(G1 + 决策 2/3):委派/查询函数经 callerCtx.delegateFns;
//   agentResolvers LIVE 解 per-agent 配置(G4);UI 无 loop 状态 → 返默认/示例;
//   execute 返 ToolResult JSON;format 文本与 sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";

/** A subagent entry's effective name = entry.name override, else the target agent's name. */
function entryDisplayName(entry: { agentId: string; name?: string }, target?: { name?: string }): string {
	return entry.name?.trim() || target?.name?.trim() || entry.agentId;
}

interface DelegateData {
	/** LLM-facing text. */
	text: string;
	/** Minted background task id (delegate action only). */
	taskId?: string;
}

export const delegateTool = buildTool({
	name: "Subagent",
	description:
		"Delegate a sub-agent task (background, returns task_id) or list delegatable role agents. Actions: list, delegate.",
	prompt:
		"Delegate sub-agent tasks (each runs in an isolated context with its own conversation history, persisted for restart-aware inspection).\n\n" +
		"Delegation is BACKGROUND: `delegate` returns immediately with a task_id — the sub-agent runs in the background. Use `Task action:'get'` to drill in (running → recent calls, completed → full result + acknowledge, interrupted → status), `Task action:'list'` for an overview, `Task action:'kill'` to discard, `Task action:'finish'`/`Task action:'resume'` (agent only) to gracefully wrap / resume a frozen child.\n\n" +
		"Delegation never requires a configured subagent. The default is to simply omit `subagent`: a sub-agent inherits your identity and runs the task in an isolated context. Name a `subagent` only when you want to hand the work to a specific registered role agent.\n\n" +
		"Actions:\n" +
		"- { action:'list' } — lists the registered role agents you can hand off to by name (your configured subagents), with name/description/model. Only useful when you want a named `subagent`. An empty list doesn't block delegation — it just means there's no named role agent, so omit `subagent`.\n" +
		"- { action:'delegate', task, subagent?, model?, systemPrompt? } — delegate a task (background, returns task_id).\n" +
		"    · Omit `subagent` (the default, always available): an ephemeral sub-agent that inherits YOUR identity (or the inline `model`/`systemPrompt` overrides). Good for isolated sub-tasks you'd otherwise do yourself.\n" +
		"    · `subagent` (a name from `list`): hand off to a registered role agent, which runs with ITS OWN identity (system prompt / tools / model). Only needed for role-based handoff to a specialist.\n" +
		"Task lifecycle (status, recent calls, kill, finish, resume) is handled by the single `Task` action tool — `Task action:'get'/'list'/'kill'/'finish'/'resume'`.\n\n" +
		"When to delegate — for LARGE or MULTI-STEP tasks, prefer delegating to a sub-agent over doing them inline. If a request looks like it will need many tool calls, multiple file edits, or a long exploration, lean toward breaking it into sub-tasks and delegating them (independent sub-tasks run in parallel). Delegating keeps your own context lean, lets work proceed in parallel, and keeps exploratory noise out of the main conversation. Use your judgment: tasks that hinge on the context you've already built may be better done inline. Also delegate to hand work to a specialized role agent (a configured subagent).\n\n" +
		"If you name a `subagent`, it must come from your own subagents list (run 'list'). You can always delegate without one by omitting `subagent`.",
	meta: { category: "agent", isReadOnly: false, isConcurrencySafe: false, exposable: false },
	inputSchema: z.object({
		action: z.enum(["list", "delegate"]).describe("list (show delegatable role agents) or delegate (background delegation, returns task_id)"),
		task: z.string().optional().describe("The task description (action:'delegate')"),
		subagent: z.string().optional().describe("Name of a registered subagent to delegate to (from 'list'). Omit for ephemeral delegation."),
		model: z.string().optional().describe("Model ID override (ephemeral delegation only)"),
		systemPrompt: z.string().optional().describe("Custom system prompt override (ephemeral delegation only)"),
	}),
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<DelegateData>> => {
		const { action } = input;
		const resolvers = callerCtx.agentResolvers;
		const resolveAgent = resolvers?.resolveAgent;
		const fns = callerCtx.delegateFns;

		// ── list ───────────────────────────────────────────────────
		if (action === "list") {
			// G1:UI/external host without agentResolvers → empty list (preview).
			const caller = resolveAgent?.(callerCtx.agentId ?? "");
			const entries = caller?.subagents ?? [];
			if (entries.length === 0) {
				return {
					ok: true,
					data: {
						text: "(No registered subagents to hand off to by name. You can still delegate — just omit `subagent` and the sub-agent inherits your identity.)",
					},
				};
			}
			const summary = entries.map((e) => {
				const target = resolveAgent?.(e.agentId);
				const name = entryDisplayName(e, target);
				return {
					name,
					description: e.description?.trim() || undefined,
					model: target?.model ?? null,
					...(target ? {} : { note: "target agent not found (stale reference)" }),
				};
			});
			return { ok: true, data: { text: JSON.stringify(summary) } };
		}

		// ── delegate (blocking) ────────────────────────────────────
		if (action !== "delegate") {
			return { ok: false, error: `unknown Subagent action '${action}'. Supported: list, delegate. (Task lifecycle is handled by the single Task action tool: Task action:'get'/'list'/'kill'/'finish'/'resume'.)` };
		}
		const { task } = input;
		if (!task || !task.trim()) {
			return { ok: false, error: "`task` required for delegate" };
		}

		// Resolve delegation options. If `subagent` is named, resolve it LIVE to
		// the target agent's identity (systemPrompt/model/toolPolicy); else the
		// sub-agent inherits the caller's identity (ephemeral), with optional
		// inline model/systemPrompt overrides.
		let delegateOpts: { targetAgentId?: string; systemPrompt?: string; model?: string; toolPolicy?: any } = {};
		if (input.subagent) {
			const caller = resolveAgent?.(callerCtx.agentId ?? "");
			const entries = caller?.subagents ?? [];
			// Match by effective name (entry.name > target.name). First hit wins.
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
			// Ephemeral: caller identity, inline overrides.
			delegateOpts = {
				model: input.model,
				systemPrompt: input.systemPrompt,
			};
		}

		// Background mode (sub-1 / execution-entry-redesign): delegate runs in the
		// background and returns a task_id immediately. We call delegateTaskBackground
		// directly (NOT delegateTask — that path is blocking and reserved for
		// Orchestrate's task nodes via orchestrate-tool.ts). Sub-agent identity /
		// white-list resolution is unchanged from the prior blocking path; only the
		// dispatch primitive changed (delegateTask → delegateTaskBackground).
		if (!fns?.delegateTaskBackground) {
			return { ok: false, error: "Sub-agent delegation is not available in this context." };
		}
		// Step 2E: tool-call ↔ task link annotation (mirrors the wiring the old
		// start action used to register). Background dispatch
		// returns the taskId synchronously; onDispatched is fired inside
		// delegateTaskBackground right after the row is created (before the sub-loop
		// is spawned), so the recorder block gets annotated before any work starts.
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
				text: `Background sub-agent started.\ntask_id: ${taskId}\nUse Task action:'get' to drill in (recent calls / completed result), Task action:'finish' to wrap up, Task action:'resume' to resume a frozen child.`,
				taskId,
			},
		};
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "Subagent failed.";
		}
		return (result.data as DelegateData)?.text ?? "";
	},
});
