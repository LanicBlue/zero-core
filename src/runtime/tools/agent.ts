// Agent 委派工具 (v0.8 — action 化重构)
//
// # 文件说明书
//
// ## 核心功能
// 单一 `Agent` 工具,两个 action:
//   - list     列出 caller 当前可委派的 subagent(现查 agentStore,自发现,
//              不靠 system prompt 注入)。
//   - delegate 委派任务。传 `subagent`(name)→ 用那个已注册 agent 的身份
//              (systemPrompt/model/toolPolicy,现查)跑;不传 → 临时委派
//              (继承 caller 身份,或 inline model/systemPrompt 覆盖)。
//              支持 blocking / non_blocking。
//
// 取代了:(a) 旧通用 Agent 工具(只临时委派);(b) per-subagent 工具
// (buildSubagentTools,每个 subagent 一个独立工具,名字不安全 + 身份固化)。
// 单工具名 `Agent` 恒定合法;subagent 是参数值;身份/列表现查 agentStore,
// 改配置不用重启 loop。
//
// ## 白名单语义
// delegate 带 subagent 时只能委派给 caller 自己 subagents 列表里的 agent
// (运行时现查)。匹配不到 name → 报错并列出可用名;目标 agentId 查不到 →
// 报错(不静默回落 caller)。
//
// ## 输入
// - ctx.delegateTask / ctx.delegateTaskBackground
// - ctx.resolveAgent(id)(活查 agentStore)
//
// ## 输出
// - export const delegateTool
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import { OUTPUT_TRUNCATION_CHARS } from "../../core/constants.js";

function truncate(text: string): string {
	if (text.length <= OUTPUT_TRUNCATION_CHARS) return text;
	return text.slice(0, OUTPUT_TRUNCATION_CHARS) + "\n... (output truncated)";
}

/** A subagent entry's effective name = entry.name override, else the target agent's name. */
function entryDisplayName(entry: { agentId: string; name?: string }, target?: { name?: string }): string {
	return entry.name?.trim() || target?.name?.trim() || entry.agentId;
}

