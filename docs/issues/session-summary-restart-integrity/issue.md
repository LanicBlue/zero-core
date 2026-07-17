# Issue: session-summary-restart-integrity

- **状态**：① issues（问题记录）
- **提出**：2026-07-17
- **类型**：缺陷（P0 数据完整性）
- **依赖**：[`wiki-system-redesign`](../../plan/wiki-system-redesign/README.md) 完成并合并后重新核验

## 问题

当前 [`SessionDB.initSchema()`](../../../src/server/session-db.ts) 在每次数据库初始化时执行 `DROP TABLE IF EXISTS messages`，随后重建 `messages` 表。该表现已保存滚动摘要 `summary_json` 和压缩/组装游标 `last_compressed_step_seq`，不再是可无损重建的旧消息缓存。

因此，只要会话已经生成摘要，正常关闭并重新启动应用就可能清空摘要和游标，使重启后的 LLM 上下文与重启前不一致；旧 steps 虽然仍在，但此前压缩得到的信息和边界已经丢失。

## 当前代码证据

- [`session-db.ts`](../../../src/server/session-db.ts) 的初始化路径无条件执行 `DROP TABLE IF EXISTS messages`，不是只在识别到旧 schema 时执行的一次性迁移。
- 同一文件的 `getSummaries()`、`getCompressionCursor()` 和 `replaceSummariesAndAdvanceCursor()` 明确把 `messages` 作为摘要与游标的持久化位置。
- [`session.ts`](../../../src/runtime/session.ts) 的重启组装路径从上述摘要与游标恢复 LLM view；表被清空后只能从剩余 steps 重新组装，无法恢复已经持久化的摘要语义。
- 当前测试没有覆盖“写入摘要和游标 → 关闭数据库 → 使用同一数据库重新初始化 → 数据保持不变”的 reopen 场景。
- 架构审计已将其记录为 [`D-001`](../../arch/10-tech-debt-architect-view.md#d-001启动时无条件删除-messages)。

## 影响

- 正常重启可能改变长会话的模型上下文，而用户没有收到数据丢失提示。
- 压缩游标丢失后，后续压缩可能重复处理旧 steps，或产生与重启前不同的上下文边界。
- 仅验证 fresh DB 或单进程读写无法发现该问题；必须通过同一数据库文件的 reopen 测试验证。

## 与 wiki-system-redesign 的边界

`wiki-system-redesign` 正在另一个 worktree 改造数据库生命周期，包括 `SessionDB` / core database 边界、数据库文件布局和迁移入口。现在在本 worktree 修改旧初始化代码，会制造重复实现与合并冲突，也可能让测试绑定即将退役的类名和结构。

本 issue 因此只记录问题，不修改该 worktree 的 plan、acceptance、实现或任务节奏。待其完成并合并后，以合并后的数据库实现为唯一真相源重新核验；如果新实现已经消除问题，则补回归测试并记录证据后关闭，而不是再做无意义修复。

## 重新核验条件

仅在 `wiki-system-redesign` 合并后进入下一阶段，并至少核对：

1. 摘要和压缩游标在新 schema 中的实际存储位置与所有者。
2. fresh profile、旧 profile 升级和现有 profile 重启三条初始化路径。
3. 是否仍存在每次启动执行的破坏性 DROP/rebuild。
4. 是否已有可证明 reopen 后摘要与游标保持不变的测试。
5. 新数据库迁移是否有稳定的一次性判定；如迁移版本台账仍缺失，另行评估 [`D-006`](../../arch/10-tech-debt-architect-view.md#d-006schema-有多处真相源且没有版本台账)，不在本 issue 中顺带扩张范围。

## 非目标

- 当前不修改任何项目代码或测试。
- 不修改 `wiki-system-redesign` 的 worktree、plan 或 acceptance。
- 不提前决定采用条件迁移、版本台账、表重命名或其他具体修复方式。
- 不尝试恢复此前已经被启动流程删除、且没有备份的摘要数据。
- 不把完整 schema 治理、跨数据库事务或 Wiki 数据迁移并入本 issue。

## 下一步

等待 `wiki-system-redesign` 完成并合并。合并后先执行源码审计和最小 reopen 复现：写入一条摘要及非空压缩游标，关闭数据库连接，再以同一路径初始化并读取；只有确认问题仍存在，才把整个 effort 移入 `docs/design/` 讨论修复与迁移策略。
