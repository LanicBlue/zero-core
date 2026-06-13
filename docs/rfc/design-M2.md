# M2 设计文档：项目分析 Agent

> **版本**: 2.0
> **对应计划**: `plan-M2.md`
> **依赖**: M1（数据基础）
> **目标**: 角色系统、Wiki/需求工具、Analyst 冷启动与增量分析、三层上下文注入

---

## 1. 角色系统设计

### 1.1 设计决策

**不动现有模板体系**。5 个工作流角色是系统内部概念，不暴露给用户的模板选择器。

- **Analyst / Lead** → 自动创建 AgentRecord（随项目/需求生命周期）
- **Developer / Reviewer / QA** → 纯运行时角色（Orchestrate 时临时 AgentLoop，执行完释放）

角色 prompt **基于现有模板扩展**，不重写：
- Developer 继承 Coder 模板核心规则
- Reviewer 直接复用 Reviewer 模板
- QA 基于 Coder + 测试策略
- Analyst 基于 Researcher 方法论
- Lead 基于 Architect 思维方式

### 1.2 角色配置结构

```typescript
// src/runtime/agent-roles.ts

export interface WorkflowRoleConfig {
  role: string;                           // 唯一标识
  displayName: string;                    // 显示名
  baseTemplate: string;                   // 基座的现有模板名
  recommendedModel: string;               // 推荐模型
  toolPolicy: {
    blockedTools: string[];               // 禁用工具
    autoApprove: string[];                // 自动批准工具
  };
  /** 追加到 base 模板 prompt 末尾的角色规则（T1 静态内容） */
  promptAppend: string;
  /** T2 动态上下文注入配置 */
  contextPolicy: {
    injectProjectInfo: boolean;           // 注入项目名/路径
    injectWikiBaseline: boolean;          // 注入 Wiki 浅层基线
    injectRequirementDetail: boolean;     // 注入需求标题/描述
    injectStepsProgress: boolean;         // 注入步骤执行进度
    injectGitDiff: boolean;               // 注入增量 diff
  };
  /** 是否需要持久化 AgentRecord（true = Analyst/Lead, false = sub-agent） */
  persistent: boolean;
}
```

### 1.3 五角色定义

#### Analyst（项目分析师）

```typescript
{
  role: "analyst",
  displayName: "Project Analyst",
  baseTemplate: "Researcher",            // 继承调研方法论：三角验证、信源评估
  recommendedModel: "",                   // 空 = 使用用户默认模型

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
    injectGitDiff: true,                  // 增量分析时注入
  },

  persistent: true,                       // 自动创建 AgentRecord
}
```

#### Lead（任务负责人）

```typescript
{
  role: "lead",
  displayName: "Task Lead",
  baseTemplate: "Architect",              // 继承架构思维：trade-off、边界设计
  recommendedModel: "",

  toolPolicy: {
    blockedTools: ["Write", "Edit"],      // Lead 不直接改代码
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
    injectStepsProgress: true,            // Lead 需要看到已完成的步骤
    injectGitDiff: false,
  },

  persistent: true,                       // 自动创建 AgentRecord
}
```

#### Developer（开发者）

```typescript
{
  role: "developer",
  displayName: "Developer",
  baseTemplate: "Coder",                  // 继承 Coder 核心：读后写、最小改动、验证
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
    injectRequirementDetail: true,        // 需要理解需求上下文
    injectStepsProgress: false,
    injectGitDiff: false,
  },

  persistent: false,                      // 临时 AgentLoop
}
```

#### Reviewer（审查者）

```typescript
{
  role: "reviewer",
  displayName: "Reviewer",
  baseTemplate: "Reviewer",               // 直接复用 Reviewer 模板
  recommendedModel: "",

  toolPolicy: {
    blockedTools: ["Write", "Edit", "Orchestrate", "CreateRequirement", "UpdateWikiNode", "ExpandNode"],
    autoApprove: ["Read", "Grep", "Glob", "Shell"],
  },

  promptAppend: `
## Workflow Role: Code Reviewer

You are reviewing changes for a specific requirement.

Original requirement: {requirementTitle}
{requirementDescription}

