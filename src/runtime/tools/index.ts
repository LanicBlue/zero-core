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
import { getToolMeta, getToolConfigSchema, getToolDescription, getToolPrompt, getToolInputFields, getToolExecute } from "./tool-factory.js";
import { webFetchTool } from "../mcp-tools/fetch-tools.js";
import { sequentialThinkingTool } from "../mcp-tools/sequential-thinking-tools.js";
import { createPlatformTools } from "../mcp-tools/platform-tools.js";
import { createRequirementTool, createRequirementWithDocTool } from "./requirement-tools.js";
import { orchestrateTool } from "./orchestrate-tool.js";
// v0.8 (P3 §7.3): the four domain action tools + verify, replacing the retired
// zero-admin-tools.ts (CreateProject/CreateAgent/.../InstantiatePreset/SetToolPolicy/...).
import { projectTool } from "./project-tool.js";
import { agentTool } from "./agent-tool.js";
import { cronTool } from "./cron-tool.js";
import { wikiTool } from "./wiki-tool.js";
import { verifyTool } from "./verify-tool.js";
import { type ToolRegistry, RENAMED_TOOLS } from "../../core/tool-registry.js";
import type { ToolCategory } from "./tool-factory.js";

// Built-in tools (platform tool needs getAppVersion, so lazy init)
let _platformTools: Record<string, any> | null = null;
function getPlatformTools(): Record<string, any> {
	if (!_platformTools) {
		_platformTools = createPlatformTools();
	}
	return _platformTools;
}

export const ALL_TOOLS: Record<string, any> = {
	Shell: bashTool,
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
	// v0.8 (P2 §11.6): MemoryRecall / MemoryNote tools removed — memory is
	// now a wiki per-agent subtree; agents read it via the Wiki action tool
	// (expand/read/upsert/search) and search via the wiki tree. The legacy
	// MemoryNodeStore-backed tools are retired.
	SequentialThinking: sequentialThinkingTool,
	CreateRequirement: createRequirementTool,
	// v0.8 (M4): PM-only tool — creates a requirement + repo doc + discuss
	// landing in one shot (PmService.createRequirementWithDoc).
	CreateRequirementWithDoc: createRequirementWithDocTool,
	Orchestrate: orchestrateTool,
	// v0.8 (P3 §7.3): four action-switched domain tools (Project/AgentRegistry/
	// Cron/Wiki) + the lead verify tool, replacing the retired zero-admin tools
	// (CreateProject/CreateAgent/.../InstantiatePreset/SetToolPolicy/...).
	// Capability lives in tools; agents are just tool-config bundles.
	// Note: the management tool is named `AgentRegistry` (not `Agent`) to avoid
	// collision with the long-existing `Agent` sub-agent delegation tool.
	Project: projectTool,
	AgentRegistry: agentTool,
	Cron: cronTool,
	Wiki: wikiTool,
	verify: verifyTool,

	...getPlatformTools(),
};

// Tools that require special context capabilities
const CONDITIONAL_TOOLS: Record<string, (ctx: ToolExecutionContext) => boolean> = {
	Agent: (ctx) => !!ctx.delegateTask,
	TaskStatus: (ctx) => !!ctx.getTaskResult,
	TaskList: (ctx) => !!ctx.listTasks,
	TaskStop: (ctx) => !!ctx.stopTask,
	Wait: (ctx) => !!ctx.suspendUntilWake,
	CreateRequirement: (ctx) => !!ctx.requirementStore,
	// v0.8 (M4): PM-only — gated on ctx.pmService (only PM sessions carry it).
	CreateRequirementWithDoc: (ctx) => !!(ctx as any).pmService,
	Orchestrate: (ctx) => !!ctx.delegateTask,
	// v0.8 (P3): domain action tools. Project/AgentRegistry/Cron need the
	// management service handle (zero sessions only). Wiki needs the wiki
	// store (every project-role session). verify needs delegate + requirement
	// store (lead).
	Project: (ctx) => !!(ctx as any).management,
	AgentRegistry: (ctx) => !!(ctx as any).management,
	Cron: (ctx) => !!(ctx as any).management,
	Wiki: (ctx) => !!ctx.wikiStore,
	verify: (ctx) => !!ctx.delegateTask && !!ctx.requirementStore,
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
): Record<string, any> {
	context.toolPolicy = policy;

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
	const DEFAULT_ENABLED = new Set(["Shell", "Read", "Write", "Edit", "Grep", "Glob"]);

	// Determine enabled check: prefer tools map, fall back to autoApprove.
	// v0.8 (delegation refactor): the tools map gates built-in (hard-coded)
	// tools. Subagent delegation is the single `Agent` action tool (in
	// ALL_TOOLS, gated like any built-in) — there is no separate per-subagent
	// tool channel anymore.
	const toolsMap = policy.tools;
	const autoApprove = new Set(policy.autoApprove ?? []);
	const isEnabled = (name: string): boolean => {
		if (toolsMap) {
			if (name in toolsMap) return toolsMap[name].enabled;
			return DEFAULT_ENABLED.has(name);
		}
		if (autoApprove.has("*")) return true;
		if (autoApprove.size > 0) return autoApprove.has(name);
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

	// Merge MCP tools (always enabled unless blocked)
	if (mcpTools) {
		for (const [name, def] of Object.entries(mcpTools)) {
			if (blocked.has(name)) continue;
			tools[name] = def;
		}
	}

	// v0.8 (delegation refactor): subagent delegation is the single
	// action-based `Agent` tool (already in ALL_TOOLS) — no per-subagent tools
	// to merge here anymore.

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
