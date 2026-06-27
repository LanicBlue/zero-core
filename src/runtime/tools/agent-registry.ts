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
// - export const agentRegistryTool
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

/**
 * Compact agent summary for mutation/list results. The full record (incl. the
 * multi-KB systemPrompt) is only useful via `get` — dumping it on every
 * create/update floods the model's context. `get` still returns the full record.
 */
function summaryOf(a: any): any {
	return {
		id: a.id,
		name: a.name,
		model: a.model ?? null,
		provider: a.provider ?? null,
		workspaceDir: a.workspaceDir ?? null,
		thinkingLevel: a.thinkingLevel ?? null,
		subagents: a.subagents?.length ?? 0,
		wikiAnchors: a.wikiAnchors?.length ?? 0,
		updatedAt: a.updatedAt ?? null,
	};
}

/**
 * Compact template summary for listTemplates. The full template (incl. the
 * multi-KB systemPrompt + toolPolicy) is only useful via getTemplate.
 */
function templateSummaryOf(t: any): any {
	return {
		id: t.id,
		name: t.name,
		description: t.description,
		tags: t.tags ?? [],
		tools: t.toolPolicy?.tools ? Object.keys(t.toolPolicy.tools) : [],
		isBuiltIn: t.isBuiltIn ?? false,
	};
}

/** Throw a clear, actionable error for a missing required field. */
function requireField(value: unknown, field: string, action: string): void {
	if (value === undefined || value === null || value === "") {
		throw new Error(`${action} requires \`${field}\``);
	}
}

/**
 * Return the value, or throw a not-found error. Throwing (rather than returning
 * an `{error}` object) keeps the result style uniform across all actions —
 * safe() formats every failure as `"Error: …"`.
 */
function notFound<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
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
// Flat action schema
// ---------------------------------------------------------------------------
// NOTE: deliberately a FLAT z.object, not z.discriminatedUnion. LLM tool-calling
// protocols require a top-level `type: object` parameters schema; a top-level
// oneOf/discriminated union is dropped/mis-parsed by most providers (OpenAI/GLM/
// Anthropic), so the model calls the tool with `{}` and zod rejects it. The
// action enum still validates the discriminator; per-action required fields are
// enforced at runtime in execute (wrapped by `safe()`).

