# Acceptance 04：Project Session 与逐 Turn Invocation Context

对应 [Plan 04](plan-04-invocation-context.md)。

## A. 长期 Session

- [ ] 同一 agentId + projectId 复用长期 Project Session。
- [ ] Session 历史能看到多个 Flow item/WorkRun，不为每个 Work 新建 Project Session。
- [ ] ProjectSessionContext 不保存临时 workId/workRunId/worktree。
- [ ] 复用 session-turn-lifecycle 的 TurnRun、snapshot 和 supervisor；不存在第二套
  busy/waiting/queue 写入所有者。

## B. Invocation 隔离

- [ ] 每个 user/Work/Cron/subagent turn 有唯一不可变 invocationId。
- [ ] Work A 的 cwd/mount 不泄漏到下一 user turn 或 Work B。
- [ ] 工具从当前 provider 取 ToolCallContext，不使用 Loop 构造时的旧 cwd。
- [ ] prompt/environment/cache 与当前 invocation 一致。

## C. Queue 与 Wait

- [ ] busy WorkRun 持久 queued，Session 空闲后只执行一次。
- [ ] 同一 Loop 不发生两个并发 run。
- [ ] 当前 running Turn 不被抢占；空闲后 queued user FIFO 优先于 background WorkRun FIFO。
- [ ] waiting/barrier 的 Work、Cron、用户 invocation 使用统一 atomic handoff。
- [ ] Stop 后普通 inbox 保持 paused，不因 WorkRun dispatcher 自动 drain。
- [ ] Wait 保持当前 invocation；handoff 后的新 Turn 使用自己的 context。
- [ ] abort/error/finally 均清除当前 invocation。
- [ ] restart 后 WorkRun 恢复不借用旧 SessionConfig 猜测上下文。

## D. Subagent

- [ ] 默认继承 project/workspace/mount 和 parent 审计链。
- [ ] 显式缩小成功；未授权扩大稳定拒绝。
- [ ] 父子 Loop 的当前 invocation 指针不共享。

## E. 验证与证据

运行 typecheck、build:lib、unit、相关 runtime E2E、check:links。`result-04.md` 必须包含
turn 序列矩阵、busy/Wait/restart trace、prompt snapshot 和 tool audit。

## F. 拒绝条件

- 通过热改长期 SessionContextBundle 切换 Work。
- busy 时继续返回 skip 并依赖人工/cron 偶然重试。
- 仅提示 Agent “请在正确目录工作”而不改变工具上下文。
