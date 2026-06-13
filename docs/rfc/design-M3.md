# M3 设计文档：编排器 + 任务执行

> **版本**: 1.0
> **对应计划**: `plan-M3.md`
> **依赖**: M1（数据基础）, M2（角色系统 + 工具）
> **目标**: Orchestrate 工具、Lead 服务、Hook 状态流转、sub-agent 生命周期

---

## 1. Orchestrate 工具设计

### 1.1 工具定义

```typescript
// src/runtime/tools/orchestrate-tool.ts

const OrchestrateTool = buildTool({
  name: "Orchestrate",
  category: "agent",
  description: "调度子 Agent 执行任务。通过此工具间接管理 Developer、Reviewer、QA。",
  isReadOnly: false,
  isConcurrencySafe: false,  // 同一时间只允许一个 sub-agent 执行

  input: z.object({
    role: z.enum(['developer', 'reviewer', 'qa'])
      .describe("子 Agent 角色"),
    task: z.string()
      .describe("具体任务描述，包含目标、要求和约束"),
    wikiNodes: z.array(z.string()).optional()
      .describe("需要展开的 Wiki 节点路径，为子 Agent 提供上下文"),
    relatedFiles: z.array(z.string()).optional()
      .describe("相关的文件路径列表"),
  }),

  execute: async (input, ctx) => {
    // 见下方流程
  },
});
```

### 1.2 执行流程

```
Orchestrate.execute(input, ctx)
  │
  ├─ 1. 校验上下文
  │     ├─ ctx.createRoleLoop 必须存在
  │     ├─ ctx.activeRequirementId 必须存在
  │     └─ ctx.projectId 必须存在
  │
  ├─ 2. 加载 Wiki 上下文（如果有 wikiNodes）
  │     ├─ 遍历 input.wikiNodes
  │     ├─ wikiStore.getByPath(ctx.projectId, path)
  │     ├─ 如果 detail 为空 → 按 summary 使用
  │     └─ 拼接成 wikiContext 字符串
  │
  ├─ 3. 获取角色配置
  │     └─ getRoleConfig(input.role)
  │     └─ systemPromptTemplate, toolPolicy, recommendedModel
  │
  ├─ 4. 创建 TaskStepRecord
  │     └─ taskStepStore.create({
  │           requirementId: ctx.activeRequirementId,
  │           stepOrder: nextStepOrder,
  │           role: input.role,
  │           title: input.task.substring(0, 100),
  │           description: input.task,
  │           status: 'running',
  │           input: JSON.stringify(input),
  │           startedAt: new Date().toISOString(),
  │         })
  │
  ├─ 5. 构建 sub-agent 上下文
  │     ├─ systemPrompt = buildRoleSystemPrompt(input.role, { ... })
  │     ├─ 追加任务描述到 systemPrompt
  │     └─ 追加 wikiContext（如果存在）
  │
  ├─ 6. 调用 createRoleLoop 创建 sub-agent
  │     └─ const { result, changedFiles } = await ctx.createRoleLoop({
  │           role: input.role,
  │           task: input.task,
  │           systemPrompt,
  │           toolPolicy: roleConfig.toolPolicy,
  │           wikiContext,
  │           workspaceDir: ctx.projectPath,
  │         })
  │
  ├─ 7. 更新 TaskStepRecord
  │     └─ taskStepStore.update(stepId, {
  │           status: 'completed',
  │           output: JSON.stringify({ result, changedFiles }),
  │           completedAt: new Date().toISOString(),
  │         })
  │
  └─ 8. 返回摘要给 Lead
        └─ "Step completed: {role} 执行了 {task}\n结果: {result}\n变更文件: {changedFiles}"
```

### 1.3 错误处理

```
Orchestrate 执行中如果 sub-agent 失败:
  ├─ 捕获异常
  ├─ taskStepStore.update(stepId, {
  │     status: 'failed',
  │     error: err.message,
  │     completedAt: now(),
  │   })
  └─ 返回错误摘要给 Lead: "Step failed: {role} - {error}"
     Lead 决定是重试还是调整计划
```

---

## 2. ToolExecutionContext 扩展

