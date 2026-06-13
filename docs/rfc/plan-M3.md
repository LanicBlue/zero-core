# M3 子计划：编排器 + 任务执行

> **状态**: 待实施
> **依赖**: M1, M2
> **目标**: Lead Agent 领取就绪需求，通过编排器工具调度 Dev/Reviewer/QA sub-agent，步骤结果可追踪，状态自动流转

---

## 实施步骤

### Step 1: 编排器工具 — `src/runtime/tools/orchestrate-tool.ts`

核心工具，Lead 通过它间接管理 sub-agent。

```
name: "Orchestrate"
category: "agent", isReadOnly: false, isConcurrencySafe: false
input:
  role: z.enum(['developer', 'reviewer', 'qa'])
  task: z.string()                          // 具体任务描述
  wikiNodes: z.array(z.string()).optional() // Lead 指定展开的 Wiki 路径
  relatedFiles: z.array(z.string()).optional()

execute:
  1. 从 ctx 获取 wikiStore, projectId, requirementStore
  2. 加载 wikiNodes 对应节点的 detail（按需展开）
  3. 从 agent-roles.ts 获取角色配置（system prompt + toolPolicy）
  4. 构建角色 TaskStepRecord（写入 task_steps 表）
  5. 创建 sub-agent AgentLoop：
     - 复用 SubagentDelegator 的 LoopFactory 模式
     - SessionConfig.agentRole = input.role
     - SessionConfig.systemPrompt = 角色模板 + 任务描述 + Wiki 上下文
     - SessionConfig.toolPolicy = 角色工具策略
     - workspaceDir = 项目目录
  6. 执行 sub-agent
  7. 收集结果，生成摘要（改了什么文件、有什么问题）
  8. 更新 TaskStepRecord（output, status, completedAt）
  9. 返回摘要给 Lead
```

关键：编排器需要访问 `SubagentDelegator` 的 `LoopFactory`。实现方式：
- 在 `ToolExecutionContext` 中新增 `createRoleLoop?: (role, task, context) => Promise<string>`
- 由 AgentService 在创建 Lead session 时注入此函数

---

### Step 2: ToolExecutionContext 扩展 — `src/runtime/types.ts`

追加：
```typescript
// 编排器上下文
createRoleLoop?: (params: {
  role: string;
  task: string;
  systemPrompt: string;
  toolPolicy: any;
  wikiContext?: string;
  workspaceDir?: string;
}) => Promise<{ result: string; changedFiles: string[] }>;

// 需求上下文（编排器写入 task_steps）
activeRequirementId?: string;
```

---

### Step 3: Lead 服务 — `src/server/lead-service.ts`

管理 Lead Agent 的生命周期。

```typescript
class LeadService {
  // 依赖：agentService, requirementStore, taskStepStore, wikiStore, projectStore

  // 领取就绪需求
  async pickupRequirement(requirementId: string): Promise<string>
  // 1. 校验需求状态为 'ready'
  // 2. 获取需求关联的项目信息
  // 3. 创建 Lead AgentRecord（或复用现有）
  // 4. 创建持续会话 SessionRecord
  // 5. 更新 requirement.assignedLeadSessionId
  // 6. 需求状态 → 'plan'
  // 7. 构建 Lead prompt："以下需求已就绪，请分析并制定执行计划..."
  // 8. 通过 agentService.sendRolePrompt() 发送
  // 返回 sessionId

  // Lead 完成规划后，Hook 检测到 PostTurnComplete
  // → 检查是否有 task_steps 被创建（Lead 通过编排器创建步骤）
  // → 状态从 plan → build

  // 获取执行进度
  getProgress(requirementId: string): {
    steps: TaskStepRecord[];
    currentStep: TaskStepRecord | undefined;
    completedCount: number;
    totalCount: number;
  }

  // 构建 Lead 的工具上下文
  private buildLeadToolContext(
    project: ProjectRecord,
    requirement: RequirementRecord
  ): Partial<ToolExecutionContext>
  // 注入：wikiStore, requirementStore, createRoleLoop, projectId, agentRole='lead'
  //       activeRequirementId=requirement.id
}
```

---

