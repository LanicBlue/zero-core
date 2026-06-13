// 编排器工具
//
// # 文件说明书
//
// ## 核心功能
// Lead Agent 通过此工具调度 sub-agent（Developer/Reviewer/QA）执行任务。
// 创建 TaskStepRecord 记录执行步骤，收集结果后返回摘要。
//
// ## 输入
// - role — sub-agent 角色 (developer/reviewer/qa)
// - task — 具体任务描述
// - wikiNodes — 可选，需要展开的 Wiki 节点路径
// - relatedFiles — 可选，相关文件路径列表
//
// ## 输出
// 执行结果摘要字符串
//
// ## 定位
// Runtime 工具，被 Lead Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - ./tool-factory - 工具工厂
// - ../agent-roles - 角色配置
//
// ## 维护规则
// - 变更执行流程时注意错误处理完整性
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import { getRoleConfig } from "../agent-roles.js";

// ---------------------------------------------------------------------------
// Orchestrate — dispatch sub-agent to execute a task
// ---------------------------------------------------------------------------

export const orchestrateTool = buildTool({
	name: "Orchestrate",
	description: "调度子 Agent 执行任务。通过此工具间接管理 Developer、Reviewer、QA。",
	prompt: "Dispatch a sub-agent to execute a specific task.\n\n" +
		"Use to delegate work to Developer (implementation), Reviewer (code review), or QA (testing).\n\n" +
		"Inputs:\n" +
		"- role (required) — 'developer' | 'reviewer' | 'qa'\n" +
		"- task (required) — detailed task description including goals, requirements, and constraints\n" +
		"- wikiNodes (optional) — Wiki node paths to expand for sub-agent context\n" +
		"- relatedFiles (optional) — file paths relevant to this task\n\n" +
		"Returns: summary of sub-agent execution result.",
	meta: { category: "agent", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },

	inputSchema: z.object({
		role: z.enum(["developer", "reviewer", "qa"])
			.describe("Sub-agent role to dispatch"),
		task: z.string()
			.describe("Detailed task description including goals, requirements, and constraints"),
		wikiNodes: z.array(z.string()).optional()
			.describe("Wiki node paths to expand for sub-agent context"),
		relatedFiles: z.array(z.string()).optional()
			.describe("File paths relevant to this task"),
	}),

	execute: async (input, ctx) => {
		// 1. Validate context
		if (!ctx.createRoleLoop) {
			return "Error: Orchestrate not available in this context (no createRoleLoop)";
		}
		if (!ctx.activeRequirementId) {
			return "Error: Orchestrate not available in this context (no activeRequirementId)";
		}
		if (!ctx.projectId) {
			return "Error: Orchestrate not available in this context (no projectId)";
		}

		// Need taskStepStore — access via wikiStore's constructor pattern or inject directly
		// We rely on ctx.taskStepStore being injected alongside other stores
		const taskStepStore = (ctx as any).taskStepStore;
		if (!taskStepStore) {
			return "Error: Orchestrate not available in this context (no taskStepStore)";
		}

		// 2. Load Wiki context (if wikiNodes provided)
		let wikiContext = "";
		if (input.wikiNodes && input.wikiNodes.length > 0 && ctx.wikiStore) {
			const parts: string[] = [];
			for (const nodePath of input.wikiNodes) {
				const node = ctx.wikiStore.getByPath(ctx.projectId, nodePath);
				if (node) {
					parts.push(`## Wiki: ${node.path}\n${node.detail || node.summary || "No content"}`);
				}
			}
			wikiContext = parts.join("\n\n");
		}

		// 3. Get role config
		const roleConfig = getRoleConfig(input.role);

		// 4. Build sub-agent systemPrompt
		let systemPrompt = roleConfig.promptAppend;
		if (wikiContext) {
			systemPrompt += "\n\n## Wiki Context\n" + wikiContext;
		}
		if (input.relatedFiles && input.relatedFiles.length > 0) {
			systemPrompt += "\n\n## Related Files\n" + input.relatedFiles.join("\n");
		}

		// 5. Compute next step order
		const existingSteps = taskStepStore.listByRequirement(ctx.activeRequirementId);
		const nextOrder = existingSteps.length > 0
			? Math.max(...existingSteps.map((s: any) => s.stepOrder)) + 1
			: 1;

		// 6. Create TaskStepRecord
		const now = new Date().toISOString();
		const step = taskStepStore.create({
			requirementId: ctx.activeRequirementId,
			stepOrder: nextOrder,
			role: input.role,
			title: input.task.substring(0, 100),
			description: input.task,
			status: "running",
			input: JSON.stringify(input),
			retryCount: 0,
			maxRetries: 3,
			startedAt: now,
		});

		// 7. Execute sub-agent via createRoleLoop
		try {
			const toolPolicy = {
				allow: roleConfig.toolPolicy.autoApprove,
				deny: roleConfig.toolPolicy.blockedTools,
			};

			const { result, changedFiles } = await ctx.createRoleLoop({
				role: input.role,
				task: input.task,
				systemPrompt,
				toolPolicy,
				wikiContext: wikiContext || undefined,
				workspaceDir: ctx.projectPath,
			});

			// 8. Update step — success
			taskStepStore.update(step.id, {
				status: "completed",
				output: JSON.stringify({ result, changedFiles }),
				completedAt: new Date().toISOString(),
			});

			// 9. Return summary to Lead
			const fileSummary = changedFiles.length > 0
				? `\nChanged files: ${changedFiles.join(", ")}`
				: "";
			return `Step completed: ${input.role} executed task\n${result}${fileSummary}`;
		} catch (err) {
			// Update step — failure
			const errMsg = (err as Error).message || String(err);
			try {
				taskStepStore.update(step.id, {
					status: "failed",
					error: errMsg,
					completedAt: new Date().toISOString(),
				});
			} catch {
				// Best effort — step update failure shouldn't mask original error
			}

			return `Step failed: ${input.role} — ${errMsg}`;
		}
	},
});
