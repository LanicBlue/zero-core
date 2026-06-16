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
import type { OrchestratePlanStore, OrchestrateManifestStore } from "./orchestrate-store.js";
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
	// v0.8 (M3): Orchestrate plan/manifest stores — surfaced into the lead's
	// tool context so the Orchestrate tool persists plans + manifests.
	private orchestratePlanStore?: OrchestratePlanStore;
	private orchestrateManifestStore?: OrchestrateManifestStore;

	constructor(deps: {
		agentService: AgentService;
		agentStore: AgentStore;
		requirementStore: RequirementStore;
		taskStepStore: TaskStepStore;
		wikiStore: ProjectWikiStore;
		projectStore: ProjectStore;
		templateStore: TemplateStore;
		gitIntegration?: GitIntegration;
		orchestratePlanStore?: OrchestratePlanStore;
		orchestrateManifestStore?: OrchestrateManifestStore;
	}) {
		this.agentService = deps.agentService;
		this.agentStore = deps.agentStore;
		this.requirementStore = deps.requirementStore;
		this.taskStepStore = deps.taskStepStore;
		this.wikiStore = deps.wikiStore;
		this.projectStore = deps.projectStore;
		this.templateStore = deps.templateStore;
		if (deps.gitIntegration) this.gitIntegration = deps.gitIntegration;
		if (deps.orchestratePlanStore) this.orchestratePlanStore = deps.orchestratePlanStore;
		if (deps.orchestrateManifestStore) this.orchestrateManifestStore = deps.orchestrateManifestStore;
	}

	/** v0.8 (M3): inject Orchestrate stores after construction. */
	setOrchestrateStores(plan: OrchestratePlanStore, manifest: OrchestrateManifestStore): void {
		this.orchestratePlanStore = plan;
		this.orchestrateManifestStore = manifest;
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

		// v0.8 (M3): lead 建 feature worktree(决策 25/28)。独立目录
		// `{workspace}.worktrees/req-{shortId}/`,分支 `req-{shortId}`,与
		// archivist-git 的约定一致(archivist 后续 mergeFeatureToMain 能直接
		// 找到 + 清理)。失败时 fallback 到主 workspace(非阻塞)。
		let featureWorkspace = project.workspaceDir;
		if (this.gitIntegration && project.workspaceDir) {
			try {
				const wt = await this.gitIntegration.createFeatureWorktree(
					project.workspaceDir, requirementId,
				);
				if (wt.ok) featureWorkspace = wt.worktreePath;
				else log.debug("lead", `feature worktree fallback to main: branch=${wt.branch}`);
			} catch (err) {
				log.debug("lead", "feature worktree creation failed (non-blocking):", (err as Error).message);
			}
		}

		// 7. Build tool context (v0.8 M0: no createRoleLoop — Orchestrate now
		// dispatches via delegateTask + toolPolicy, see orchestrate-tool.ts)
		const toolContext = this.buildLeadToolContext(project, req);

		// 8. Build pickup prompt
		const prompt = this.buildPickupPrompt(req);

		log.agent("Lead: picking up requirement:", req.title, "agent:", agent.id, "session:", sessionId);

		// 9. Execute via sendRolePrompt with injected tool context (M3: also
		// surface the Orchestrate plan/manifest stores so the Orchestrate tool
		// persists confirm-gate state + per-run manifests). projectPath points
		// at the feature worktree so sub-agent dispatches (delegateTask) inherit
		// the worktree as their cwd (决策 25).
		await this.agentService.sendRolePrompt(
			agent.id,
			sessionId,
			"lead",
			prompt,
			{
				projectId: project.id,
				projectPath: featureWorkspace,
				projectName: project.name,
				wikiStore: toolContext.wikiStore,
				requirementStore: toolContext.requirementStore,
				taskStepStore: toolContext.taskStepStore,
				activeRequirementId: requirementId,
				orchestratePlanStore: this.orchestratePlanStore,
				orchestrateManifestStore: this.orchestrateManifestStore,
				// v0.8 (M3): hand GitIntegration to the Orchestrate tool so each
				// task node commits on the feature worktree with [req-<short>]
				// reference (decision 21 / RFC §2.15 / acceptance-M3 item 10).
				gitIntegration: this.gitIntegration ?? undefined,
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
	 * 构建 Lead 的领取 prompt (v0.8 M3 — Orchestrate-DSL-author flow).
	 *
	 * Decision 11/48: lead is the DSL author. The pickup prompt walks lead
	 * through: planner outline → author Orchestrate DSL (specify per-node
	 * agent) → submit via Orchestrate (confirm gate) → run → manifest.
	 */
	private buildPickupPrompt(requirement: RequirementRecord): string {
		return `需求「${requirement.title}」(id ${requirement.id}) 已确认就绪,请按交付流程推进。

需求描述:
${requirement.description || "(无描述)"}

优先级: ${requirement.priority}
影响范围: ${requirement.impactScope || "N/A"}

相关上下文:
${requirement.context || "(无附加上下文)"}

交付流程(决策 11/48 — 你是 Orchestrate DSL 作者,Orchestrate 工具是执行引擎):

1. 用 Read/Grep/Glob/ExpandNode 了解相关代码现状 + 读 archivist wiki 做好 plan。
2. 调用 planner agent-tool 出执行大纲(任务队列)。
3. 把大纲拆成 Orchestrate DSL flow:
   - 用 parallel/pipeline/if/for/barrier 节点表达执行逻辑;
   - 每个 task 节点指定一个你 toolPolicy 放行的 agent-tool(developer/reviewer/qa/...);
   - 末尾追加 verify 节点跑测试 + 派 reviewer agent-tool(决策 34 — 验收在流程内自动执行)。
4. 调用 Orchestrate({ flow, mode: "confirm" }) 提交流程:
   - 工具会停住等用户确认(看板 plan 待审入口)。确认后才 run;驳回会返回 "false: <reason>",
     你据此自重 Orchestrate flow(同角色,mode="run" 重交)。
5. run 完后 Orchestrate 自动产出 manifest(改了哪些文件 + 跑了哪些测试 + 审查结果)。
   PM 后续读这份 manifest 做覆盖判断(决策 34),你不用管 PM 那一步。

注意:
- commit 引用 requirementId,格式如 "feat: ... [req-${shortIdForPrompt(requirement.id)}]"(决策 21,喂 traceability)。
- 在 feature 分支(req-${shortIdForPrompt(requirement.id)})上每步 commit。
- 默认串行(一次一个需求),最多重试 3 次/步。`;
	}
}

function shortIdForPrompt(id: string): string {
	return id.substring(0, 8);
}