### 2.1 编排器专用字段

```typescript
// src/runtime/types.ts — ToolExecutionContext 追加

interface ToolExecutionContext {
  // ... M1/M2 字段 ...

  // 编排器上下文
  createRoleLoop?: (params: {
    role: string;
    task: string;
    systemPrompt: string;
    toolPolicy: { allow: string[]; deny: string[] };
    wikiContext?: string;
    workspaceDir?: string;
  }) => Promise<{
    result: string;           // sub-agent 执行结果摘要
    changedFiles: string[];   // 变更文件列表
  }>;

  // 项目路径（AgentLoop toolContext 构造时注入）
  projectPath?: string;
}
```

**注意**：`activeRequirementId` 统一放在 `SessionConfig.projectContext.activeRequirementId`
（已在 design-M2 定义），不重复放在 ToolExecutionContext。
Orchestrate 工具通过 `ctx` 上的 `taskStepStore`（需要额外注入）
和 `projectContext.activeRequirementId` 访问需求 ID。

---

## 3. Lead 服务设计

### 3.1 类结构

```typescript
// src/server/lead-service.ts

class LeadService {
  private agentService: AgentService;
  private requirementStore: RequirementStore;
  private taskStepStore: TaskStepStore;
  private wikiStore: ProjectWikiStore;
  private projectStore: ProjectStore;

  constructor(deps: {
    agentService: AgentService;
    requirementStore: RequirementStore;
    taskStepStore: TaskStepStore;
    wikiStore: ProjectWikiStore;
    projectStore: ProjectStore;
  });

  /** 领取就绪需求，启动 Lead session */
  async pickupRequirement(requirementId: string): Promise<string>;

  /** 获取执行进度 */
  getProgress(requirementId: string): LeadProgress;

  /** 构建 Lead 的工具上下文 */
  private buildLeadToolContext(
    project: ProjectRecord,
    requirement: RequirementRecord
  ): Partial<ToolExecutionContext>;

  /** 构建 Lead 的首次 prompt */
  private buildPickupPrompt(requirement: RequirementRecord): string;
}

interface LeadProgress {
  requirement: RequirementRecord;
  steps: TaskStepRecord[];
  currentStep: TaskStepRecord | undefined;
  completedCount: number;
  totalCount: number;
}
```

### 3.2 自动领取机制

Lead 不是由用户手动触发，而是**空闲时自动按优先级领取**。

```typescript
// src/server/lead-service.ts

class LeadService {
  // ... 现有方法 ...

  /** 检查并自动领取下一个就绪需求 */
  async autoPickupIfIdle(projectId: string): Promise<string | null> {
    // 1. 检查 Lead 是否空闲（无 assignedLeadSessionId 或 session 已结束）
    const project = this.projectStore.get(projectId);
    if (!project) return null;

    // 检查是否有正在执行的需求
    const activeReqs = this.requirementStore.listByStatus('build')
      .filter(r => r.projectId === projectId);
    const planReqs = this.requirementStore.listByStatus('plan')
      .filter(r => r.projectId === projectId);
    if (activeReqs.length > 0 || planReqs.length > 0) return null;

    // 2. 按 priority 降序获取就绪需求
    const readyReqs = this.requirementStore.listByStatus('ready')
      .filter(r => r.projectId === projectId && !r.assignedLeadSessionId);

    // priority 排序：critical > high > normal > low
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
    readyReqs.sort((a, b) =>
      (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3)
    );

    if (readyReqs.length === 0) return null;

    // 3. 领取第一个
    return this.pickupRequirement(readyReqs[0].id);
  }
}
```

**触发时机**：
- `requirement-hooks.ts` 的 `PostTurnComplete` Hook：Lead 完成一个需求后，检查是否有下一个
- `requirement-hooks.ts` 的状态流转 Hook：需求变为 `ready` 时触发 `autoPickupIfIdle`
- 项目创建后的首次就绪需求

### 3.3 领取流程