Output format:
- **Verdict:** APPROVED or REJECTED
- **Issues:** (list if any, with file:line references)
- **Suggestions:** (list if any)`,

  contextPolicy: {
    injectProjectInfo: true,
    injectWikiBaseline: false,
    injectRequirementDetail: true,        // 对照需求审查
    injectStepsProgress: false,
    injectGitDiff: false,
  },

  persistent: false,
}
```

#### QA（测试工程师）

```typescript
{
  role: "qa",
  displayName: "QA Engineer",
  baseTemplate: "Coder",                  // 继承工具能力
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
}
```

### 1.4 Prompt 构建函数

```typescript
// src/runtime/agent-roles.ts

import { TemplateStore } from "../server/template-store.js";

const WORKFLOW_ROLES: Record<string, WorkflowRoleConfig> = {
  analyst: { /* 见上 */ },
  lead:    { /* 见上 */ },
  developer: { /* 见上 */ },
  reviewer:  { /* 见上 */ },
  qa:       { /* 见上 */ },
};

export function getRoleConfig(role: string): WorkflowRoleConfig {
  const config = WORKFLOW_ROLES[role];
  if (!config) throw new Error(`Unknown workflow role: ${role}`);
  return config;
}

/**
 * 构建角色 T1 systemPrompt
 * = 基座模板 prompt + 角色追加规则
 */
export function buildWorkflowSystemPrompt(
  role: string,
  templateStore: TemplateStore,
): string {
  const config = getRoleConfig(role);

  // 获取基座模板
  const baseTemplate = templateStore.list().find(t => t.name === config.baseTemplate);
  const basePrompt = baseTemplate?.systemPrompt ?? "";

  // 拼接角色追加
  return basePrompt + "\n\n" + config.promptAppend;
}
```

**关键点**：
- 不做模板变量替换（`{projectName}` 等）— 动态内容走 T2
- `promptAppend` 是纯静态的角色规则，整个会话不变
- 基座模板由 `template-store.ts` 管理，自动同步更新

---

## 2. 三层上下文注入

### 2.1 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                     AgentLoop 每 Turn 执行流                       │
│                                                                  │
│  T1 systemPrompt（构造时固定，Assembler 缓存）                     │
│  ├─ 基座模板 prompt（Coder / Reviewer / Researcher / Architect）  │
│  └─ 角色追加规则（promptAppend）                                  │
│  → 位置: streamText({ system: systemPrompt })                    │
│  → 机制: SystemPromptAssembler base section, cacheBreak=false    │
│                                                                  │
│  T2 prependContext（每 turn 重建，不存 DB）                        │
│  ├─ 现有: Environment + Guidelines + Memory + RAG                │
│  ├─ 新增: WorkflowContext（项目/Wiki/需求/步骤/diff）              │
│  └─ → 位置: prependContext() 插入最后一条 user message 前         │
│  → 机制: PreLLMCall Hook → buildContextMessage → prependContext   │
│                                                                  │
│  T3 session messages（存 DB，自然积累）                            │
│  ├─ 用户消息（"我想讨论需求：支付集成"）                           │
│  ├─ 工具调用结果（ExpandNode 返回的 Wiki 内容）                   │
│  └─ Assistant 回复（"已完成分析，创建了 3 个 Wiki 节点"）          │
│  → 机制: session.addMessage() → prune 按窗口裁剪                  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 T1 — systemPrompt（构造时固定）

**注入时机**: 创建 AgentLoop 时，传入 `SessionConfig.systemPrompt`

**谁负责**:
- Analyst: `AnalystService.ensureAnalystAgent()` 创建 AgentRecord 时设置
- Lead: `LeadService.pickupRequirement()` 创建 AgentRecord 时设置
- Sub-agent: `OrchestrateTool.execute()` 创建临时 AgentLoop 时设置

```typescript
// Analyst 服务中
const systemPrompt = buildWorkflowSystemPrompt('analyst', templateStore);
// → Researcher 模板 prompt + "\n\n" + analyst promptAppend
// 整个 Analyst 会话生命周期不变

const agent = agentStore.create({
  name: `Analyst-${project.name}`,
  systemPrompt,
  toolPolicy: roleConfig.toolPolicy,
  metadata: { role: 'analyst', projectId: project.id },
});
```

