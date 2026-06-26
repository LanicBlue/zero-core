// Wiki 充实 runner
//
// # 文件说明书
//
// ## 核心功能
// 把"深度充实项目 wiki"作为一个 archivist agent run 拉起来(后台、非阻塞):
// resolveAgent(via) → resolveSessionByRoleProject(agentId, projectId) → 起 job
// 记 → fire-and-forget sendRolePrompt → 完成/失败写回 project_jobs。
//
// 这是"配置驱动、不硬绑 archivist"的落点:via 决定谁来充实(默认
// { role: "archivist" }),本文件不出现对具体角色的硬编码假设 —— 只通过
// getRoleConfig(via.role) 解析。换角色/换 agent = 改 via 配置,代码不变。
//
// ## 输入
// - projectId
// - opts.via (AgentVia: role | agentId | model)
// - opts.prompt (可选,默认用内置充实任务 prompt)
//
// ## 输出
// - { jobId, sessionId } —— 立即返回,run 在后台跑
//
// ## 定位
// 服务层编排器,被 ManagementService.enrichProject 调用;由 server/index.ts
// 构造并经 management.setEnrichmentRunner 注入。
//
// ## 依赖
// - ./agent-service (sendRolePrompt)
// - ./agent-store / ./template-store (resolveAgent)
// - ./session-context-router (resolveSessionByRoleProject)
// - ./project-job-store (run 记录)
// - ../runtime/agent-roles (getRoleConfig / buildWorkflowSystemPrompt)
//

