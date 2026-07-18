# Acceptance 02：Provider Priority 与 Bypass Runtime

对应 [Plan 02](plan-02-provider-priority-bypass-runtime.md)。

- [ ] P0–P4 对未 dispatch call 的顺序有确定性测试。
- [ ] user Subagent 继承 P1，Work/Cron Subagent 继承 P3，archive 派生调用保持 P4。
- [ ] Parent 等待 Child 时，新 Work/Cron 不会造成 priority inversion。
- [ ] 同 priority FIFO；P3/P4 aging 有界且 P4 永不提升到 P0。
- [ ] 不同 Provider 独立执行；在途 call 不被强制抢占。
- [ ] concurrency >1 保留 foreground slot；concurrency=1 的顺序无死锁。
- [ ] preferred bypass 已在途时不取消，尚未 dispatch 的 pass 会让位 P1。
- [ ] BypassRuntime 不调用/重入 foreground AgentLoop，不共享其 mutable messages、recorder
  或 AbortController。
- [ ] bypass 不生成普通 Session Step/Turn 持久记录。
- [ ] Stop/dispose/shutdown 丢弃 runtime result；重启没有 run/candidate recovery scan。
- [ ] compacting branch DTO 由 Session supervisor 发布，不存在第二个 lifecycle owner。