### 2.3 T2 — prependContext（每 turn 重建，不存 DB）

**注入时机**: `PreLLMCall` Hook，每 turn 调 LLM 前

**机制**: 复用现有 `buildContextMessage()` + `prependContext()`，通过 Hook 追加 `workflowContext`

```typescript
// src/server/workflow-context-hook.ts

export function registerWorkflowContextHook(deps: {
  projectStore: ProjectStore;
  requirementStore: RequirementStore;
  wikiStore: ProjectWikiStore;
  taskStepStore: TaskStepStore;
}): void {

  hookRegistry.register("PreLLMCall", async (ctx) => {
    const role = ctx.config.agentRole;
    if (!role) return;  // 非工作流会话，跳过

    const config = getRoleConfig(role);
    const policy = config.contextPolicy;
    const projectId = ctx.config.projectContext?.projectId;
    const requirementId = ctx.config.projectContext?.activeRequirementId;
    const parts: string[] = [];

    // ── 项目信息（通用） ──
    if (policy.injectProjectInfo && projectId) {
      const project = deps.projectStore.get(projectId);
      if (project) {
        parts.push(`## Project\n- Name: ${project.name}\n- Path: ${project.path}\n- Working directory: ${project.path}`);
      }
    }

    // ── Wiki 基线（Analyst 用） ──
    if (policy.injectWikiBaseline && projectId) {
      const baseline = getWikiBaseline(deps.wikiStore, projectId);
      if (baseline) {
        parts.push(`## Wiki Baseline\n${baseline}`);
      }
      // 上次分析时间
      const project = deps.projectStore.get(projectId);
      if (project?.lastAnalysisAt) {
        parts.push(`## Last Analysis: ${project.lastAnalysisAt}`);
      }
    }

    // ── 需求详情（Lead / Developer / Reviewer / QA 用） ──
    if (policy.injectRequirementDetail && requirementId) {
      const req = deps.requirementStore.get(requirementId);
      if (req) {
        parts.push(`## Requirement\n- Title: ${req.title}\n- Priority: ${req.priority}\n- Impact: ${req.impactScope || 'N/A'}\n- Description:\n${req.description || '(no description)'}`);
      }
    }

    // ── 步骤进度（Lead 用） ──
    if (policy.injectStepsProgress && requirementId) {
      const steps = deps.taskStepStore.listByRequirement(requirementId);
      if (steps.length > 0) {
        const progress = steps.map(s =>
          `  ${s.status === 'completed' ? '✅' : s.status === 'running' ? '🔄' : s.status === 'failed' ? '❌' : '○'} ${s.role}: ${s.title}`
        ).join('\n');
        const completed = steps.filter(s => s.status === 'completed').length;
        parts.push(`## Steps Progress (${completed}/${steps.length})\n${progress}`);
      }
    }

    // ── Git Diff（Analyst 增量分析用） ──
    // 注意：gitDiff 不通过 Hook context 传递。
    // AnalystService.runIncrementalAnalysis() 直接把 diff 拼入用户消息（T3），
    // 而非走 T2 hook。这里的 injectGitDiff 实际上由用户消息携带，
    // Hook 不需要额外处理。
    // 如果未来需要通过 Hook 注入 diff，可以通过 SessionConfig 扩展字段传递。

    if (parts.length === 0) return;

    // 追加到 memoryContext（复用现有 prependContext 通道）
    return {
      memoryContext: parts.join('\n\n'),
    };
  });
}

