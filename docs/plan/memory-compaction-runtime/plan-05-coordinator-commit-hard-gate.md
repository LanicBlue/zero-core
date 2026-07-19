# Plan 05：Coordinator、Commit 与 Hard Gate

## 目标

把一次 MemoryRun 与多 pass CompressionPipeline 并行协调，在 safe point 联合校验，并按
Wiki-first/Core-second 提交；建立 hard block、冲突和崩溃语义。

## 工作

1. 实现 CompactionCoordinator：

   ```text
   snapshot
   → MemoryRun once || CompressionPipeline pass 1..N
   → both succeeded
   → safe-point validation
   → Wiki-first/Core-second commit
   ```

2. 两个分支共享 cycle id/Snapshot/cancellation，但一个完成不取消、提交或持久化另一个。
3. 任一分支失败/取消、Stop 在 commit 前生效、session dispose 或 shutdown，丢弃 WikiPatch、
   rolling summary、SummaryCandidate 和 pass cursor。
4. safe point 校验 Session generation、history digest、boundary、summary base 和 Wiki
   touched node revision/hash；无关 Wiki 写不冲突，touched node 冲突整轮失败。
5. Wiki commit：
   - deterministic request id =
     session/cursor/B/historyDigest/patchDigest；
   - provenance 保存 source range/digest；
   - 所有 patch operations 在单个 Wiki transaction 内完成。
6. Wiki 成功后，以 Core transaction CAS 写 final summary + `maintenanceCursor=B`；Core 失败
   不回滚 Wiki，接受安全重复窗口。
7. crash injection 覆盖：分支中、两个分支完成后、Wiki transaction 中、Wiki 成功/Core
   前、Core transaction 中、Core 成功后。
8. 重启不恢复 run/candidate；Wiki 已写/Core 未写时新 MemoryRun读取最新 Wiki snapshot，
   不创建相同事实。
9. hard 失败进入 `compaction_blocked`；下一 LLM call 等待 Provider/config/manual retry，
   不存在 compression-only emergency path。
10. commit 是最小不可中断临界段；settle 后按 Stop → handoff/queue → completion 顺序归并。
11. 同一 Turn 可以在后续 StepEnd 再创建新 cycle；删除 single-turn compression guard。

## 完成

[Acceptance 05](acceptance-05-coordinator-commit-hard-gate.md)通过并创建 `result-05.md`。
