import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import { pendingResponses } from "../pending-responses.js";

// ---------------------------------------------------------------------------
// AskUserQuestion — ask the user questions during task execution
// ---------------------------------------------------------------------------

export const askUserTool = buildTool({
	name: "ask_user",
	description:
		"Ask the user a question during task execution. Use to clarify requirements, " +
		"get decisions on implementation choices, or gather preferences. " +
		"The user can select from provided options or type a custom answer.",
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

		// Emit ask_user event for renderer to pick up
		ctx.emit({
			type: "ask_user",
			agentId: ctx.agentId,
			requestId,
			questions,
		} as any);

		// Wait for user response
		const answers = await pendingResponses.createRequest(requestId);

		// Format answers for the agent
		const lines: string[] = ["User responses:"];
		for (const [key, value] of Object.entries(answers)) {
			lines.push(`- ${key}: ${value}`);
		}
		return lines.join("\n");
	},
});
