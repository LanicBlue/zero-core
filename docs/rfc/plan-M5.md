# M5 子计划：完善闭环

> **状态**: 待实施
> **依赖**: M3, M4
> **目标**: 定时巡检自动运行、验证归档自动化、Git 集成、重要通知、崩溃恢复

---

## 实施步骤

### Step 1: Cron 巡检调度 — `src/server/cron-analysis.ts`

利用现有 Cron 基础设施，为每个活跃项目注册定时巡检。

```typescript
class CronAnalysisManager {
  private analystService: AnalystService;
  private projectStore: ProjectStore;
  private scheduledJobs: Map<string, NodeJS.Timeout>;  // projectId → timer

  // 启动时恢复所有活跃项目的定时任务
  restoreSchedules(): void
  // 读取 projectStore.listActive()
  // 为每个项目按 analysisInterval 注册 setInterval
  // 回调：analystService.runIncrementalAnalysis(projectId)

  // 为新项目注册定时任务
  scheduleProject(projectId: string, interval: string): void
  // interval 映射：'daily' → 24h, 'hourly' → 1h, 或自定义 cron
  // 注册到 scheduledJobs

  // 移除项目定时任务
  unscheduleProject(projectId: string): void
  // 清除 timer，从 scheduledJobs 删除
}
```

**集成点**:
- `src/server/index.ts` 启动时调用 `cronManager.restoreSchedules()`
- `project-router.ts` 创建项目时调用 `scheduleProject()`
- `project-router.ts` 删除/暂停项目时调用 `unscheduleProject()`
- `project-router.ts` 更新 analysisInterval 时重新注册

---

### Step 2: 验证归档 — `src/server/analyst-service.ts` (修改)

在 AnalystService 中新增验证和归档方法。

```typescript
// 验证需求实现是否符合原始设计
async verifyRequirement(requirementId: string): Promise<{
  passed: boolean;
  report: string;
}> {
  // 1. 获取需求记录 + 所有 task_steps
  // 2. 收集变更文件列表（从 steps 的 output 中提取）
  // 3. 创建 Analyst 验证 session
  // 4. 构建 prompt："验证需求 [title] 是否已正确实现。
  //    原始需求描述：[description]
  //    变更文件：[file list]
  //    请检查实现是否符合需求，是否存在遗漏或偏差。"
  // 5. 执行，获取验证报告
  // 6. 返回 { passed, report }
}

// 归档需求并更新 Wiki
async archiveRequirement(requirementId: string): Promise<void> {
  // 1. 获取需求 + 变更文件列表
  // 2. 运行针对性 Wiki 更新：
  //    prompt："以下文件发生了变更，请更新相关 Wiki 节点的摘要：
  //    [变更文件列表 + diff 摘要]"
  // 3. 生成完成报告（需求摘要 + 步骤摘要 + 测试结果 + 审查意见）
  // 4. 将报告写入 requirement_messages（type='status_change'）
  // 5. 需求状态 → 'closed'
}
```

**触发点**: 当 Lead 完成所有步骤后（requirement 进入 `verify` 状态），
- 如果 `reviewer='analyst'`，自动调用 `verifyRequirement()` + `archiveRequirement()`
- 如果 `reviewer='user'`，等待用户在 UI 上点击"验证通过"后才调用 `archiveRequirement()`

---

### Step 3: Git 集成 — `src/server/git-integration.ts`

封装 Git 操作，供 Lead 服务和 Analyst 服务调用。

```typescript
class GitIntegration {
  // 创建需求分支
  async createRequirementBranch(
    projectPath: string,
    requirementId: string,
    title: string
  ): Promise<string>
  // 分支名格式：workflow/{requirementId}-{slug(title)}
  // git checkout -b {branch}

  // 获取自某时间以来的 diff（增量分析用）
  async getDiffSince(
    projectPath: string,
    sinceDate: string
  ): Promise<string>
  // git log --since={sinceDate} --oneline + git diff HEAD~{n}..HEAD

  // 获取变更文件列表（验证用）
  async getChangedFiles(
    projectPath: string,
    baseBranch?: string
  ): Promise<string[]>
  // git diff --name-only {base}..HEAD

  // 创建 PR（如果配置了远端）
  async createPullRequest(
    projectPath: string,
    requirementId: string,
    title: string,
    body: string
  ): Promise<{ url?: string; branch: string }>
  // 尝试 git push + gh pr create（如果 gh 可用）
  // 如果 gh 不可用，只 push 并返回分支名

  // 提交变更（步骤完成后可选）
  async commitChanges(
    projectPath: string,
    message: string
  ): Promise<void>
  // git add -A + git commit -m {message}
}
```

**集成点**:
- `lead-service.ts` 领取需求时调用 `createRequirementBranch()`
- `lead-service.ts` 完成所有步骤后调用 `commitChanges()` + `createPullRequest()`
- `analyst-service.ts` 增量分析时调用 `getDiffSince()`
- `analyst-service.ts` 验证时调用 `getChangedFiles()`

---

### Step 4: 分级通知 — `src/server/notification-service.ts`

Agent 判断内容重要性后的通知分发。

```typescript
class NotificationService {
  private wss: WebSocketServer;  // 复用现有 WebSocket

  // 关键需求通知（high/critical 优先级）
  async notifyCriticalRequirement(requirement: RequirementRecord): void
  // 发送 WebSocket 事件 { type: "requirement_notification", ... }
  // 同时写入 requirement_messages（type='notification'）

  // 步骤失败通知
  async notifyStepFailure(requirementId: string, step: TaskStepRecord): void

  // 验证失败通知
  async notifyVerificationFailure(requirementId: string, report: string): void

  // 需要用户审批通知（Plan 阶段等待审核）
  async notifyPlanReviewRequired(requirementId: string): void

  // 通用通知
  private emit(event: {
    type: string;
    requirementId: string;
    priority: "info" | "warning" | "critical";
    title: string;
    message: string;
  }): void
  // 通过 WebSocket 广播
  // 渲染进程接收后按 priority 决定是否弹出
}
```

