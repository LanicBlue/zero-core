# M3 验收标准：编排器 + 任务执行

> **对应设计**: `design-M3.md`
> **对应计划**: `plan-M3.md`
> **前置**: M1, M2 全部验收通过

---

## 1. 前置条件

- [ ] M1, M2 全部验收标准通过
- [ ] `npm run build:lib` 编译无错误
- [ ] `npm run build` 全量构建通过
- [ ] Analyst 冷启动可正常生成 Wiki

---

## 2. Orchestrate 工具

### AC-2.1: 工具定义

**验证**:
- [ ] `Orchestrate` 在 `ALL_TOOLS` 中注册
- [ ] `CONDITIONAL_TOOLS.Orchestrate` = `(ctx) => !!ctx.createRoleLoop`
- [ ] 无 `createRoleLoop` 时工具不可用
- [ ] 工具 input schema 包含 `role`（enum）, `task`（string）, `wikiNodes`（可选）, `relatedFiles`（可选）

### AC-2.2: 调度 Developer

**前置**:
1. 创建项目 P，执行冷启动生成 Wiki
2. 创建需求 R（status=ready）
3. Lead 领取 R（status=plan）
4. Lead 在会话中调用 `Orchestrate({ role: 'developer', task: '实现 XXX 功能' })`

**预期**:
- [ ] `task_steps` 表新增一条记录
- [ ] step 的 `role` = "developer"
- [ ] step 的 `status` = "running"（执行中）→ "completed"（完成后）
- [ ] step 的 `title` 包含任务描述
- [ ] step 的 `startedAt` 和 `completedAt` 有值
- [ ] 返回给 Lead 的摘要包含执行结果

### AC-2.3: 调度 Reviewer

**测试**: Lead 调用 `Orchestrate({ role: 'reviewer', task: '审查 XXX 变更' })`

**预期**:
- [ ] Reviewer sub-agent 只能使用 Read, Grep, Glob, Shell（只读）
- [ ] Reviewer 不能使用 Write, Edit
- [ ] task_steps 有新记录，role="reviewer"

### AC-2.4: 调度 QA

**测试**: Lead 调用 `Orchestrate({ role: 'qa', task: '测试 XXX 功能' })`

**预期**:
- [ ] QA sub-agent 可使用 Read, Write（测试文件）, Shell
- [ ] task_steps 有新记录，role="qa"

### AC-2.5: Wiki 上下文传递

**前置**: 项目 Wiki 中有节点 path="src/payment/"

**测试**: Lead 调用 `Orchestrate({ role: 'developer', task: '...', wikiNodes: ['src/payment/'] })`

**预期**:
- [ ] Sub-agent 的 system prompt 中包含该 Wiki 节点的上下文
- [ ] Sub-agent 可以理解该模块的背景信息

### AC-2.6: 步骤失败处理

**前置**: Mock 一个必定失败的 sub-agent

**测试**: `Orchestrate({ role: 'developer', task: '...' })` → sub-agent 执行失败

**预期**:
- [ ] task_step 的 status 变为 "failed"
- [ ] task_step 的 error 字段包含错误信息
- [ ] 返回给 Lead 的摘要包含失败信息
- [ ] Lead 不崩溃，可以继续决策

### AC-2.7: 缺少上下文

**测试**: 在无 `activeRequirementId` 的上下文中调用 Orchestrate

**预期**:
- [ ] 返回错误信息（缺少必要上下文）
- [ ] 不创建 task_step

---

## 3. Lead 服务

### AC-3.1: 领取就绪需求

**前置**:
1. 创建项目 P
2. 创建需求 R（status=ready）

**测试**: `leadService.pickupRequirement(R.id)`

**预期**:
- [ ] 返回 sessionId
- [ ] 需求 status 变为 "plan"
- [ ] `assignedLeadSessionId` 已更新
- [ ] status_history 有新记录：ready → plan
- [ ] Lead Agent 会话开始运行

### AC-3.2: 领取非就绪需求

**前置**: 创建需求 R（status=found）

**测试**: `leadService.pickupRequirement(R.id)`

**预期**:
- [ ] 抛出错误或返回 400
- [ ] 需求状态不变

### AC-3.3: 重复领取

**前置**: 需求 R 已被领取（assignedLeadSessionId 不为空）

**测试**: 再次调用 `pickupRequirement(R.id)`

**预期**:
- [ ] 返回错误（已被领取）
- [ ] 或返回已有 sessionId（幂等）

### AC-3.4: 获取执行进度

**前置**: 需求 R 有 3 个 task_steps（1 completed, 1 running, 1 pending）

**测试**: `leadService.getProgress(R.id)`

**预期**:
- [ ] 返回 `steps` 数组（3 条记录）
- [ ] `currentStep` 为 running 状态的步骤
- [ ] `completedCount` = 1
- [ ] `totalCount` = 3

### AC-3.5: Lead System Prompt

**验证**:
- [ ] Lead 的 system prompt 包含需求标题
- [ ] Lead 的 system prompt 包含项目名称和路径
- [ ] Lead 的 toolPolicy 禁止 Write, Edit
- [ ] Lead 的 toolPolicy 允许 Orchestrate

