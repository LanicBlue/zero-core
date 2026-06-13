# M5 设计文档：完善闭环

> **版本**: 1.0
> **对应计划**: `plan-M5.md`
> **依赖**: M3（编排器）, M4（看板 UI）
> **目标**: Cron 巡检、验证归档、Git 集成、分级通知、崩溃恢复

---

## 1. Cron 巡检调度

### 1.1 CronAnalysisManager

```typescript
// src/server/cron-analysis.ts

class CronAnalysisManager {
  private analystService: AnalystService;
  private projectStore: ProjectStore;
  private scheduledJobs: Map<string, NodeJS.Timeout>;  // projectId → timer

  constructor(deps: {
    analystService: AnalystService;
    projectStore: ProjectStore;
  });

  /** 启动时恢复所有活跃项目的定时任务 */
  restoreSchedules(): void;

  /** 为新项目注册定时任务 */
  scheduleProject(projectId: string, interval: string): void;

  /** 移除项目定时任务 */
  unscheduleProject(projectId: string): void;

  /** 更新项目巡检间隔 */
  rescheduleProject(projectId: string, newInterval: string): void;

  /** 获取调度状态 */
  getScheduledProjectIds(): string[];
}
```

### 1.2 间隔映射

```typescript
function parseInterval(interval: string): number {
  switch (interval) {
    case 'hourly': return 60 * 60 * 1000;           // 1 小时
    case 'daily': return 24 * 60 * 60 * 1000;       // 24 小时
    case 'weekly': return 7 * 24 * 60 * 60 * 1000;  // 7 天
    default:
      // 尝试解析为 cron 表达式或毫秒数
      const ms = parseInt(interval, 10);
      if (!isNaN(ms) && ms >= 60 * 1000) return ms;  // 最小 1 分钟
      return 24 * 60 * 60 * 1000;                      // 默认 24h
  }
}
```

### 1.3 调度流程

```
restoreSchedules()
  │
  ├─ 1. projectStore.listActive()
  │     └─ 获取所有 status='active' 的项目
  │
  ├─ 2. 为每个项目：
  │     ├─ 如果 lastAnalysisAt 为空 → scheduleProject(projectId, 'daily')
  │     └─ 否则 → scheduleProject(projectId, project.analysisInterval)
  │
  └─ 3. log: 恢复了 N 个项目的定时巡检

scheduleProject(projectId, interval)
  │
  ├─ 1. unscheduleProject(projectId)  // 先清除已有
  │
  ├─ 2. const ms = parseInterval(interval)
  │
  ├─ 3. const timer = setInterval(async () => {
  │       try {
  │         const project = projectStore.get(projectId);
  │         if (!project || project.status !== 'active') {
  │           unscheduleProject(projectId);
  │           return;
  │         }
  │         await analystService.runIncrementalAnalysis(projectId);
  │       } catch (err) {
  │         log.error('cron', `Analysis failed for ${projectId}:`, err.message);
  │       }
  │     }, ms)
  │
  └─ 4. scheduledJobs.set(projectId, timer)
```

### 1.4 集成点

| 触发位置 | 操作 |
|----------|------|
| `server/index.ts` 启动 | `cronManager.restoreSchedules()` |
| `project-router.ts` 创建项目 | `cronManager.scheduleProject(id, interval)` |
| `project-router.ts` 删除项目 | `cronManager.unscheduleProject(id)` |
| `project-router.ts` 暂停项目 | `cronManager.unscheduleProject(id)` |
| `project-router.ts` 恢复项目 | `cronManager.scheduleProject(id, interval)` |
| `project-router.ts` 更新间隔 | `cronManager.rescheduleProject(id, newInterval)` |

---

## 2. 验证归档

### 2.1 AnalystService 扩展

```typescript
// src/server/analyst-service.ts 追加方法

class AnalystService {
  // ... 现有方法 ...

  /** 验证需求实现是否符合原始设计 */
  async verifyRequirement(requirementId: string): Promise<{
    passed: boolean;
    report: string;
  }> {
    // 1. 获取需求 + 所有 task_steps
    const req = this.requirementStore.get(requirementId);
    const steps = this.taskStepStore.listByRequirement(requirementId);

    // 2. 收集变更文件列表
    const changedFiles = steps
      .filter(s => s.status === 'completed' && s.output)
      .map(s => {
        try { return JSON.parse(s.output!).changedFiles; } catch { return []; }
      })
      .flat();

    // 3. 获取变更文件内容（通过 git diff 或直接读取）
    const project = this.projectStore.get(req.projectId);
    const diff = await this.gitIntegration.getChangedFiles(
      project.path, 'main'  // 或项目默认分支
    );

    // 4. 创建 Analyst 验证 session
    const prompt = `验证需求「${req.title}」是否已正确实现。

