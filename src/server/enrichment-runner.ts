// Wiki 充实 runner
//
// # 文件说明书
//
// ## 核心功能
// 把"深度充实项目 wiki"作为一个 agent run 拉起来(后台、非阻塞):
// resolveAgent(via) → resolveSessionByRoleProject(agentId, projectId) → 起 job
// 记 → fire-and-forget sendProjectPrompt → 完成/失败写回 project_jobs。
//
// v0.8 推动弃用工作流角色 —— archivist 率先去 role:
// - **无 fallback**:via.agentId 必填(必须选已存在的 agent),不再自动建角色 agent。
// - **工具校验**:入口核实 agent 配了 Wiki 工具,否则拒绝(提醒用户从 Archivist
//   模板创建一个带 Wiki 工具的 agent)。
// - **去-role 触发**:用 sendProjectPrompt(身份/toolPolicy 全用 agent 自带,
//   按 session.projectId 注入 wikiStore/projectContext),不调 sendRolePrompt/
//   getRoleConfig。lead/pm/analyst 仍用各自 service 的 sendRolePrompt。
//
// ## 输入
// - projectId
// - opts.via.agentId(必填) —— 已存在、配了 Wiki 工具的 agent
// - opts.prompt (可选,默认用内置充实任务 prompt)
// - opts.operationId (可选,阶段 1 多操作)
//
// ## 输出
// - { jobId, sessionId } —— 立即返回,run 在后台跑
//
// ## 定位
// 服务层编排器,被 ManagementService.enrichProject 调用;由 server/index.ts
// 构造并经 management.setEnrichmentRunner 注入。
//
// ## 依赖
// - ./agent-service (sendProjectPrompt)
// - ./agent-store / ./template-store (resolveAgent)
// - ./session-context-router (resolveSessionByRoleProject)
// - ./project-job-store (run 记录)
// - ./wiki-operations (agentHasWikiTool 校验)
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
import { agentHasWikiTool } from "./wiki-operations.js";
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

/** resolveAgent 的产物:只剩 agentId(role 已弃用)。 */
export interface ResolvedAgent {
	agentId: string;
}

export class EnrichmentRunner {
	private deps: EnrichmentRunnerDeps;

	constructor(deps: EnrichmentRunnerDeps) {
		this.deps = deps;
	}

	/**
	 * 解析 via → { agentId }。**无 fallback**:via.agentId 必填,且必须存在、
	 * 配了 Wiki 工具。不再自动建角色 agent(推动弃用工作流角色)。
	 */
	resolveAgent(via: AgentVia): ResolvedAgent {
		if (!via.agentId) {
			throw new Error("via.agentId is required — select an existing agent (no fallback). Tip: create one from the Archivist template.");
		}
		const agent = this.deps.agentStore.get(via.agentId);
		if (!agent) {
			throw new Error(`Agent not found: ${via.agentId}`);
		}
		if (!agentHasWikiTool(agent)) {
			throw new Error(
				`Agent "${agent.name}" has the Wiki tool blocked — cannot enrich/maintain wiki. Use an agent with the Wiki tool (e.g. create one from the Archivist template).`,
			);
		}
		return { agentId: agent.id };
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

		// 1. 解析 agent(必填 + Wiki 工具校验,无 fallback)
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

		// 4. fire-and-forget 起充实 run。去-role:sendProjectPrompt 注入
		//    wikiStore/projectContext(按 session.projectId),archivist 在该
		//    session 里调 Wiki docWrite/docEdit 时 anchor = 本项目子树根。
		//    完成/失败写回 job。
		void Promise.resolve()
			.then(() =>
				agentService.sendProjectPrompt(resolved.agentId, session.id, prompt, {
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