```
pickupRequirement(requirementId)
  │
  ├─ 1. 校验需求状态
  │     ├─ requirement.status === 'ready'
  │     └─ 否则抛出 InvalidStatusError
  │
  ├─ 2. 获取关联项目
  │     └─ projectStore.get(requirement.projectId)
  │
  ├─ 3. 创建 Lead AgentRecord（或复用）
  │     └─ 如果项目已有 lead agent → 复用
  │     └─ 否则创建新的 AgentRecord（name="Lead-{projectName}"）
  │
  ├─ 4. 创建持续会话 SessionRecord
  │     └─ agentService.createSession(agentId, { agentRole: 'lead', ... })
  │
  ├─ 5. 更新需求
  │     └─ requirementStore.update(requirementId, {
  │           assignedLeadSessionId: sessionId,
  │         })
  │
  ├─ 6. 状态流转：ready → plan
  │     └─ requirementStore.transitionStatus(requirementId, 'plan', 'lead', 'Lead 领取需求')
  │
  ├─ 7. 构建 Lead 工具上下文
  │     └─ buildLeadToolContext(project, requirement)
  │     └─ 注入: wikiStore, requirementStore, createRoleLoop, projectId,
  │              agentRole='lead', projectPath
  │
  ├─ 8. 构建领取 prompt
  │     └─ buildPickupPrompt(requirement)
  │
  └─ 9. 执行
        └─ agentService.sendRolePrompt(agentId, sessionId, 'lead', prompt, context)
        └─ 返回 sessionId
        └─ agentService.sendRolePrompt(agentId, sessionId, 'lead', prompt, context)
        └─ 返回 sessionId
```

### 3.3 领取 Prompt 模板

```
需求「{title}」已确认就绪，请分析并制定执行计划。

需求描述：
{description}

优先级：{priority}
影响范围：{impactScope}

相关上下文：
{context}

请完成以下步骤：
1. 先使用 Read/Grep/Glob 工具了解相关代码现状
2. 使用 ExpandNode 展开相关 Wiki 节点获取背景
3. 制定执行计划，明确每步由哪个角色（developer/reviewer/qa）执行
4. 使用 Orchestrate 工具依次调度各角色执行
5. 汇总结果，确认需求是否完整实现

注意：
- 执行步骤应按照：开发 → 审查 → 测试 的顺序
- 审查不通过时可以调整方案并重新调度 developer
- 测试不通过时可以修复并重新测试
- 最多重试 {maxRetries} 次
```

### 3.4 createRoleLoop 注入路径

**核心问题**：Orchestrate 工具的 execute 函数只能访问 `ctx`（ToolExecutionContext），
它需要 `createRoleLoop` 函数来创建 sub-agent AgentLoop。
这个函数必须通过 ToolExecutionContext 注入。

**注入链**：

```
AgentService
  → 持有 providers、config 等创建 AgentLoop 的材料
  → 提供 createRoleLoopFactory(project, wikiStore, taskStepStore) 方法

LeadService.pickupRequirement()
  → 调用 agentService.createRoleLoopFactory(project, wikiStore, taskStepStore)
  → 得到 createRoleLoop 函数
  → 在 buildLeadToolContext() 中注入到 ToolExecutionContext
    → ctx.createRoleLoop = createRoleLoopFn

AgentLoop 构造
  → this.toolContext = { ...config, createRoleLoop }

OrchestrateTool.execute(input, ctx)
  → ctx.createRoleLoop(params)  ← 直接可用
  → 内部创建临时 AgentLoop，执行完释放
```

```typescript
// src/server/agent-service.ts — 新增公开方法

class AgentService {
  // ... 现有方法 ...

  /** 创建角色循环工厂 — 供 LeadService 使用 */
  createRoleLoopFactory(
    project: ProjectRecord,
    wikiStore: ProjectWikiStore,
    taskStepStore: TaskStepStore
  ): ToolExecutionContext["createRoleLoop"] {
    return async (params) => {
      // 1. 获取角色配置
      const roleConfig = getRoleConfig(params.role);

      // 2. 构建角色 systemPrompt（T1）
      const systemPrompt = params.systemPrompt ||
        buildWorkflowSystemPrompt(params.role, this.templateStore);

      // 3. 创建临时 AgentLoop（不存 DB，无持久化）
      const subConfig: SessionConfig = {
        agentId: `role-${params.role}-${Date.now()}`,
        workspaceDir: params.workspaceDir || project.path,
        systemPrompt,
        agentRole: params.role,
        projectContext: {
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
        },
      };

      // 4. 构建工具集（使用角色的 toolPolicy）
      const subCtx: Partial<ToolExecutionContext> = {
        wikiStore,
        projectId: project.id,
        agentRole: params.role,
      };

      // 5. 创建并执行 AgentLoop
      const loop = new AgentLoop(subConfig, this.providers, {
        onToolUse: () => {},  // 可选：记录 sub-agent 工具日志
      });

      const result = await loop.run(params.task);

      // 6. 收集变更文件
      const changedFiles: string[] = [];
      // git diff --name-only 或从 session messages 中提取

      return { result, changedFiles };
    };
  }
}
```

