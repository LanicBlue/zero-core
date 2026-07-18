# Design：Agent Work Runtime

本设计服从跨 effort 的
[Agent Project Automation 架构合同](../agent-project-automation.md)，并以
[`project-flow-system`](../project-flow-system/README.md) 和
[`session-turn-lifecycle`](../session-turn-lifecycle/README.md) 的 Final 合同为前置。

## 1. 所有权

本 effort 拥有：

- WorkDefinition validator/repository、trigger、snapshot 和 manual/cron fire；
- 持久 WorkRun queue、retry/recovery 和 Agent defer/prioritize/switch；
- ProjectSessionContext、TurnInvocationContext、ToolCallContext 接线；
- `flow://`、`skill://` VFS 和物理 `.zero-core` 隐藏；
- Project 内 linked worktree 的创建、handoff 与清理；
- Project 的 `kind: work` 配置 handler、`work.fire` 和 Agent-facing Work runtime 工具。

它不拥有 Flow 语义、Session lifecycle 状态机、renderer 管理体验或 Eval grader。

## 2. Flow/Session 边界

Flow event 只创建 durable WorkRun；不会把长期 Agent Session 绑定到某个 Flow，也不会
强制新 run 成为下一项。Session 仍由 `agentId + projectId` 定位，同一 Session 内的
eligible run 默认按 priority/FIFO 建议排序，持有 Work 的 Agent可审计地调整自己的队列。

所有运行时 workspace、mount、workId/workRunId 只存在于不可变 TurnInvocationContext。
running Turn 不热改 cwd/mount；switch 通过统一 supervisor 在安全边界 handoff。

## 3. 工具边界

- Project 管理 Agent通过通用 config 原语管理 `kind: work`，通过 `work.fire` 创建
  durable run。
- 普通 Project Agent的 Work 只管理当前 Agent Session 的 WorkRun runtime。
- Work 不再包含 Definition CRUD/manual fire；Agent不能直接设置 succeeded/failed 或
  修改 snapshot。

## 4. VFS 与 worktree

VFS 使用 invocation mount table，`flow://project` 提供 Project 视野，
`flow://current` 提供当前任务；`skill://` 是唯一 Skill 虚拟路径。普通文件工具从
Project 根忽略 `.zero-core`，但当 workspaceRoot 本身是内部 worktree 时正常工作。

worktree 创建失败不得回退主 checkout；清理失败形成可重试清理记录，不删除 Flow 文档。
