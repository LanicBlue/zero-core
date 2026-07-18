# Plan 06：Agent Work Runtime 加固

## 目标

完成 WorkRun、Invocation、VFS、worktree 和工具切换的恢复、并发、性能与故障验证。

## 依赖

Acceptance 00–05 通过。

## 实施范围

- queued/deferred/running/retry/switch reservation 的重启矩阵；
- Stop/Wait/用户插队/跨 Turn task event 与 context 清理；
- mount revision、路径逃逸、Windows junction、多个 Agent 并发编辑；
- worktree create/cleanup/orphan/merge failure；
- skill migration interruption 和 `[skills]/` 生产残留清理；
- WorkRun queue claim、VFS Glob/Grep 和 worktree 操作 benchmark；
- 验收后更新活动架构文档。

## 完成定义

[Acceptance 06](acceptance-06-hardening.md) 通过并生成 `result-06.md`，随后执行
[Final Acceptance](acceptance-final.md)。
