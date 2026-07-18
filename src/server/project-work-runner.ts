// project-work 触发执行器
//
// # 文件说明书
//
// ## 核心功能
// fireProjectWork —— 手动触发 / hook 触发 project-work 的共享执行路径。
// 解析 work(agent + actionPrompt + requiredTools)→ 校验 agent 工具 → 解析 session
// (resolveSessionByRoleProject)→ sendProjectPrompt(actionPrompt 作 user message,
// 注入 wikiStore/projectContext)。cron 触发不经此,由 CronAnalysisManager.fireAgent
// 内联解析 work(保留 cron 的 git-aware/cron_runs 审计)。
//
// ## 输入
// - workId + 可选 requirementId(hook 触发带入)
//
// ## 输出
// - FireProjectWorkResult: ok / skipped(vacant/disabled/缺工具)/ error
//
// ## 定位
// 服务层,被 ProjectWorkHookManager(事件触发)+ ManagementService(手动触发)调用。
//
// ## 依赖
// - ./agent-service sendProjectPrompt
// - ./session-context-router resolveSessionByRoleProject
// - ./wiki-operations agentHasTool
//

import type { AgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";
import type { ProjectWorkStore } from "./project-work-store.js";

import type { CoreDatabase } from "./core-database.js";
import { resolveSessionByRoleProject, type WikiRootResolver } from "./session-context-router.js";
import { agentHasTool } from "./wiki-operations.js";
import { log } from "../core/logger.js";
import type { FireProjectWorkResult } from "../shared/types.js";

export type { FireProjectWorkResult } from "../shared/types.js";

export interface ProjectWorkRunnerDeps {
	agentService: AgentService;
	agentStore: AgentStore;
	projectStore: ProjectStore;
	projectWorkStore: ProjectWorkStore;
	sessionDB: CoreDatabase;
	
	resolveWikiRoot?: WikiRootResolver;
}

export class ProjectWorkRunner {
	private deps: ProjectWorkRunnerDeps;

	constructor(deps: ProjectWorkRunnerDeps) {
		this.deps = deps;
	}

	/**
	 * 触发一个 project-work。actionPrompt 作为 user message 发送给 work.agentId
	 * (去-role:身份来自 agent.systemPrompt,行为来自 work.actionPrompt)。
	 * 校验:work 必须启用 + 有 agent + agent 满足 requiredTools,否则 skipped。
	 */
	async fireProjectWork(workId: string, opts: { requirementId?: string } = {}): Promise<FireProjectWorkResult> {
		const work = this.deps.projectWorkStore.get(workId);
		if (!work) return { status: "error", error: `project-work not found: ${workId}` };
		if (!work.enabled) return { status: "skipped", reason: "work disabled" };
		if (!work.agentId) {
			log.debug("project-work", `work ${workId} (${work.name}) skipped: vacant (no agent assigned)`);
			return { status: "skipped", reason: "vacant — no agent assigned" };
		}
		const agent = this.deps.agentStore.get(work.agentId);
		if (!agent) return { status: "error", error: `Agent ${work.agentId} not found` };

		// 校验工具要求:work.requiredTools 逐项,任一被 blocked → skipped + 提醒。
		if (Array.isArray(work.requiredTools)) {
			for (const tool of work.requiredTools) {
				if (!agentHasTool(agent, tool)) {
					log.warn("project-work", `work ${workId} (${work.name}) skipped: agent "${agent.name}" is missing required tool ${tool} (blocked)`);
					return { status: "skipped", reason: `agent missing required tool: ${tool}` };
				}
			}
		}

		const project = this.deps.projectStore.get(work.projectId);
		const projectName = project?.name ?? "";
		const workspaceDir = project?.workspaceDir;
		const wikiRootNodeId = `wiki-root:${work.projectId}`;
		const actionPrompt = (work.actionPrompt ?? "").replaceAll("{projectName}", projectName);
		if (!actionPrompt.trim()) {
			return { status: "skipped", reason: "empty actionPrompt" };
		}

		const resolved = resolveSessionByRoleProject(
			{
				sessionDB: this.deps.sessionDB,
				projectStore: this.deps.projectStore,
				resolveWikiRoot: this.deps.resolveWikiRoot,
			},
			work.agentId,
			work.projectId,
			{ bundleOverride: { workspaceDir, wikiRootNodeId } },
		);
		const sessionId = resolved.session.id;

		log.debug("project-work", `Firing work "${work.name}" (${workId}) → agent ${agent.name} session ${sessionId}`);
		const result = await this.deps.agentService.sendProjectPrompt(agent.id, sessionId, actionPrompt, {
			projectId: work.projectId,
			projectPath: workspaceDir,
			projectName,
			
			activeRequirementId: opts.requirementId,
			workId: work.id,
		}, "work");
		if (result?.skipped === "busy") {
			log.debug("project-work", `work ${workId} (${work.name}) skipped: session ${sessionId} busy(上一 turn 未完成)`);
			return { status: "skipped", reason: "agent busy(上一 turn 未完成)" };
		}
		return { status: "ok", sessionId };
	}
}
