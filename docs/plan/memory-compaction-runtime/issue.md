# Issue: memory-compaction-runtime

- **状态**：③ plan（用户已确认，Ready）
- **提出**：2026-07-18
- **类型**：可靠性 / 上下文与长期记忆（P1）
- **设计**：[design.md](./design.md)
- **外部前置**：`wiki-system-redesign` 最终验收并合并；与
  `session-turn-lifecycle` 的 compacting owner 完成对齐

## 问题

zero-core 当前把“压缩前写长期记忆”和“生成滚动摘要”串行塞在同一个
`AgentLoop` 周边：

1. force compression 先临时重入同一个 loop 跑 ephemeral memory turn，再调用独立摘要模型；
2. memory turn 可以直接写真实 Wiki，失败或中断可能留下部分副作用；
3. 压缩触发同时混合 cache 冷热、自然语言提醒和 Agent 自行请求压缩；
4. 前台运行、Wait、Stop、软件关闭和压缩提交之间没有稳定的 snapshot、generation 与
   commit barrier；
5. Memory 与 Compression 没有可验证的共同覆盖边界。

这使当前流程难以在不中断前台 Session 的前提下并行执行，也难以回答：

- 压缩期间前台继续产生的新 Step 属于哪一侧；
- Memory 成功而 Compression 失败时是否应推进上下文；
- 软件关闭后哪些副作用应该保留；
- Provider prompt cache 仍热时是否值得破坏前缀；
- 大窗口、小窗口和硬上限如何使用同一套触发规则。

## 当前代码事实

以下事实来自 2026-07-18 的 master，`wiki-system-redesign` 合并后必须重新核验：

- [`compression-trigger-hooks.ts`](../../../src/runtime/hooks/compression-trigger-hooks.ts)
  使用 `Provider.cacheTtlMs` 和内存态 `lastLLMCall` 判定 cache 冷热，但 soft/hard 阈值和
  Agent 自判提醒仍是旧设计。
- [`agent-loop.ts`](../../../src/runtime/agent-loop.ts) 的 force compression 会暂时改写同一
  loop 的运行状态并重入 ephemeral turn；该对象还共享 messages、recorder、abort、hooks
  和 session state，不能直接改成与前台并行。
- [`compression-core.ts`](../../../src/server/compression-core.ts) 的
  `SUMMARY_USER_TEMPLATE` 包含 `{transcript}`，当前调用路径没有把 transcript 替换进去。
- 同文件的 `renderSegmentTranscript()` 会在字符上限处停止，但后续仍可能把 cursor 推进到
  整个 segment 末尾，使模型没有读到的 Step 被标记为已压缩。
- [`session-db.ts`](../../../src/server/core-database.ts) 当前启动时无条件删除 `messages` 表，
  可能清空摘要和压缩 cursor；该问题另见
  [`session-summary-restart-integrity`](../../issues/session-summary-restart-integrity/issue.md)。
- “Recalled Memories” 仍没有生产级自动召回链路；当前可用能力是 bounded Wiki
  outline/summary 注入，以及 Agent 显式搜索、读取 `memory://`。

这些实现缺陷不在本次设计讨论中直接修复，但后续计划不得把它们当作可靠基线。

## 已确认的产品语义

- 原始 Steps 是无损事实源；滚动摘要是当前 Session 的有损连续性视图；Wiki Memory 是
  跨 Session 长期记忆，三者不能混为一个存储。
- Agent 不负责判断何时压缩。压缩是 runtime 的资源管理；自然语言“请求压缩”协议应退出
  生产路径。
- 达到 preferred 后优先等待 TurnEnd/Wait 和 cache 冷却；达到 hard 后在完整 StepEnd
  强制启动。
- 前台 Session 可以在 Memory/Compression 运行时继续产生 fresh tail；已经固定的被压缩
  前缀不再变化。
- MemoryRun 与 CompressionPipeline 读取同一个不可变 Snapshot，并行执行。
- 每个 CompactionRun 的 MemoryRun 使用 foreground 原模型且恰好创建一个逻辑 call；
  CompressionPipeline 使用专用模型，可按窗口顺序执行多个 pass。
- 两个分支都是纯运行时、不可恢复工作；软件关闭、进程中断或任一分支失败时，不恢复旧
  run/candidate，等待下次触发重新生成。
- 只有两个分支都成功，才允许把 Wiki patch 和压缩结果提交到持久化层。
- MemoryRun 对 Wiki 使用内存 copy-on-write view；运行中不得直接修改真实 Wiki。
- Memory 与 Compression 使用同一个覆盖 cursor，不能让 Memory 在未来追赶任意长的已压缩
  历史。
- Provider API 调度区分 hard compaction、用户交互、preferred compaction、Work/Cron 和
  archive maintenance；Subagent 继承根 Invocation 的优先级，不作为固定低优先级类别。
- 首版不增加 embedding、reranker 或自动语义召回；继续使用 bounded Memory Wiki 注入和
  Agent 显式读取。
- UI 显示低干扰的 memory/compression 运行状态；运行态不要求持久化。

## 影响面

- Session/Turn supervisor、Stop、Wait、handoff 和 compacting projection；
- context token accounting、触发 hook 和 Provider cache TTL；
- 独立 bypass runner、Provider concurrency lane 与 cancellation；
- Provider Runtime queue priority、foreground capacity reservation 与 priority inheritance；
- Core context summary/cursor 和 Wiki copy-on-write patch；
- prompt assembly、fresh tail、generation/CAS；
- Memory/Compression 状态、错误与遥测；
- 压缩、重启、并发 Wiki 写、Provider 失败和大上下文测试。

## 非目标

- 不在本 effort 实现自动 Memory 召回、embedding 或向量数据库。
- 不进行 Memory 节点去重、冲突治理、衰减或淘汰；这些属于
  [`memory-maintenance`](../../issues/memory-maintenance/issue.md)。
- 不实现 provider-specific 显式 prompt cache；该能力仍由
  [`prompt-cache-control`](../../issues/prompt-cache-control/issue.md)跟踪。
- 不改变 archive export、session 删除或归档恢复语义。
- 不让 Agent 通过自然语言或隐藏 ack 控制 runtime compression。
- 不在 `AgentLoop` 中增加第二条内联功能路径。
- 当前阶段不修改项目代码、测试或现有 worktree。

## 当前实施安排

本 effort 已完成设计和计划拆分，但必须等待：

1. `wiki-system-redesign` 最终验收并合并；
2. `session-turn-lifecycle` 最终验收并合并，其 compacting branch DTO、Provider scheduler、
   safe-point 和 commit 临界段成为真实基线。

随后从 Plan 00 重新核对真实 `CoreDatabase/WikiDatabase/WikiService/Session supervisor` API。
`wiki.db` 与 `core.db` 没有跨库 transaction，计划按已确认的 Wiki-first/Core-second 安全
偏置实现，不引入可恢复 CompactionRun journal。