/** 获取 Wiki 浅层基线 */
function getWikiBaseline(wikiStore: ProjectWikiStore, projectId: string): string {
  const nodes = wikiStore.listByProject(projectId);
  if (nodes.length === 0) return '';

  // 按路径排序，缩进表示层级
  const sorted = nodes
    .filter(n => n.summary)
    .sort((a, b) => a.path.localeCompare(b.path));

  return sorted.map(n => {
    const depth = n.path.split('/').length - 1;
    const indent = '  '.repeat(Math.max(0, depth - 1));
    return `${indent}${n.path} — ${n.summary}`;
  }).join('\n');
}
```

**不改动 `buildContextMessage` 和 `agent-loop.ts`**。

现有 `PreLLMCall` Hook 返回 `memoryContext` 后，`agent-loop.ts:370` 已经会把它拼入 `buildContextMessage`：

```typescript
// agent-loop.ts executeStream() — 现有代码，无需修改
const memoryContext = preResult.memoryContext as string | undefined;
const ctx = buildContextMessage({
  workspaceDir: this.config.workspaceDir,
  guidelines: this.config.guidelines,
  ragContext,
  memoryContext,       // ← workflow context hook 返回的内容会到这里
});
const messages = this.prependContext(this.session.getMessages(), ctx);
```

### 2.4 T3 — session messages（自然积累）

不需要额外机制。工具执行结果通过 `session.addMessage()` 自动积累：

```
Turn 1:
  user: "请全面分析项目..."
  assistant: 调用 Glob("src/**/*.ts")
  tool: [文件列表]
  assistant: 调用 UpdateWikiNode({ path: "src/runtime/", summary: "..." })
  tool: "Wiki node created: src/runtime/"
  assistant: 调用 CreateRequirement({ title: "...", priority: "high" })
  tool: "Requirement created: req_abc123"
  assistant: "已完成项目分析。创建了 12 个 Wiki 节点，发现 2 个需求。"

Turn 2 (增量):
  user: "请进行增量分析..."
  assistant: 调用 ExpandNode({ path: "src/runtime/agent-loop.ts" })
  tool: [节点详情]          ← T3 提供了具体内容
  assistant: 调用 UpdateWikiNode({ path: "src/runtime/agent-loop.ts", summary: "更新后的摘要" })
  tool: "Wiki node updated"
```

### 2.5 三层映射总结

| 角色 | T1 systemPrompt | T2 prependContext (每 turn) | T3 session messages |
|------|-----------------|-----------------------------|---------------------|
| **Analyst** | Researcher + Wiki维护规则 | 项目信息 + Wiki基线 + 上次分析时间 + Git Diff | 工具调用结果（Wiki节点内容、代码文件内容） |
| **Lead** | Architect + 编排调度规则 | 项目信息 + 需求详情 + 步骤进度 | Orchestrate返回的摘要、工具调用结果 |
| **Developer** | Coder + 任务输出规则 | 项目信息 + 需求详情 | 代码文件内容、工具执行结果 |
| **Reviewer** | Reviewer + 审查输出规则 | 项目信息 + 需求详情 | 代码文件内容、审查发现 |
| **QA** | Coder + 测试策略 | 项目信息 + 需求详情 | 测试执行结果、代码文件内容 |

---

## 3. ToolExecutionContext 扩展

### 3.1 新增字段

```typescript
// src/runtime/types.ts — ToolExecutionContext 追加

interface ToolExecutionContext {
  // ... 现有字段 ...

  // Multi-Agent Workflow
  wikiStore?: ProjectWikiStore;         // Wiki 数据访问
  requirementStore?: RequirementStore;   // 需求数据访问
  projectId?: string;                    // 当前项目 ID
  agentRole?: string;                    // 当前 Agent 角色
}
```

### 3.2 SessionConfig 扩展

```typescript
// src/runtime/types.ts — SessionConfig 追加

interface SessionConfig {
  // ... 现有字段 ...

  agentRole?: string;                    // analyst | lead | developer | reviewer | qa
  projectContext?: {
    projectId: string;
    projectName: string;
    projectPath: string;
    activeRequirementId?: string;        // Lead/sub-agent 用
  };
}
```

---

## 4. Wiki 工具设计

### 4.1 ExpandNode

```typescript
// src/runtime/tools/wiki-tools.ts

