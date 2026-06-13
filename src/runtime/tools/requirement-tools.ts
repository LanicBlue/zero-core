// 需求工具
//
// # 文件说明书
//
// ## 核心功能
// 提供需求创建工具，用于 Analyst Agent 发现问题后记录到需求池。
//
// ## 输入
// - ToolExecutionContext（需包含 requirementStore + projectId）
//
// ## 输出
// - CreateRequirement — 创建需求记录
//
// ## 定位
// Runtime 工具，被工作流 Agent 调用。
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