---

## 4. 状态流转 Hook

### AC-4.1: PostToolUse — plan → build

**前置**: 需求 status=plan

**步骤**:
1. Lead 调用 Orchestrate 创建第一个 task_step
2. PostToolUse Hook 触发

**预期**:
- [ ] 需求状态自动从 plan → build
- [ ] status_history 有新记录
- [ ] 触发者是 "lead"

### AC-4.2: PostTurnComplete — build → verify

**前置**: 需求 status=build，所有 task_steps 都 completed

**步骤**: Lead 会话完成（PostTurnComplete 触发）

**预期**:
- [ ] 需求状态自动从 build → verify
- [ ] status_history 有新记录
- [ ] 触发者是 "system"

### AC-4.3: PostTurnComplete — 部分完成

**前置**: 需求 status=build，有 step 还是 running

**步骤**: Lead 会话完成

**预期**:
- [ ] 需求状态不变（仍为 build）
- [ ] 不触发状态流转

### AC-4.4: 非 Lead Agent 的 Hook

**测试**: Analyst 或普通 Agent 完成 Turn

**预期**:
- [ ] Hook 不触发（检查 agentRole !== "lead"）

### AC-4.5: 非 Orchestrate 工具的 Hook

**测试**: Lead 使用 Read 工具（非 Orchestrate）

**预期**:
- [ ] PostToolUse Hook 不触发状态流转（检查 toolName !== "Orchestrate"）

---

## 5. createRoleLoop 工厂

### AC-5.1: 工厂函数注入

**验证**:
- [ ] Lead 的 ToolExecutionContext 中 `createRoleLoop` 不为 undefined
- [ ] createRoleLoop 可被调用创建 sub-agent

### AC-5.2: Sub-agent 工具策略

**验证**:
- [ ] Developer sub-agent 可使用 Write, Edit
- [ ] Reviewer sub-agent 不可使用 Write, Edit
- [ ] QA sub-agent 可使用 Shell

### AC-5.3: Sub-agent 生命周期

**验证**:
- [ ] 每次 Orchestrate 调用创建独立的 sub-agent
- [ ] Sub-agent 执行完毕后释放资源
- [ ] Sub-agent 的 AgentLoop 正常退出

---

## 6. IPC 通道

### AC-6.1: lead:pickup

**测试**: 从渲染进程调用 `api().leadPickup(requirementId)`

**预期**:
- [ ] 返回 `{ sessionId: "..." }`
- [ ] IPC 类型安全

### AC-6.2: lead:progress

**测试**: 从渲染进程调用 `api().leadProgress(requirementId)`

**预期**:
- [ ] 返回 `{ requirement, steps, currentStep, completedCount, totalCount }`

---

## 7. 端到端验证

### AC-7.1: 完整执行流程

**步骤**:
1. 创建项目 P → 冷启动生成 Wiki
2. 创建需求 R（status=found, priority=high）
3. R: found → discuss → ready（通过 API）
4. Lead 领取 R → status=plan
5. Lead 制定计划，调用 Orchestrate(developer) → status=build
6. Lead 调用 Orchestrate(reviewer)
7. Lead 调用 Orchestrate(qa)
8. Lead 完成 → status=verify

**预期**:
- [ ] 每步状态流转正确
- [ ] task_steps 有 3 条记录（developer, reviewer, qa）
- [ ] 所有 step 最终 status=completed
- [ ] 需求最终 status=verify

### AC-7.2: 步骤重试

**步骤**:
1. Lead 领取需求
2. Orchestrate(developer) → failed
3. Lead 决定重试，再次 Orchestrate(developer)

**预期**:
- [ ] 第一个 step status=failed
- [ ] 第二个 step 被创建
- [ ] retry_count 递增（如果在同一 step 上重试）

---

## 8. 错误处理

| 场景 | 预期 |
|------|------|
| Lead 会话异常退出 | 所有 running steps 标记 failed |
| Sub-agent 超时 | step 标记 failed + error 信息 |
| createRoleLoop 返回异常 | step 标记 failed，Lead 收到错误摘要 |
| 并发 Orchestrate 调用 | 第二次排队或拒绝（isConcurrencySafe=false） |
| 需求被删除但 Lead 还在执行 | Lead 的后续 Orchestrate 失败 |
| Wiki 路径不存在 | ExpandNode 返回 not found，sub-agent 自行处理 |

---

## 9. Smoke Test 清单

M3 完成的最低验证标准：

- [ ] `npm run build:lib` 编译通过
- [ ] `npm run build` 全量构建通过
- [ ] `lead:pickup` IPC 调用成功，Lead session 启动
- [ ] Lead 可调用 `Orchestrate` 工具
- [ ] 每次 Orchestrate 后 task_steps 有新记录
- [ ] Sub-agent 按角色限制工具（Developer 可写，Reviewer 只读）
- [ ] 需求状态 plan → build 自动流转
- [ ] 需求状态 build → verify 自动流转
- [ ] 步骤失败时 task_step.error 有内容
- [ ] `lead:progress` IPC 返回正确的进度信息