export const delegateTool = buildTool({
	name: "Agent",
	description:
		"Delegate a task to a sub-agent. Action-switched: 'list' (see who you can delegate to) and 'delegate' (run a task in an isolated sub-agent context).",
	prompt:
		"Delegate a task to a sub-agent (runs in an isolated context with its own conversation history).\n\n" +
		"Actions:\n" +
		"- { action:'list' } — list the agents YOU can delegate to (your configured subagents), with their name/description/model. Call this first if you don't know who's available.\n" +
		"- { action:'delegate', task, subagent?, mode?, model?, systemPrompt? } — delegate a task.\n" +
		"    · `subagent` (name, from list): delegate to that registered agent — it runs with ITS OWN identity (system prompt / tools / model). Use this for role-based handoff (e.g. hand coding work to your 'Developer' subagent).\n" +
		"    · omit `subagent`: ephemeral delegation — the sub-agent inherits YOUR identity (or the inline `model`/`systemPrompt` overrides). Use for isolated/parallel sub-tasks you'd otherwise do yourself.\n" +
		"    · `mode`: 'blocking' (default, wait for output) | 'non_blocking' (return a task_id immediately; use Wait/TaskStatus to check later).\n\n" +
		"When to delegate: parallel work, complex multi-step searches, isolated exploration that shouldn't pollute the main conversation, or handing work to a specialized role agent.\n\n" +
		"You can ONLY delegate by `subagent` name to agents in your own subagents list (run 'list' to see them).",
	meta: { category: "agent", isReadOnly: false, isConcurrencySafe: false },
	configSchema: [
		{ key: "auto_background", type: "boolean", label: "自动转后台", description: "阻塞超时后自动转为非阻塞后台执行" },
		{ key: "auto_background_timeout", type: "number", label: "超时 (s)", description: "阻塞等待秒数，超时后转后台；设为 0 则立即非阻塞", default: 0 },
	],
	inputSchema: z.object({
		action: z.enum(["list", "delegate"]).describe("'list' to see delegatable agents; 'delegate' to run a task"),
		task: z.string().optional().describe("The task description (action:'delegate')"),
		subagent: z.string().optional().describe("Name of a registered subagent to delegate to (from 'list'). Omit for ephemeral delegation."),
		model: z.string().optional().describe("Model ID override (ephemeral delegation only)"),
		systemPrompt: z.string().optional().describe("Custom system prompt override (ephemeral delegation only)"),
		mode: z.enum(["blocking", "non_blocking"]).optional().describe("blocking (wait) or non_blocking (return task_id)"),
	}),
	execute: async (input, ctx) => {
		const { action } = input;

		// ── list ───────────────────────────────────────────────────
		if (action === "list") {
			const caller = ctx.resolveAgent?.(ctx.agentId);
			const entries = caller?.subagents ?? [];
			if (entries.length === 0) {
				return "(no subagents configured — this agent cannot delegate to any registered agent. Use ephemeral delegation by omitting `subagent`.)";
			}
			const summary = entries.map((e) => {
				const target = ctx.resolveAgent?.(e.agentId);
				const name = entryDisplayName(e, target);
				return {
					name,
					description: e.description?.trim() || undefined,
					model: target?.model ?? null,
					...(target ? {} : { note: "target agent not found (stale reference)" }),
				};
			});
			return JSON.stringify(summary);
		}

		// ── delegate ───────────────────────────────────────────────
		if (action !== "delegate") return `Error: unknown Agent action '${action}'`;
		const { task, mode: inputMode } = input;
		if (!task || !task.trim()) return "Error: `task` required for delegate";

		const config = ctx.toolConfig?.Agent ?? {};
		const autoBg = config.auto_background === true;
		const bgTimeout = Number(config.auto_background_timeout) || 0;

		// Resolve delegation options. If `subagent` is named, resolve it LIVE to
		// the target agent's identity (systemPrompt/model/toolPolicy); else the
		// sub-agent inherits the caller's identity (ephemeral), with optional
		// inline model/systemPrompt overrides.
		let delegateOpts: { targetAgentId?: string; systemPrompt?: string; model?: string; toolPolicy?: any } = {};
		if (input.subagent) {
			const caller = ctx.resolveAgent?.(ctx.agentId);
			const entries = caller?.subagents ?? [];
			// Match by effective name (entry.name > target.name). First hit wins.
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
			// Ephemeral: caller identity, inline overrides.
			delegateOpts = {
				model: input.model,
				systemPrompt: input.systemPrompt,
			};
		}

		// Determine effective mode.
		let effectiveMode: "blocking" | "non_blocking";
		if (inputMode) {
			effectiveMode = inputMode;
		} else if (!autoBg) {
			effectiveMode = "blocking";
		} else if (bgTimeout === 0) {
			effectiveMode = "non_blocking";
		} else {
			effectiveMode = "blocking"; // will auto-background after timeout
		}

		if (effectiveMode === "non_blocking") {
			if (!ctx.delegateTaskBackground) {
				return "Error: Non-blocking sub-agent is not available in this context.";
			}
			const taskId = ctx.delegateTaskBackground(task, {
				model: delegateOpts.model,
				systemPrompt: delegateOpts.systemPrompt,
			});
			return `Agent dispatched in non-blocking mode.\ntask_id: ${taskId}\nUse TaskStatus to check progress and retrieve the result.`;
		}

		// Blocking mode
		if (!ctx.delegateTask) {
			return "Error: Sub-agent delegation is not available in this context.";
		}
		try {
			const result = await ctx.delegateTask(task, delegateOpts);
			return truncate(result || "(sub-agent returned no output)");
		} catch (err: any) {
			return `Sub-agent error: ${err.message}`;
		}
	},
});
