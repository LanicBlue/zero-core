// Agent 委派工具 (sub-4 — blocking-only 重构 / tool-decoupling sub-4 迁新签名)
//
// # 文件说明书
//
// ## 核心功能
// 单一 `Subagent` 工具,两个 action(sub-4 瘦身后):
//   - list     列出 caller 当前可委派的 subagent(现查 agentStore,自发现,
//              不靠 system prompt 注入)。
//   - delegate 委派任务(blocking)。传 `subagent`(name)→ 用那个已注册 agent
//              的身份(systemPrompt/model/toolPolicy,现查)跑;不传 → 临时委派
//              (继承 caller 身份,或 inline model/systemPrompt 覆盖)。
//
// sub-4 改动:去 mode:non_blocking(显式后台全归 TaskStart)、去 stop/complete/
// request_finish/tree/resume(全归 Task 工具族)。本工具现在只 blocking 委派 +
// 列可委派角色。超时自动后台保留(auto_background config)safety net 不变 —— 阻塞
// 超时仍会转后台 task(经 delegator.delegateTask 的 auto-bg 分支),父用 TaskGet 看。
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
// - callerCtx.delegateFns.delegateTask(blocking 委派)
//
// ## 输出
// - ToolResult{data:{text}};format(r) = r.data.text
//
// ## 维护规则
// - tool-decoupling sub-4(G1 + 决策 2/3):委派/查询函数经 callerCtx.delegateFns;
//   agentResolvers LIVE 解 per-agent 配置(G4);UI 无 loop 状态 → 返默认/示例;
//   execute 返 ToolResult JSON;format 文本与 sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";
import { OUTPUT_TRUNCATION_CHARS } from "../core/constants.js";

function truncate(text: string): string {
	if (text.length <= OUTPUT_TRUNCATION_CHARS) return text;
	return text.slice(0, OUTPUT_TRUNCATION_CHARS) + "\n... (output truncated)";
}

/** A subagent entry's effective name = entry.name override, else the target agent's name. */
function entryDisplayName(entry: { agentId: string; name?: string }, target?: { name?: string }): string {
	return entry.name?.trim() || target?.name?.trim() || entry.agentId;
}

interface DelegateData {
	/** LLM-facing text (truncated to OUTPUT_TRUNCATION_CHARS). */
	text: string;
}

export const delegateTool = buildTool({
	name: "Subagent",
	description:
		"Delegate a sub-agent task (blocking) or list delegatable role agents. Actions: list, delegate.",
	prompt:
		"Delegate and control sub-agent tasks (each runs in an isolated context with its own conversation history, persisted for restart-aware inspection).\n\n" +
		"Delegation is BLOCKING (waits for the result). For a background / parallel sub-agent, use TaskStart { type:'agent', ... } instead — that's the single explicit background entry point. A blocking delegate that exceeds its timeout auto-backgrounds (you get a task_id); watch it via TaskGet.\n\n" +
		"Delegation never requires a configured subagent. The default is to simply omit `subagent`: a sub-agent inherits your identity and runs the task in an isolated context. Name a `subagent` only when you want to hand the work to a specific registered role agent.\n\n" +
		"Actions:\n" +
		"- { action:'list' } — lists the registered role agents you can hand off to by name (your configured subagents), with name/description/model. Only useful when you want a named `subagent`. An empty list doesn't block delegation — it just means there's no named role agent, so omit `subagent`.\n" +
		"- { action:'delegate', task, subagent?, model?, systemPrompt? } — delegate a task (blocking).\n" +
		"    · Omit `subagent` (the default, always available): an ephemeral sub-agent that inherits YOUR identity (or the inline `model`/`systemPrompt` overrides). Good for isolated sub-tasks you'd otherwise do yourself.\n" +
		"    · `subagent` (a name from `list`): hand off to a registered role agent, which runs with ITS OWN identity (system prompt / tools / model). Only needed for role-based handoff to a specialist.\n" +
		"Task lifecycle (status, recent calls, kill, finish, resume) is handled by the Task tool family — TaskGet / TaskList / TaskKill / TaskFinish / TaskResume.\n\n" +
		"When to delegate — for LARGE or MULTI-STEP tasks, prefer delegating to a sub-agent over doing them inline. If a request looks like it will need many tool calls, multiple file edits, or a long exploration, lean toward breaking it into sub-tasks and delegating them (use TaskStart for independent sub-tasks so they run in parallel). Delegating keeps your own context lean, lets work proceed in parallel, and keeps exploratory noise out of the main conversation. Use your judgment: tasks that hinge on the context you've already built may be better done inline. Also delegate to hand work to a specialized role agent (a configured subagent).\n\n" +
		"If you name a `subagent`, it must come from your own subagents list (run 'list'). You can always delegate without one by omitting `subagent`.",
	meta: { category: "agent", isReadOnly: false, isConcurrencySafe: false, exposable: false },
	configSchema: [
		{ key: "auto_background", type: "boolean", label: "自动转后台", description: "阻塞超时后自动转为非阻塞后台执行 (safety net)" },
		{ key: "auto_background_timeout", type: "number", label: "超时 (s)", description: "阻塞等待秒数，超时后转后台；设为 0 则立即非阻塞", default: 0 },
	],
	inputSchema: z.object({
		action: z.enum(["list", "delegate"]).describe("list (show delegatable role agents) or delegate (blocking delegation)"),
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
			return { ok: false, error: `unknown Subagent action '${action}'. Supported: list, delegate. (Task lifecycle is handled by the Task tool family: TaskGet / TaskList / TaskKill / TaskFinish / TaskResume.)` };
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

		// Blocking mode (sub-4: the ONLY mode now — non_blocking moved to TaskStart).
		// auto_background remains as a safety net: a blocking delegate that exceeds
		// its timeout auto-backgrounds (delegator.delegateTask's auto-bg branch).
		if (!fns?.delegateTask) {
			return { ok: false, error: "Sub-agent delegation is not available in this context." };
		}
		try {
			// Step 2E: same tool-call ↔ task link as TaskStart. The blocking path
			// doesn't return a taskId, so we use the onDispatched callback (fired
			// synchronously inside delegateTask right after the row is created) to
			// annotate the recorder block before the call awaits.
			const parentToolCallId = callerCtx.toolCallId;
			const result = await fns.delegateTask(task, {
				...delegateOpts,
				parentToolCallId,
				onDispatched: parentToolCallId && fns.setToolCallTaskId
					? (id: string) => fns.setToolCallTaskId!(parentToolCallId, id)
					: undefined,
			});
			return { ok: true, data: { text: truncate(result || "(sub-agent returned no output)") } };
		} catch (err: any) {
			// Preserve the pre-sub-4 "soft failure" semantics: the delegator threw
			// (e.g. agent target vanished / sub-loop crashed), but historically the
			// tool returned the error as a successful string so the agent could read
			// it inline + react. Migrated tools' {ok:false} → buildTool throws →
			// PostToolUseFailure fires + tool_usage(success=false); that would be a
			// behavior change for the Subagent error path. Keep ok:true + put the
			// error text in data.text so format returns it verbatim (same as before).
			return { ok: true, data: { text: `Sub-agent error: ${err.message}` } };
		}
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "Subagent failed.";
		}
		return (result.data as DelegateData)?.text ?? "";
	},
});
