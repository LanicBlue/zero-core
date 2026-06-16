// Zero 全局管理工具集 (v0.8 M0)
//
// # 文件说明书
//
// ## 核心功能
// 给 zero 全局管理角色提供对话式 workflow 搭建能力 (RFC §2.14 / 决策 24):
//   - CreateProject / UpdateProject / DeleteProject / ListProjects
//   - CreateAgent / UpdateAgent / DeleteAgent / ListAgents
//   - InstantiatePreset (从 role-presets 一键实例化全局角色 + 接好 toolPolicy)
//   - ListPresets
//   - SetToolPolicy / SetToolEnabled
//   - ExposeAgentAsTool / UnexposeAgentAsTool
//   - CreateCron / UpdateCron / DeleteCron / ListCrons (M1 — first-class cron)
//
// ## 输入
// - ToolExecutionContext.zeroAdmin (ZeroAdminService 实例,只在 zero session 注入)
//
// ## 输出
// - 工具定义集合 (export const ZERO_ADMIN_TOOLS)
//
// ## 定位
// Runtime 工具,被 agent-loop 的 buildTools 拉入(经 ZERO_ADMIN_TOOLS 注入
// ALL_TOOLS 或通过专用合并路径)。条件门控:仅当 ctx.zeroAdmin 存在才启用。
//
// ## 依赖
// - zod
// - ./tool-factory
// - ../../server/zero-admin-service (经 ctx.zeroAdmin)
//
// ## 维护规则
// - 工具 fail-soft:错误返回字符串而非抛出,让 LLM 看到反馈
// - 工具 schema 简洁,描述清楚每个工具用途
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const admin = (ctx: any) => {
	const a = ctx?.zeroAdmin;
	if (!a) throw new Error("zero-admin tools require ctx.zeroAdmin (zero session only)");
	return a as import("../../server/zero-admin-service.js").ZeroAdminService;
};

const safe = async (fn: () => any): Promise<string> => {
	try {
		const result = await fn();
		return typeof result === "string" ? result : JSON.stringify(result);
	} catch (err: any) {
		return `Error: ${err.message ?? String(err)}`;
	}
};

// ---------------------------------------------------------------------------
// Project tools
// ---------------------------------------------------------------------------

export const createProjectTool = buildTool({
	name: "CreateProject",
	description: "Create a Project bound to a normalized workspace directory. One workspaceDir can only bind one Project.",
	prompt: "Create a Project. Inputs: name (string), workspaceDir (absolute path, will be normalized via resolve + realpath). Returns the created ProjectRecord.",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		name: z.string(),
		workspaceDir: z.string(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).createProject(input)),
});

export const updateProjectTool = buildTool({
	name: "UpdateProject",
	description: "Update a Project's metadata. workspaceDir is immutable after creation.",
	prompt: "Update a Project. Inputs: id, name? (workspaceDir cannot be changed).",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		id: z.string(),
		name: z.string().optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).updateProject(input.id, { name: input.name })),
});

export const deleteProjectTool = buildTool({
	name: "DeleteProject",
	description: "Delete a Project (metadata only — does NOT touch workspace files).",
	prompt: "Delete a Project by id. Workspace files are NOT deleted (Project is pure metadata).",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: true },
	inputSchema: z.object({
		id: z.string(),
	}),
	execute: async (input, ctx) => safe(async () => { admin(ctx).deleteProject(input.id); return { success: true }; }),
});

export const listProjectsTool = buildTool({
	name: "ListProjects",
	description: "List all Projects.",
	prompt: "List all Projects.",
	meta: { category: "zero-admin", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	inputSchema: z.object({}),
	execute: async (_input, ctx) => safe(() => admin(ctx).listProjects()),
});

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

export const createAgentTool = buildTool({
	name: "CreateAgent",
	description: "Create a global Agent with the given systemPrompt + toolPolicy + roleTag.",
	prompt: "Create a global agent. Inputs: name, systemPrompt?, toolPolicy?, roleTag?.",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		name: z.string(),
		systemPrompt: z.string().optional(),
		roleTag: z.string().optional(),
		toolPolicy: z.record(z.string(), z.any()).optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).createAgent(input as any)),
});