```typescript
// src/server/lead-service.ts — 注入到 ToolExecutionContext

class LeadService {
  private buildLeadToolContext(
    project: ProjectRecord,
    requirement: RequirementRecord
  ): Partial<ToolExecutionContext> {
    // 从 AgentService 获取工厂
    const createRoleLoop = this.agentService.createRoleLoopFactory(
      project, this.wikiStore, this.taskStepStore
    );

    return {
      wikiStore: this.wikiStore,
      requirementStore: this.requirementStore,
      projectId: project.id,
      agentRole: 'lead',
      projectPath: project.path,
      createRoleLoop,                       // ← 注入到 ctx
      activeRequirementId: requirement.id,   // ← 注入到 ctx
    };
  }
}
```

---

## 4. 状态流转 Hook

### 4.1 Hook 注册

```typescript
// src/server/requirement-hooks.ts

export function registerRequirementHooks(deps: {
  requirementStore: RequirementStore;
  taskStepStore: TaskStepStore;
  leadService: LeadService;
  notificationService?: any;  // M5 注入
}): void {

  // Hook 1: PostToolUse — 追踪 Orchestrate 调用
  hookRegistry.register("PostToolUse", async (ctx) => {
    if (ctx.toolName !== "Orchestrate") return;

    const reqId = ctx.sessionConfig?.projectContext?.activeRequirementId;
    if (!reqId) return;

    const req = deps.requirementStore.get(reqId);
    if (!req) return;

    // 如果需求还在 plan 状态且有 task_steps 被创建 → 推进到 build
    if (req.status === 'plan') {
      const steps = deps.taskStepStore.listByRequirement(reqId);
      if (steps.length > 0) {
        deps.requirementStore.transitionStatus(reqId, 'build', 'lead', 'Lead 开始执行步骤');
      }
    }
  });

  // Hook 2: PostTurnComplete — Lead 会话完成时检查步骤状态
  hookRegistry.register("PostTurnComplete", async (ctx) => {
    if (ctx.agentRole !== "lead") return;

    const projectId = ctx.sessionConfig?.projectContext?.projectId;
    const reqId = ctx.sessionConfig?.projectContext?.activeRequirementId;
    if (!projectId || !reqId) return;

    const steps = deps.taskStepStore.listByRequirement(reqId);
    const allCompleted = steps.length > 0 && steps.every(s =>
      s.status === 'completed' || s.status === 'skipped'
    );
    const hasFailed = steps.some(s => s.status === 'failed');

    if (allCompleted) {
      deps.requirementStore.transitionStatus(reqId, 'verify', 'system', '所有步骤已完成');
    } else if (hasFailed) {
      // 通知（M5 完善）
    }

    // Lead 完成当前需求后，检查是否有下一个就绪需求可自动领取
    // 不 await — 不阻塞当前会话的清理
    deps.leadService.autoPickupIfIdle(projectId).catch(() => {});
  });
}
```

### 4.2 Hook 触发时序

