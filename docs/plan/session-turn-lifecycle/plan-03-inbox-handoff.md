# Plan 03：Invocation Inbox、软插入与 Handoff

## 目标

把用户输入、Work/Cron dispatch 入口统一成 invocation envelope，稳定 next-turn、next-step、
queue pause 和 waiting handoff。

## 工作

1. 普通 inbox 保存 invocationId、source、content、context、delivery、time。
2. 保持普通 chat inbox 内存态；WorkRun durable queue 仍由其 dispatcher 拥有。
3. next_turn FIFO；Stop 后 paused，只有明确 invocation/dispatch 才恢复调度。
4. next_step 保持 StepStart 注入、成功 StepEnd commit、失败 rollback。
5. Turn 在注入前结束时，把 next_step 原子降级为 next_turn。
6. waiting/needs_input/barrier 收到新 invocation 时执行 atomic supersede + handoff。
7. running 中普通 invocation 只排队；不把 handoff 扩成任意时刻硬抢占。
8. 为多来源、附件、retry、Stop pause、并发 arrival 和 handoff 写测试。

## 完成

[Acceptance 03](acceptance-03-inbox-handoff.md) 通过并创建 `result-03.md`。

