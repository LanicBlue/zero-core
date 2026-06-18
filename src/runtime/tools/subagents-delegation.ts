// v0.8 (P2 §11.5) — subagents delegation entry factory
//
// # 文件说明书
//
// ## 核心功能
// 按 AgentRecord.subagents 列表为 caller agent-loop 生成委派入口工具。每个
// subagent → 一个工具,name = subagent.name 或目标 agent 的 alias;描述 =
// entry.description。工具 execute 调 delegateTask(task, { targetAgentId }),
// 继承 caller context bundle(含 projectId)。
//
// ## 关键差异(与已废 agent-as-tool)
// - 不读 agent-tool-entries 表;入口来自 AgentRecord.subagents(JSON 列)。
// - 不进全局工具 UI(不注册到 ALL_TOOLS / ToolRegistry);只在 caller 的
//   buildToolsSet 输出里出现。
// - 与 toolPolicy.tools 分开(那是硬编码工具开关);subagents 走单独通道。
// - targetAgentId 参数化:可真实 agentId 也可临时 `:sub`。默认走 entry.agentId。
//
// ## 输入
// - subagents:AgentRecord.subagents(JSON)
// - resolveTarget:(agentId) => 目标 agent 的 systemPrompt / model / toolPolicy
//   (可选;不提供时只传 targetAgentId,由 delegateTask 默认继承 caller)
// - ctx:ToolExecutionContext(delegateTask 在此)
//
// ## 输出
// - Record<toolName, toolDef>:caller 的 buildToolsSet 通过 subagents 参数注入。
//
// ## 定位
// runtime/tools 层,被 agent-loop.buildTools 调用;取代已废的 buildAgentTools。
//
// ## 依赖
// - zod、./tool-factory(buildTool)
// - ../types(ToolExecutionContext)、../subagent-delegator(DelegateTaskOptions)
// - ../../shared/types(AgentRecord.subagents 形状)
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { ToolExecutionContext } from "../types.js";
import { OUTPUT_TRUNCATION_CHARS } from "../../core/constants.js";

/** AgentRecord.subagents entry shape (re-declared to avoid cycles). */
export interface SubagentEntry {
	agentId: string;
	/** Caller-facing tool name override; falls back to a slug of agentId. */
	name?: string;
	/** Caller-facing tool description. */
	description?: string;
}

/** Identity of the target agent (used to drive the sub-loop's prompt/policy). */
export interface SubagentTarget {
	id: string;
	name?: string;
	systemPrompt?: string;
	model?: string;
	toolPolicy?: any;
}

export interface BuildSubagentToolsOptions {
	/** Caller's subagents list (from AgentRecord.subagents). */
	subagents: SubagentEntry[];
	/** Resolve a target agent's identity by id. Optional — when absent, only
	 * targetAgentId is passed and delegateTask inherits the caller's identity. */
	resolveTarget?: (agentId: string) => SubagentTarget | undefined;
	/** Tool execution context (carries delegateTask). */
	context: ToolExecutionContext;
}

function slugify(s: string): string {
	const out = s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");
	return out || "subagent";
}

function truncate(text: string): string {
	if (text.length <= OUTPUT_TRUNCATION_CHARS) return text;
	return text.slice(0, OUTPUT_TRUNCATION_CHARS) + "\n... (output truncated)";
}

/**
 * Build one delegation tool per subagent entry. The tools are returned as a
 * Record keyed by user-facing tool name. They are NOT registered into the
 * global ToolRegistry / ALL_TOOLS — the caller passes them through
 * buildToolsSet's `subagentsTools` channel only.
 *
 * Empty subagents → empty record (no error). The caller's loop still works.
 */
export function buildSubagentTools(opts: BuildSubagentToolsOptions): Record<string, any> {
	const { subagents, resolveTarget, context } = opts;
	const tools: Record<string, any> = {};
	if (!subagents || subagents.length === 0) return tools;
	if (!context.delegateTask) return tools; // nothing to delegate through

	for (const entry of subagents) {
		if (!entry?.agentId) continue;
		const target = resolveTarget?.(entry.agentId);
		// Tool name: entry.name > target.name > slug(agentId).
		const toolName = entry.name?.trim() || target?.name?.trim() || slugify(entry.agentId);
		const desc =
			entry.description?.trim() ||
			(target?.name ? `Delegate a task to the "${target.name}" agent.` : `Delegate a task to subagent ${entry.agentId}.`);

		const capturedAgentId = entry.agentId;
		const capturedTarget = target;

		tools[toolName] = buildTool({
			name: toolName,
			description: desc,
			meta: {
				category: "agent",
				isReadOnly: true,
				isConcurrencySafe: false,
				isDestructive: false,
			},
			inputSchema: z.object({
				task: z.string().describe("Task for the sub-agent to perform"),
			}),
			execute: async (input) => {
				if (!context.delegateTask) return "Error: Agent delegation is not available.";
				try {
					// targetAgentId is parameterized: real agentId (preferred when
					// the target exists) or fall back to a temp `:sub` id. Identity
					// (prompt/model/policy) comes from the resolved target when
					// available; otherwise delegateTask inherits caller identity.
					const result = await context.delegateTask(input.task, {
						targetAgentId: capturedAgentId,
						systemPrompt: capturedTarget?.systemPrompt,
						model: capturedTarget?.model,
						toolPolicy: capturedTarget?.toolPolicy,
					});
					return truncate(result || "(sub-agent returned no output)");
				} catch (err: any) {
					return `Sub-agent error: ${err.message}`;
				}
			},
		});
	}

	return tools;
}