原始需求描述：
${req.description}

执行步骤：
${steps.map(s => `- ${s.role}: ${s.title} (${s.status})`).join('\n')}

变更文件：
${changedFiles.join('\n')}

请检查：
1. 实现是否完整覆盖需求描述中的所有功能点
2. 是否存在遗漏或偏差
3. 代码质量是否达标

输出格式：
- 结论：PASSED / FAILED
- 详细报告`;

    // 5. 通过 agentService 执行验证
    const result = await this.sendAnalystPrompt(project.id, prompt);

    // 6. 解析结果
    const passed = result.includes('PASSED') && !result.includes('FAILED');
    return { passed, report: result };
  }

  /** 归档需求并更新 Wiki */
  async archiveRequirement(requirementId: string): Promise<void> {
    const req = this.requirementStore.get(requirementId);
    const steps = this.taskStepStore.listByRequirement(requirementId);

    // 1. 获取变更文件
    const changedFiles = steps
      .filter(s => s.status === 'completed' && s.output)
      .map(s => {
        try { return JSON.parse(s.output!).changedFiles; } catch { return []; }
      })
      .flat();

    // 2. 更新 Wiki（只更新受影响的节点）
    if (changedFiles.length > 0) {
      const project = this.projectStore.get(req.projectId);
      const wikiPrompt = `以下文件发生了变更，请更新相关 Wiki 节点的摘要：
${changedFiles.map(f => `- ${f}`).join('\n')}`;

      await this.sendAnalystPrompt(project.id, wikiPrompt);
    }

    // 3. 生成完成报告
    const report = `## 需求完成报告：${req.title}

**优先级**: ${req.priority}
**影响范围**: ${req.impactScope || 'N/A'}

### 执行步骤
${steps.map(s => `- **${s.role}**: ${s.title} — ${s.status}`).join('\n')}

### 摘要
${steps.filter(s => s.output).map(s => {
  try { return JSON.parse(s.output!).summary; } catch { return ''; }
}).filter(Boolean).join('\n')}`;

    // 4. 写入报告到消息
    this.requirementStore.addMessage(
      requirementId, 'analyst', report, 'status_change'
    );

    // 5. 需求状态 → closed
    this.requirementStore.transitionStatus(
      requirementId, 'closed', 'analyst', '需求已完成并归档'
    );

    // 6. 更新 closedAt
    this.requirementStore.update(requirementId, {
      closedAt: new Date().toISOString(),
    });
  }
}
```

### 2.2 验证触发逻辑

```typescript
// 在 requirement-hooks.ts 或 lead-service 中

// 当需求进入 verify 状态时
async function handleVerifyState(requirementId: string, req: RequirementRecord): Promise<void> {
  if (req.reviewer === 'analyst') {
    // Analyst 自动验证
    const result = await analystService.verifyRequirement(requirementId);
    if (result.passed) {
      await analystService.archiveRequirement(requirementId);
    } else {
      // 验证失败通知
      await notificationService.notifyVerificationFailure(requirementId, result.report);
    }
  }
  // 如果 reviewer === 'user'，等待用户手动触发
}
```

---

## 3. Git 集成

### 3.1 GitIntegration