const ExpandNodeTool = buildTool({
  name: "ExpandNode",
  category: "agent",
  description: "展开 Wiki 节点的详细内容。当需要深入了解某个文件或模块时使用。",
  isReadOnly: true,
  isConcurrencySafe: true,

  input: z.object({
    path: z.string().describe("Wiki 节点路径，如 'src/runtime/agent-loop.ts'"),
  }),

  execute: async (input, ctx) => {
    if (!ctx.wikiStore || !ctx.projectId) {
      return "Error: Wiki context not available";
    }
    const node = ctx.wikiStore.getByPath(ctx.projectId, input.path);
    if (!node) {
      return `Wiki node not found: ${input.path}`;
    }
    if (node.detail) {
      return node.detail;
    }
    return `Node: ${node.title}\nPath: ${node.path}\nSummary: ${node.summary || 'No summary'}\n\n(Detail not yet expanded. Use UpdateWikiNode to add detail.)`;
  },
});
```

### 4.2 UpdateWikiNode

```typescript
const UpdateWikiNodeTool = buildTool({
  name: "UpdateWikiNode",
  category: "agent",
  description: "创建或更新 Wiki 节点。用于冷启动创建知识树或增量更新。Upsert 语义。",
  isReadOnly: false,
  isConcurrencySafe: false,

  input: z.object({
    path: z.string().describe("节点路径"),
    title: z.string().optional().describe("节点标题"),
    nodeType: z.enum(['directory', 'file', 'function', 'class', 'section']).optional(),
    parentId: z.string().optional().describe("父节点 ID"),
    summary: z.string().optional().describe("浅层摘要"),
    detail: z.string().optional().describe("详细内容"),
  }),

  execute: async (input, ctx) => {
    if (!ctx.wikiStore || !ctx.projectId) {
      return "Error: Wiki context not available";
    }
    const existing = ctx.wikiStore.getByPath(ctx.projectId, input.path);
    if (existing) {
      const updates: Record<string, any> = { lastUpdatedBy: ctx.agentRole || 'analyst' };
      if (input.summary !== undefined) updates.summary = input.summary;
      if (input.detail !== undefined) updates.detail = input.detail;
      if (input.title !== undefined) updates.title = input.title;
      ctx.wikiStore.update(existing.id, updates);
      return `Wiki node updated: ${input.path}`;
    } else {
      ctx.wikiStore.create({
        projectId: ctx.projectId,
        path: input.path,
        title: input.title || input.path.split('/').pop() || input.path,
        nodeType: input.nodeType || 'section',
        parentId: input.parentId,
        summary: input.summary,
        detail: input.detail,
        lastUpdatedBy: ctx.agentRole || 'analyst',
      });
      return `Wiki node created: ${input.path}`;
    }
  },
});
```

---

## 5. 需求工具设计

### 5.1 CreateRequirement

```typescript
// src/runtime/tools/requirement-tools.ts

const CreateRequirementTool = buildTool({
  name: "CreateRequirement",
  category: "agent",
  description: "创建新的需求记录。用于项目分析时发现问题并记录到需求池。",
  isReadOnly: false,
  isConcurrencySafe: false,

  input: z.object({
    title: z.string().describe("需求标题，简洁明了"),
    description: z.string().describe("需求详细描述"),
    priority: z.enum(['low', 'normal', 'high', 'critical'])
      .default('normal').describe("优先级"),
    impactScope: z.string().optional().describe("影响范围，如 '支付模块'"),
  }),

  execute: async (input, ctx) => {
    if (!ctx.requirementStore || !ctx.projectId) {
      return "Error: Requirement context not available";
    }
    const req = ctx.requirementStore.create({
      projectId: ctx.projectId,
      title: input.title,
      description: input.description,
      status: 'found',
      source: 'analyst',
      priority: input.priority,
      impactScope: input.impactScope,
      reviewer: 'analyst',
    });

    // 高优先级通知（M5 完善通知系统后接入）
    if (input.priority === 'high' || input.priority === 'critical') {
      // 预留通知 hook 点
    }

    return `Requirement created: ${req.id}\nTitle: ${input.title}\nPriority: ${input.priority}`;
  },
});
```

---

## 6. Analyst 服务设计

### 6.1 类结构

```typescript
class AnalystService {
  private agentService: AgentService;
  private projectStore: ProjectStore;
  private wikiStore: ProjectWikiStore;
  private requirementStore: RequirementStore;
  private templateStore: TemplateStore;

  constructor(deps: {
    agentService: AgentService;
    projectStore: ProjectStore;
    wikiStore: ProjectWikiStore;
    requirementStore: RequirementStore;
    templateStore: TemplateStore;
  });

  /** 确保 Analyst AgentRecord 存在（不存在则创建） */
  async ensureAnalystAgent(project: ProjectRecord): Promise<string>;

