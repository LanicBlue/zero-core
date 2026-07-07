# acceptance-3:recovery 分流 + 懒重建

对应 `sub-3.md`。

## 用例

1. **委派子启动不 auto-run**:崩溃时有 incomplete 的 delegated session → 重启后**不**自动 resume(冻结),turn_state 仍 incomplete。
2. **父 chat auto-resume**:incomplete 的 chat session → 重启后 auto-resume 续跑。
3. **中断子在父 workbench 显 Interrupted**:冻结子经 `restoreDelegatedTasks` seed 进父 registry → 父 workbench Task 段显 `[taskX] Interrupted`。
4. **懒重建**:`restoreAllSessions` 不再 eager 全建;只给有 incomplete turn 的建 loop。无 incomplete turn 的 session 启动时不预建 loop,`activateSession` 时才建。
5. **幂等再现**:连续两次重启,冻结子都显 Interrupted(不被消费、不重复 seed)。
6. **懒重建无回归**:`getRuntimeTaskTree` / config-sync / metrics 在 loop 未预建时不报错(按需建或容忍)。

## 验证手段

- 集成测:构造 chat + delegated 两个 incomplete session,重启后断言 chat resumed、delegated 未 resumed。
- 集成测:重启后父 workbench(经 restoreDelegatedTasks)含 Interrupted 子。
- 手测:杀进程重启,日志确认 delegated session 不在 doRecoverIncompleteSessions 的 resume 列表。