```typescript
// src/server/git-integration.ts

class GitIntegration {

  /** 创建需求分支 */
  async createRequirementBranch(
    projectPath: string,
    requirementId: string,
    title: string
  ): Promise<string> {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .substring(0, 30);
    const branchName = `workflow/${requirementId.substring(0, 8)}-${slug}`;

    await exec(`git checkout -b ${branchName}`, { cwd: projectPath });
    return branchName;
  }

  /** 获取自某时间以来的 diff */
  async getDiffSince(projectPath: string, sinceDate: string): Promise<string> {
    try {
      const { stdout } = await exec(
        `git log --since="${sinceDate}" --oneline && git diff HEAD~$(git log --since="${sinceDate}" --oneline | wc -l)..HEAD`,
        { cwd: projectPath }
      );
      return stdout;
    } catch {
      return '';  // 无变更或 git 不可用
    }
  }

  /** 获取变更文件列表 */
  async getChangedFiles(projectPath: string, baseBranch?: string): Promise<string[]> {
    try {
      const branch = baseBranch || 'main';
      const { stdout } = await exec(
        `git diff --name-only ${branch}..HEAD`,
        { cwd: projectPath }
      );
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 创建 PR（如果配置了远端） */
  async createPullRequest(
    projectPath: string,
    requirementId: string,
    title: string,
    body: string
  ): Promise<{ url?: string; branch: string }> {
    const branch = (await exec('git branch --show-current', { cwd: projectPath })).stdout.trim();

    try {
      await exec(`git push -u origin ${branch}`, { cwd: projectPath });
    } catch {
      // push 可能失败（无远端），继续
    }

    try {
      const { stdout } = await exec(
        `gh pr create --title "${title}" --body "${body}" --base main`,
        { cwd: projectPath }
      );
      const urlMatch = stdout.match(/https:\/\/github\.com\/\S+/);
      return { url: urlMatch?.[0], branch };
    } catch {
      // gh CLI 不可用
      return { branch };
    }
  }

  /** 提交变更 */
  async commitChanges(projectPath: string, message: string): Promise<void> {
    await exec('git add -A', { cwd: projectPath });
    await exec(`git commit -m "${message}"`, { cwd: projectPath });
  }
}
```

### 3.2 集成点

| 调用者 | 操作 | Git 方法 |
|--------|------|----------|
| Lead 领取需求 | 创建需求分支 | `createRequirementBranch()` |
| Lead 完成所有步骤 | 提交 + PR | `commitChanges()` + `createPullRequest()` |
| Analyst 增量分析 | 获取增量 diff | `getDiffSince()` |
| Analyst 验证 | 获取变更文件 | `getChangedFiles()` |

---

## 4. 分级通知

### 4.1 NotificationService

```typescript
// src/server/notification-service.ts

interface NotificationEvent {
  type: string;
  requirementId: string;
  projectId: string;
  priority: "info" | "warning" | "critical";
  title: string;
  message: string;
  actionUrl?: string;       // 跳转链接
  timestamp: string;
}

class NotificationService {
  private wss: WebSocketServer;
  private requirementStore: RequirementStore;

  constructor(deps: {
    wss: WebSocketServer;
    requirementStore: RequirementStore;
  });

  /** 关键需求通知 */
  async notifyCriticalRequirement(requirement: RequirementRecord): Promise<void> {
    this.emit({
      type: "requirement_notification",
      requirementId: requirement.id,
      projectId: requirement.projectId,
      priority: requirement.priority === 'critical' ? 'critical' : 'warning',
      title: `${requirement.priority === 'critical' ? '🚨' : '⚠️'} 新需求：${requirement.title}`,
      message: requirement.description || '',
      actionUrl: `/requirements?id=${requirement.id}`,
      timestamp: new Date().toISOString(),
    });
  }

  /** 步骤失败通知 */
  async notifyStepFailure(requirementId: string, step: TaskStepRecord): Promise<void> {
    this.emit({
      type: "step_failure",
      requirementId,
      projectId: '',  // 从 requirement 获取
      priority: 'warning',
      title: `步骤失败：${step.title}`,
      message: `角色 ${step.role} 执行失败：${step.error || '未知错误'}`,
      actionUrl: `/requirements?id=${requirementId}`,
      timestamp: new Date().toISOString(),
    });
  }

  /** 验证失败通知 */
  async notifyVerificationFailure(requirementId: string, report: string): Promise<void> {
    this.emit({
      type: "verification_failure",
      requirementId,
      projectId: '',
      priority: 'warning',
      title: '需求验证未通过',
      message: report.substring(0, 200),
      actionUrl: `/requirements?id=${requirementId}`,
      timestamp: new Date().toISOString(),
    });
  }

  /** 需要用户审批通知 */
  async notifyPlanReviewRequired(requirementId: string): Promise<void> {
    this.emit({
      type: "plan_review_required",
      requirementId,
      projectId: '',
      priority: 'info',
      title: '执行计划待审批',
      message: 'Lead 已制定执行计划，请审批后继续',
      actionUrl: `/requirements?id=${requirementId}`,
      timestamp: new Date().toISOString(),
    });
  }

  /** 通过 WebSocket 广播 */
  private emit(event: NotificationEvent): void {
    // 写入 requirement_messages
    this.requirementStore.addMessage(
      event.requirementId,
      'system',
      event.message,
      'notification',
      JSON.stringify({ priority: event.priority, actionUrl: event.actionUrl })
    );

    // WebSocket 广播到所有连接的客户端
    const data = JSON.stringify(event);
    this.wss.clients.forEach(client => {
      if (client.readyState === 1) {  // WebSocket.OPEN
        client.send(data);
      }
    });
  }
}
```

