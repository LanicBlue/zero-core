# Final Acceptance：Memory Compaction Runtime

## 前置

- [ ] Acceptance 00–06 全部 PASS，存在 `result-00.md` 至 `result-06.md`。
- [ ] 每阶段 commit、偏差、测试和上游 result 映射完整。
- [ ] 最终目标分支仍包含 Wiki 与 Session Lifecycle Final。

## 核心语义

- [ ] 原始 Steps 无损保留；Context Summary 与 Wiki Memory 职责分离。
- [ ] 每个 CompactionRun 固定不可变 Snapshot 和单一 `maintenanceCursor`。
- [ ] MemoryRun 使用原工作模型且每 cycle 恰好一个逻辑 callId；CompressionPipeline 可顺序
  多 pass；transparent attempts 不形成第二次 Memory reasoning pass。
- [ ] Turn 不是边界；超长 Turn 可多次压缩，in-flight Step/未闭合 atom 永不进入 coverage。
- [ ] 两分支联合成功前无持久化副作用；任一失败不单独提交。
- [ ] process restart 不恢复 bypass run/candidate/pass cursor。

## Policy 与调度

- [ ] preferred/hard/target/summaryCap 公式在 32K–1M 窗口精确生效。
- [ ] per-provider TTL 空值为 60 分钟，无“6 分钟”分叉。
- [ ] semantic idle、TurnEnd/Wait、hard StepEnd 和 PreLLM fit guard 时序正确。
- [ ] P0–P4、Subagent root inheritance、foreground reservation、FIFO/aging 和跨 Provider
  独立性符合 design。

## Memory 与 Compression

- [ ] Memory 单次调用只接收当前 Agent bounded MemoryView，返回结构化 patch；不使用 live
  Wiki tool 或 tool-result follow-up，运行中真实 Wiki 不变。
- [ ] `no_change`、written、failure、cancel 均有明确结果。
- [ ] Compression 每 pass 实际读取完整 segment，无 placeholder、静默截断或 cursor 越界。
- [ ] 专用模型小于 foreground 时 multi-pass 完成；单 atom 超限 fail closed。
- [ ] summary cap、minimum reduction 和 target 防止无效循环。

## Commit 与恢复

- [ ] safe-point CAS 覆盖 Session generation/history/summary/Wiki touched revisions。
- [ ] Wiki-first/Core-second；Wiki 失败时 Core cursor 永不推进。
- [ ] Wiki request id/provenance 可识别 source range/digest。
- [ ] Wiki/Core crash window 只产生允许的安全 Memory，不产生“压缩后无 Memory”。
- [ ] touched node 冲突整轮失败，无自动 rebase/部分提交。
- [ ] hard failure 进入 blocked 并可显式重试，无 emergency compression。
- [ ] commit 中 Stop、handoff、queue 和 late task event 顺序符合 Session Lifecycle。

## 产品与回归

- [ ] 普通 Agent 不决定压缩时机；管理面 manual compact 走同一生产路径。
- [ ] Archive MemoryRun 复用 runner/overlay、P4、一个原模型逻辑 call，archive best-effort
  语义保持。
- [ ] 自动语义 Memory recall/embedding/reranker 没有被顺带实现。
- [ ] UI 可见但低干扰；reconnect snapshot 与 WS 增量 revision 一致。
- [ ] telemetry 可供 Eval Harness 消费且不泄露正文、prompt、transcript 或 secret。
- [ ] 无旧 compression reminder、nested loop、single-turn guard、双真相源或 legacy fallback。

## 必跑矩阵

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

另需运行相关 integration/E2E、数据库 reopen、fake-clock TTL、Provider concurrency、
32K–1M token policy、multi-pass、小模型、超长 Turn、Stop/Wait/handoff、quota/restart 和
Wiki/Core crash injection。

Final PASS 后仍需用户同意合并；不得由实施 Agent自行更新本地 zero-core 安装。
