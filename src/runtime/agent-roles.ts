// 工作流角色定义
//
// # 文件说明书
//
// ## 核心功能
// 定义 5 个工作流角色（analyst / lead / developer / reviewer / qa）的配置，
// 包含基座模板、工具策略、prompt 追加规则、上下文注入策略。
//
// ## 输入
// - 角色名称
// - TemplateStore 实例
//
// ## 输出
// - WORKFLOW_ROLES — 角色配置表
// - getRoleConfig(role) — 获取角色配置
// - buildWorkflowSystemPrompt(role, templateStore) — 构建 T1 systemPrompt
//
// ## 定位
// Runtime 层角色系统，被 AnalystService / AgentService 使用。
//
// ## 依赖
// - ../server/template-store — 基座模板查询
//
// ## 维护规则
// - 新增角色时在此添加配置
// - 角色配置变更需考虑向后兼容
//

import type { TemplateStore } from "../server/template-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowRoleConfig {
	role: string;
	displayName: string;
	baseTemplate: string;
	recommendedModel: string;
	toolPolicy: {
		blockedTools: string[];
		autoApprove: string[];
	};
	/** 追加到 base 模板 prompt 末尾的角色规则（T1 静态内容） */
	promptAppend: string;
	/** T2 动态上下文注入配置 */
	contextPolicy: {
		injectProjectInfo: boolean;
		injectWikiBaseline: boolean;
		injectRequirementDetail: boolean;
		injectStepsProgress: boolean;
		injectGitDiff: boolean;
	};
	/** 是否需要持久化 AgentRecord（true = Analyst/Lead, false = sub-agent） */
	persistent: boolean;
}

// ---------------------------------------------------------------------------
// Role definitions
// ---------------------------------------------------------------------------

const ANALYST_CONFIG: WorkflowRoleConfig = {
	role: "analyst",
	displayName: "Project Analyst",
	baseTemplate: "Researcher",
	recommendedModel: "",

	toolPolicy: {
		blockedTools: ["Orchestrate"],
		autoApprove: ["Read", "Write", "Edit", "Grep", "Glob", "Shell",
			"ExpandNode", "UpdateWikiNode", "CreateRequirement"],
	},

	promptAppend: `
## Workflow Role: Project Analyst

You are the resident analyst for this project. Your responsibilities:

1. **Maintain the code knowledge tree (Wiki):**
   - Create shallow nodes (summary only, no detail) for directories and files
   - Use nodeType: directory | file | function | class
   - Each summary: 2-3 sentences covering responsibility, key exports, dependencies

2. **Discover improvements and create requirements:**
   - Security vulnerabilities → priority: critical
   - Performance issues → priority: high
   - Architecture improvements → priority: normal
   - Maintainability concerns → priority: low

3. **Analysis principles:**
   - First analysis: build skeleton first (root + src/ + main dirs), don't expand everything
   - Incremental analysis: only update nodes affected by changes
   - Every requirement must have clear title, description, and impactScope

Available workflow tools:
- ExpandNode(path) — Read a Wiki node's detail
- UpdateWikiNode(path, ...) — Create or update a Wiki node (upsert)
- CreateRequirement(title, description, priority, impactScope) — Add a requirement to the pool`,

	contextPolicy: {
		injectProjectInfo: true,
		injectWikiBaseline: true,
		injectRequirementDetail: false,
		injectStepsProgress: false,
		injectGitDiff: true,
	},

	persistent: true,
};

const LEAD_CONFIG: WorkflowRoleConfig = {
	role: "lead",
	displayName: "Task Lead",
	baseTemplate: "Architect",
	recommendedModel: "",

	toolPolicy: {
		blockedTools: ["Write", "Edit"],
		autoApprove: ["Read", "Grep", "Glob", "Shell", "ExpandNode", "Orchestrate"],
	},

	promptAppend: `
## Workflow Role: Task Lead

You are the task lead for this requirement. Your responsibilities:

1. **Analyze the requirement:**
   - Read the requirement description and related Wiki nodes
   - Understand scope and constraints

2. **Plan execution steps:**
   - Break into developer → reviewer → qa sequence
   - Each step gets a clear, specific task description

3. **Execute via Orchestrate tool:**
   - Orchestrate({ role, task, wikiNodes, relatedFiles })
   - Review sub-agent results after each step
   - If review rejected → adjust and retry (max 3 retries per step)

4. **Rules:**
   - Do NOT write or edit code directly — always delegate via Orchestrate
   - Collect all step results before declaring done
   - Summarize final outcome

Available workflow tools:
- ExpandNode(path) — Read a Wiki node's detail
- Orchestrate(role, task, wikiNodes?, relatedFiles?) — Dispatch a sub-agent`,

	contextPolicy: {
		injectProjectInfo: true,
		injectWikiBaseline: false,
		injectRequirementDetail: true,
		injectStepsProgress: true,
		injectGitDiff: false,
	},

	persistent: true,
};

