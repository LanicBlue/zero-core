# Acceptance 05：Coordinator、Commit 与 Hard Gate

对应 [Plan 05](plan-05-coordinator-commit-hard-gate.md)。

- [ ] MemoryRun once 与 CompressionPipeline 真并行，联合成功前无 Wiki/context 持久化。
- [ ] 一个分支先完成不会单独提交或取消另一个。
- [ ] failure/cancel/dispose/shutdown 丢弃全部内存 candidate/pass state。
- [ ] Session generation/history/summary base stale 使整轮失败。
- [ ] 无关 Wiki 节点变化不冲突；touched node revision/hash 变化使整轮失败且不自动 rebase。
- [ ] WikiPatch 单库事务和 deterministic request id/provenance 可验证。
- [ ] Core summary + maintenance cursor 在同一 Core transaction/CAS 中提交。
- [ ] Core 永远不会在 Wiki commit 失败时推进 cursor。
- [ ] Wiki 成功/Core 前崩溃只留下安全 Memory；重启不恢复旧 run，下一新 run 不重复创建同一
  source fact。
- [ ] hard failure 显示 `compaction_blocked`，下一 LLM call 不发送，manual/provider recovery
  可创建新 Snapshot 重试。
- [ ] 没有 compression-only emergency path。
- [ ] commit 中 Stop 不产生半 cursor/context；settle 后 Stop 优先。
- [ ] 同一 Turn 可完成两个以上 cycle，cursor 单调且每个 atom 只覆盖一次。
