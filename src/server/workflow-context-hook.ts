// 工作流上下文注入 Hook
//
// # 文件说明书
//
// ## 核心功能
// 注册 PreLLMCall Hook，在每 turn 调 LLM 前注入工作流上下文（T2）。
// 根据角色的 contextPolicy 决定注入哪些上下文信息。
//
// ## 输入
// - PreLLMCall Hook context（含 SessionConfig）
//
// ## 输出
// - memoryContext — 追加到 buildContextMessage 的上下文字符串
//
// ## 定位
// 服务层，被 server/index.ts 调用注册。
//
// ## 依赖
// - hook-registry — Hook 注册
// - agent-roles — 角色配置
// - project-store / wiki-store / requirement-store / task-step-store — 数据查询
//
// ## 维护规则
// - 新增上下文注入策略时在此扩展
// - 不改动 agent-loop.ts 和 buildContextMessage
//

import { HookRegistry } from "../core/hook-registry.js";
import type { WorkContextPolicy } from "../shared/types.js";
import type { ProjectStore } from "./project-store.js";
import type { ProjectWikiStore } from "./project-wiki-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { TaskStepStore } from "./task-step-store.js";
import type { ProjectWorkStore } from "./project-work-store.js";

// ---------------------------------------------------------------------------
// Wiki baseline helper
// ---------------------------------------------------------------------------

/** Get Wiki shallow baseline for a project (sorted by path, indented by depth). */
function getWikiBaseline(wikiStore: ProjectWikiStore, projectId: string): string {
	const nodes = wikiStore.listByProject(projectId);
	if (nodes.length === 0) return "";

	const sorted = nodes
		.filter((n) => n.summary)
		.sort((a, b) => a.path.localeCompare(b.path));

	return sorted.map((n) => {
		const depth = n.path.split("/").length - 1;
		const indent = "  ".repeat(Math.max(0, depth - 1));
		return `${indent}${n.path} — ${n.summary}`;
	}).join("\n");
}

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

/**
 * Register the workflow context PreLLMCall hook.
 *
 * For project-work sessions (workId set), injects project info, Wiki baseline,
 * requirement detail, or step progress based on the work's contextPolicy.
 * Returns injected context as memoryContext, which agent-loop.ts already merges
 * into buildContextMessage — no changes to agent-loop.ts needed.
 */
export function registerWorkflowContextHook(deps: {
	projectStore: ProjectStore;
	requirementStore: RequirementStore;
	wikiStore: ProjectWikiStore;
	taskStepStore: TaskStepStore;
	/** v0.8 project-work:按 config.workId 反查 work.contextPolicy(去-role 主路径)。 */
	projectWorkStore?: ProjectWorkStore;
	hookRegistry?: HookRegistry;
}): void {
	const registry = deps.hookRegistry ?? HookRegistry.getInstance();

	registry.register("PreLLMCall", async (ctx) => {
		const config = ctx.config as any;
		const projectId = config?.projectContext?.projectId as string | undefined;
		const requirementId = config?.projectContext?.activeRequirementId as string | undefined;

		// 解析 contextPolicy:project-work(config.workId → work.contextPolicy,去-role)。
		const workId = config?.workId as string | undefined;
		let policy: WorkContextPolicy | undefined;
		if (workId && deps.projectWorkStore) {
			policy = deps.projectWorkStore.get(workId)?.contextPolicy;
		}
		if (!policy) return; // 非 work session,跳过

		const parts: string[] = [];

		// Project info (common to all roles)
		if (policy.injectProjectInfo && projectId) {
			const project = deps.projectStore.get(projectId);
			if (project) {
				// v0.8 (M0): ProjectRecord slimmed to workspaceDir
				parts.push(`## Project\n- Name: ${project.name}\n- Working directory: ${project.workspaceDir}`);
			}
		}

		// Wiki baseline (Analyst)
		if (policy.injectWikiBaseline && projectId) {
			const baseline = getWikiBaseline(deps.wikiStore, projectId);
			if (baseline) {
				parts.push(`## Wiki Baseline\n${baseline}`);
			}
			// v0.8 (M0): lastAnalysisAt removed; (archivist, project) cursor lands in M5
		}

		// Requirement detail (Lead / Developer / Reviewer / QA)
		if (policy.injectRequirementDetail && requirementId) {
			const req = deps.requirementStore.get(requirementId);
			if (req) {
				parts.push(`## Requirement\n- Title: ${req.title}\n- Priority: ${req.priority}\n- Impact: ${req.impactScope || "N/A"}\n- Description:\n${req.description || "(no description)"}`);
			}
		}

		// Steps progress (Lead)
		if (policy.injectStepsProgress && requirementId) {
			const steps = deps.taskStepStore.listByRequirement(requirementId);
			if (steps.length > 0) {
				const progress = steps.map((s) => {
					const icon = s.status === "completed" ? "done" : s.status === "running" ? "running" : s.status === "failed" ? "failed" : "pending";
					return `  [${icon}] ${s.role}: ${s.title}`;
				}).join("\n");
				const completed = steps.filter((s) => s.status === "completed").length;
				parts.push(`## Steps Progress (${completed}/${steps.length})\n${progress}`);
			}
		}

		// Git diff: injected via user message (T3) by AnalystService.runIncrementalAnalysis,
		// not through this hook. No action needed here.

		if (parts.length === 0) return;

		return {
			memoryContext: parts.join("\n\n"),
		};
	});
}
