// Lead 服务
//
// # 文件说明书
//
// ## 核心功能
// 管理 Lead Agent 的生命周期：领取就绪需求、构建工具上下文、追踪执行进度。
//
// ## 输入
// - requirementId — 需求 ID
// - projectId — 项目 ID
//
// ## 输出
// - pickupRequirement() — 领取需求，启动 Lead session
// - autoPickupIfIdle() — 空闲时自动领取下一个就绪需求
// - getProgress() — 获取执行进度
//
// ## 定位
// 服务层，被 IPC handler 和 requirement-hooks 使用。
//
// ## 依赖
// - agent-service — Agent 执行
// - agent-store — Agent 持久化
// - requirement-store — 需求数据
// - task-step-store — 步骤数据
// - wiki-store — Wiki 数据
// - project-store — 项目数据
// - template-store — 模板数据
//
// ## 维护规则
// - Lead Agent 创建/复用逻辑需幂等
// - 异步执行不阻塞 HTTP 响应
//

import type { AgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";
import type { ProjectWikiStore } from "./project-wiki-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { TaskStepStore } from "./task-step-store.js";
import type { TemplateStore } from "./template-store.js";
import type { GitIntegration } from "./git-integration.js";
import type { ProjectRecord, RequirementRecord, TaskStepRecord } from "../shared/types.js";
import { buildWorkflowSystemPrompt, getRoleConfig } from "../runtime/agent-roles.js";
import { log } from "../core/logger.js";
import type { ToolExecutionContext } from "../runtime/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadProgress {
	requirement: RequirementRecord;
	steps: TaskStepRecord[];
	currentStep: TaskStepRecord | undefined;
	completedCount: number;
	totalCount: number;
}

// ---------------------------------------------------------------------------
// LeadService
// ---------------------------------------------------------------------------

export class LeadService {
	private agentService: AgentService;
	private agentStore: AgentStore;
	private requirementStore: RequirementStore;
	private taskStepStore: TaskStepStore;
	private wikiStore: ProjectWikiStore;
	private projectStore: ProjectStore;
	private templateStore: TemplateStore;
	private gitIntegration: GitIntegration | null = null;

	constructor(deps: {
		agentService: AgentService;
		agentStore: AgentStore;
		requirementStore: RequirementStore;
		taskStepStore: TaskStepStore;
		wikiStore: ProjectWikiStore;
		projectStore: ProjectStore;
		templateStore: TemplateStore;
		gitIntegration?: GitIntegration;
	}) {
		this.agentService = deps.agentService;
		this.agentStore = deps.agentStore;
		this.requirementStore = deps.requirementStore;
		this.taskStepStore = deps.taskStepStore;
		this.wikiStore = deps.wikiStore;
		this.projectStore = deps.projectStore;
		this.templateStore = deps.templateStore;
		if (deps.gitIntegration) this.gitIntegration = deps.gitIntegration;
	}

	/**
	 * M5: Inject GitIntegration after construction.
	 */
	setGitIntegration(gi: GitIntegration): void {
		this.gitIntegration = gi;
	}

	// ─── Public API ──────────────────────────────────────────────────

	/**
	 * 领取就绪需求，启动 Lead session。
	 */
	async pickupRequirement(requirementId: string): Promise<string> {
		// 1. Validate requirement status
		const req = this.requirementStore.get(requirementId);
		if (!req) {
			throw new Error(`Requirement not found: ${requirementId}`);
		}
		if (req.status !== "ready") {
			throw new Error(`Requirement status must be 'ready', got '${req.status}'`);
		}
		if (req.assignedLeadSessionId) {
			throw new Error(`Requirement already assigned to session: ${req.assignedLeadSessionId}`);
		}

		// 2. Get associated project
		const project = this.projectStore.get(req.projectId);
		if (!project) {
			throw new Error(`Project not found: ${req.projectId}`);
		}

		// 3. Create or reuse Lead AgentRecord
		const agent = this.ensureLeadAgent(project);

		// 4. Create session via agentService
		const session = this.agentService.getDB().createSession(agent.id);
		const sessionId = session.id;

		// 5. Update requirement with assigned session
		this.requirementStore.update(requirementId, {
			assignedLeadSessionId: sessionId,
		} as any);

		// 6. Transition status: ready → plan
		this.requirementStore.transitionStatus(requirementId, "plan", "lead", "Lead 领取需求");

		// M5: Create requirement branch (non-blocking)
		if (this.gitIntegration && project.workspaceDir) {
			this.gitIntegration.createRequirementBranch(
				project.workspaceDir, requirementId, req.title,
			).catch((err) => {
				log.debug("lead", "Git branch creation failed (non-blocking):", (err as Error).message);
			});
		}

		// 7. Build tool context (v0.8 M0: no createRoleLoop — Orchestrate now
		// dispatches via delegateTask + toolPolicy, see orchestrate-tool.ts)
		const toolContext = this.buildLeadToolContext(project, req);

		// 8. Build pickup prompt
		const prompt = this.buildPickupPrompt(req);

		log.agent("Lead: picking up requirement:", req.title, "agent:", agent.id, "session:", sessionId);

		// 9. Execute via sendRolePrompt with injected tool context
		await this.agentService.sendRolePrompt(
			agent.id,
			sessionId,
			"lead",
			prompt,
			{
				projectId: project.id,
				projectPath: project.workspaceDir,
				projectName: project.name,
				wikiStore: toolContext.wikiStore,
				requirementStore: toolContext.requirementStore,
				taskStepStore: toolContext.taskStepStore,
				activeRequirementId: requirementId,
			},
		);

		return sessionId;
	}

