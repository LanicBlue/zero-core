# M2 子计划：项目分析 Agent

> **状态**: 待实施
> **依赖**: M1（数据基础）
> **目标**: 创建项目后 Analyst Agent 冷启动生成 Wiki 浅层树；手动触发巡检可增量分析并创建需求

---

## 实施步骤

### Step 1: 角色定义 — `src/runtime/agent-roles.ts`

定义 5 个预置角色的配置，每个角色包含：
- `role` — 角色标识
- `systemPromptTemplate` — 参数化 system prompt（支持 `{projectName}`, `{projectPath}` 等变量）
- `recommendedModel` — 推荐模型 ID
- `toolPolicy` — 工具策略（启用/禁用哪些工具）
- `capabilities` — 能力列表（如 `create_requirement`, `update_wiki`）

```
analyst:  全部工具 + CreateRequirement + UpdateWikiNode + ExpandNode, 推荐 Opus
lead:     全部工具 + Orchestrate, 推荐 Opus
developer: Read + Write + Edit + Shell + Grep + Glob, 推荐 Sonnet
reviewer: Read + Grep + Glob + Shell(只读), 推荐 Sonnet
qa:       Read + Write + Shell + Grep + Glob, 推荐 Haiku
```

导出 `buildRoleSystemPrompt(role, context)` 函数，将模板变量替换为实际值。

---

### Step 2: ToolExecutionContext 扩展 — `src/runtime/types.ts`

在 `ToolExecutionContext` 接口中追加：

```typescript
// Multi-Agent Workflow context
wikiStore?: any;                    // ProjectWikiStore
requirementStore?: any;             // RequirementStore
projectId?: string;                 // 当前项目 ID
agentRole?: string;                 // 当前 agent 角色
```

在 `SessionConfig` 接口中追加：

```typescript
agentRole?: string;                 // analyst | lead | developer | reviewer | qa
projectContext?: {
  projectId: string;
  projectName: string;
  projectPath: string;
};
```

---

### Step 3: Wiki 工具 — `src/runtime/tools/wiki-tools.ts`

遵循 `buildTool()` 模式，创建两个工具：

#### ExpandNode
```
name: "ExpandNode"
category: "agent", isReadOnly: true
input: { path: string }
execute: 从 ctx.wikiStore 按 projectId + path 查询，返回 detail 字段
```

#### UpdateWikiNode
```
name: "UpdateWikiNode"
category: "agent", isReadOnly: false
input: { path: string, summary?: string, detail?: string }
execute: upsert wiki 节点（有则更新，无则创建）
```

两个工具都需要 `ctx.wikiStore` 和 `ctx.projectId`，在 `CONDITIONAL_TOOLS` 中注册条件检查。

---

### Step 4: 需求工具 — `src/runtime/tools/requirement-tools.ts`

#### CreateRequirement
```
name: "CreateRequirement"
category: "agent", isReadOnly: false
input: { title: string, description: string, priority: enum, impactScope?: string }
execute:
  1. 通过 ctx.requirementStore 创建需求（status='found', source='analyst'）
  2. 如果 priority 是 high/critical，emit 通知事件
  3. 返回创建的需求 ID
```

在 `CONDITIONAL_TOOLS` 中注册条件：`ctx.requirementStore` 存在时才可用。

---

### Step 5: 工具注册 — `src/runtime/tools/index.ts`

在 `ALL_TOOLS` 中追加 `ExpandNode`, `UpdateWikiNode`, `CreateRequirement`。

在 `CONDITIONAL_TOOLS` 中追加：
```typescript
ExpandNode: (ctx) => !!ctx.wikiStore,
UpdateWikiNode: (ctx) => !!ctx.wikiStore,
CreateRequirement: (ctx) => !!ctx.requirementStore,
```

---

### Step 6: Analyst 服务 — `src/server/analyst-service.ts`

核心服务类，管理 Analyst Agent 的生命周期。