**集成点**:
- `requirement-tools.ts` 的 CreateRequirement 在 high/critical 时调用
- `requirement-hooks.ts` 检测到步骤失败时调用
- `analyst-service.ts` 验证失败时调用
- `lead-service.ts` 规划完成等待审核时调用

---

### Step 5: 通知 UI — `src/renderer/components/layout/AppLayout.tsx` (修改)

接收 WebSocket 通知事件并展示。

```typescript
// 在 WebSocket 事件监听中追加
if (event.type === "requirement_notification") {
  // critical/warning 优先级：在聊天窗口显示通知卡片
  // info 优先级：仅在看板上更新（不弹窗）
  if (event.priority === "critical" || event.priority === "warning") {
    showNotificationToast(event.title, event.message);
  }
  // 刷新 requirement store
  requirementStore.fetchRequirements();
}
```

新增一个轻量通知组件：
- `src/renderer/components/requirements/NotificationToast.tsx`
- 非模态，显示在聊天窗口顶部
- 点击可跳转到对应需求

---

### Step 6: 崩溃恢复 — `src/server/recovery.ts` (修改)

在现有恢复逻辑中追加工作流相关恢复。

```typescript
// 在现有 scanIncompleteTurns 之后追加

function recoverWorkflowState(
  projectStore: ProjectStore,
  requirementStore: RequirementStore,
  cronManager: CronAnalysisManager
): void {
  // 1. 恢复定时巡检
  cronManager.restoreSchedules();

  // 2. 恢复处于 Build 状态的需求
  const buildingReqs = requirementStore.listByStatus("build");
  for (const req of buildingReqs) {
    // 检查 Lead session 是否还存活
    // 如果 session 存在，尝试 resume
    // 如果 session 丢失，标记为需人工处理
  }

  // 3. 恢复处于 Plan 状态的需求
  const planReqs = requirementStore.listByStatus("plan");
  for (const req of planReqs) {
    // 类似处理
  }

  // 4. 恢复处于 Verify 状态的需求
  const verifyReqs = requirementStore.listByStatus("verify");
  // 标记为待重新验证
}
```

**集成点**: `src/server/index.ts` 启动恢复流程中调用。

---

### Step 7: Router/API 补充

#### `src/server/requirement-router.ts` (修改)

追加路由：
- `POST /:id/verify` — 手动触发验证（reviewer='user' 时）
- `POST /:id/archive` — 手动归档
- `GET /:id/report` — 获取完成报告

#### `src/server/project-router.ts` (修改)

追加路由：
- `PUT /:id/interval` — 更新巡检间隔（联动 cronManager）
- `POST /:id/pause` — 暂停巡检
- `POST /:id/resume` — 恢复巡检

#### `src/shared/ipc-api.ts` (修改)

追加 IPC 通道：
```
"requirements:verify"    — { id } → { passed, report }
"requirements:archive"   — { id } → void
"requirements:report"    — { id } → report
"projects:updateInterval"— { id, interval } → void
"projects:pause"         — { id } → void
"projects:resume"        — { id } → void
```

---

### Step 8: 集成接线

#### `src/server/index.ts`
- 实例化 CronAnalysisManager, GitIntegration, NotificationService
- 调用 `cronManager.restoreSchedules()`
- 在恢复流程中调用 `recoverWorkflowState()`

#### `src/main/ipc/types.ts`
- IpcContext 追加 cronManager, gitIntegration, notificationService

---

## 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新建** | `src/server/cron-analysis.ts` | Cron 巡检调度 |
| **修改** | `src/server/analyst-service.ts` | 验证 + 归档方法 |
| **新建** | `src/server/git-integration.ts` | Git 分支/PR 操作 |
| **新建** | `src/server/notification-service.ts` | 分级通知 |
| **新建** | `src/renderer/components/requirements/NotificationToast.tsx` | 通知 Toast |
| **修改** | `src/renderer/components/layout/AppLayout.tsx` | 通知接收 + 展示 |
| **修改** | `src/server/recovery.ts` | 工作流状态恢复 |
| **修改** | `src/server/requirement-router.ts` | 验证/归档路由 |
| **修改** | `src/server/project-router.ts` | 巡检间隔/暂停路由 |
| **修改** | `src/shared/ipc-api.ts` | 新 IPC 通道 |
| **修改** | `src/server/index.ts` | 新服务实例化 + 恢复 |
| **修改** | `src/main/ipc/types.ts` | IpcContext 扩展 |

---

## 验证

1. `npm run build` — 编译通过
2. **Cron 巡检**: 启动 App → 等待定时触发 → 检查是否有新分析执行
3. **验证归档**: 需求在 Verify 状态 → 触发验证 → 检查验证报告 → 通过后自动归档 → Wiki 更新
4. **Git 集成**: 需求进入 Build → 自动创建分支 → 步骤完成后可提交 → 尝试创建 PR
5. **通知**: 创建 high/critical 需求 → 聊天窗口弹出通知 → 点击跳转需求
6. **崩溃恢复**: 强制关闭 App → 重启 → 检查定时任务恢复 → 检查 Build/Plan 状态需求可恢复
7. **端到端**: 项目创建 → 冷启动 → 需求发现 → 讨论 → 确认 → Lead 执行 → 验证 → 归档 → Wiki 更新 → Git PR
