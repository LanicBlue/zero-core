# Memory Compaction Runtime：实施路线图

> 状态：设计与计划已于 2026-07-18 经用户确认，进入 **Ready**；尚未实施。  
> 问题：[issue.md](./issue.md)  
> 设计：[design.md](./design.md)  
> Wiki 前置已满足（Final PASS，`master` 基线 `a58102d`，已归档）；仍等待 `session-turn-lifecycle` Final 并合并后，才能从 Plan 00 开始。

## 目标

把长期记忆提取与上下文压缩改造成低干扰、可验证的 runtime compaction：

- preferred 时利用 TurnEnd/Wait 与 Provider cache TTL 寻找自然空闲边界；
- hard 时保证下一次 Provider request 不超过安全输入预算；
- 一个不可变 Snapshot 同时驱动一个原模型逻辑 Memory call 与多 pass CompressionPipeline；
- 两个分支并行、只产生内存 candidate，联合成功后才进入持久化提交；
- Provider Runtime 按 hard compaction、用户交互、preferred compaction、Work/Cron、
  archive maintenance 分级，并让 Subagent 继承根 Invocation 优先级；
- 前台 Session 继续运行，新增 Step 留在 fresh tail；
- 软件关闭不恢复旧 bypass run；
- 不增加自动语义召回或 Agent 自判压缩协议。

## 已确认结构

```text
TurnEnd / Wait + preferred + cache cold
                 OR
StepEnd + hard
                  ↓
          CompactionSnapshot
          ├── MemoryRun once
          │     → WikiPatch(memory only)
          └── CompressionPipeline
                → pass 1..N → SummaryCandidate(memory only)
                  ↓ both succeeded
          safe-point validation
                  ↓
             durable commit
```

## 外部依赖

```text
wiki-system-redesign FINAL + merge ───────┐
                                          ├──→ memory-compaction-runtime Plan 00
session-turn-lifecycle FINAL + merge ─────┘
```

这不是已经存在的 FlowDependency，只是当前人工/文档门禁。

Session Lifecycle 提供 supervisor、Provider scheduler、compacting branch DTO、safe point 和
commit 临界段；本 effort 不得重建这些 owner。Wiki 提供独立 Core/Wiki DB、WikiService、
revision/request id 和 prompt refresh；Plan 00 必须以合并后 API 为准。

## 阶段

| 阶段 | Plan | Acceptance | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Post-Dependency Reconciliation](plan-00-post-dependency-reconciliation.md) | [Acceptance 00](acceptance-00-post-dependency-reconciliation.md) | Wiki Final + Session Final | 真实 owner/API/缺陷/测试映射 |
| 01 | [Policy, Snapshot & Atoms](plan-01-policy-snapshot-atoms.md) | [Acceptance 01](acceptance-01-policy-snapshot-atoms.md) | 00 | 水位、TTL、CompactionAtom、Snapshot |
| 02 | [Provider Priority & Bypass Runtime](plan-02-provider-priority-bypass-runtime.md) | [Acceptance 02](acceptance-02-provider-priority-bypass-runtime.md) | 01 | P0–P4、继承、capacity、runtime-only runner |
| 03 | [MemoryRunner & Wiki Overlay](plan-03-memory-runner-wiki-overlay.md) | [Acceptance 03](acceptance-03-memory-runner-wiki-overlay.md) | 01–02 | 一次 Memory call、COW WikiPatch、archive adapter |
| 04 | [Multi-pass Compression](plan-04-multipass-compression.md) | [Acceptance 04](acceptance-04-multipass-compression.md) | 01–02 | atom segmentation、rolling multi-pass summary |
| 05 | [Coordinator, Commit & Hard Gate](plan-05-coordinator-commit-hard-gate.md) | [Acceptance 05](acceptance-05-coordinator-commit-hard-gate.md) | 03–04 | 并行协调、CAS、Wiki-first/Core-second、blocked |
| 06 | [Trigger Cutover, UI & Archive](plan-06-trigger-cutover-ui-archive.md) | [Acceptance 06](acceptance-06-trigger-cutover-ui-archive.md) | 01–05 | 全触发切换、旧路径删除、UI/E2E/telemetry |

全部通过后执行 [Final Acceptance](acceptance-final.md)。

```text
Wiki Final + Session Final
          ↓
00 → 01 → 02 ─┬→ 03 ─┐
              └→ 04 ─┴→ 05 → 06 → FINAL
```

Plan 03 与 Plan 04 在 Plan 02 后可以由不同 worktree 并行研究，但它们共享 Snapshot/types；
默认仍建议同一实施 worktree 串行提交，避免合并出两套 candidate contract。

## 与已有问题的关系

- [`memory-maintenance`](../../issues/memory-maintenance/issue.md)：后续治理已有 Memory，不由
  本 effort 实现。
- [`session-summary-restart-integrity`](../../archive/session-summary-restart-integrity/issue.md)：
  合并后重核确认缺陷仍在；由本 effort Plan 00 / 05 统一修复和验收。
- [`prompt-cache-control`](../../issues/prompt-cache-control/issue.md)：显式 Provider cache
  控制；本 effort 只复用现有 `cacheTtlMs` 冷热估计。

## 全程不可违反

- 每个 CompactionRun 的 MemoryRun 恰好一个原工作模型逻辑 call；Compression 可多 pass。
- Turn 不是压缩/保留单位；不能恢复 single-turn guard。
- bypass run、WikiPatch、rolling summary 和 pass cursor 在完成前不持久化，重启不恢复。
- 任一 branch 失败不能单独提交另一个；hard 没有 compression-only emergency path。
- 不截断 transcript 后推进 cursor，不拆 tool/AskUser 原子组。
- Wiki-first/Core-second，不用 `ATTACH` 或持久 run journal伪造跨库原子性。
- 不增加自动 semantic recall、embedding 或 Memory maintenance。
- 不在 AgentLoop 内联 Memory/Compression 功能，不建立第二个 Session/Provider owner。

## 提交与验收

- 每阶段独立 commit，并生成 `result-XX.md`。
- result 记录 baseline/target commit、真实接口映射、命令、测试、failure injection 和偏差。
- Plan 00 前置未满足时不得提前写 adapter 或按当前 master 实现。
- 至少运行 typecheck、build:lib、相关 unit 和 links；Plan 05–Final 运行 integration/E2E、
  reopen、fake-clock、Provider concurrency、multi-pass、超长 Turn 和双 DB crash injection。
- 不以 skipped/only、放宽 timeout/threshold、减少 fixture 或保留旧生产 fallback 通过验收。
- Final PASS 与最终合并仍需用户同意。
