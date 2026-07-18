# Plan 00：Flow 与 Session 上游接口对齐

## 目标

在实现 Work Runtime 前，以已经合并的 Project Flow System 和 Session Turn Lifecycle
为事实源冻结 event、CallerCtx、TurnRun、handoff、queue pause 和 Project Session 接口。

## 依赖

- `project-flow-system` Final PASS 并合并；
- `session-turn-lifecycle` Final PASS 并合并。

## 实施范围

- 记录目标 commit、dirty files、Node/npm/Git/OS 和 baseline；
- 映射 Flow event/outbox、Project config extension、CallerCtx 与 Session supervisor；
- 删除计划中已失效的文件名/类型假设，但不得弱化共同架构不变量；
- 写 `result-00.md`，明确 WorkRuntime 所有者文件和与其他 worktree 的冲突边界。

## 完成定义

[Acceptance 00](acceptance-00-upstream-reconciliation.md) 通过。
