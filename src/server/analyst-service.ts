// Analyst 服务
//
// # 文件说明书
//
// ## 核心功能
// 管理 Analyst Agent 的生命周期，包括冷启动全量分析和增量分析。
//
// ## 输入
// - projectId — 项目 ID
//
// ## 输出
// - runFullAnalysis() — 冷启动全量分析
// - runIncrementalAnalysis() — 增量分析
//
// ## 定位
// 服务层，被 project-router 和 server/index.ts 使用。
//
// ## 依赖
// - agent-service — Agent 执行
// - agent-store — Agent 持久化
// - project-store — 项目数据
// - wiki-store — Wiki 数据
// - requirement-store — 需求数据
// - template-store — 模板数据
//
// ## 维护规则
// - 分析逻辑变更时需注意幂等性
// - 异步执行不阻塞 HTTP 响应
//

import type { AgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";
import type { ProjectWikiStore } from "./project-wiki-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { TemplateStore } from "./template-store.js";
import type { ProjectRecord } from "../shared/types.js";
import { buildWorkflowSystemPrompt, getRoleConfig } from "../runtime/agent-roles.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// AnalystService
// ---------------------------------------------------------------------------

export class AnalystService {
	private agentService: AgentService;
	private agentStore: AgentStore;
	private projectStore: ProjectStore;
	private wikiStore: ProjectWikiStore;
	private requirementStore: RequirementStore;
	private templateStore: TemplateStore;

	constructor(deps: {
		agentService: AgentService;
		agentStore: AgentStore;
		projectStore: ProjectStore;
		wikiStore: ProjectWikiStore;
		requirementStore: RequirementStore;
		templateStore: TemplateStore;
	}) {
		this.agentService = deps.agentService;
		this.agentStore = deps.agentStore;
		this.projectStore = deps.projectStore;
		this.wikiStore = deps.wikiStore;
		this.requirementStore = deps.requirementStore;
		this.templateStore = deps.templateStore;
	}

	// ─── Public API ──────────────────────────────────────────────────

	/**
	 * 冷启动：全量分析新项目。
	 * 扫描项目目录结构，创建 Wiki 浅层节点。
	 */
	async runFullAnalysis(projectId: string): Promise<void> {
		const project = this.projectStore.get(projectId);
		if (!project) {
			log.error("analyst", "Project not found:", projectId);
			return;
		}

		// If project already has wiki data, switch to incremental
		const existingNodes = this.wikiStore.listByProject(projectId);
		if (existingNodes.length > 0) {
			log.agent("Analyst: project already has wiki data, switching to incremental:", projectId);
			return this.runIncrementalAnalysis(projectId);
		}

		// Ensure analyst agent exists
		const agent = this.ensureAnalystAgent(project);

		// Build cold-start prompt
		const prompt = this.buildColdStartPrompt(project);

		log.agent("Analyst: starting full analysis for project:", project.name, "agent:", agent.id);

		try {
			await this.agentService.sendPrompt(prompt, agent);
			// Update lastAnalysisAt
			this.projectStore.update(projectId, {
				lastAnalysisAt: new Date().toISOString(),
			} as any);
			log.agent("Analyst: full analysis completed for:", project.name);
		} catch (err) {
			log.error("analyst", "Full analysis failed:", (err as Error).message);
		}
	}

	/**
	 * 增量分析：基于 git diff + Wiki 基线。
	 * 只更新受变更影响的 Wiki 节点。
	 */
	async runIncrementalAnalysis(projectId: string): Promise<void> {
		const project = this.projectStore.get(projectId);
		if (!project) {
			log.error("analyst", "Project not found:", projectId);
			return;
		}

		// Get incremental diff
		const diff = this.getGitDiff(project);
		if (!diff || diff.trim().length === 0) {
			log.agent("Analyst: no changes since last analysis, skipping:", project.name);
			return;
		}

		// Ensure analyst agent exists
		const agent = this.ensureAnalystAgent(project);

		// Build incremental prompt
		const prompt = this.buildIncrementalPrompt(project, diff);

		log.agent("Analyst: starting incremental analysis for project:", project.name);

		try {
			await this.agentService.sendPrompt(prompt, agent);
			// Update lastAnalysisAt
			this.projectStore.update(projectId, {
				lastAnalysisAt: new Date().toISOString(),
			} as any);
			log.agent("Analyst: incremental analysis completed for:", project.name);
		} catch (err) {
			log.error("analyst", "Incremental analysis failed:", (err as Error).message);
		}
	}

	// ─── Private helpers ─────────────────────────────────────────────

	/**
	 * 确保 Analyst AgentRecord 存在（不存在则创建）。
	 * 返回已存在或新创建的 AgentRecord。
	 */
	private ensureAnalystAgent(project: ProjectRecord) {
		// Lookup by name pattern — AgentRecord has no metadata field,
		// so we rely on the naming convention "Analyst-{projectName}".
		const analystName = `Analyst-${project.name}`;
		const existing = this.agentStore.list().find(a => a.name === analystName);
		if (existing) return existing;

		// Build T1 systemPrompt = base template + role append
		const systemPrompt = buildWorkflowSystemPrompt("analyst", this.templateStore);
		const roleConfig = getRoleConfig("analyst");

		// Create AgentRecord
		const agent = this.agentStore.create({
			name: `Analyst-${project.name}`,
			workspaceDir: project.path,
			systemPrompt,
			toolPolicy: {
				autoApprove: roleConfig.toolPolicy.autoApprove,
				blockedTools: roleConfig.toolPolicy.blockedTools,
			},
		} as any);

		// Store role metadata in a way that survives reload.
		// AgentRecord doesn't have a metadata field natively, so we use knowledgeBaseIds
		// as a workaround — or better, just match by name pattern in the future.
		// For now, the agent exists and sendPrompt will use its systemPrompt + toolPolicy.

		return agent;
	}

	/**
	 * 构建冷启动 prompt（用户消息，非 system prompt）。
	 */
	private buildColdStartPrompt(project: ProjectRecord): string {
		return `请全面分析项目「${project.name}」，为其构建代码知识树。

任务：
1. 扫描项目目录结构，为每个主要目录和文件创建 Wiki 浅层节点
2. 为每个节点编写简短摘要（summary），不需要详细内容（detail）
3. 如果发现值得关注的问题，创建需求记录

Wiki 节点组织方式：
- 目录节点（nodeType=directory）：如 src/, src/runtime/, src/server/
- 文件节点（nodeType=file）：如 src/runtime/agent-loop.ts
- 函数/类节点（nodeType=function/class）：可选，只对关键文件展开

每个节点的 summary 应包含：
- 该文件/模块的主要职责
- 关键导出（函数、类、常量）
- 依赖关系（简要）

优先级：
- 先覆盖项目根目录和主要 src 目录
- 不要试图一次性展开所有文件，先建立骨架
- 单个节点的 summary 控制在 2-3 句话内

完成后简要说明项目概况。`;
	}

	/**
	 * 构建增量分析 prompt（用户消息）。
	 */
	private buildIncrementalPrompt(project: ProjectRecord, diff: string): string {
		return `请对项目「${project.name}」进行增量分析。

以下是自上次分析以来的变更：

\`\`\`diff
${diff}
\`\`\`

任务：
1. 检查受变更影响的 Wiki 节点，更新其 summary
2. 如果有新增文件/目录，创建新的 Wiki 节点
3. 如果变更中发现新的问题，创建需求记录

注意：
- 只更新受影响的节点，不要重新分析整个项目
- 如果 diff 很大，优先关注最重要的变更`;
	}

	/**
	 * 获取增量 git diff。
	 * 基于 lastAnalysisAt 时间戳计算。
	 */
	private getGitDiff(project: ProjectRecord): string {
		// Placeholder — actual git diff execution would require shell access.
		// For now, return empty string to indicate no changes.
		// This will be implemented with proper shell execution in a follow-up.
		// The analyst agent can still use Grep/Glob/Read tools to detect changes.
		try {
			const { execSync } = require("child_process");
			const since = project.lastAnalysisAt
				? `--since="${project.lastAnalysisAt}"`
				: "--since=\"1 week ago\"";
			const cmd = `git -C "${project.path}" log --oneline ${since} -n 50`;
			const logOutput = execSync(cmd, { encoding: "utf-8", timeout: 10000 });

			if (!logOutput.trim()) return "";

			// Get actual diff for changed files
			const diffCmd = `git -C "${project.path}" diff HEAD~${Math.min(logOutput.split("\n").length, 20)} --stat`;
			return execSync(diffCmd, { encoding: "utf-8", timeout: 30000 });
		} catch {
			return "";
		}
	}
}