  /** 冷启动：全量分析新项目 */
  async runFullAnalysis(projectId: string): Promise<void>;

  /** 增量分析：基于 git diff + Wiki 基线 */
  async runIncrementalAnalysis(projectId: string): Promise<void>;

  /** 构建 Analyst 的 ToolExecutionContext 扩展 */
  private buildAnalystToolContext(project: ProjectRecord): Partial<ToolExecutionContext>;

  /** 构建冷启动 prompt（用户消息，非 system prompt） */
  private buildColdStartPrompt(project: ProjectRecord): string;

  /** 构建增量分析 prompt（用户消息） */
  private buildIncrementalPrompt(project: ProjectRecord, diff: string): string;
}
```

### 6.2 ensureAnalystAgent — 自动创建 AgentRecord

```typescript
async ensureAnalystAgent(project: ProjectRecord): Promise<string> {
  // 检查是否已存在
  const existing = this.agentService.listAgents()
    .find(a => a.metadata?.role === 'analyst' && a.metadata?.projectId === project.id);
  if (existing) return existing.id;

  // 构建角色 systemPrompt (T1)
  const systemPrompt = buildWorkflowSystemPrompt('analyst', this.templateStore);

  // 创建 AgentRecord
  const agent = this.agentService.createAgent({
    name: `Analyst-${project.name}`,
    systemPrompt,
    toolPolicy: getRoleConfig('analyst').toolPolicy,
    metadata: { role: 'analyst', projectId: project.id },
  });

  return agent.id;
}
```

### 6.3 冷启动流程

```
runFullAnalysis(projectId)
  │
  ├─ 1. 获取 ProjectRecord
  │     └─ projectStore.get(projectId)
  │
  ├─ 2. 检查是否已有 Wiki 数据
  │     └─ wikiStore.listByProject(projectId)
  │     └─ 如果已有节点 → 走增量分析
  │
  ├─ 3. ensureAnalystAgent(project)    ← 自动创建 AgentRecord
  │     └─ 返回 agentId
  │
  ├─ 4. 创建 SessionRecord
  │     └─ SessionConfig 含:
  │       - systemPrompt = buildWorkflowSystemPrompt('analyst', templateStore)  ← T1
  │       - agentRole = 'analyst'
  │       - projectContext = { projectId, projectName, projectPath }
  │       - workspaceDir = project.path
  │
  ├─ 5. 构建 ToolExecutionContext 扩展
  │     └─ { wikiStore, requirementStore, projectId, agentRole: 'analyst' }
  │
  ├─ 6. 发送冷启动 prompt（用户消息）
  │     └─ "请全面分析项目..."          ← 首条 user message → T3
  │
  ├─ 7. 执行（AgentLoop.run）
  │     ├─ T1: systemPrompt = Researcher + analyst append
  │     ├─ T2: PreLLMCall Hook 注入 Wiki baseline + 项目信息
  │     └─ T3: 工具调用结果自然积累
  │
  └─ 8. 更新 lastAnalysisAt
        └─ projectStore.update(projectId, { lastAnalysisAt: now() })
```

### 6.4 冷启动 Prompt（用户消息）

```
请全面分析项目「{projectName}」，为其构建代码知识树。

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

完成后简要说明项目概况。
```

### 6.5 增量分析流程

```
runIncrementalAnalysis(projectId)
  │
  ├─ 1. 获取 ProjectRecord + lastAnalysisAt
  │
  ├─ 2. 获取增量 diff
  │     └─ git log/diff --since={lastAnalysisAt}
  │     └─ 如果无 diff → 跳过
  │
  ├─ 3. ensureAnalystAgent(project)
  │
  ├─ 4. 创建新 SessionRecord（或复用已有会话）
  │     └─ 同样的 T1 systemPrompt
  │     └─ projectContext = { projectId, projectName, projectPath }
  │     └─ workspaceDir = project.path
  │
  ├─ 5. 发送增量 prompt（用户消息）
  │     └─ buildIncrementalPrompt(project, diff)
  │     └─ diff 直接嵌入用户消息（T3），不走 T2 Hook
  │     └─ T2 Hook 会自动注入最新 Wiki baseline（每 turn 从 DB 读取）
  │
  └─ 6. 更新 lastAnalysisAt
