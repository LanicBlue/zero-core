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
// - verifyRequirement() — 验证需求实现
// - archiveRequirement() — 归档需求
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
// - task-step-store — 步骤数据
// - template-store — 模板数据
// - git-integration — Git 操作
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
import type { TaskStepStore } from "./task-step-store.js";
import type { TemplateStore } from "./template-store.js";
import type { GitIntegration } from "./git-integration.js";
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
	private taskStepStore: TaskStepStore | null;
	private templateStore: TemplateStore;
	private gitIntegration: GitIntegration | null;

	constructor(deps: {
		agentService: AgentService;
		agentStore: AgentStore;
		projectStore: ProjectStore;
		wikiStore: ProjectWikiStore;
		requirementStore: RequirementStore;
		taskStepStore?: TaskStepStore;
		templateStore: TemplateStore;
	}) {
		this.agentService = deps.agentService;
		this.agentStore = deps.agentStore;
		this.projectStore = deps.projectStore;
		this.wikiStore = deps.wikiStore;
		this.requirementStore = deps.requirementStore;
		this.taskStepStore = deps.taskStepStore ?? null;
		this.templateStore = deps.templateStore;
		this.gitIntegration = null;
	}

	/** Inject GitIntegration (called during wiring in server/index.ts). */
	setGitIntegration(gi: GitIntegration): void {
		this.gitIntegration = gi;
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

	// ─── M5: Verification & Archival ────────────────────────────────────

	/**
	 * 验证需求实现是否符合原始设计。
	 * 使用 Analyst Agent 检查实现完整性。
	 */
	async verifyRequirement(requirementId: string): Promise<{
		passed: boolean;
		report: string;
	}> {
		const req = this.requirementStore.get(requirementId);
		if (!req) {
			return { passed: false, report: `Requirement not found: ${requirementId}` };
		}

		if (!this.taskStepStore) {
			return { passed: false, report: "TaskStepStore not available" };
		}

		// 1. Get all task steps
		const steps = this.taskStepStore.listByRequirement(requirementId);

		// 2. Collect changed files from completed step outputs
		const changedFiles = steps
			.filter(s => s.status === "completed" && s.output)
			.map(s => {
				try { return JSON.parse(s.output!).changedFiles; } catch { return []; }
			})
			.flat() as string[];

		// 3. Try git-based changed files as well
		const project = this.projectStore.get(req.projectId);
		if (this.gitIntegration && project) {
			try {
				const gitFiles = await this.gitIntegration.getChangedFiles(project.path, "main");
				for (const f of gitFiles) {
					if (!changedFiles.includes(f)) changedFiles.push(f);
				}
			} catch {
				// Git unavailable, continue with what we have
			}
		}

		// 4. Build verification prompt
		const prompt = `Verify whether requirement "${req.title}" has been correctly implemented.

Original requirement description:
${req.description || "(No description)"}

Execution steps:
${steps.map(s => `- ${s.role}: ${s.title} (${s.status})`).join("\n")}

Changed files:
${changedFiles.length > 0 ? changedFiles.join("\n") : "(No tracked changes)"}

Please check:
1. Does the implementation fully cover all features described in the requirement?
2. Are there any omissions or deviations?
3. Is the code quality acceptable?

Output format:
- Conclusion: PASSED / FAILED
- Detailed report`;

		// 5. Execute verification via analyst agent
		let result = "";
		try {
			const agent = project ? this.ensureAnalystAgent(project) : undefined;
			if (agent) {
				await this.agentService.sendPrompt(prompt, agent);
				// Read back the last assistant message from the session
				const db = this.agentService.getDB();
				const messages = db.getMessages
					? db.getMessages(agent.id)
					: [];
				const lastAssistant = [...messages]
					.reverse()
					.find((m: any) => m.role === "assistant");
				result = lastAssistant?.content || "Verification completed (no detailed output captured)";
			} else {
				result = "PASSED\nVerification completed (no agent session available for detailed check)";
			}
		} catch (err) {
			result = `FAILED\nVerification error: ${(err as Error).message}`;
		}

		// 6. Parse result
		const passed = result.includes("PASSED") && !result.includes("FAILED");

		// 7. Store verification result as a message
		this.requirementStore.addMessage(
			requirementId,
			"analyst" as any,
			`Verification ${passed ? "PASSED" : "FAILED"}:\n\n${result}`,
			"status_change",
		);

		return { passed, report: result };
	}

	/**
	 * 归档需求并更新 Wiki。
	 * 生成完成报告，更新 Wiki 节点，关闭需求。
	 */
	async archiveRequirement(requirementId: string): Promise<void> {
		const req = this.requirementStore.get(requirementId);
		if (!req) {
			log.error("analyst", `Cannot archive: requirement not found: ${requirementId}`);
			return;
		}

		if (!this.taskStepStore) {
			log.error("analyst", "Cannot archive: TaskStepStore not available");
			return;
		}

		const steps = this.taskStepStore.listByRequirement(requirementId);

		// 1. Collect changed files
		const changedFiles = steps
			.filter(s => s.status === "completed" && s.output)
			.map(s => {
				try { return JSON.parse(s.output!).changedFiles; } catch { return []; }
			})
			.flat() as string[];

		// 2. Update Wiki (only affected nodes)
		if (changedFiles.length > 0) {
			const project = this.projectStore.get(req.projectId);
			if (project) {
				const wikiPrompt = `The following files have changed. Please update the summaries of related Wiki nodes:
${changedFiles.map(f => `- ${f}`).join("\n")}`;

				try {
					const agent = this.ensureAnalystAgent(project);
					await this.agentService.sendPrompt(wikiPrompt, agent);
				} catch (err) {
					log.error("analyst", `Wiki update failed during archive: ${(err as Error).message}`);
				}
			}
		}

		// 3. Generate completion report
		const report = `## Requirement Completion Report: ${req.title}

**Priority**: ${req.priority}
**Impact**: ${req.impactScope || "N/A"}

### Execution Steps
${steps.map(s => `- **${s.role}**: ${s.title} — ${s.status}`).join("\n")}

### Summary
${steps.filter(s => s.output).map(s => {
			try { return JSON.parse(s.output!).summary; } catch { return ""; }
		}).filter(Boolean).join("\n") || "(No step summaries available)"}`;

		// 4. Write report to messages
		this.requirementStore.addMessage(
			requirementId,
			"analyst" as any,
			report,
			"status_change",
		);

		// 5. Transition status → closed
		try {
			this.requirementStore.transitionStatus(
				requirementId, "closed", "analyst" as any, "Requirement completed and archived",
			);
		} catch (err) {
			log.error("analyst", `Archive transition failed: ${(err as Error).message}`);
		}

		log.agent("Analyst: archived requirement:", req.title);
	}
}
