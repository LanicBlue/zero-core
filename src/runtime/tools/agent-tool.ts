// Agent action 工具 (v0.8 P3 — §7.3)
//
// # 文件说明书
//
// ## 核心功能
// "AgentRegistry" 是 v0.8 P3 四个判别联合 action 工具之一。一个工具 + action
// 字段切换 7 个操作 (§7.3):
//   - create         建 Agent。template 可选 → 从 role preset 拷身份 +
//                     toolPolicy + 接好 subagents (替代旧 InstantiatePreset)
//   - update         改 systemPrompt / toolPolicy / subagents / wikiAnchors /
//                     name / model (合并旧 SetToolPolicy / SetToolEnabled)
//   - delete         删 Agent(zero protected → reject)
//   - get            读一条 Agent
//   - list           列 Agent(可选 roleTag 过滤)
//   - listTemplates  列可用 role template(替代旧 ListPresets)
//   - getTemplate    读一条 template
//
// ## 命名 (§7.3 硬原则)
// 原 CreateAgent/UpdateAgent/.../InstantiatePreset/ListPresets/SetToolPolicy/
// SetToolEnabled 八个工具合并到此。能力在工具,zero agent 只是组合。
//
// ## 输入
// - ctx.management (ManagementService,只在 zero session 注入)
//
// ## 输出
// - export const agentTool
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { ManagementService } from "../../server/management-service.js";

function mgmt(ctx: any): ManagementService {
	const svc = ctx?.management;
	if (!svc) throw new Error("Agent tool requires ctx.management (zero session only)");
	return svc as ManagementService;
}

async function safe(fn: () => any): Promise<string> {
	try {
		const result = await fn();
		return typeof result === "string" ? result : JSON.stringify(result);
	} catch (err: any) {
		return `Error: ${err.message ?? String(err)}`;
	}
}

// ---------------------------------------------------------------------------
// Reusable shapes
// ---------------------------------------------------------------------------

const subagentsShape = z.array(
	z.object({
		agentId: z.string(),
		name: z.string().optional(),
		description: z.string().optional(),
	}),
);

const wikiAnchorsShape = z.array(
	z.object({
		nodeId: z.string(),
		inject: z.enum(["system", "context", "off"]),
		depth: z.number().optional(),
	}),
);

const toolPolicyShape = z.object({
	autoApprove: z.array(z.string()).optional(),
	blockedTools: z.array(z.string()).optional(),
	tools: z.record(z.string(), z.object({ enabled: z.boolean() })).optional(),
	executionMode: z.enum(["sequential", "parallel"]).optional(),
	resultMaxTokens: z.number().optional(),
	readScope: z.enum(["filesystem", "workspace"]).optional(),
});

// ---------------------------------------------------------------------------
// Discriminated-union schema
// ---------------------------------------------------------------------------