```

**gitDiff 传递方式**：增量分析时 diff 已在 AnalystService 手里，
直接拼入用户消息 `buildIncrementalPrompt(project, diff)` 发送，
不通过 PreLLMCall Hook 传递。
T2 Hook 只负责注入 Wiki baseline（每 turn 从 DB 读最新值，反映 Analyst 的实时更新）。

---

## 7. 工具注册

### 7.1 ALL_TOOLS 追加

```typescript
// src/runtime/tools/index.ts

import { ExpandNodeTool, UpdateWikiNodeTool } from './wiki-tools';
import { CreateRequirementTool } from './requirement-tools';

const ALL_TOOLS = {
  // ... 现有工具 ...
  ExpandNode: ExpandNodeTool,
  UpdateWikiNode: UpdateWikiNodeTool,
  CreateRequirement: CreateRequirementTool,
};
```

### 7.2 CONDITIONAL_TOOLS 追加

```typescript
const CONDITIONAL_TOOLS: Record<string, (ctx: ToolExecutionContext) => boolean> = {
  // ... 现有条件工具 ...
  ExpandNode: (ctx) => !!ctx.wikiStore,
  UpdateWikiNode: (ctx) => !!ctx.wikiStore,
  CreateRequirement: (ctx) => !!ctx.requirementStore,
};
```

---

## 8. 错误处理

| 场景 | 处理策略 |
|------|----------|
| 项目路径不存在 | runFullAnalysis 前校验 path，不存在则标记项目 paused 并跳过 |
| 分析中 Agent 异常 | catch 后记录错误到 requirement_messages，不阻塞项目创建响应 |
| Wiki 节点路径冲突 | UpdateWikiNode 做 upsert，不报错 |
| 冷启动超时 | AgentLoop 自身的超时机制处理，Analyst 不额外处理 |
| 并发分析同一项目 | 检查 project.analystSessionId 是否已有活跃会话 |
| 基座模板不存在 | buildWorkflowSystemPrompt 降级：只用 promptAppend，无基座 |

---

## 9. 集成点

### 9.1 server/index.ts

```typescript
// 注册工作流上下文 Hook（T2 注入）
registerWorkflowContextHook({
  projectStore, requirementStore, wikiStore, taskStepStore,
});

// 实例化 AnalystService
const analystService = new AnalystService({
  agentService,
  projectStore,
  wikiStore,
  requirementStore,
  templateStore,
});

// 传递给 router
app.use("/api/projects", createProjectRouter({
  projectStore, requirementStore, wikiStore, analystService,
}));
```

### 9.2 IpcContext 扩展

```typescript
// src/main/ipc/types.ts
interface IpcContext {
  // ... 现有 ...
  analystService: AnalystService;
}
```

---

## 10. 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新建** | `src/runtime/agent-roles.ts` | 5 个角色定义 + prompt 构建函数 |
| **新建** | `src/server/workflow-context-hook.ts` | T2 PreLLMCall Hook |
| **修改** | `src/runtime/types.ts` | ToolExecutionContext + SessionConfig 扩展 |
| **新建** | `src/runtime/tools/wiki-tools.ts` | ExpandNode + UpdateWikiNode |
| **新建** | `src/runtime/tools/requirement-tools.ts` | CreateRequirement |
| **修改** | `src/runtime/tools/index.ts` | 注册新工具 + 条件检查 |
| **新建** | `src/server/analyst-service.ts` | Analyst 生命周期管理 |
| **修改** | `src/server/agent-service.ts` | 创建工作流 AgentRecord 的辅助方法 |
| **修改** | `src/server/project-router.ts` | 冷启动触发 + 手动巡检 |
| **修改** | `src/server/index.ts` | AnalystService + Hook 注册 |
| **修改** | `src/main/ipc/types.ts` | IpcContext 扩展 |

**不改动**:
- `src/server/template-store.ts` — 模板体系不动
- `src/core/persona.ts` — Persona 体系不动
- `src/runtime/context-message.ts` — 复用现有通道，不改
- `src/runtime/agent-loop.ts` — 复用现有 PreLLMCall → memoryContext 通道，不改
- `src/runtime/prompt-sections.ts` — 复用现有 Assembler，不改