```typescript
class AnalystService {
  // 依赖：agentService, projectStore, wikiStore, requirementStore, providerStore

  // 冷启动：全量分析新项目
  async runFullAnalysis(projectId: string): Promise<void>
  // 1. 获取 ProjectRecord
  // 2. 创建/复用 analyst agent 的 AgentRecord
  // 3. 构建 SessionConfig（agentRole='analyst', workspaceDir=project.path）
  // 4. 注入 wikiStore + requirementStore 到 ToolExecutionContext
  // 5. 构建冷启动 prompt："扫描项目结构，为每个目录/文件创建 Wiki 浅层节点..."
  // 6. 通过 agentService.sendPrompt() 执行
  // 7. 更新 project.lastAnalysisAt

  // 增量分析：git diff + Wiki 基线
  async runIncrementalAnalysis(projectId: string): Promise<void>
  // 1. 获取 ProjectRecord + lastAnalysisAt
  // 2. 执行 git diff --since 获取增量变更
  // 3. 加载当前 Wiki 浅层摘要作为基线
  // 4. 构建增量分析 prompt："以下是自上次分析以来的变更...请检查并更新 Wiki 或创建需求"
  // 5. 通过 agentService.sendPrompt() 执行

  // 为 analyst agent 构建工具上下文
  private buildAnalystToolContext(project: ProjectRecord): Partial<ToolExecutionContext>
  // 设置 wikiStore, requirementStore, projectId, agentRole

  // 冷启动 prompt 模板
  private buildColdStartPrompt(project: ProjectRecord): string

  // 增量 prompt 模板
  private buildIncrementalPrompt(project: ProjectRecord, diff: string, wikiSummary: string): string
}
```

---

### Step 7: AgentService 角色感知 — `src/server/agent-service.ts`

修改 `sendPrompt()` 或新增方法，当 `agentRole` 设置时：

1. 从 `agent-roles.ts` 获取角色配置
2. 用 `buildRoleSystemPrompt()` 生成 system prompt
3. 在 `buildToolsSet()` 时注入角色的 toolPolicy
4. 将 `wikiStore` / `requirementStore` 注入 `ToolExecutionContext`

新增方法：
```typescript
async sendRolePrompt(
  agentId: string,
  sessionId: string,
  role: string,
  prompt: string,
  context: { projectId?: string; projectPath?: string; wikiStore?: any; requirementStore?: any }
): Promise<void>
```

---

### Step 8: 项目创建触发冷启动 — `src/server/project-router.ts` (修改)

在 `POST /` 创建项目路由中，异步触发冷启动：

```typescript
// 创建项目后
res.json(project);
// 异步触发冷启动分析（不阻塞响应）
analystService.runFullAnalysis(project.id).catch(err => {
  log.error("analyst", "Cold start analysis failed:", err.message);
});
```

---

### Step 9: 手动触发巡检 — `src/server/project-router.ts` (修改)

实现 `POST /:id/trigger-analysis` 路由：

```typescript
router.post("/:id/trigger-analysis", async (req, res) => {
  const project = projectStore.get(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  // 如果是首次（无 lastAnalysisAt），走冷启动；否则走增量
  if (project.lastAnalysisAt) {
    analystService.runIncrementalAnalysis(project.id);
  } else {
    analystService.runFullAnalysis(project.id);
  }
  res.json({ ok: true, message: "Analysis triggered" });
});
```

---

### Step 10: 集成接线

#### `src/server/index.ts`
- 实例化 AnalystService
- 传递给 project-router

#### `src/main/ipc/types.ts`
- 在 IpcContext 中追加 `analystService`

---

## 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新建** | `src/runtime/agent-roles.ts` | 5 个角色配置 + prompt 构建函数 |
| **修改** | `src/runtime/types.ts` | ToolExecutionContext + SessionConfig 扩展 |
| **新建** | `src/runtime/tools/wiki-tools.ts` | ExpandNode + UpdateWikiNode |
| **新建** | `src/runtime/tools/requirement-tools.ts` | CreateRequirement |
| **修改** | `src/runtime/tools/index.ts` | 注册新工具 + 条件检查 |
| **新建** | `src/server/analyst-service.ts` | Analyst 生命周期管理 |
| **修改** | `src/server/agent-service.ts` | 角色感知 prompt + 工具注入 |
| **修改** | `src/server/project-router.ts` | 冷启动触发 + 手动巡检 |
| **修改** | `src/server/index.ts` | AnalystService 实例化 |
| **修改** | `src/main/ipc/types.ts` | IpcContext 扩展 |

---

## 验证

1. `npm run build:lib` — 编译通过
2. 启动 App，创建项目 → 触发冷启动 → 检查 SQLite 中 `project_wiki` 表有数据
3. 手动触发巡检 → 检查是否有新需求入池
4. Agent 对话中可调用 ExpandNode / UpdateWikiNode / CreateRequirement 工具
