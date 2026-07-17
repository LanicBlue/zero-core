# Plan 04：Project Session 与逐 Turn Invocation Context

## 目标

保留 `agentId + projectId` 长期 Project Session，把用户消息、Work、Cron 和 subagent
统一建模为不可变 TurnInvocationContext；AgentLoop 和工具在每个 turn 动态读取正确的
workspace、mount 和 WorkRun。

## 依赖

Acceptance 03 通过，且
[`session-turn-lifecycle`](../session-turn-lifecycle/README.md) Final Acceptance 已通过。
后者先提供 TurnRun、统一 Session snapshot、invocation inbox/handoff、queue pause 和跨 Turn
task event 契约；本阶段只把其中的 context payload 收紧为 Project/Work-aware
TurnInvocationContext，不得再建一套 busy/waiting/queue 状态机。

## 实施范围

### 1. 类型分层

按 design 落地：

- AgentContext：身份、模型、tool policy、default workspace；
- ProjectSessionContext：projectId、projectRoot、active FlowDefinition ref；
- TurnInvocationContext：source、workspaceRoot、active Flow、work/workRun、mount
  snapshot；
- ToolCallContext：当前 invocation 派生的工具视图。

`projectRoot` 对 global/archive Agent 可空；`workspaceRoot` 始终是已解析绝对路径。

### 2. Invocation builder

新增唯一 resolver：

```text
explicit WorkRun snapshot
  > Project Session defaults
  > Agent default workspace
  > global workspace
```

解析时验证 Project、workspace、worktree、definition digest 和 mounts。解析后不可变，
下游不得再 fallback。

### 3. AgentLoop 接入

将 `run/resume` 接收 invocation 或由 loop-owned InvocationProvider 安装当前值：

```text
install → invalidate/rebuild prompt sections → run
→ persist turn/tool audit → finally clear
```

工具构造不得永久闭包 `workspaceDir/contextBundle/workId`。每次 tool call 从 provider 读取
当前 ToolCallContext。

### 4. 队列

- 在 session-turn-lifecycle 的 TurnInvocationEnvelope 上增加完整 context；普通用户 inbox
  继续保持其 ephemeral 语义。
- WorkRun queue 保持 Core DB durable，由 dispatcher 在 Session 空闲时 claim。
- busy Work 不再调用旧 `sendProjectPrompt` 后 skip。
- 用户 queued input 与 WorkRun 串行，不允许两个 `loop.run()` 并发。
- 当前 running Turn 不被抢占；waiting/barrier 的用户、Work、Cron invocation 使用已验收的
  atomic handoff。
- Session 空闲后先按 FIFO 处理 queued user input，再按 FIFO claim background
  WorkRun，避免后台 Work 让交互饥饿。该调度策略集中在一个 scheduler，不分散到
  router/hook。

### 5. Wait、恢复与 prompt

- Wait suspend 保留当前 invocation；新 invocation 按 session-turn-lifecycle 的 supersede /
  handoff 语义替换 active Turn。
- 下一条用户 invocation 恢复 Project root，不继承 Work worktree。
- environment、Work prompt、Flow mounts、skill list 和可缓存 context 每 turn 按
  invocation revision 重建。
- turn state/tool audit 保存 invocationId/workRunId/workspace identity。

### 6. Subagent

默认继承 parent project/workspace/mount 和审计链；允许显式缩小或合法 workspace
override，不允许隐式扩大 Project/Flow scope。子 Loop 有自己的 provider。

## 测试

覆盖同 Session 连续 user→Work A→user→Work B、busy queue、Wait handoff、Stop queue
pause、后台 task event 跨 Turn、restart、worktree→project cwd 恢复、prompt cache、
tool call audit 和 subagent 继承/缩小。生命周期行为复用既有 supervisor 测试；本阶段重点
断言 invocation context 不泄漏。

## 完成定义

[Acceptance 04](acceptance-04-invocation-context.md) 全部通过并生成 `result-04.md`。