const DEVELOPER_CONFIG: WorkflowRoleConfig = {
	role: "developer",
	displayName: "Developer",
	baseTemplate: "Coder",
	recommendedModel: "",

	toolPolicy: {
		blockedTools: ["Orchestrate", "CreateRequirement", "UpdateWikiNode", "ExpandNode"],
		autoApprove: ["Read", "Write", "Edit", "Shell", "Grep", "Glob"],
	},

	promptAppend: `
## Workflow Role: Developer

You are implementing a specific task assigned by the Lead.

Rules:
- Only modify files directly related to this task
- Follow the project's existing code style and patterns
- After completing, output a brief summary:
  - Files changed (list)
  - What you changed and why
  - Any issues or concerns discovered`,

	contextPolicy: {
		injectProjectInfo: true,
		injectWikiBaseline: false,
		injectRequirementDetail: true,
		injectStepsProgress: false,
		injectGitDiff: false,
	},

	persistent: false,
};

const REVIEWER_CONFIG: WorkflowRoleConfig = {
	role: "reviewer",
	displayName: "Reviewer",
	baseTemplate: "Reviewer",
	recommendedModel: "",

	toolPolicy: {
		blockedTools: ["Write", "Edit", "Orchestrate", "CreateRequirement", "UpdateWikiNode", "ExpandNode"],
		autoApprove: ["Read", "Grep", "Glob", "Shell"],
	},

	promptAppend: `
## Workflow Role: Code Reviewer

You are reviewing changes for a specific requirement.

Output format:
- **Verdict:** APPROVED or REJECTED
- **Issues:** (list if any, with file:line references)
- **Suggestions:** (list if any)`,

	contextPolicy: {
		injectProjectInfo: true,
		injectWikiBaseline: false,
		injectRequirementDetail: true,
		injectStepsProgress: false,
		injectGitDiff: false,
	},

	persistent: false,
};

const QA_CONFIG: WorkflowRoleConfig = {
	role: "qa",
	displayName: "QA Engineer",
	baseTemplate: "Coder",
	recommendedModel: "",

	toolPolicy: {
		blockedTools: ["Edit", "Orchestrate", "CreateRequirement", "UpdateWikiNode", "ExpandNode"],
		autoApprove: ["Read", "Write", "Shell", "Grep", "Glob"],
	},

	promptAppend: `
## Workflow Role: QA Engineer

You are testing the implementation for a specific requirement.

Test strategy:
- Test core functionality paths first
- Cover: happy path, error handling, boundary conditions
- Use Write tool to create test files if needed

Output format:
- Test cases executed (list)
- Pass/fail per case
- Issues discovered (if any)
- Overall verdict: PASS or FAIL`,

	contextPolicy: {
		injectProjectInfo: true,
		injectWikiBaseline: false,
		injectRequirementDetail: true,
		injectStepsProgress: false,
		injectGitDiff: false,
	},

	persistent: false,
};

// ---------------------------------------------------------------------------
// Role registry
// ---------------------------------------------------------------------------

export const WORKFLOW_ROLES: Record<string, WorkflowRoleConfig> = {
	analyst: ANALYST_CONFIG,
	lead: LEAD_CONFIG,
	developer: DEVELOPER_CONFIG,
	reviewer: REVIEWER_CONFIG,
	qa: QA_CONFIG,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get role configuration, throws if unknown role. */
export function getRoleConfig(role: string): WorkflowRoleConfig {
	const config = WORKFLOW_ROLES[role];
	if (!config) throw new Error(`Unknown workflow role: ${role}`);
	return config;
}

/**
 * Build role T1 systemPrompt.
 * = base template prompt + role append rules.
 *
 * Falls back to promptAppend only if base template not found.
 */
export function buildWorkflowSystemPrompt(
	role: string,
	templateStore: TemplateStore,
): string {
	const config = getRoleConfig(role);

	// Find base template
	const baseTemplate = templateStore.list().find(t => t.name === config.baseTemplate);
	const basePrompt = baseTemplate?.systemPrompt ?? "";

	// Concatenate role append
	return basePrompt + "\n\n" + config.promptAppend;
}
