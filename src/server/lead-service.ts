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
import type { ProjectWorkStore } from "./project-work-store.js";
import type { ProjectRecord, RequirementRecord, TaskStepRecord, ProjectWorkRecord, AgentRecord } from "../shared/types.js";
import { log } from "../core/logger.js";

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
	/** v0.8 project-work:需求管理工位(去-role,agent+prompt 从 work 取)。Late-bound。 */
	private projectWorkStore?: ProjectWorkStore;

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
	/** v0.8 project-work:注入 project_work store(去-role,需求管理工位)。 */
	setProjectWorkStore(store: ProjectWorkStore): void {
		this.projectWorkStore = store;
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

		// 3. 解析"需求管理"工位(去-role:agent + actionPrompt 从 work 取)
		const { work, agent } = this.resolveLeadWork(project);

		// 4. Create session via agentService
		const session = this.agentService.getDB().createSession(agent.id);
		const sessionId = session.id;

		// 5. Update requirement with assigned session
		this.requirementStore.update(requirementId, {
			assignedLeadSessionId: sessionId,
		} as any);

		// 6. Transition status: ready → plan
		this.requirementStore.transitionStatus(requirementId, "plan", "agent", "agent 领取需求");

		// v0.8 (M3): lead 建 feature worktree(决策 25/28)。独立目录,分支
		// `req-{shortId}`,与 archivist-git 的约定一致(archivist 后续
		// mergeFeatureToMain 能直接找到 + 清理)。失败时 fallback 到主
		// workspace(非阻塞)。project-flow §4.2 (F3): 路径集中化到
		// `~/.zero-core/projects/{project}/{req-shortId}/`(传 projectId 给
		// createFeatureWorktree)。
		let featureWorkspace = project.workspaceDir;
		if (this.gitIntegration && project.workspaceDir) {
			try {
				const wt = await this.gitIntegration.createFeatureWorktree(
					project.workspaceDir, requirementId, project.id,
				);
				if (wt.ok) featureWorkspace = wt.worktreePath;
				else log.debug("lead", `feature worktree fallback to main: branch=${wt.branch}`);
			} catch (err) {
				log.debug("lead", "feature worktree creation failed (non-blocking):", (err as Error).message);
			}
		}

		// 7+8. prompt = work.actionPrompt(需求 detail 由 T2 hook 按 work.contextPolicy 注入)
		const prompt = work.actionPrompt.replaceAll("{projectName}", project.name);

		log.agent("Lead: picking up requirement:", req.title, "work:", work.name, "agent:", agent.id, "session:", sessionId);

		// 9. Execute via sendProjectPrompt(去-role,带 workId)。projectPath 指
		// feature worktree,sub-agent dispatch 继承其为 cwd(决策 25)。M3 stores
		// (Orchestrate plan/manifest + git)透传给 Orchestrate 工具。
		await this.agentService.sendProjectPrompt(
			agent.id,
			sessionId,
			prompt,
			{
				projectId: project.id,
				projectPath: featureWorkspace,
				projectName: project.name,
				wikiStore: this.wikiStore,
				requirementStore: this.requirementStore,
				taskStepStore: this.taskStepStore,
				activeRequirementId: requirementId,
				workId: work.id,
				orchestratePlanStore: this.orchestratePlanStore,
				orchestrateManifestStore: this.orchestrateManifestStore,
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
	 * v0.8 project-work(去-role):解析 project 的"需求管理"工位,取其 agent +
	 * actionPrompt。空岗/未配置 → throw(无 fallback,提醒先分配 agent)。
	 */
	private resolveLeadWork(project: ProjectRecord): { work: ProjectWorkRecord; agent: AgentRecord } {
		if (!this.projectWorkStore) throw new Error("LeadService: projectWorkStore not wired (去-role 需要 需求管理 工位)");
		const works = this.projectWorkStore.listByProject(project.id);
		const work = works.find((w) => w.name === "需求管理" && w.enabled);
		if (!work) {
			throw new Error(`项目「${project.name}」未配置启用的"需求管理"工位。请在项目页创建/启用该工位(project-work 取代了 lead 角色)。`);
		}
		if (!work.agentId) {
			throw new Error(`"需求管理"工位未分配 agent(空岗)。请在项目页给该工位分配一个带 Orchestrate+Wiki 工具的 agent。`);
		}
		const agent = this.agentStore.get(work.agentId);
		if (!agent) throw new Error(`"需求管理"工位引用的 agent ${work.agentId} 不存在`);
		return { work, agent };
	}

}