export const updateAgentTool = buildTool({
	name: "UpdateAgent",
	description: "Update an existing Agent's fields (systemPrompt, toolPolicy, roleTag, etc.).",
	prompt: "Update an agent by id.",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		id: z.string(),
		systemPrompt: z.string().optional(),
		roleTag: z.string().optional(),
		toolPolicy: z.record(z.string(), z.any()).optional(),
		name: z.string().optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).updateAgent(input.id, input as any)),
});

export const deleteAgentTool = buildTool({
	name: "DeleteAgent",
	description: "Delete an Agent and cascade-clean its agent-tool entries.",
	prompt: "Delete an agent by id. Its agent-tool entries are also removed.",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: true },
	inputSchema: z.object({
		id: z.string(),
	}),
	execute: async (input, ctx) => safe(async () => { admin(ctx).deleteAgent(input.id); return { success: true }; }),
});

export const listAgentsTool = buildTool({
	name: "ListAgents",
	description: "List all agents, optionally filtered by roleTag (lead/pm/archivist/analyzer/planner/developer/reviewer/qa/zero).",
	prompt: "List agents. Optional input: roleTag to filter.",
	meta: { category: "zero-admin", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	inputSchema: z.object({
		roleTag: z.string().optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).listAgents(input.roleTag)),
});

// ---------------------------------------------------------------------------
// Preset instantiation
// ---------------------------------------------------------------------------

export const instantiatePresetTool = buildTool({
	name: "InstantiatePreset",
	description: "Instantiate a role preset (lead/pm/archivist/analyzer-*/planner-*/developer/reviewer/qa/zero) as a global Agent, auto-wiring toolPolicy to whitelist the preset's callee roles.",
	prompt: "One-click instantiate a role preset. Inputs: presetId (e.g. 'lead', 'pm', 'analyzer-ui', 'planner-feature'), optional name override. Returns the created AgentRecord with toolPolicy wired.",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		presetId: z.string(),
		name: z.string().optional(),
		bindToolPolicy: z.boolean().optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).instantiatePreset(input.presetId, { name: input.name }, { bindToolPolicy: input.bindToolPolicy ?? true })),
});

export const listPresetsTool = buildTool({
	name: "ListPresets",
	description: "List available role presets (with M0 degradation notes).",
	prompt: "List role presets, optionally filtered by roleTag.",
	meta: { category: "zero-admin", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	inputSchema: z.object({
		roleTag: z.string().optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).listPresets(input.roleTag)),
});

// ---------------------------------------------------------------------------
// toolPolicy tools
// ---------------------------------------------------------------------------

export const setToolPolicyTool = buildTool({
	name: "SetToolPolicy",
	description: "Merge toolPolicy fields onto an agent. Existing fields not in patch are preserved; tools map is merged per-key.",
	prompt: "Set/merge toolPolicy on an agent. Inputs: agentId, patch (autoApprove?/blockedTools?/tools?/executionMode?/resultMaxTokens?/readScope?).",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		agentId: z.string(),
		patch: z.record(z.string(), z.any()),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).setToolPolicy(input.agentId, input.patch as any)),
});

export const setToolEnabledTool = buildTool({
	name: "SetToolEnabled",
	description: "Enable or disable a single tool on an agent by policy key (built-in name OR agent-tool entry id).",
	prompt: "Toggle a single tool. Inputs: agentId, key (built-in tool name or agent-tool entry id), enabled (bool).",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		agentId: z.string(),
		key: z.string(),
		enabled: z.boolean(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).setToolEnabled(input.agentId, input.key, input.enabled)),
});

// ---------------------------------------------------------------------------
// expose-as-tool
// ---------------------------------------------------------------------------

export const exposeAgentAsToolTool = buildTool({
	name: "ExposeAgentAsTool",
	description: "Expose an agent as an internal agent-tool so other agents can call it. Idempotent: if already exposed, updates settings.",
	prompt: "Expose an agent as a callable agent-tool. Inputs: agentId, name? (tool name, defaults to kebab of agent name), description?, enabled? (default true), blocking? (default true).",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		agentId: z.string(),
		name: z.string().optional(),
		description: z.string().optional(),
		enabled: z.boolean().optional(),
		blocking: z.boolean().optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).exposeAgentAsTool(input.agentId, input)),
});

