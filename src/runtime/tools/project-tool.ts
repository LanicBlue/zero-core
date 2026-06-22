// Project action 工具 (v0.8 P5 — §8.2)
//
// # 文件说明书
//
// ## 核心功能
// "Project" 是 v0.8 P3 的四个判别联合 action 工具之一。一个工具 + action
// 字段切换 5 个操作 (§8.2):
//   - create  同步建 ProjectRecord + ensureProjectSubtree(空根) + 异步 kick
//             archivist 渐进扫描(§8.3,P5 接入;扫描两阶段完整逻辑在 P1/P7)
//   - update  改 name (workspaceDir immutable)
//   - delete  metadata-only delete(workspace files 不动)
//   - get     读元数据。includeContext=true → 容器视图聚合(§8.4,P5):
//             requirementsByStatus + crons + wikiSummary + activeSessions
//   - list    列所有 Project
//
// ## 命名 (§7.3 硬原则)
// 工具按功能命名 → `Project`;能力在工具,zero agent 只是持有它的组合。
// 原 CreateProject/UpdateProject/.../ListProjects 五个分散工具合并到此。
//
// ## 输入
// - ctx.management (ManagementService,只在 zero session 注入)
//
// ## 输出
// - export const projectTool
//
// ## 定位
// Runtime 工具,被 agent-loop buildTools 通过 DOMAIN_TOOLS 拉入。
// 条件门控:仅当 ctx.management 存在才启用。
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { ManagementService } from "../../server/management-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mgmt(ctx: any): ManagementService {
	const svc = ctx?.management;
	if (!svc) throw new Error("Project tool requires ctx.management (zero session only)");
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
// Flat action schema — one tool, five actions
// ---------------------------------------------------------------------------
// NOTE: deliberately a FLAT z.object (not z.discriminatedUnion). LLM tool-calling
// protocols (OpenAI/GLM/Anthropic function-calling) require the top-level
// parameters schema to be `type: object`; a top-level `oneOf`/discriminated
// union is dropped or mis-parsed by most providers, so the model calls the tool
// with `{}` and zod then rejects it ("Invalid discriminator value"). The action
// enum still validates the discriminator; per-action required fields are checked
// at runtime in execute (wrapped by `safe()`).

export const projectActionSchema = z.object({
	action: z.enum(["create", "update", "delete", "get", "list"]),
	name: z.string().optional(),
	workspaceDir: z.string().optional(),
	id: z.string().optional(),
	/**
	 * v0.8 P5 §8.2 / §8.4: container view toggle for `get`. `false` (default) →
	 * pure metadata; `true` → aggregated container view
	 * (requirementsByStatus + crons + wikiSummary + activeSessions).
	 */
	includeContext: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const projectTool = buildTool({
	name: "Project",
	description:
		"Manage Project records (the workspace→platform binding). Action-switched tool: create/update/delete/get/list.",
	prompt:
		"Manage Projects via a single action-switched tool.\n\n" +
		"Actions:\n" +
		"- { action:'create', name, workspaceDir } — bind a workspace dir to a Project. One workspaceDir → one Project. Side-effects: synchronously creates an empty wiki subtree root + asynchronously kicks an archivist background scan (§8.3).\n" +
		"- { action:'update', id, name? } — rename. workspaceDir is immutable.\n" +
		"- { action:'delete', id } — metadata-only delete (workspace files untouched).\n" +
		"- { action:'get', id, includeContext? } — read one Project. includeContext=true returns the container view (§8.4: requirementsByStatus + crons + wikiSummary + activeSessions). Default returns metadata only.\n" +
		"- { action:'list' } — list all Projects.",
	meta: {
		category: "management",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},
	inputSchema: projectActionSchema,
	execute: async (input, ctx) =>
		safe(() => {
			const svc = mgmt(ctx);
			switch (input.action) {
				case "create":
					return svc.createProject({ name: input.name, workspaceDir: input.workspaceDir });
				case "update":
					return svc.updateProject(input.id, { name: input.name });
				case "delete":
					svc.deleteProject(input.id);
					return { success: true };
				case "get":
					if (input.includeContext) {
						return svc.getProjectContainerView(input.id);
					}
					return svc.getProject(input.id) ?? { error: `Project not found: ${input.id}` };
				case "list":
					return svc.listProjects();
			}
		}),
});