```
Lead 会话开始
  │
  ├─ Lead 分析需求，阅读代码
  ├─ Lead 制定步骤计划
  │
  ├─ Lead 调用 Orchestrate({ role: 'developer', task: '...' })
  │   ├─ PostToolUse 触发
  │   │   └─ 检测到 task_step 创建 → status plan→build
  │   └─ Sub-agent 执行
  │       └─ 返回结果
  │
  ├─ Lead 调用 Orchestrate({ role: 'reviewer', task: '...' })
  │   └─ Sub-agent 执行审查
  │       └─ 返回结果
  │
  ├─ Lead 调用 Orchestrate({ role: 'qa', task: '...' })
  │   └─ Sub-agent 执行测试
  │       └─ 返回结果
  │
  ├─ Lead 汇总结果
  └─ Lead 会话结束
      └─ PostTurnComplete 触发
          └─ 检查所有 steps → allCompleted → status build→verify
```

---

## 5. IPC 通道

### 5.1 新增通道

```typescript
"lead:pickup"    — { requirementId: string } → { sessionId: string }
// pickup 不暴露给 UI，由后端 autoPickupIfIdle 自动调用
// IPC 通道保留供内部调用（如崩溃恢复后手动重试）
"lead:progress"  — { requirementId: string } → {
  requirement: RequirementRecord;
  steps: TaskStepRecord[];
  currentStep: TaskStepRecord | undefined;
  completedCount: number;
  totalCount: number;
}
```

### 5.2 IPC Handler

```typescript
// src/main/ipc/requirement-handlers.ts 追加

typedHandle("lead:pickup", async (ctx, { requirementId }) => {
  const sessionId = await ctx.leadService.pickupRequirement(requirementId);
  return { sessionId };
});

typedHandle("lead:progress", async (ctx, { requirementId }) => {
  return ctx.leadService.getProgress(requirementId);
});
```

---

## 6. 工具注册

### 6.1 ALL_TOOLS 追加

```typescript
// src/runtime/tools/index.ts

import { OrchestrateTool } from './orchestrate-tool';

const ALL_TOOLS = {
  // ... 现有 + M2 工具 ...
  Orchestrate: OrchestrateTool,
};
```

### 6.2 CONDITIONAL_TOOLS 追加

```typescript
const CONDITIONAL_TOOLS = {
  // ... 现有 ...
  Orchestrate: (ctx) => !!ctx.createRoleLoop,
};
```

---

## 7. 集成接线

### 7.1 server/index.ts

```typescript
// 实例化 LeadService
const leadService = new LeadService({
  agentService,
  requirementStore,
  taskStepStore,
  wikiStore,
  projectStore,
});

// 注册状态流转 Hook
registerRequirementHooks(requirementStore, taskStepStore);
```

### 7.2 IpcContext 扩展

```typescript
// src/main/ipc/types.ts
interface IpcContext {
  // ... 现有 + M2 ...
  leadService: LeadService;
}
```

---

## 8. 错误处理

| 场景 | 处理策略 |
|------|----------|
| 领取非 ready 状态的需求 | pickupRequirement 抛出 InvalidStatusError，IPC 返回 400 |
| Orchestrate 缺少 createRoleLoop | 返回 "Error: Orchestrate not available in this context" |
| Sub-agent 执行超时 | AgentLoop 自身超时 → step 标记 failed → Lead 决定重试 |
| Sub-agent 执行失败 | step 标记 failed + error → Lead 收到失败摘要 |
| Lead 会话异常 | 所有 running 状态的 steps 标记 failed → 需求可恢复 |
| 并发领取同一需求 | 第二次检测到 assignedLeadSessionId 已存在 → 拒绝 |
| Wiki 节点不存在 | ExpandNode 返回 not found，sub-agent 自行判断 |
| createRoleLoop 工厂失败 | catch → step 标记 failed → Lead 收到错误 |

---

## 9. 重试策略

### 9.1 步骤级重试

```
Orchestrate 返回失败后:
  ├─ Lead 判断是否值得重试
  │   ├─ 是 → 再次调用 Orchestrate（相同 role + 修正的 task）
  │   └─ 否 → 调整计划或放弃该步骤
  │
  └─ TaskStepRecord:
        retry_count += 1
        如果 retry_count >= max_retries → step 状态 'failed'
```

### 9.2 重试限制

- 默认 `max_retries = 3`
- 每次重试可修改 task 描述（Lead 自行判断）
- 超过重试限制后 Lead 决定是否跳过或需求退回
