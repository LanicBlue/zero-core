import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import { pendingResponses } from "../pending-responses.js";
import { triggerHooks } from "../../core/hook-registry.js";

// ---------------------------------------------------------------------------
// AskUserQuestion — ask the user questions during task execution
// ---------------------------------------------------------------------------

export const askUserTool = buildTool({
	name: "AskUser",
	description: "Ask the user a question during task execution. Supports multiple-choice and free-text.",
	prompt:
		"Ask the user a question and wait for their response. Use when you need clarification or a decision.\n\nWhen to ask:\n- The task is ambiguous and multiple interpretations are possible\n- You need the user to choose between options\n- You are unsure about a destructive action\n\nWhen NOT to ask:\n- The intent is clear from context — just do it\n- You can infer the answer from the codebase or conversation\n\nTips:\n- Provide 2-4 concrete options when possible (faster for the user)\n- Include 'Other' as an implicit option — the user can always type freely\n- Keep questions specific and actionable",
	meta: { category: "interaction", isReadOnly: true, isConcurrencySafe: false },
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
	execute: async ({ questions }, ctx) => {
		const requestId = `${ctx.agentId}-${Date.now()}`;

			// Hook: Elicitation
			triggerHooks("Elicitation", { agentId: ctx.agentId, questions });

		// Emit ask_user event for renderer to pick up
		ctx.emit({
			type: "ask_user",
			agentId: ctx.agentId,
			requestId,
			questions,
		} as any);

		// Wait for user response
		const answers = await pendingResponses.createRequest(requestId);

			// Hook: ElicitationResult
			triggerHooks("ElicitationResult", { agentId: ctx.agentId, response: answers });

		// Format answers for the agent
		const lines: string[] = ["User responses:"];
		for (const [key, value] of Object.entries(answers)) {
			lines.push(`- ${key}: ${value}`);
		}
		return lines.join("\n");
	},
});