	/**
	 * 检查并自动领取下一个就绪需求。
	 */
	async autoPickupIfIdle(projectId: string): Promise<string | null> {
		const project = this.projectStore.get(projectId);
		if (!project) return null;

		// Check if there are active requirements (plan/build) for this project
		const activeReqs = this.requirementStore.listByStatus("build" as any)
			.filter((r) => r.projectId === projectId);
		const planReqs = this.requirementStore.listByStatus("plan" as any)
			.filter((r) => r.projectId === projectId);
		if (activeReqs.length > 0 || planReqs.length > 0) return null;

		// Get ready requirements sorted by priority
		const readyReqs = this.requirementStore.listByStatus("ready" as any)
			.filter((r) => r.projectId === projectId && !r.assignedLeadSessionId);

		const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
		readyReqs.sort((a, b) =>
			(priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3)
		);

		if (readyReqs.length === 0) return null;

		// Pickup the first one
		return this.pickupRequirement(readyReqs[0].id);
	}

	/**
	 * 获取执行进度。
	 */
	getProgress(requirementId: string): LeadProgress {
		const req = this.requirementStore.get(requirementId);
		if (!req) {
			throw new Error(`Requirement not found: ${requirementId}`);
		}

		const steps = this.taskStepStore.listByRequirement(requirementId);
		const currentStep = steps.find((s) => s.status === "running");
		const completedCount = steps.filter((s) => s.status === "completed" || s.status === "skipped").length;

		return {
			requirement: req,
			steps,
			currentStep,
			completedCount,
			totalCount: steps.length,
		};
	}

	// ─── Private helpers ─────────────────────────────────────────────

	/**
	 * 确保 Lead AgentRecord 存在。
	 */
	private ensureLeadAgent(project: ProjectRecord) {
		const leadName = `Lead-${project.name}`;
		const existing = this.agentStore.list().find((a) => a.name === leadName);
		if (existing) return existing;

		const systemPrompt = buildWorkflowSystemPrompt("lead", this.templateStore);
		const roleConfig = getRoleConfig("lead");

		const agent = this.agentStore.create({
			name: leadName,
			workspaceDir: project.workspaceDir,
			systemPrompt,
			toolPolicy: {
				autoApprove: roleConfig.toolPolicy.autoApprove,
				blockedTools: roleConfig.toolPolicy.blockedTools,
			},
		} as any);

		return agent;
	}

	/**
	 * 构建 Lead 的工具上下文。
	 * v0.8 (M0): no longer creates a role-loop factory. Sub-agent dispatch
	 * (developer/reviewer/qa) is delegated to agent-as-tool + toolPolicy —
	 * lead's toolPolicy whitelists the relevant role agent-tools.
	 */
	private buildLeadToolContext(
		project: ProjectRecord,
		requirement: RequirementRecord,
	): Partial<ToolExecutionContext> {
		return {
			wikiStore: this.wikiStore,
			requirementStore: this.requirementStore,
			taskStepStore: this.taskStepStore,
			projectId: project.id,
			agentRole: "lead",
			projectPath: project.workspaceDir,
			activeRequirementId: requirement.id,
		};
	}

	/**
	 * 构建 Lead 的领取 prompt。
	 */
	private buildPickupPrompt(requirement: RequirementRecord): string {
		return `需求「${requirement.title}」已确认就绪，请分析并制定执行计划。

需求描述：
${requirement.description || "(无描述)"}

优先级：${requirement.priority}
影响范围：${requirement.impactScope || "N/A"}

相关上下文：
${requirement.context || "(无附加上下文)"}

请完成以下步骤：
1. 先使用 Read/Grep/Glob 工具了解相关代码现状
2. 使用 ExpandNode 展开相关 Wiki 节点获取背景
3. 制定执行计划，明确每步由哪个角色（developer/reviewer/qa）执行
4. 使用 Orchestrate 工具依次调度各角色执行
5. 汇总结果，确认需求是否完整实现

注意：
- 执行步骤应按照：开发 → 审查 → 测试 的顺序
- 审查不通过时可以调整方案并重新调度 developer
- 测试不通过时可以修复并重新测试
- 最多重试 3 次`;
	}
}
