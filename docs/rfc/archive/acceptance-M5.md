# M5 验收标准：完善闭环

> **对应设计**: `design-M5.md`
> **对应计划**: `plan-M5.md`
> **前置**: M3（编排器）, M4（看板 UI）全部验收通过

---

## 1. 前置条件

- [ ] M1-M4 全部验收标准通过
- [ ] `npm run build:lib` 编译无错误
- [ ] `npm run build` 全量构建通过
- [ ] 端到端流程（M1-M4）可正常运行

---

## 2. Cron 巡检调度

### AC-2.1: 启动恢复定时任务

**前置**: 有 2 个活跃项目（P1 interval=daily, P2 interval=hourly）

**步骤**: 重启 App

**预期**:
- [ ] `cronManager.restoreSchedules()` 被调用
- [ ] P1 和 P2 的定时任务被恢复
- [ ] `getScheduledProjectIds()` 返回 [P1.id, P2.id]
- [ ] 定时任务按照各自间隔运行

### AC-2.2: 新项目自动注册

**步骤**: 创建新项目 P3

**预期**:
- [ ] `cronManager.scheduleProject(P3.id, 'daily')` 被调用
- [ ] P3 出现在 `getScheduledProjectIds()` 中

### AC-2.3: 定时触发增量分析

**前置**: 项目 P 有 Wiki（已冷启动），interval='hourly'

**步骤**: 等待定时触发

**预期**:
- [ ] `analystService.runIncrementalAnalysis(P.id)` 被调用
- [ ] 如果有变更，Wiki 节点被更新
- [ ] 如果有新问题，需求被创建
- [ ] 错误不阻断定时任务（catch 后继续）

### AC-2.4: 暂停项目取消定时

**步骤**: `POST /api/projects/:id/pause`

**预期**:
- [ ] 项目 status → "paused"
- [ ] `cronManager.unscheduleProject()` 被调用
- [ ] 定时任务不再触发

### AC-2.5: 恢复项目重新注册

**步骤**: `POST /api/projects/:id/resume`

**预期**:
- [ ] 项目 status → "active"
- [ ] `cronManager.scheduleProject()` 被调用
- [ ] 定时任务恢复

### AC-2.6: 更新巡检间隔

**步骤**: `PUT /api/projects/:id/interval` body: `{ "interval": "hourly" }`

**预期**:
- [ ] 项目 analysisInterval 更新
- [ ] 旧定时任务取消，新定时任务注册
- [ ] 新间隔生效

### AC-2.7: 删除项目清理定时

**步骤**: `DELETE /api/projects/:id`

**预期**:
- [ ] `cronManager.unscheduleProject()` 被调用
- [ ] 定时任务清除

---

## 3. 验证归档

### AC-3.1: Analyst 自动验证

**前置**:
1. 需求 R（reviewer='analyst'）所有 steps 完成
2. 需求进入 verify 状态

**预期**:
- [ ] `analystService.verifyRequirement(R.id)` 自动触发
- [ ] 返回 `{ passed: boolean, report: string }`
- [ ] report 包含验证详情

### AC-3.2: 验证通过 → 归档

**前置**: verifyRequirement 返回 passed=true

**预期**:
- [ ] `archiveRequirement()` 自动调用
- [ ] 需求 status → "closed"
- [ ] `closedAt` 已更新
- [ ] Wiki 节点被更新（受影响文件）
- [ ] requirement_messages 有完成报告
- [ ] 完成报告格式包含：标题、优先级、步骤摘要

### AC-3.3: 验证失败

**前置**: verifyRequirement 返回 passed=false

**预期**:
- [ ] 需求保持 verify 状态
- [ ] 验证失败通知发出（notificationService）
- [ ] requirement_messages 有失败消息

### AC-3.4: 用户验证模式

**前置**: 需求 R（reviewer='user'）进入 verify 状态

**预期**:
- [ ] 不自动触发验证
- [ ] 用户可在 UI 点击"验证通过"或"返回执行"
- [ ] `POST /api/requirements/:id/verify` 手动触发
- [ ] `POST /api/requirements/:id/archive` 手动归档

### AC-3.5: 手动触发验证

**步骤**: `POST /api/requirements/:id/verify`

**预期**:
- [ ] 返回 `{ passed: boolean, report: string }`
- [ ] 不自动归档（需手动调用 archive）

### AC-3.6: 获取完成报告

**步骤**: `GET /api/requirements/:id/report`

**预期**:
- [ ] 返回 `{ report: "## 需求完成报告..." }`
- [ ] 报告包含需求信息和执行步骤摘要

---

## 4. Git 集成

### AC-4.1: 创建需求分支

**前置**: 项目 P 有 git 仓库

