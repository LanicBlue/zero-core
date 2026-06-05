// 工具模块入口
//
// # 文件说明书
//
// ## 核心功能
// 导出所有工具和工具相关函数，提供统一的工具访问点。
//
// ## 输入
// 无 - 模块入口文件。
//
// ## 输出
// - ALL_TOOLS - 所有工具列表
// - buildToolsSet - 构建工具集
//
// ## 定位
// 工具模块入口，被 agent-loop 和其他模块使用。
//
// ## 依赖
// - ai - AI SDK
// - zod - 数据验证
// - ./ - 各个工具模块
//
// ## 维护规则
// - 新增工具时需在此导出
// - 保持工具列表完整
//
import { tool } from "ai";
import { z } from "zod";
import type { ToolExecutionContext } from "../types.js";
import { bashTool } from "./bash.js";
import { fileReadTool } from "./file-read.js";
import { fileWriteTool } from "./file-write.js";
import { fileEditTool } from "./file-edit.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { delegateTool } from "./agent.js";
import { taskStatusTool } from "./task-status.js";
import { taskListTool } from "./task-list.js";
import { taskStopTool } from "./task-stop.js";
import { waitTool } from "./wait.js";
import { buildMcpTools } from "./mcp-tool.js";
import { webSearchTool } from "./web-search.js";
import { askUserTool } from "./ask-user.js";
import { todoWriteTool } from "./todo-write.js";
import { getToolMeta, getToolName, getToolConfigSchema, getToolDescription, getToolPrompt, getToolInputFields, getToolExecute } from "./tool-factory.js";
import { webFetchTool } from "../mcp-tools/fetch-tools.js";
import { memoryReadTool, memoryWriteTool } from "../mcp-tools/memory-tools.js";
import { sequentialThinkingTool } from "../mcp-tools/sequential-thinking-tools.js";
import { createAssistantTools } from "../mcp-tools/assistant-tools.js";
import { type ToolRegistry, RENAMED_TOOLS } from "../../core/tool-registry.js";
import type { ToolCategory } from "./tool-factory.js";

// Built-in tools (assistant needs getAppVersion, so lazy init)
let _assistantTools: Record<string, any> | null = null;
function getAssistantTools(): Record<string, any> {
	if (!_assistantTools) {
		_assistantTools = createAssistantTools();
	}
	return _assistantTools;
}

export const ALL_TOOLS: Record<string, any> = {
	Bash: bashTool,
	Read: fileReadTool,
	Write: fileWriteTool,
	Edit: fileEditTool,
	Grep: grepTool,
	Glob: globTool,
	Agent: delegateTool,
	TaskStatus: taskStatusTool,
	TaskList: taskListTool,
	TaskStop: taskStopTool,
	Wait: waitTool,
	WebSearch: webSearchTool,
	AskUser: askUserTool,
	TodoWrite: todoWriteTool,
	WebFetch: webFetchTool,
	MemoryRead: memoryReadTool,
	MemoryWrite: memoryWriteTool,
	SequentialThinking: sequentialThinkingTool,

	...getAssistantTools(),
};

// Tools that require special context capabilities
const CONDITIONAL_TOOLS: Record<string, (ctx: ToolExecutionContext) => boolean> = {
	Agent: (ctx) => !!ctx.delegateTask,
	TaskStatus: (ctx) => !!ctx.getTaskResult,
	TaskList: (ctx) => !!ctx.listTasks,
	TaskStop: (ctx) => !!ctx.stopTask,
	Wait: (ctx) => !!ctx.suspendUntilWake,
};





// ---------------------------------------------------------------------------
// Runtime tool registration into ToolRegistry
// ---------------------------------------------------------------------------

export function registerRuntimeTools(registry: ToolRegistry): void {
	for (const [name, def] of Object.entries(ALL_TOOLS)) {
		const meta = getToolMeta(def);
		const configSchema = getToolConfigSchema(def);
		const description = getToolDescription(def) ?? "";
		const prompt = getToolPrompt(def);
		registry.register({
			name,
			description,
			prompt: prompt ?? description,
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
	// Migrate legacy lowercase tool keys to PascalCase
	if (policy.tools) {
		const migrated: Record<string, { enabled: boolean }> = {};
		for (const [key, val] of Object.entries(policy.tools)) {
			migrated[RENAMED_TOOLS[key] ?? key] = val;
		}
		policy.tools = migrated;
	}

	const blocked = new Set(policy.blockedTools ?? []);

	// Tools enabled by default — core filesystem/shell tools only
	const DEFAULT_ENABLED = new Set(["Bash", "Read", "Write", "Edit", "Grep", "Glob"]);

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

	// Config injection into descriptions is now handled by ToolRegistry.getAll()
	// via buildEffectiveDescription() - UI and runtime see the same prompt.

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
		lines.push("Read tools (Read, Grep, Glob) are restricted to the workspace directory only.");
	} else {
		lines.push("Read tools (Read, Grep, Glob) can access the entire filesystem.");
	}
	lines.push("Write/edit/delete tools (Write, Edit, Bash) are always restricted to the workspace directory.");

	return lines.join("\n");
}
