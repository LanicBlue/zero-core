# Plan 00：Post-Dependency Reconciliation

## 目标

在 Wiki 与 Session Lifecycle 都 Final 并合并后，以真实代码重新锁定数据库、Wiki、
Provider scheduler、Session supervisor、compacting DTO 和旧 compression 路径，避免按
当前 master 的类名或旧行为机械实现。

## 前置

- `wiki-system-redesign` Final PASS、用户同意合并，目标分支包含其 result/merge commit。
- `session-turn-lifecycle` Final PASS、用户同意合并，目标分支包含其 result/merge commit。
- 本 effort 使用独立 worktree/分支；没有其他 Agent 同时修改同一 Provider/runtime 核心文件。

## 工作

1. 记录 baseline commit、dirty files、Node/npm/Git/OS、数据库布局和测试基线。
2. 映射最终 `CoreDatabase`、`WikiDatabase`、`DatabaseManager`、`WikiService`、
   Wiki revision/request-id/audit、context summary/cursor 和 reopen lifecycle。
3. 映射 Session supervisor、Turn/Step safe point、Stop/Wait/handoff、compacting branch DTO、
   Provider priority queue、manual retry 和 cancellation scope。
4. 映射 main、delegated、Work/Cron、archive 和 manual compact 的所有 compression/memory
   caller；确认 Agent Work Runtime 是否已经合并，不能猜测未来接口。
5. 用最小测试确认或关闭当前已知问题：
   - summary prompt 是否实际包含 transcript；
   - transcript budget 是否可能跳过内容却推进 cursor；
   - summary/cursor reopen 是否仍丢失；
   - 同一 Turn 是否仍被 guard 限制只能压缩一次；
   - force memory 是否仍重入 foreground AgentLoop 或直接写真实 Wiki。
6. 测量 32K/64K/128K/200K/256K/1M policy 输入和当前 token estimator 误差。
7. 核对 Provider `cacheTtlMs` 的 schema/UI/runtime 默认，固定未配置时 60 分钟并列出所有
   过时“6 分钟”注释。
8. 形成 production owner map、删除/替换清单、测试 fixture map 和跨 effort 冲突表。
9. 若上游真实合同无法表达并行 branch/pass progress、P0–P4 priority、safe-point CAS 或
   Wiki request id，停止并回到设计，不建立本地 fallback。
10. 本阶段只补 characterization/reopen 测试和文档，不切换生产行为。

## 完成

[Acceptance 00](acceptance-00-post-dependency-reconciliation.md)通过并创建 `result-00.md`。