const agentActionSchema = z.discriminatedUnion("action", [
	// create — accepts a template (preset id) to copy identity from
	z.object({
		action: z.literal("create"),
		name: z.string(),
		systemPrompt: z.string().optional(),
		model: z.string().optional(),
		provider: z.string().optional(),
		/**
		 * Optional role template id (e.g. "lead"/"pm"/"archivist"). When
		 * set, the new agent's identity (systemPrompt / model / toolPolicy)
		 * is copied from the template — replaces the retired InstantiatePreset
		 * tool. Overrides (name/model/provider) still apply.
		 */
		template: z.string().optional(),
		toolPolicy: toolPolicyShape.optional(),
		subagents: subagentsShape.optional(),
		wikiAnchors: wikiAnchorsShape.optional(),
	}),
	// update — single mutation surface (consolidates SetToolPolicy/SetToolEnabled)
	z.object({
		action: z.literal("update"),
		id: z.string(),
		name: z.string().optional(),
		systemPrompt: z.string().optional(),
		model: z.string().optional(),
		provider: z.string().optional(),
		toolPolicy: toolPolicyShape.optional(),
		subagents: subagentsShape.optional(),
		wikiAnchors: wikiAnchorsShape.optional(),
	}),
	z.object({
		action: z.literal("delete"),
		id: z.string(),
	}),
	z.object({
		action: z.literal("get"),
		id: z.string(),
	}),
	z.object({
		action: z.literal("list"),
		roleTag: z.string().optional(),
	}),
	z.object({
		action: z.literal("listTemplates"),
		roleTag: z.string().optional(),
	}),
	z.object({
		action: z.literal("getTemplate"),
		templateId: z.string(),
	}),
]);

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const agentTool = buildTool({
	name: "AgentRegistry",
	description:
		"Manage global Agent records (the role identities). Action-switched: create/update/delete/get/list + listTemplates/getTemplate. (Distinct from the 'Agent' sub-agent delegation tool — this manages the registry of role agents.)",
	prompt:
		"Manage the global Agent registry via a single action-switched tool.\n\n" +
		"(Note: 'AgentRegistry' manages role-agent records. The separate 'Agent' tool delegates a task to a sub-agent — different capability.)\n\n" +
		"Actions:\n" +
		"- { action:'create', name, systemPrompt?, model?, template?, toolPolicy?, subagents?, wikiAnchors? } — create a global agent. `template` (e.g. 'lead'/'pm'/'archivist') copies the role preset's identity+toolPolicy (replaces InstantiatePreset).\n" +
		"- { action:'update', id, name?/systemPrompt?/model?/toolPolicy?/subagents?/wikiAnchors? } — single mutation surface. Set/merge toolPolicy here (replaces SetToolPolicy/SetToolEnabled).\n" +
		"- { action:'delete', id } — delete. The 'zero' management agent is protected and cannot be deleted.\n" +
		"- { action:'get', id } — read one.\n" +
		"- { action:'list', roleTag? } — list, optionally filtered by roleTag.\n" +
		"- { action:'listTemplates', roleTag? } — list available role templates (presets).\n" +
		"- { action:'getTemplate', templateId } — read one template.",
	meta: {
		category: "management",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},
	inputSchema: agentActionSchema,
	execute: async (input, ctx) =>
		safe(() => {
			const svc = mgmt(ctx);
			switch (input.action) {
				case "create": {
					if (input.template) {
						// Template path replaces InstantiatePreset.
						return svc.instantiateTemplate(
							input.template,
							{
								name: input.name,
								model: input.model,
								provider: input.provider,
							},
							{ bindToolPolicy: true },
						);
					}
					return svc.createAgent({
						name: input.name,
						systemPrompt: input.systemPrompt,
						model: input.model,
						provider: input.provider,
						toolPolicy: input.toolPolicy as any,
						subagents: input.subagents,
						wikiAnchors: input.wikiAnchors,
					});
				}
				case "update": {
					const patch: any = {};
					if (input.name !== undefined) patch.name = input.name;
					if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
					if (input.model !== undefined) patch.model = input.model;
					if (input.provider !== undefined) patch.provider = input.provider;
					if (input.toolPolicy !== undefined) patch.toolPolicy = input.toolPolicy;
					if (input.subagents !== undefined) patch.subagents = input.subagents;
					if (input.wikiAnchors !== undefined) patch.wikiAnchors = input.wikiAnchors;
					return svc.updateAgent(input.id, patch);
				}
				case "delete":
					svc.deleteAgent(input.id);
					return { success: true };
				case "get":
					return svc.getAgent(input.id) ?? { error: `Agent not found: ${input.id}` };
				case "list":
					return svc.listAgents(input.roleTag);
				case "listTemplates":
					return svc.listTemplates(input.roleTag);
				case "getTemplate":
					return svc.getTemplate(input.templateId) ?? { error: `Template not found: ${input.templateId}` };
			}
		}),
});