export const agentRegistryActionSchema = z.object({
	action: z.enum(["create", "update", "delete", "get", "list", "listTemplates", "getTemplate"]),
	// create
	name: z.string().optional(),
	/**
	 * Optional template id OR name (case-insensitive). On `create`, copies
	 * identity (systemPrompt/model/toolPolicy) from the template — replaces the
	 * retired InstantiatePreset tool. Use `listTemplates` to discover ids/names;
	 * id wins if a name is ambiguous.
	 */
	template: z.string().optional(),
	systemPrompt: z.string().optional(),
	model: z.string().optional(),
	provider: z.string().optional(),
	toolPolicy: toolPolicyShape.optional(),
	subagents: subagentsShape.optional(),
	wikiAnchors: wikiAnchorsShape.optional(),
	// update/delete/get
	id: z.string().optional(),
	// getTemplate
	templateId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const agentRegistryTool = buildTool({
	name: "AgentRegistry",
	description:
		"Manage global Agent records (the role identities). Action-switched: create/update/delete/get/list + listTemplates/getTemplate. (Distinct from the 'Agent' sub-agent delegation tool — this manages the registry of role agents.)",
	prompt:
		"Manage the global Agent registry via a single action-switched tool.\n\n" +
		"(Note: 'AgentRegistry' manages role-agent records. The separate 'Agent' tool delegates a task to a sub-agent — different capability.)\n\n" +
		"Actions:\n" +
		"- { action:'create', name, systemPrompt?, model?, provider?, toolPolicy?, subagents?, wikiAnchors? } — create a global agent from scratch. `name` is required.\n" +
		"- { action:'create', template, name?, model?, provider? } — instantiate a template. `template` accepts the id OR (case-insensitive) name from `listTemplates` (e.g. 'Coder' or its uuid). systemPrompt + toolPolicy come from the template; the optional `name`/`model`/`provider` override the template defaults (use `name` so each instance is distinguishable). Further customize via `update`.\n" +
		"- { action:'update', id, name?/systemPrompt?/model?/toolPolicy?/subagents?/wikiAnchors? } — single mutation surface. toolPolicy is MERGED (toggle one tool without wiping the rest: {toolPolicy:{tools:{WebSearch:{enabled:false}}}} only disables WebSearch); subagents/wikiAnchors are replaced wholesale. create/update/list return a compact summary — use `get` for full detail.\n" +
		"- { action:'delete', id } — delete. The 'zero' management agent is protected and cannot be deleted.\n" +
		"- { action:'get', id } — read one (full record).\n" +
		"- { action:'list' } — list all agents (compact summary).\n" +
		"- { action:'listTemplates' } — list ALL templates (built-in role identities like zero/lead/pm + user-created). Returns the SAME list the UI Templates page shows; compact summaries (id/name/description/tags/tools). Use getTemplate for the full systemPrompt.\n" +
		"- { action:'getTemplate', templateId } — read one template (full). Accepts id OR case-insensitive name.\n" +
		"Errors are uniform: any failure (not found, missing required field) returns `\"Error: …\"`.",
	meta: {
		category: "management",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},
	inputSchema: agentRegistryActionSchema,
	execute: async (input, ctx) =>
		safe(() => {
			const svc = mgmt(ctx);
			switch (input.action) {
				case "create": {
					if (input.template) {
						// Template path: systemPrompt + toolPolicy come from the
						// template (pure identity), but name/model/provider are
						// tunable overrides — the caller's `name` wins over the
						// template's default name so each instance is distinguishable.
						// `template` accepts the template's id OR (case-insensitive)
						// name; discover both via `listTemplates`.
						const created = svc.instantiateTemplate(input.template, {
							name: input.name,
							model: input.model,
							provider: input.provider,
						});
						return summaryOf(created);
					}
					requireField(input.name, "name", "create");
					const created = svc.createAgent({
						name: input.name,
						systemPrompt: input.systemPrompt,
						model: input.model,
						provider: input.provider,
						toolPolicy: input.toolPolicy as any,
						subagents: input.subagents,
						wikiAnchors: input.wikiAnchors,
					});
					return summaryOf(created);
				}
				case "update": {
					requireField(input.id, "id", "update");
					const patch: any = {};
					if (input.name !== undefined) patch.name = input.name;
					if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
					if (input.model !== undefined) patch.model = input.model;
					if (input.provider !== undefined) patch.provider = input.provider;
					// toolPolicy is MERGED (not replaced) inside updateAgent —
					// toggling one tool won't wipe the rest.
					if (input.toolPolicy !== undefined) patch.toolPolicy = input.toolPolicy;
					if (input.subagents !== undefined) patch.subagents = input.subagents;
					if (input.wikiAnchors !== undefined) patch.wikiAnchors = input.wikiAnchors;
					return summaryOf(svc.updateAgent(input.id, patch));
				}
				case "delete":
					requireField(input.id, "id", "delete");
					svc.deleteAgent(input.id);
					return { success: true };
				case "get":
					requireField(input.id, "id", "get");
					return notFound(svc.getAgent(input.id), `Agent not found: ${input.id}`);
				case "list": {
					// List returns a COMPACT summary (full systemPrompt/toolPolicy
					// would flood the result). Use `get` for full detail.
					return svc.listAgents().map(summaryOf);
				}
				case "listTemplates": {
					// Compact summary — full systemPrompt/toolPolicy via getTemplate.
					// Returns the SAME templates the UI Templates page shows (single
					// template concept after the v0.8 模板统一).
					return svc.listTemplates().map(templateSummaryOf);
				}
				case "getTemplate":
					requireField(input.templateId, "templateId", "getTemplate");
					return notFound(svc.getTemplate(input.templateId), `Template not found: ${input.templateId}`);
			}
		}),
});