export const unexposeAgentAsToolTool = buildTool({
	name: "UnexposeAgentAsTool",
	description: "Stop exposing an agent as a tool (deletes its internal AgentToolEntry).",
	prompt: "Un-expose an agent. Input: agentId.",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: true },
	inputSchema: z.object({
		agentId: z.string(),
	}),
	execute: async (input, ctx) => safe(async () => { admin(ctx).unexposeAgentAsTool(input.agentId); return { success: true }; }),
});

// ---------------------------------------------------------------------------
// Cron management tools (v0.8 M1 — first-class cron entity)
// ---------------------------------------------------------------------------

export const createCronTool = buildTool({
	name: "CreateCron",
	description: "Create a cron entry: schedules a global agent to run on a recurring cadence against a workingScope (RFC §4.3). One agent can carry N cron entries (one per scope). schedule ∈ off|hourly|daily|weekly|<ms>. projectId is optional — omit it for a global observation cron.",
	prompt: "Create a cron entry. Inputs: agentId, workingScope { projectId?, workspaceDir, wikiRootNodeId }, schedule, prompt?, enabled? (default true).",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		agentId: z.string(),
		workingScope: z.object({
			projectId: z.string().optional(),
			workspaceDir: z.string(),
			wikiRootNodeId: z.string(),
		}),
		schedule: z.string(),
		prompt: z.string().optional(),
		enabled: z.boolean().optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).createCron(input)),
});

export const updateCronTool = buildTool({
	name: "UpdateCron",
	description: "Update an existing cron entry's scope / schedule / prompt / enabled. agentId is immutable.",
	prompt: "Update a cron by id. Inputs: id, workingScope?, schedule?, prompt?, enabled?.",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
	inputSchema: z.object({
		id: z.string(),
		workingScope: z.object({
			projectId: z.string().optional(),
			workspaceDir: z.string(),
			wikiRootNodeId: z.string(),
		}).optional(),
		schedule: z.string().optional(),
		prompt: z.string().optional(),
		enabled: z.boolean().optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).updateCron(input.id, input)),
});

export const deleteCronTool = buildTool({
	name: "DeleteCron",
	description: "Delete a cron entry. This is an unbind — the global agent it referenced stays intact (not a cascade delete).",
	prompt: "Delete a cron by id. The agent it referenced is NOT deleted.",
	meta: { category: "zero-admin", isReadOnly: false, isConcurrencySafe: false, isDestructive: true },
	inputSchema: z.object({
		id: z.string(),
	}),
	execute: async (input, ctx) => safe(async () => { admin(ctx).deleteCron(input.id); return { success: true }; }),
});

export const listCronsTool = buildTool({
	name: "ListCrons",
	description: "List cron entries, optionally filtered by agentId.",
	prompt: "List crons. Optional input: agentId to filter.",
	meta: { category: "zero-admin", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	inputSchema: z.object({
		agentId: z.string().optional(),
	}),
	execute: async (input, ctx) => safe(() => admin(ctx).listCrons(input.agentId ? { agentId: input.agentId } : undefined)),
});

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

export const ZERO_ADMIN_TOOLS: Record<string, any> = {
	CreateProject: createProjectTool,
	UpdateProject: updateProjectTool,
	DeleteProject: deleteProjectTool,
	ListProjects: listProjectsTool,
	CreateAgent: createAgentTool,
	UpdateAgent: updateAgentTool,
	DeleteAgent: deleteAgentTool,
	ListAgents: listAgentsTool,
	InstantiatePreset: instantiatePresetTool,
	ListPresets: listPresetsTool,
	SetToolPolicy: setToolPolicyTool,
	SetToolEnabled: setToolEnabledTool,
	ExposeAgentAsTool: exposeAgentAsToolTool,
	UnexposeAgentAsTool: unexposeAgentAsToolTool,
	CreateCron: createCronTool,
	UpdateCron: updateCronTool,
	DeleteCron: deleteCronTool,
	ListCrons: listCronsTool,
};