### 4.2 通知触发矩阵

| 事件 | 触发者 | 优先级 | 通知位置 |
|------|--------|--------|----------|
| 创建 critical 需求 | requirement-tools.ts | critical | 聊天弹窗 + 看板 |
| 创建 high 需求 | requirement-tools.ts | warning | 聊天弹窗 + 看板 |
| 步骤失败 | requirement-hooks.ts | warning | 聊天弹窗 + 看板 |
| 验证失败 | analyst-service.ts | warning | 聊天弹窗 + 看板 |
| 执行计划待审批 | lead-service.ts | info | 仅看板 |
| 需求完成归档 | analyst-service.ts | info | 仅看板 |
| 分析完成 | analyst-service.ts | info | 仅看板 |

---

## 5. 通知 UI

### 5.1 NotificationToast

```typescript
// src/renderer/components/requirements/NotificationToast.tsx

interface NotificationToastProps {
  event: NotificationEvent;
  onDismiss: () => void;
  onClick: (event: NotificationEvent) => void;
}
```

**渲染**:
```
┌────────────────────────────────────────────────┐
│ 🚨 新需求：发现安全漏洞  [✕]                     │
│ SQL 注入风险存在于用户输入处理...               │
│ [查看详情]                                      │
└────────────────────────────────────────────────┘
```

**样式**:
- critical: 红色边框 + 浅红背景
- warning: 橙色边框 + 浅橙背景
- info: 蓝色边框 + 浅蓝背景

**行为**:
- 非模态，显示在聊天窗口顶部
- 5s 后自动消失（info），或手动关闭（warning/critical）
- 点击 [查看详情] 跳转到对应需求

### 5.2 AppLayout 集成

```typescript
// src/renderer/components/layout/AppLayout.tsx

// WebSocket 事件监听
useEffect(() => {
  const ws = /* 获取 WebSocket 连接 */;
  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'requirement_notification' ||
          data.type === 'step_failure' ||
          data.type === 'verification_failure' ||
          data.type === 'plan_review_required') {

        if (data.priority === 'critical' || data.priority === 'warning') {
          // 显示 Toast
          showNotificationToast(data);
        }

        // 刷新需求 store
        requirementStore.fetchRequirements();
      }
    } catch {}
  });
}, []);
```

---

## 6. 崩溃恢复

### 6.1 recovery.ts 扩展

```typescript
// src/server/recovery.ts 追加

function recoverWorkflowState(
  projectStore: ProjectStore,
  requirementStore: RequirementStore,
  taskStepStore: TaskStepStore,
  cronManager: CronAnalysisManager,
  agentService: AgentService
): void {

  // 1. 恢复定时巡检
  cronManager.restoreSchedules();

  // 2. 恢复处于 build 状态的需求
  const buildingReqs = requirementStore.listByStatus('build');
  for (const req of buildingReqs) {
    const runningSteps = taskStepStore.listByRequirement(req.id)
      .filter(s => s.status === 'running');

    if (runningSteps.length > 0) {
      // 标记当前步骤为需重新执行
      for (const step of runningSteps) {
        taskStepStore.update(step.id, {
          status: 'failed',
          error: 'Session interrupted by crash',
          completedAt: new Date().toISOString(),
        });
      }
    }

    // 检查 Lead session 是否还存活
    if (req.assignedLeadSessionId) {
      const session = agentService.getSession(req.assignedLeadSessionId);
      if (!session) {
        // Session 丢失，添加恢复消息
        requirementStore.addMessage(
          req.id, 'system',
          'Lead 会话因异常中断，需要手动恢复或重新领取',
          'notification'
        );
      }
    }
  }

  // 3. 恢复处于 plan 状态的需求
  const planReqs = requirementStore.listByStatus('plan');
  for (const req of planReqs) {
    if (req.assignedLeadSessionId) {
      const session = agentService.getSession(req.assignedLeadSessionId);
      if (!session) {
        // Lead session 丢失，退回 ready
        requirementStore.transitionStatus(
          req.id, 'ready', 'system',
          'Lead 会话因异常中断，需求退回到就绪状态'
        );
        requirementStore.update(req.id, {
          assignedLeadSessionId: undefined,
        });
      }
    }
  }

  // 4. 恢复处于 verify 状态的需求
  const verifyReqs = requirementStore.listByStatus('verify');
  for (const req of verifyReqs) {
    // 标记为待重新验证
    requirementStore.addMessage(
      req.id, 'system',
      '验证流程因重启中断，需要重新触发验证',
      'notification'
    );
  }
}
```