**步骤**: Lead 领取需求 R

**预期**:
- [ ] 创建分支 `workflow/{requirementId-slug}`
- [ ] 当前分支切换到新分支
- [ ] 分支名格式正确

### AC-4.2: 提交变更

**前置**: Developer 完成代码修改

**步骤**: Lead 完成所有步骤后

**预期**:
- [ ] `git add -A` + `git commit` 执行
- [ ] commit message 包含需求信息

### AC-4.3: 创建 PR

**前置**: 项目有 GitHub 远端，gh CLI 可用

**预期**:
- [ ] push 到远端
- [ ] 创建 PR
- [ ] 返回 PR URL

### AC-4.4: 无远端时

**前置**: 项目无 git 远端

**预期**:
- [ ] push 失败时不报错
- [ ] gh 不可用时不报错
- [ ] 返回 `{ branch: branchName }`

### AC-4.5: 增量 diff

**步骤**: `gitIntegration.getDiffSince(projectPath, lastAnalysisAt)`

**预期**:
- [ ] 返回变更内容
- [ ] 无变更时返回空字符串
- [ ] 非 git 仓库时返回空字符串

### AC-4.6: 变更文件列表

**步骤**: `gitIntegration.getChangedFiles(projectPath, 'main')`

**预期**:
- [ ] 返回变更文件路径数组
- [ ] 无变更时返回空数组

### AC-4.7: Git 不可用

**前置**: 项目路径不是 git 仓库

**预期**:
- [ ] 所有 Git 方法不抛出异常
- [ ] 返回安全的默认值（空字符串、空数组）
- [ ] 不影响核心工作流

---

## 5. 分级通知

### AC-5.1: 通知服务初始化

**验证**:
- [ ] NotificationService 构造函数接收 WebSocketServer 和 RequirementStore
- [ ] 无 WebSocket 连接时不报错

### AC-5.2: Critical 需求通知

**前置**: 创建 priority='critical' 的需求

