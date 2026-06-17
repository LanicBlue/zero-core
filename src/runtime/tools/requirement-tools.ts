// 需求工具
//
// # 文件说明书
//
// ## 核心功能
// 提供两类需求创建工具:
//   - CreateRequirement          —— Analyst 发现后写裸 record (status=found)
//   - CreateRequirementWithDoc   —— (M4) PM 创建需求 + 写需求文档 + 绑定 docPath
//     + 落看板 discuss 栏。调用 PmService.createRequirementWithDoc。
//
// ## 设计意图 (M4 修订)
// PM 发现完全由 PM agent 驱动: cron 只发 prompt 激活 PM session, PM 用本工具
// 自己决定怎么发现/调 analyzer/写需求文档/落 discuss。代码不自动 seed PM
// agent 或自动注册 cron (用户用 zero 角色手动创建)。
//
// ## 输入
// - ToolExecutionContext (需包含 pmService + projectId / contextBundle.projectId)
//
// ## 输出
// - CreateRequirement / CreateRequirementWithDoc
//
// ## 定位
// Runtime 工具,被工作流 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - ./tool-factory - 工具工厂
//
// ## 维护规则
// - 新增需求操作工具时在此添加
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";

// ---------------------------------------------------------------------------
// CreateRequirement — create a new requirement record
// ---------------------------------------------------------------------------

export const createRequirementTool = buildTool({
	name: "CreateRequirement",
	description: "Create a new requirement record. Use to log issues or improvements discovered during project analysis.",
	prompt: "Create a new requirement in the project's requirement pool.\n\n" +
		"Use when analysis reveals security vulnerabilities, performance issues, architecture improvements, or maintainability concerns.\n\n" +
		"Inputs:\n" +
		"- title (required) — concise requirement title\n" +
		"- description (required) — detailed description of the issue or improvement\n" +
		"- priority — 'low' | 'normal' | 'high' | 'critical' (default: 'normal')\n" +
		"  - critical: security vulnerabilities\n" +
		"  - high: performance issues\n" +
		"  - normal: architecture improvements\n" +
		"  - low: maintainability concerns\n" +
		"- impactScope — affected scope, e.g. 'payment module'",
	meta: { category: "agent", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },

	inputSchema: z.object({
		title: z.string().describe("Requirement title, concise and clear"),
		description: z.string().describe("Detailed requirement description"),
		priority: z.enum(["low", "normal", "high", "critical"])
			.default("normal").describe("Priority level"),
		impactScope: z.string().optional().describe("Impact scope, e.g. 'payment module'"),
	}),

	execute: async (input, ctx) => {
		if (!ctx.requirementStore || !ctx.projectId) {
			return "Error: Requirement context not available";
		}
		const req = ctx.requirementStore.create({
			projectId: ctx.projectId,
			title: input.title,
			description: input.description,
			status: "found",
			source: "analyst",
			priority: input.priority,
			impactScope: input.impactScope,
			reviewer: "analyst",
		});

		// High/critical priority notification hook point (M5)
		// Reserved for future notification system integration

		return `Requirement created: ${req.id}\nTitle: ${input.title}\nPriority: ${input.priority}`;
	},
});

// ---------------------------------------------------------------------------
// CreateRequirementWithDoc — (M4) PM creates a new requirement + doc + discuss
// ---------------------------------------------------------------------------

/**
 * PM-facing tool that creates a requirement bound to a repo doc and lands it
 * in the kanban 'discuss' column. Backed by PmService.createRequirementWithDoc
 * (decision 7/12/14/34): record (status=discuss) + repo doc at
 * `{workspace}/.zero/requirements/{projectId}/{id}.md` + docPath binding.
 *
 * Idempotent on (projectId, title): re-creating the same title is a no-op
 * (PM cron re-scan safety, decision 7).
 *
 * PM is agent-driven (M4 design): cron only sends the PM session a prompt;
 * whether/when/what to call this tool is PM's own decision. The platform only
 * ensures PM has this tool available + the analyzer agent-tool whitelisted.
 */
export const createRequirementWithDocTool = buildTool({
	name: "CreateRequirementWithDoc",
	description: "Create a new requirement bound to a requirement document and add it to the project's discuss column.",
	prompt: "Create a new requirement with a backing requirement document.\n\n" +
		"Use after a discovery finding (yours or from an analyzer agent-tool) is confirmed worth tracking. " +
		"Creates a RequirementRecord at status='discuss' AND writes a repo doc at " +
		"`{workspace}/.zero/requirements/{projectId}/{id}.md`, binding docPath on the record. " +
		"The new requirement immediately appears in the kanban 'discuss' column for user refinement.\n\n" +
		"Idempotent: if a requirement with the same title already exists in this project, returns the " +
		"existing one unchanged (safe to re-call on cron re-scans — never overwrites an existing doc).\n\n" +
		"Inputs:\n" +
		"- title (required) — concise, unique-within-project requirement title\n" +
		"- summary — one-line intent (also seeds the doc's Intent section)\n" +
		"- body — optional full markdown body for the doc (default template used if omitted)\n" +
		"- priority — 'low' | 'normal' | 'high' | 'critical' (default 'normal')",
	meta: { category: "agent", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },

	inputSchema: z.object({
		title: z.string().describe("Requirement title (unique within the project)"),
		summary: z.string().optional().describe("One-line intent summary; seeds the doc's Intent section"),
		body: z.string().optional().describe("Optional full markdown body for the requirement doc"),
		priority: z.enum(["low", "normal", "high", "critical"])
			.default("normal").describe("Priority level"),
	}),

	execute: async (input, ctx) => {
		const pm = ctx.pmService;
		// projectId comes from the session context bundle (project-role PM
		// session) or the legacy ctx.projectId field.
		const projectId = ctx.contextBundle?.projectId ?? ctx.projectId;
		if (!pm) {
			return "Error: PM service not available on this session (tool is PM-only)";
		}
		if (!projectId) {
			return "Error: projectId not available — this tool requires a project-scoped session";
		}
		try {
			const req = pm.createRequirementWithDoc({
				projectId,
				title: input.title,
				summary: input.summary,
				body: input.body,
				priority: input.priority,
				source: "pm",
			});
			return `Requirement created: ${req.id}\nTitle: ${req.title}\nStatus: ${req.status}\nDoc: ${req.docPath ?? "(none)"}`;
		} catch (err) {
			return `Create requirement failed: ${(err as Error).message}`;
		}
	},
});