import type { AgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { TemplateStore } from "./template-store.js";
import type { SessionDB } from "./session-db.js";
import type { ProjectStore } from "./project-store.js";
import type { WikiStore } from "./wiki-node-store.js";
import type { ProjectJobStore } from "./project-job-store.js";
import type { AgentVia } from "../shared/types.js";
import { resolveSessionByRoleProject, type WikiRootResolver } from "./session-context-router.js";
import { getRoleConfig, buildWorkflowSystemPrompt } from "../runtime/agent-roles.js";
import { log } from "../core/logger.js";

export interface EnrichmentRunnerDeps {
	agentService: AgentService;
	agentStore: AgentStore;
	templateStore: TemplateStore;
	sessionDB: SessionDB;
	projectStore: ProjectStore;
	wikiStore: WikiStore;
	projectJobStore: ProjectJobStore;
	resolveWikiRoot?: WikiRootResolver;
}

/** resolveAgent 的产物:身份 + 路由键 + 对话保护标志。 */
export interface ResolvedAgent {
	agentId: string;
	role: string;
	/** 该角色 session 是否允许用户输入(worker=false)。 */
	interactive: boolean;
}

const DEFAULT_ENRICH_ROLE = "archivist";

export class EnrichmentRunner {
	private deps: EnrichmentRunnerDeps;

	constructor(deps: EnrichmentRunnerDeps) {
		this.deps = deps;
	}

	/**
	 * 解析 via → { agentId, role, interactive }。配置驱动:
	 * - via.role 给定 → 按角色解析,ensure 一个全局角色 agent(name = displayName)。
	 * - via.agentId 给定 → 直接用该 agent(必须存在);role 取 via.role ?? 默认。
	 * 代码不硬编码具体角色 —— 默认值 DEFAULT_ENRICH_ROLE 由调用方语义决定。
	 */
	resolveAgent(via: AgentVia): ResolvedAgent {
		const role = via.role ?? DEFAULT_ENRICH_ROLE;
		const roleConfig = getRoleConfig(role);

		let agentId: string;
		if (via.agentId) {
			const agent = this.deps.agentStore.get(via.agentId);
			if (!agent) throw new Error(`Agent not found: ${via.agentId}`);
			agentId = agent.id;
		} else {
			agentId = this.ensureRoleAgent(role);
		}

		return { agentId, role, interactive: roleConfig.interactive };
	}

	/**
	 * Ensure a global role agent exists (lookup by displayName; create from
	 * role config if missing). Mirrors lead-service.ensureLeadAgent, but
	 * global (not per-project) — 一个角色一个全局 agent,服务所有 project。
	 */
	private ensureRoleAgent(role: string): string {
		const roleConfig = getRoleConfig(role);
		const existing = this.deps.agentStore.list().find((a) => a.name === roleConfig.displayName);
		if (existing) return existing.id;

		const systemPrompt = buildWorkflowSystemPrompt(role, this.deps.templateStore);
		const agent = this.deps.agentStore.create({
			name: roleConfig.displayName,
			systemPrompt,
			toolPolicy: {
				autoApprove: roleConfig.toolPolicy.autoApprove,
				blockedTools: roleConfig.toolPolicy.blockedTools,
			},
		} as any);
		log.debug("enrichment", `ensured global role agent '${roleConfig.displayName}' (${agent.id})`);
		return agent.id;
	}

	/**
	 * 起一个 wiki 充实 agent run。非阻塞:立即返回 { jobId, sessionId },
	 * run 在后台跑,完成/失败写回 project_jobs。
	 */
	async runProjectEnrichment(
		projectId: string,
		opts: { via: AgentVia; prompt?: string },
	): Promise<{ jobId: string; sessionId: string }> {
		const { agentService, sessionDB, projectStore, wikiStore, projectJobStore } = this.deps;

		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);

		// 1. 解析身份(配置驱动,不硬绑 archivist)
		const resolved = this.resolveAgent(opts.via);

		// 2. 路由出项目 session(find-or-create by (agentId, projectId))
		const { session } = resolveSessionByRoleProject(
			{ sessionDB, projectStore, resolveWikiRoot: this.deps.resolveWikiRoot },
			resolved.agentId,
			projectId,
			{ title: `enrich:${project.name}` },
		);

		// 3. 起 job 记录(running)
		const prompt = opts.prompt ?? this.buildDefaultPrompt(project.name);
		const job = projectJobStore.create({
			jobType: "wiki-enrich",
			projectId,
			agentId: resolved.agentId,
			sessionId: session.id,
			status: "running",
			startedAt: new Date().toISOString(),
			promptSummary: prompt.slice(0, 500),
		});

		// 4. fire-and-forget 起充实 run。范式同 cron-analysis 的 void fireCron().catch()。
		//    sendRolePrompt 注入 role + project 上下文(含 wikiStore),archivist 在该
		//    session 里调 Wiki docWrite/docEdit 时 anchor 天然 = 本项目子树根(写入
		//    守卫放行)。完成/失败写回 job。
		void Promise.resolve()
			.then(() =>
				agentService.sendRolePrompt(resolved.agentId, session.id, resolved.role, prompt, {
					projectId: project.id,
					projectPath: project.workspaceDir,
					projectName: project.name,
					wikiStore,
				}),
			)
			.then(() => {
				projectJobStore.markCompleted(job.id);
				log.debug("enrichment", `wiki-enrich completed: project=${projectId} job=${job.id}`);
			})
			.catch((err: Error) => {
				projectJobStore.markFailed(job.id, err.message);
				log.warn("enrichment", `wiki-enrich failed: project=${projectId} job=${job.id}:`, err.message);
			});

		return { jobId: job.id, sessionId: session.id };
	}

	/** 默认充实任务 prompt:遍历骨架,给空 detail 的节点写详 doc + 准 summary。 */
	private buildDefaultPrompt(projectName: string): string {
		return [
			`深度充实项目 "${projectName}" 的 wiki 树。`,
			"",
			"骨架扫描已经建好了结构节点(header/intent/structure)和启发式简摘。",
			"你的任务是把它们做实:",
			"",
			"1. 用 Wiki(expand) 从项目子树根开始遍历整棵骨架。",
			"2. 对每个 header 节点(代码文件):用 Read 读源文件,然后用 Wiki(docWrite/docEdit)",
			"   写一段详实的 detail —— 讲清这个文件/模块的职责、关键导出、依赖关系、",
			"   设计意图(为什么这么写),并更新 summary 成准确的一句话概括。",
			"3. 对每个 intent 节点(需求/设计/ADR 文档):读文档,写 detail 概述其内容。",
			"4. 对 structure 节点(模块/子系统):聚合子节点信息,写 detail 说明该层的组织。",
			"5. 持续直到没有 detail 为空的 header/intent 节点。provenance 标 structure/derived/confirmed。",
			"",
			"硬约束:只在本项目 wiki 子树内写、只写 header/intent/structure 类型(你已有的规则)。",
			"遇到读不到/拿不准的,留 flags 不要瞎编。完成后简述你充实了多少节点。",
		].join("\n");
	}
}