**预期**:
- [ ] `notifyCriticalRequirement()` 被调用
- [ ] WebSocket 广播通知事件
- [ | 事件 type="requirement_notification", priority="critical"
- [ ] requirement_messages 有通知记录

### AC-5.3: 步骤失败通知

**前置**: TaskStep 执行失败

**预期**:
- [ ] `notifyStepFailure()` 被调用
- [ ] 通知包含步骤名和错误信息
- [ ] priority="warning"

### AC-5.4: 验证失败通知

**前置**: 验证不通过

**预期**:
- [ ] `notifyVerificationFailure()` 被调用
- [ ] 通知包含验证报告摘要
- [ ] priority="warning"

### AC-5.5: 审批请求通知

**前置**: Lead 制定计划等待审批

**预期**:
- [ ] `notifyPlanReviewRequired()` 被调用
- [ ] priority="info"

### AC-5.6: WebSocket 广播

**验证**:
- [ ] 通知通过 WebSocket 发送到所有连接的客户端
- [ ] 消息格式为 JSON
- [ ] 包含 type, requirementId, priority, title, message

---

## 6. 通知 UI

### AC-6.1: Toast 显示

**前置**: 收到 critical/warning 优先级的 WebSocket 通知

**预期**:
- [ ] 聊天窗口顶部显示 NotificationToast
- [ ] Toast 包含通知标题和摘要
- [ ] Toast 有关闭按钮
- [ ] Toast 有 [查看详情] 链接

### AC-6.2: Toast 样式

**验证**:
- [ ] critical: 红色边框 + 浅红背景
- [ ] warning: 橙色边框 + 浅橙背景
- [ ] info: 不显示 Toast（仅更新看板）

### AC-6.3: Toast 自动消失

**预期**:
- [ ] info 优先级不显示 Toast
- [ ] warning/critical Toast 需手动关闭

### AC-6.4: 点击跳转

**测试**: 点击 Toast 中的 [查看详情]

**预期**:
- [ ] 跳转到对应需求（看板或聊天）

### AC-6.5: 看板刷新

**前置**: 收到任何通知

**预期**:
- [ ] 看板需求列表自动刷新
- [ ] 新需求出现在对应列中

---

## 7. 崩溃恢复

### AC-7.1: 定时任务恢复

**前置**: App 崩溃重启

**预期**:
- [ ] `cronManager.restoreSchedules()` 被调用
- [ ] 所有活跃项目的定时任务恢复

### AC-7.2: Build 状态需求恢复

**前置**: 崩溃时有 2 个 build 状态需求（R1 有 running steps, R2 有 running steps）

**预期**:
- [ ] R1 的 running steps 标记为 failed
- [ ] R2 的 running steps 标记为 failed
- [ ] 如果 Lead session 存活 → 可恢复
- [ ] 如果 Lead session 丢失 → 添加恢复消息

### AC-7.3: Plan 状态需求恢复

**前置**: 崩溃时有 plan 状态需求

**预期**:
- [ ] Lead session 存活 → 不操作
- [ ] Lead session 丢失 → 退回 ready + 清除 assignedLeadSessionId

### AC-7.4: Verify 状态需求恢复

**前置**: 崩溃时有 verify 状态需求

**预期**:
- [ ] 添加消息："验证流程因重启中断，需要重新触发验证"
- [ ] 不自动改变状态

### AC-7.5: 恢复不阻塞启动

**预期**:
- [ ] 恢复流程执行完毕后 App 才算启动完成
- [ ] 恢复中的错误不导致 App 崩溃
- [ ] 恢复日志可查看

---

## 8. IPC 通道补充

### AC-8.1: 新通道可用

**验证**:
- [ ] `requirements:verify` — 手动验证
- [ ] `requirements:archive` — 手动归档
- [ ] `requirements:report` — 获取报告
- [ ] `projects:updateInterval` — 更新间隔
- [ ] `projects:pause` — 暂停项目
- [ ] `projects:resume` — 恢复项目

### AC-8.2: Preload 暴露

**验证**: 从渲染进程可调用
- [ ] `api().requirementsVerify(id)` → `{ passed, report }`
- [ ] `api().requirementsArchive(id)` → void
- [ ] `api().projectsUpdateInterval(id, interval)` → void
- [ ] `api().projectsPause(id)` → void
- [ ] `api().projectsResume(id)` → void

---

## 9. 端到端验证

### AC-9.1: 完整生命周期

**步骤**:
1. 创建项目 P → 冷启动生成 Wiki
2. 等待定时巡检或手动触发 → 发现新需求 R1
3. R1: found → discuss（用户讨论）
4. R1: discuss → ready（用户确认）
5. Lead 领取 R1 → 创建 Git 分支
6. Lead 调度 Developer → 编码
7. Lead 调度 Reviewer → 审查
8. Lead 调度 QA → 测试
9. 所有步骤完成 → R1 进入 verify
10. Analyst 自动验证 → 通过
11. 归档 → Wiki 更新 → Git commit + PR
12. R1: closed

**预期**:
- [ ] 每步状态流转正确
- [ ] Git 分支创建正确
- [ ] 步骤结果可追踪
- [ ] 验证报告生成
- [ ] Wiki 节点更新
- [ ] 需求最终 closed
- [ ] 完成报告可查看

### AC-9.2: 验证失败回退

**步骤**:
1. 执行到步骤 9（verify）
2. Analyst 验证失败
3. Lead 重新调度 Developer 修复
4. 再次验证 → 通过
5. 归档

**预期**:
- [ ] 验证失败后需求保持 verify
- [ ] 重新调度后新步骤创建
- [ ] 最终归档成功

### AC-9.3: 崩溃恢复后继续

**步骤**:
1. 需求执行到步骤 6（Developer 编码中）
2. 强制关闭 App
3. 重启 App

**预期**:
- [ ] 定时任务恢复
- [ ] running steps 标记 failed
- [ ] 用户可手动恢复或重新领取

---

## 10. 错误处理

| 场景 | 预期 |
|------|------|
| Git 不可用 | 所有 Git 方法返回安全默认值，不影响核心流程 |
| gh CLI 不可用 | PR 创建失败但不报错，只返回 branch 名 |
| WebSocket 无连接 | 通知写入 requirement_messages，不广播 |
| 定时任务执行失败 | catch 错误，记录日志，不取消定时任务 |
| 验证 Agent 异常 | 返回 `{ passed: false, report: error }` |
| 归档部分失败 | Wiki 更新失败不阻断归档，记录错误 |
| 恢复中 Store 异常 | catch 错误，跳过该需求，继续恢复其他 |

---

## 11. Smoke Test 清单

M5 完成的最低验证标准：

- [ ] `npm run build:lib` 编译通过
- [ ] `npm run build` 全量构建通过
- [ ] App 启动后定时任务自动恢复
- [ ] 新项目自动注册定时任务
- [ ] 暂停/恢复项目正确管理定时任务
- [ ] 需求进入 verify 后 Analyst 自动验证
- [ ] 验证通过后自动归档 + Wiki 更新
- [ ] 手动验证/归档 API 可用
- [ ] Git 分支创建成功
- [ ] Critical 需求创建后 Toast 通知显示
- [ ] 步骤失败后通知发送
- [ ] App 崩溃重启后工作流状态恢复
- [ ] 端到端：项目创建 → 巡检 → 需求 → 执行 → 验证 → 归档 → Git PR