### 6.2 恢复策略

| 中断状态 | 恢复策略 |
|----------|----------|
| build（Lead 存活） | 恢复 Lead session，继续执行 |
| build（Lead 丢失） | 标记 running steps 为 failed，等待人工恢复 |
| plan（Lead 存活） | 恢复 Lead session |
| plan（Lead 丢失） | 退回 ready，清除 assignedLeadSessionId |
| verify | 标记为待重新验证，通知用户 |
| running steps | 标记 failed + error 信息 |

---

## 7. Router/API 补充

### 7.1 requirement-router.ts 追加

```typescript
// 手动触发验证
router.post("/:id/verify", async (req, res) => {
  const result = await analystService.verifyRequirement(req.params.id);
  res.json(result);
});

// 手动归档
router.post("/:id/archive", async (req, res) => {
  await analystService.archiveRequirement(req.params.id);
  res.json({ ok: true });
});

// 获取完成报告
router.get("/:id/report", async (req, res) => {
  const messages = requirementStore.getMessages(req.params.id);
  const report = messages.find(m => m.messageType === 'status_change' && m.content.startsWith('##'));
  res.json({ report: report?.content || null });
});
```

### 7.2 project-router.ts 追加

```typescript
// 更新巡检间隔
router.put("/:id/interval", async (req, res) => {
  const { interval } = req.body;
  projectStore.update(req.params.id, { analysisInterval: interval });
  cronManager.rescheduleProject(req.params.id, interval);
  res.json({ ok: true });
});

// 暂停巡检
router.post("/:id/pause", async (req, res) => {
  projectStore.update(req.params.id, { status: 'paused' });
  cronManager.unscheduleProject(req.params.id);
  res.json({ ok: true });
});

// 恢复巡检
router.post("/:id/resume", async (req, res) => {
  const project = projectStore.get(req.params.id);
  projectStore.update(req.params.id, { status: 'active' });
  cronManager.scheduleProject(req.params.id, project.analysisInterval);
  res.json({ ok: true });
});
```

### 7.3 IPC 通道追加

```typescript
"requirements:verify"     — { id } → { passed: boolean, report: string }
"requirements:archive"    — { id } → void
"requirements:report"     — { id } → { report: string | null }
"projects:updateInterval" — { id, interval } → void
"projects:pause"          — { id } → void
"projects:resume"         — { id } → void
```

---

## 8. 集成接线

### 8.1 server/index.ts

```typescript
// 实例化
const gitIntegration = new GitIntegration();
const notificationService = new NotificationService({ wss, requirementStore });
const cronManager = new CronAnalysisManager({ analystService, projectStore });

// 注入依赖
analystService.setGitIntegration(gitIntegration);
analystService.setNotificationService(notificationService);
leadService.setGitIntegration(gitIntegration);

// 启动恢复
cronManager.restoreSchedules();
recoverWorkflowState(projectStore, requirementStore, taskStepStore, cronManager, agentService);
```

### 8.2 IpcContext 扩展

```typescript
interface IpcContext {
  // ... 现有 + M2 + M3 ...
  cronManager: CronAnalysisManager;
  gitIntegration: GitIntegration;
  notificationService: NotificationService;
}
```