### Step 4: 状态流转 Hook — `src/server/requirement-hooks.ts`

注册在 `PostTurnComplete` 和 `PostToolUse` 上的 Hook，自动推进需求状态。

```typescript
// PostToolUse Hook — 追踪 Orchestrate 工具调用
register("PostToolUse", async (ctx) => {
  if (ctx.toolName !== "Orchestrate") return;
  // 检查 requirement 当前状态
  // 如果是 'plan' 且有 task_steps 被创建 → 'build'
});

// PostTurnComplete Hook — Lead 会话完成时
register("PostTurnComplete", async (ctx) => {
  if (ctx.agentRole !== "lead") return;
  // 检查所有 task_steps 是否完成
  // 如果全部 completed → requirement.status = 'verify'
  // 如果有 failed → 记录并通知
});
```

---

### Step 5: 工具注册 — `src/runtime/tools/index.ts`

在 `ALL_TOOLS` 中追加 `Orchestrate`。

在 `CONDITIONAL_TOOLS` 中追加：
```typescript
Orchestrate: (ctx) => !!ctx.createRoleLoop,
```

---

### Step 6: AgentService 扩展 — `src/server/agent-service.ts`

新增角色感知的 prompt 发送方法（或复用 M2 已创建的方法）：

```typescript
// 为 Lead session 注入 createRoleLoop 函数
private createRoleLoopFactory(
  project: ProjectRecord,
  wikiStore: ProjectWikiStore
): ToolExecutionContext["createRoleLoop"] {
  return async (params) => {
    // 创建 sub-agent AgentLoop
    // 参考 SubagentDelegator.delegateTask() 的实现
    // 但使用角色特定的 toolPolicy 和 systemPrompt
    const subConfig: SessionConfig = {
      agentId: `${config.agentId}:role-${params.role}`,
      workspaceDir: project.path,
      systemPrompt: params.systemPrompt,
      modelId: /* 从角色配置获取 */,
      providerName: /* 从 provider 配置获取 */,
      toolPolicy: params.toolPolicy,
      agentRole: params.role,
      projectContext: { projectId: project.id, projectName: project.name, projectPath: project.path },
    };
    // 创建并执行 AgentLoop
    // 返回 { result, changedFiles }
  };
}
```

---

### Step 7: IPC 通道 + Handler

#### `src/shared/ipc-api.ts` 追加
```
"lead:pickup"        — { requirementId } → { sessionId }
"lead:progress"      — { requirementId } → { steps, currentStep, ... }
```

#### `src/main/ipc/requirement-handlers.ts` 修改
追加 `lead:pickup` 和 `lead:progress` 的 `typedHandle`。

---

### Step 8: 集成接线

#### `src/server/index.ts`
- 实例化 LeadService
- 注册 requirement-hooks

#### `src/main/ipc/types.ts`
- 在 IpcContext 中追加 `leadService`

#### `src/runtime/hooks/index.ts`
- 注册 requirement-hooks

---

## 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新建** | `src/runtime/tools/orchestrate-tool.ts` | 编排器工具 |
| **修改** | `src/runtime/types.ts` | ToolExecutionContext 扩展 |
| **新建** | `src/server/lead-service.ts` | Lead 生命周期管理 |
| **新建** | `src/server/requirement-hooks.ts` | 状态流转 Hook |
| **修改** | `src/runtime/tools/index.ts` | 注册 Orchestrate |
| **修改** | `src/server/agent-service.ts` | createRoleLoop 工厂 |
| **修改** | `src/shared/ipc-api.ts` | lead IPC 通道 |
| **修改** | `src/main/ipc/requirement-handlers.ts` | lead IPC handler |
| **修改** | `src/server/index.ts` | LeadService + hooks 注册 |
| **修改** | `src/main/ipc/types.ts` | IpcContext 扩展 |

---

## 验证

1. `npm run build:lib` — 编译通过
2. 准备一个 status='ready' 的需求
3. 调用 `lead:pickup` → Lead session 启动
4. Lead 应能调用 `Orchestrate` 工具调度 Dev/Reviewer/QA
5. 每次编排后 task_steps 表有新记录
6. 所有步骤完成后需求状态自动推进到 'verify'
