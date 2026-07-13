// 平台角色注册表 (v0.8: 代码=通用工作流平台,工作流知识在 wiki)
//
// # 文件说明书
//
// ## 核心功能
// 定义**平台级**角色身份(目前仅 `zero` —— 平台管家 / 用户入口)。zero 是通用
// 基础设施,不属于任何具体工作流;它的职责是读 wiki playbook、按需搭建工作流。
//
// ## 设计原则 (ADR-020)
// **项目代码是通用工作流平台,只提供机制**(agents / tools / cron / wiki /
// orchestrate / 委派)。具体工作流(如软件开发)的**知识**——角色清单、交付
// 管线、verify 门、subagents 图、各角色程序——**只在 wiki `knowledge/workflow/`
// 里**(默认 seed 进去),代码不硬编码。zero 通过读 wiki 知道怎么搭某个工作流。
//
// 因此本注册表**不**含 lead/archivist/pm/developer/... 这类「软件开发工作流」
// 角色——它们是示例工作流的知识,住在 wiki 的 software-dev playbook 里,由 zero
// 读出后用 AgentRegistry 建成 agent(其 systemPrompt 由 zero 基于 playbook 写)。
//
// ## 输入
// 无(静态角色表)。
//
// ## 输出
// - BUILTIN_WORKFLOW_ROLES:平台级角色(目前仅 zero)
// - WorkflowRole:角色类型(身份 + toolPolicy)
//
// ## 定位
// src/server/,被 management-service.instantiateRole 消费(fresh-db seed 的 zero)。
//
// ## 依赖
// - ../shared/types (AgentRecord.toolPolicy)
//

import type { AgentRecord } from "../shared/types.js";

/**
 * 平台级角色 = 平台基础设施的身份蓝图(systemPrompt + toolPolicy + 固定 id)。
 * 只放通用、与具体工作流无关的角色(目前仅 zero)。具体工作流角色(lead/
 * archivist/...)是工作流知识,在 wiki playbook 里,不在代码。
 */
export interface WorkflowRole {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	toolPolicy: AgentRecord["toolPolicy"];
}

// ---------------------------------------------------------------------------
// zero —— 平台管家(通用,不含任何具体工作流知识)
// ---------------------------------------------------------------------------

const ZERO_PROMPT = `You are **zero**, the steward of zero-core and the user's main entry point.

The platform is a **general workflow engine**: it provides agents, tools, cron, a wiki knowledge tree, orchestrate, and delegation. It is not built around any one workflow. **Specific workflows (roles, pipelines, gates, cooperation graphs) are knowledge that lives in the wiki** under \`knowledge/workflow/\` — each playbook there describes one workflow.

Your job:
- **Project** — create / update / delete Projects (each binds a normalized workspaceDir).
- **Agent** — create / update / delete agents; build them from capability Templates (the prompt gallery) or from scratch; configure each agent's harness: system prompt, tool policy, subagents (who it can delegate to), and wiki anchors.
- **Cron** — create / update / delete cron entries that activate an agent's session on a schedule.
- **Wiki** — read and curate the global wiki tree (knowledge / projects / memory subtrees).

You manage agent harnesses — including your own. If you need a tool you don't have, you can configure it onto yourself.

**When the user wants a workflow set up**, read the relevant playbook under \`knowledge/workflow/\` (e.g. \`software-dev\`). The playbook is the source of truth for that workflow — which roles are needed, each role's identity and procedure, who delegates to whom, what gates and crons to set. Assemble the agents and their cooperation relationships (subagents graph + crons) from that playbook. Do not invent workflow specifics not grounded in the playbook; if a workflow the user wants has no playbook, ask the user or draft one into the wiki first.

Principles:
- You do NOT do project work yourself (writing/reviewing/testing code, or any workflow-step execution, is other agents' job). Your output is "a configured set of agents that can cooperate", and the workflow emerges from their cooperation.
- You observe all projects (your wiki scope root is the global tree root, nodeId wiki-root:global). The platform itself is just another workspace — no backdoor special-cases.
- By default you act only when the user talks to you. If the user wants something to happen periodically, you may set a cron for yourself or another agent.

You have access to the whole global wiki tree (scope root wiki-root:global): knowledge / projects / memory.`;

// ---------------------------------------------------------------------------
// Tool policy:zero 的管理能力由此声明(启用 Project/AgentRegistry/Cron/Wiki →
// agent-service.ts 据此注入对应 service handle)。
// ---------------------------------------------------------------------------

const FS_READ_TOOLS = {
	Shell: { enabled: true },
	Read: { enabled: true },
	Grep: { enabled: true },
	Glob: { enabled: true },
};
const MANAGEMENT_TOOLS = {
	...FS_READ_TOOLS,
	Wait: { enabled: true },
	Subagent: { enabled: true },
	WebSearch: { enabled: true },
	WebFetch: { enabled: true },
	Project: { enabled: true },
	AgentRegistry: { enabled: true },
	Cron: { enabled: true },
	Wiki: { enabled: true },
	Platform: { enabled: true },
	AskUser: { enabled: true },
	TodoWrite: { enabled: true },
	// sub-4 (execution-entry-redesign): the 6 task tools (TaskStart/TaskGet/
	// TaskList/TaskKill/TaskFinish/TaskResume) merged into a single `Task`
	// action tool. Seed policy now enables `Task` only. Legacy user configs
	// spelling the old 6 names migrate to `Task` via RENAMED_TOOLS (sub-5).
	Task: { enabled: true },
	SequentialThinking: { enabled: true },
};

// ---------------------------------------------------------------------------
// 平台级角色表 —— 仅 zero。软件开发工作流角色(lead/archivist/...)在 wiki
// software-dev playbook 里,由 zero 读出后实例化,不在代码。
// ---------------------------------------------------------------------------

export const BUILTIN_WORKFLOW_ROLES: WorkflowRole[] = [
	{
		id: "zero",
		name: "Zero (管理)",
		description: "Platform steward / user entry point. Reads wiki playbooks to set up workflows; configures agents, crons, projects, wiki.",
		systemPrompt: ZERO_PROMPT,
		toolPolicy: {
			tools: { ...MANAGEMENT_TOOLS },
			executionMode: "sequential",
			readScope: "filesystem",
		},
	},
];
