import { tool } from "ai";
import { z } from "zod";
import type { ToolExecutionContext } from "../types.js";
import { bashTool } from "./bash.js";
import { fileReadTool } from "./file-read.js";
import { fileWriteTool } from "./file-write.js";
import { fileEditTool } from "./file-edit.js";
import { grepTool } from "./grep.js";
import { findTool } from "./find.js";
import { delegateTool } from "./agent.js";
import { taskStatusTool } from "./task-status.js";
import { taskListTool } from "./task-list.js";
import { taskStopTool } from "./task-stop.js";
import { waitTool } from "./wait.js";
import { buildMcpTools } from "./mcp-tool.js";
import { webSearchTool } from "./web-search.js";
import { askUserTool } from "./ask-user.js";
import { todoWriteTool } from "./todo-write.js";
import { getToolMeta, getToolName, getToolConfigSchema, getToolUserDescription } from "./tool-factory.js";
import { createFetchTools } from "../../server/mcp-servers/fetch-tools.js";
import { createMemoryTools } from "../../server/mcp-servers/memory-tools.js";
import { createSequentialThinkingTools } from "../../server/mcp-servers/sequential-thinking-tools.js";
import { createAssistantTools } from "../../server/mcp-servers/assistant-tools.js";
import { toolRegistry } from "../../core/tool-registry.js";
import type { ToolCategory } from "./tool-factory.js";

// Built-in tools (initialized lazily)
let _builtinTools: Record<string, any> | null = null;
function getBuiltinTools(): Record<string, any> {
	if (!_builtinTools) {
		_builtinTools = {
			...createFetchTools(),
			...createMemoryTools(),
			...createSequentialThinkingTools(),
			...createAssistantTools(),
		};
	}
	return _builtinTools;
}

const ALL_TOOLS: Record<string, any> = {
	bash: bashTool,
	read: fileReadTool,
	write: fileWriteTool,
	edit: fileEditTool,
	grep: grepTool,
	find: findTool,
	agent: delegateTool,
	task_status: taskStatusTool,
	task_list: taskListTool,
	task_stop: taskStopTool,
	wait: waitTool,
	web_search: webSearchTool,
	ask_user: askUserTool,
	todo_write: todoWriteTool,
	
	...getBuiltinTools(),
};

// Tools that require special context capabilities
const CONDITIONAL_TOOLS: Record<string, (ctx: ToolExecutionContext) => boolean> = {
	agent: (ctx) => !!ctx.delegateTask,
	task_status: (ctx) => !!ctx.getTaskResult,
	task_list: (ctx) => !!ctx.listTasks,
	task_stop: (ctx) => !!ctx.stopTask,
	wait: (ctx) => !!ctx.suspendUntilWake,
};




// ---------------------------------------------------------------------------
// Runtime tool registration into ToolRegistry
// ---------------------------------------------------------------------------

export function registerRuntimeTools(): void {
	for (const [name, def] of Object.entries(ALL_TOOLS)) {
		const meta = getToolMeta(def);
		const configSchema = getToolConfigSchema(def);
		const userDescription = getToolUserDescription(def);
		const desc = (def as any)?.description ?? "";
		toolRegistry.register({
			name,
			description: typeof desc === "string" ? desc : "",
			userDescription,
			category: meta?.category ?? "runtime",
			source: "runtime",
			configSchema,
			meta: {
				isReadOnly: meta?.isReadOnly ?? true,
				isDestructive: meta?.isDestructive ?? false,
				isConcurrencySafe: meta?.isConcurrencySafe ?? true,
				requiresConfirmation: meta?.requiresConfirmation ?? false,
			},
		});
	}
}

export function buildToolsSet(
	policy: {
		autoApprove?: string[];
		blockedTools?: string[];
		tools?: Record<string, { enabled: boolean }>;
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
	},
	context: ToolExecutionContext,
	mcpTools?: Record<string, any>,
	agentTools?: Record<string, any>,
): Record<string, any> {
	const blocked = new Set(policy.blockedTools ?? []);

	// Tools enabled by default — core filesystem/shell tools only
	const DEFAULT_ENABLED = new Set(["bash", "read", "write", "edit", "grep", "find"]);

	// Determine enabled check: prefer tools map, fall back to autoApprove
	const toolsMap = policy.tools;
	const autoApprove = new Set(policy.autoApprove ?? []);
	const isEnabled = (name: string): boolean => {
		// Explicit tools map takes priority
		if (toolsMap) {
			if (name in toolsMap) return toolsMap[name].enabled;
			return DEFAULT_ENABLED.has(name);
		}
		// Legacy autoApprove
		if (autoApprove.has("*")) return true;
		if (autoApprove.size > 0) return autoApprove.has(name);
		// No config — basic tools only
		return DEFAULT_ENABLED.has(name);
	};

	const tools: Record<string, any> = {};

	for (const [name, def] of Object.entries(ALL_TOOLS)) {
		if (blocked.has(name)) continue;

		// Check conditional tools
		const condition = CONDITIONAL_TOOLS[name];
		if (condition && !condition(context)) continue;

		if (isEnabled(name)) {
			tools[name] = def;
		}
	}

	// Merge MCP tools
	if (mcpTools) {
		for (const [name, def] of Object.entries(mcpTools)) {
			if (blocked.has(name)) continue;
			if (isEnabled(name)) {
				tools[name] = def;
			}
		}
	}

	// Merge agent tools
	if (agentTools) {
		for (const [name, def] of Object.entries(agentTools)) {
			if (blocked.has(name)) continue;
			if (isEnabled(name)) {
				tools[name] = def;
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
