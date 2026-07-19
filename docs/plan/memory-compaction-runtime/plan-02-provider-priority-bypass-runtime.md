# Plan 02：Provider Priority 与 Bypass Runtime

## 目标

在 Session Lifecycle 的共享 Provider Runtime 上实现 P0–P4 dispatch metadata、priority
inheritance、foreground capacity 和不可恢复的 runtime-only bypass execution。

## 工作

1. 扩展/消费上游 Provider queue item：
   `priorityClass/rootInvocationId/compactionCycleId/enqueuedAt/availabilityKey/cancellationScope`。
2. 固定队列：

   ```text
   P0 hard CompactionRun
   P1 user invocation lineage
   P2 preferred CompactionRun
   P3 Work/Cron lineage
   P4 Archive MemoryRun
   ```

3. Subagent 继承 root Invocation priority；Parent 等待 Child 时不得被新 Work/Cron 造成
   priority inversion。
4. 同 priority FIFO；P3/P4 有界 aging，P4 不得提升到 P0。
5. priority 只作用于同 Provider/availability key 的未 dispatch call；在途 call 不抢占，
   跨 Provider 不构造全局顺序。
6. `maxConcurrency > 1` 时为 P1 foreground 保留至少一个 slot，P0 可用；并发为 1 时按队列
   顺序。
7. 实现独立 `BypassRuntime`/等价 owner：
   - 不重入或临时修改 foreground AgentLoop；
   - 独立 abort、usage、provider lease 和事件；
   - 只持有不可变 Snapshot/capability；
   - 不写 Session steps，不创建普通 Turn；
   - process/session dispose 后结果自然丢失。
8. 同一 Session 同时至多一个 CompactionRun；Archive MemoryRun 不复用该 session guard。
9. 接入 compacting branch DTO，但不实现 Memory/Compression 业务。
10. 增加 scheduler、priority inheritance、capacity=1/2、cancel/dispose 和跨 Provider 测试。

## 完成

[Acceptance 02](acceptance-02-provider-priority-bypass-runtime.md)通过并创建 `result-02.md`。
