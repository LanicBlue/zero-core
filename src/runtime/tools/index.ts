import { tool } from "ai";
import { z } from "zod";
import type { ToolExecutionContext } from "../types.js";
import { bashTool } from "./bash.js";
import { fileReadTool } from "./file-read.js";
import { fileWriteTool } from "./file-write.js";
import { fileEditTool } from "./file-edit.js";
import { grepTool } from "./grep.js";
import { findTool } from "./find.js";
import { delegateTool } from "./delegate.js";
import { externalAgentTool } from "./external-agent.js";
import { buildMcpTools } from "./mcp-tool.js";
import { webSearchTool } from "./web-search.js";
import { askUserTool } from "./ask-user.js";
import { todoWriteTool } from "./todo-write.js";
import { scheduleWakeupTool } from "./schedule-wakeup.js";
import { getToolMeta, getToolName } from "./tool-factory.js";
import type { ToolCategory } from "./tool-factory.js";

const ALL_TOOLS: Record<string, any> = {
	bash: bashTool,
	read: fileReadTool,
	write: fileWriteTool,
	edit: fileEditTool,
	grep: grepTool,
	find: findTool,
	delegate: delegateTool,
	external_agent: externalAgentTool,
	web_search: webSearchTool,
	ask_user: askUserTool,
	todo_write: todoWriteTool,
	schedule_wakeup: scheduleWakeupTool,
};

// Tools that require special context capabilities
const CONDITIONAL_TOOLS: Record<string, (ctx: ToolExecutionContext) => boolean> = {
	delegate: (ctx) => !!ctx.delegateTask,
	external_agent: () => true,
};

function wrapDisabledTool(name: string, originalDescription: string) {
	return tool({
		description: `[DISABLED] ${originalDescription} — This tool is not enabled for this agent.`,
		inputSchema: z.object({ _: z.string().optional() }),
		execute: async () =>
			`Tool "${name}" is not enabled for this agent. You can ask the user to enable it in agent settings if needed.`,
	});
}

export function buildToolsSet(
	policy: {
		autoApprove?: string[];
		blockedTools?: string[];
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
	},
	context: ToolExecutionContext,
	mcpTools?: Record<string, any>,
	builtInTools?: Record<string, any>,
): Record<string, any> {
	const blocked = new Set(policy.blockedTools ?? []);
	const autoApprove = new Set(policy.autoApprove ?? []);
	const tools: Record<string, any> = {};

	for (const [name, def] of Object.entries(ALL_TOOLS)) {
		if (blocked.has(name)) continue;

		// Check conditional tools
		const condition = CONDITIONAL_TOOLS[name];
		if (condition && !condition(context)) continue;

		if (autoApprove.has(name) || autoApprove.has("*")) {
			tools[name] = def;
		} else {
			const desc = (def as any)?.description ?? name;
			tools[name] = wrapDisabledTool(name, typeof desc === "string" ? desc : "");
		}
	}

	// Merge MCP tools
	if (mcpTools) {
		Object.assign(tools, mcpTools);
	}

	// Merge built-in tools (fetch, memory, thinking, assistant)
	if (builtInTools) {
		for (const [name, def] of Object.entries(builtInTools)) {
			if (blocked.has(name)) continue;
			if (autoApprove.has(name) || autoApprove.has("*")) {
				tools[name] = def;
			} else {
				const desc = (def as any)?.description ?? name;
				tools[name] = wrapDisabledTool(name, typeof desc === "string" ? desc : "");
			}
		}
	}

	return tools;
}

// ---------------------------------------------------------------------------
// Tool metadata helpers
// ---------------------------------------------------------------------------

export function getToolCategories(): Record<ToolCategory, string[]> {
	const categories: Record<string, string[]> = {};

	for (const [name, def] of Object.entries(ALL_TOOLS)) {
		const meta = getToolMeta(def);
		const cat = meta?.category ?? "runtime";
		if (!categories[cat]) categories[cat] = [];
		categories[cat].push(name);
	}

	return categories as Record<ToolCategory, string[]>;
}

export function getAllToolInfo(): { name: string; category: ToolCategory; description: string; isReadOnly: boolean; isDestructive: boolean }[] {
	const infos: { name: string; category: ToolCategory; description: string; isReadOnly: boolean; isDestructive: boolean }[] = [];

	for (const [name, def] of Object.entries(ALL_TOOLS)) {
		const meta = getToolMeta(def);
		const desc = (def as any)?.description ?? "";
		infos.push({
			name,
			category: meta?.category ?? "runtime",
			description: typeof desc === "string" ? desc : "",
			isReadOnly: meta?.isReadOnly ?? true,
			isDestructive: meta?.isDestructive ?? false,
		});
	}

	return infos;
}

export function buildToolPolicyDescription(
	policy: { autoApprove?: string[]; blockedTools?: string[]; readScope?: string },
): string {
	const autoApprove = new Set(policy.autoApprove ?? []);
	const blocked = new Set(policy.blockedTools ?? []);
	const allNames = Object.keys(ALL_TOOLS);
	const isAll = autoApprove.has("*");

	const enabled = isAll
		? allNames.filter((n) => !blocked.has(n))
		: allNames.filter((n) => autoApprove.has(n));
	const disabled = isAll
		? []
		: allNames.filter((n) => !autoApprove.has(n) && !blocked.has(n));

	const lines: string[] = [];
	if (isAll) {
		lines.push(`All tools are enabled${blocked.size ? ` except: ${[...blocked].join(", ")}` : ""}.`);
	} else {
		lines.push(`Enabled tools: ${enabled.length ? enabled.join(", ") : "(none)"}`);
		if (disabled.length) lines.push(`Disabled tools: ${disabled.join(", ")}`);
	}

	if (policy.readScope === "workspace") {
		lines.push("Read tools (read, grep, find) are restricted to the workspace directory only.");
	} else {
		lines.push("Read tools (read, grep, find) can access the entire filesystem.");
	}
	lines.push("Write/edit/delete tools (write, edit, bash) are always restricted to the workspace directory.");

	return lines.join("\n");
}
