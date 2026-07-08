// 用户交互工具
//
// # 文件说明书(tool-decoupling sub-4 迁新签名)
//
// ## 核心功能
// 提供用户交互能力,允许 Agent 向用户提问并等待回答。
//
// ## 输入
// - 问题数组(LLM input —— 这是工具的实际负载,非身份)
//
// ## 输出
// - ToolResult{data:{text, requestId, answers?}};format(r) = r.data.text
//
// ## 定位
// 中立工具层(src/tools/),被 agent loop / UI dispatcher 调。
//
// ## 依赖
// - zod - 数据验证
// - ../runtime/pending-responses - 响应管理(module-level singleton)
// - ../core/hook-registry - Elicitation hook
// - callerCtx.agentId / callerCtx.sessionId / callerCtx.emit(身份 + 流式)
//
// ## 维护规则
// - 保持交互逻辑正确
// - 处理超时情况
// - tool-decoupling sub-4(决策 2/3):身份(agentId/sessionId)只从 callerCtx 取;
//   execute 返 ToolResult JSON;format 文本与 sub-4 前逐字一致。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";
import { pendingResponses } from "../runtime/pending-responses.js";
import { triggerHooks } from "../core/hook-registry.js";

interface AskUserData {
	/** LLM-facing text: formatted answers (same as pre-sub-4 output). */
	text: string;
	/** Request id used to register + await the response (for UI dispatcher traceability). */
	requestId: string;
	/** The user's answers (key = question, value = answer). */
	answers?: Record<string, string>;
}

export const askUserTool = buildTool({
	name: "AskUser",
	description: "Ask the user a question during task execution. Supports multiple-choice and free-text.",
	prompt:
		"Ask the user a question and wait for their response. Use when you need clarification or a decision.\n\nWhen to ask:\n- The task is ambiguous and multiple interpretations are possible\n- You need the user to choose between options\n- You are unsure about a destructive action\n\nWhen NOT to ask:\n- The intent is clear from context — just do it\n- You can infer the answer from the codebase or conversation\n\nTips:\n- Provide 2-4 concrete options when possible (faster for the user)\n- Include 'Other' as an implicit option — the user can always type freely\n- Keep questions specific and actionable",
	meta: { category: "interaction", isReadOnly: true, isConcurrencySafe: false, exposable: false },
	inputSchema: z.object({
		questions: z.array(z.object({
			question: z.string().describe("The complete question to ask the user"),
			header: z.string().optional().describe("Short label displayed as a chip/tag (max 12 chars)"),
			options: z.array(z.object({
				label: z.string().describe("Display text for this option"),
				description: z.string().optional().describe("Explanation of what this option means"),
			})).min(2).max(4).optional().describe("Available choices (2-4). If omitted, free-text input."),
			multiSelect: z.boolean().optional().describe("Allow multiple selections (default false)"),
		})).min(1).max(4).describe("1-4 questions to ask the user"),
	}),
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<AskUserData>> => {
		const { questions } = input;
		const requestId = `${callerCtx.agentId}-${Date.now()}`;

		// Hook: Elicitation
		triggerHooks("Elicitation", { agentId: callerCtx.agentId, questions });

		// Emit ask_user event for renderer to pick up. 带 sessionId:前端按 session
		// 路由卡片(同 agent 多 session 不串显),pendingResponses 也按 session 索引,
		// 供"显示时 pull"拉回未决问题。
		callerCtx.emit?.({
			type: "ask_user",
			agentId: callerCtx.agentId,
			sessionId: callerCtx.sessionId,
			requestId,
			questions,
		} as any);

		// Wait for user response
		const answers = await pendingResponses.createRequest(requestId, { sessionId: callerCtx.sessionId, questions });

		// Hook: ElicitationResult
		triggerHooks("ElicitationResult", { agentId: callerCtx.agentId, response: answers });

		// Format answers for the agent
		const lines: string[] = ["User responses:"];
		for (const [key, value] of Object.entries(answers)) {
			lines.push(`- ${key}: ${value}`);
		}
		return {
			ok: true,
			data: {
				text: lines.join("\n"),
				requestId,
				answers,
			},
		};
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "AskUser failed.";
		}
		return (result.data as AskUserData)?.text ?? "(no response)";
	},
});
